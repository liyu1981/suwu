// Package session manages keyed, long-lived PTY sessions with server-side
// terminal state kept by the libghostty-vt emulator (Ghostty's VT engine,
// compiled to WASM and run in-process via wazero).
//
// A session outlives its WebSocket clients: a browser refresh or transient
// disconnect can reattach to the same shell with the same key and see its
// screen restored by replaying the emulator's current state (DumpVTFull)
// before live output resumes. Scrollback history is intentionally not
// restored — only the visible screen — keeping replay cheap.
package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	libghostty "github.com/shintaoku/libghostty-go"

	"suwu/pkg/pty"
)

const (
	// DefaultTTL is how long a session with no attached clients stays alive
	// before its shell is killed. Reattaching within the window restores it.
	DefaultTTL = 10 * time.Minute

	// subBuffer caps the per-client output queue (32 KiB frames). A client
	// that falls this far behind is dropped and left to reconnect.
	subBuffer = 256

	// vtScrollback is the line budget of the server-side emulator. It is only
	// needed if scrollback-aware dumps are ever enabled; the restore path
	// dumps the visible screen only.
	vtScrollback = 1000

	// wasmTimeout bounds every single WASM emulator call.
	wasmTimeout = 5 * time.Second
)

// Manager owns every live session. A single mutex guards the whole manager:
// sessions are short-lived, output frames are small, and the operations under
// lock (PTY read fan-out, WASM feed, screen dump) are all sub-millisecond.
type Manager struct {
	mu       sync.Mutex
	rt       *libghostty.Runtime
	sessions map[string]*session
	ttl      time.Duration
}

// NewManager creates an empty session manager with the libghostty runtime
// compiled and ready.
func NewManager() (*Manager, error) {
	rt, err := libghostty.NewRuntime(context.Background())
	if err != nil {
		return nil, fmt.Errorf("session: libghostty runtime: %w", err)
	}
	return &Manager{rt: rt, sessions: map[string]*session{}, ttl: DefaultTTL}, nil
}

// SetTTL overrides the idle session lifetime (used by tests).
func (m *Manager) SetTTL(d time.Duration) {
	m.mu.Lock()
	m.ttl = d
	m.mu.Unlock()
}

// Close kills every live session and releases the emulator runtime.
func (m *Manager) Close() {
	m.mu.Lock()
	live := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		live = append(live, s)
	}
	m.sessions = map[string]*session{}
	for _, s := range live {
		s.closed = true
		if s.timer != nil {
			s.timer.Stop()
			s.timer = nil
		}
		for ch := range s.subs {
			close(ch)
		}
		s.subs = map[chan []byte]struct{}{}
	}
	m.mu.Unlock()

	for _, s := range live {
		_ = s.pty.Kill()
		s.releaseVT()
	}
	if m.rt != nil {
		_ = m.rt.Close()
	}
}

// Client is one attached WebSocket endpoint of a session.
type Client struct {
	m  *Manager
	s  *session
	ch chan []byte
}

// Frames streams the session's PTY output. The channel is closed when the
// shell exits (the exit notice is the final frame) or when the client is
// dropped for falling behind; either way the caller should disconnect.
func (c *Client) Frames() <-chan []byte { return c.ch }

// Write forwards keyboard input to the session's shell. Writes after shell
// exit are silently ignored.
func (c *Client) Write(data []byte) {
	_, _ = c.s.pty.Write(data)
}

// Resize updates both the PTY window size and the server-side emulator grid
// so future screen dumps match the client's geometry.
func (c *Client) Resize(cols, rows uint16) {
	m := c.m
	m.mu.Lock()
	defer m.mu.Unlock()
	if c.s.closed || c.s.exited {
		return
	}
	_ = c.s.pty.Resize(cols, rows)
	ctx, cancel := context.WithTimeout(context.Background(), wasmTimeout)
	defer cancel()
	_ = c.s.vt.Resize(ctx, uint32(cols), uint32(rows))
	c.s.cols, c.s.rows = cols, rows
}

// Detach removes the client from its session. When the last client detaches,
// an expiry timer is armed so the shell survives refreshes for the TTL window
// and is reaped if nobody comes back.
func (c *Client) Detach() {
	m := c.m
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := c.s; !s.closed {
		if _, ok := s.subs[c.ch]; ok {
			delete(s.subs, c.ch)
			close(c.ch)
		}
		if len(s.subs) == 0 && s.timer == nil {
			s.timer = time.AfterFunc(m.ttl, func() { m.expire(s) })
		}
	}
}

// Attach returns the live session for key, creating one (with a fresh shell
// PTY) if none exists, and registers the caller as an output subscriber.
//
// If cwd is non-empty and a new session is created, the shell starts in that
// directory. For existing sessions (reattach), cwd is ignored.
//
// The returned snapshot is a VT byte stream that reconstructs the emulator's
// current screen state (content, cursor, modes); it is empty for a
// brand-new session. The dump is taken under the same lock the output
// fan-out holds, so replaying the snapshot and then consuming Frames()
// yields the exact byte order the shell produced, with no gap or overlap.
func (m *Manager) Attach(key string, cols, rows uint16, cwd string) (*Client, []byte, error) {
	if key == "" {
		key = randomKey()
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	s := m.sessions[key]
	if s != nil && (s.closed || s.exited) {
		// Shell died while nobody was attached; start over on this key.
		delete(m.sessions, key)
		s = nil
	}

	created := s == nil
	if created {
		var err error
		if s, err = m.start(key, cols, rows, cwd); err != nil {
			return nil, nil, err
		}
	} else {
		if s.timer != nil {
			s.timer.Stop()
			s.timer = nil
		}
		// Adopt the client's grid size before dumping so the replay matches
		// what the client is about to render (the pane may have been resized
		// or opened on another display while detached).
		m.resizeLocked(s, cols, rows)
	}

	ctx, cancel := context.WithTimeout(context.Background(), wasmTimeout)
	defer cancel()
	dump, err := s.vt.DumpScreen(ctx, libghostty.DumpVTFull)
	if err != nil {
		return nil, nil, fmt.Errorf("session: dump screen state: %w", err)
	}

	ch := make(chan []byte, subBuffer)
	s.subs[ch] = struct{}{}
	var snapshot []byte
	if !created {
		snapshot = dump.VT
	}
	return &Client{m: m, s: s, ch: ch}, snapshot, nil
}

// start launches the shell PTY and its emulator twin. Callers hold m.mu.
func (m *Manager) start(key string, cols, rows uint16, cwd string) (*session, error) {
	slog.Debug("session start", "key", key, "cols", cols, "rows", rows, "cwd", cwd)
	ps, err := pty.StartWithCWD(cols, rows, cwd)
	if err != nil {
		return nil, fmt.Errorf("session: start shell: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), wasmTimeout)
	vt, err := m.rt.NewTerminal(ctx, uint32(cols), uint32(rows), vtScrollback)
	cancel()
	if err != nil {
		_ = ps.Kill()
		return nil, fmt.Errorf("session: create emulator: %w", err)
	}

	s := &session{
		key:  key,
		pty:  ps,
		vt:   vt,
		cols: cols,
		rows: rows,
		subs: map[chan []byte]struct{}{},
	}
	m.sessions[key] = s
	go m.readLoop(s)
	return s, nil
}

// readLoop pumps PTY output into the emulator and every attached client, and
// finalizes the session when the shell exits. One goroutine per session.
func (m *Manager) readLoop(s *session) {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.pty.Read(buf)
		if n > 0 {
			m.broadcast(s, buf[:n])
		}
		if err != nil {
			break
		}
	}
	code := s.pty.Wait()
	m.finish(s, code)
}

// broadcast feeds one PTY chunk into the emulator and fans it out to all
// attached clients. Callers hold no locks; the slice is copied because the
// reader's buffer is reused.
func (m *Manager) broadcast(s *session, data []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s.closed {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), wasmTimeout)
	defer cancel()
	_ = s.vt.Feed(ctx, data)

	if len(s.subs) == 0 {
		return
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	for ch := range s.subs {
		select {
		case ch <- cp:
		default:
			// Slow consumer: drop it and let its socket close + reconnect.
			close(ch)
			delete(s.subs, ch)
		}
	}
}

// finish records shell exit, delivers the exit notice as the final frame to
// every client, and removes the session.
func (m *Manager) finish(s *session, code int) {
	slog.Debug("session finish", "key", s.key, "exit_code", code)
	m.mu.Lock()
	if s.closed {
		m.mu.Unlock()
		return
	}
	s.exited = true
	s.closed = true
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	if cur, ok := m.sessions[s.key]; ok && cur == s {
		delete(m.sessions, s.key)
	}
	msg := []byte("\r\n\x1b[33mShell exited (code: " + strconv.Itoa(code) + ")\x1b[0m\r\n")
	for ch := range s.subs {
		select {
		case ch <- msg:
		default:
		}
		close(ch)
	}
	s.subs = map[chan []byte]struct{}{}
	m.mu.Unlock()

	s.releaseVT()
}

// expire reaps a session whose last client left longer than the TTL ago.
func (m *Manager) expire(s *session) {
	slog.Debug("session expire", "key", s.key)
	m.mu.Lock()
	if s.closed || len(s.subs) > 0 {
		m.mu.Unlock()
		return
	}
	s.closed = true
	s.timer = nil
	if cur, ok := m.sessions[s.key]; ok && cur == s {
		delete(m.sessions, s.key)
	}
	m.mu.Unlock()

	// Killing the PTY unblocks readLoop, whose finish() sees closed and
	// returns without re-cleaning anything.
	_ = s.pty.Kill()
	s.releaseVT()
}

// resizeLocked adopts a new grid size for the PTY and the emulator.
func (m *Manager) resizeLocked(s *session, cols, rows uint16) {
	if s.cols == cols && s.rows == rows {
		return
	}
	_ = s.pty.Resize(cols, rows)
	ctx, cancel := context.WithTimeout(context.Background(), wasmTimeout)
	defer cancel()
	_ = s.vt.Resize(ctx, uint32(cols), uint32(rows))
	s.cols, s.rows = cols, rows
}

// GetState returns the current CWD and foreground command for a session.
// Returns empty strings if the session doesn't exist.
func (m *Manager) GetState(key string) (cwd string, foreground string) {
	m.mu.Lock()
	s := m.sessions[key]
	m.mu.Unlock()
	if s == nil || s.closed {
		return "", ""
	}
	return pty.GetSessionState(s.pty.Pid())
}

// releaseVT frees the emulator instance exactly once.
func (s *session) releaseVT() {
	s.vtOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), wasmTimeout)
		defer cancel()
		_ = s.vt.Close(ctx)
	})
}

// session is one shell PTY plus its emulator twin. All fields are guarded by
// the owning Manager's mutex.
type session struct {
	key    string
	pty    *pty.Session
	vt     *libghostty.Terminal
	vtOnce sync.Once

	cols, rows uint16

	subs map[chan []byte]struct{}

	// timer is the pending idle-expiry callback while no client is attached.
	timer *time.Timer

	// exited: the shell process is gone. closed: the session is fully torn
	// down (removed from the manager, emulator released) — no new attaches.
	exited bool
	closed bool
}

// randomKey returns a URL-safe random session key.
func randomKey() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(buf)
}
