// Package session manages keyed, long-lived PTY sessions with server-side
// terminal state kept by the libghostty-vt emulator (Ghostty's VT engine 1.0,
// compiled to WASM and run in-process via wazero — see pkg/vt).
//
// A session outlives its WebSocket client: a browser refresh or transient
// disconnect can reattach to the same shell with the same key and receive a
// fresh snapshot of the screen and its retained scrollback. The browser
// terminal is disposable; the PTY and VT state owned by this package are
// authoritative.
package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"syscall"
	"time"

	"suwu/pkg/pty"
	"suwu/pkg/vt"
)

const (
	// DefaultTTL is how long a session with no attached client stays alive
	// before its shell is killed. Reattaching within the window restores it.
	// Can be overridden with the SESSION_TTL environment variable.
	DefaultTTL = 24 * time.Hour

	// subBuffer caps the attached client's output queue. A client that falls
	// this far behind is dropped and left to reattach.
	subBuffer = 256

	// vtScrollback is the history depth the server keeps per session; the
	// browser gets it back in the reattach snapshot (xterm.js holds 5000).
	vtScrollback = 1000

	// statePollInterval controls how often we poll /proc for session state.
	statePollInterval = 2 * time.Second
)

// SessionState tracks the observable state of a running PTY session.
// Designed to be extensible — add new fields as needed.
type SessionState struct {
	CWD        string `json:"cwd"`
	Foreground string `json:"foreground,omitempty"` // full cmdline of foreground process
	UpdatedAt  int64  `json:"updatedAt"`            // unix millis
}

// Manager owns every live session. A single mutex guards the manager and the
// session state. There is deliberately one writable attachment per session:
// a newer browser attachment revokes the older one so stale clients cannot
// continue writing into the PTY.
type Manager struct {
	mu       sync.Mutex
	rt       *vt.Runtime
	sessions map[string]*session
	ttl      time.Duration
	nextID   uint64
}

// Option configures a Manager.
type Option func(*managerOptions)

type managerOptions struct {
	wasmCacheDir string
}

// WithWasmCacheDir keeps the compiled terminal engine in dir. Compiling the
// embedded module costs ~0.6 s, so a persisted wazero compilation cache makes
// restarts and upgrades fast. The directory is wazero-version specific and
// must only be written by suwu.
func WithWasmCacheDir(dir string) Option {
	return func(o *managerOptions) { o.wasmCacheDir = dir }
}

func NewManager(opts ...Option) (*Manager, error) {
	var cfg managerOptions
	for _, opt := range opts {
		opt(&cfg)
	}
	var vtOpts []vt.Option
	if cfg.wasmCacheDir != "" {
		vtOpts = append(vtOpts, vt.WithCacheDir(cfg.wasmCacheDir))
	}
	rt, err := vt.NewRuntime(context.Background(), vtOpts...)
	if err != nil {
		return nil, fmt.Errorf("session: libghostty-vt runtime: %w", err)
	}
	slog.Debug("session: terminal engine ready",
		"libghostty-vt", rt.Info().LibraryVersion, "wasmCache", cfg.wasmCacheDir)
	return &Manager{rt: rt, sessions: map[string]*session{}, ttl: DefaultTTL}, nil
}

func (m *Manager) SetTTL(d time.Duration) {
	m.mu.Lock()
	m.ttl = d
	m.mu.Unlock()
}

// State returns the current state of the session with the given key.
func (m *Manager) State(key string) (SessionState, bool) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	m.mu.Unlock()
	if !ok {
		return SessionState{}, false
	}
	return s.State(), true
}

func (m *Manager) Close() {
	m.mu.Lock()
	live := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		live = append(live, s)
	}
	m.sessions = map[string]*session{}
	for _, s := range live {
		s.closed = true
		close(s.done) // stop the state poller, as finish and expire do
		if s.timer != nil {
			s.timer.Stop()
			s.timer = nil
		}
		m.revokeLocked(s)
	}
	m.mu.Unlock()

	for _, s := range live {
		_ = s.pty.Kill()
		<-s.pollerDone
		s.releaseVT()
	}
	if m.rt != nil {
		_ = m.rt.Close()
	}
}

// Client is one writable attachment to a session. It becomes active only
// after the WebSocket handshake has sent the snapshot and ready message.
type Client struct {
	m      *Manager
	s      *session
	ch     chan []byte
	id     uint64
	active bool
	ready  bool
}

func (c *Client) AttachmentID() uint64  { return c.id }
func (c *Client) Frames() <-chan []byte { return c.ch }

// Activate grants this attachment input ownership. The server calls it only
// after the ordered attach/snapshot/ready protocol has completed.
func (c *Client) Activate() {
	m := c.m
	m.mu.Lock()
	defer m.mu.Unlock()
	accepted := !c.s.closed && c.s.client == c
	if accepted {
		c.ready = true
	}
	slog.Debug("session client ready", "key", c.s.key, "attachment", c.id, "accepted", accepted, "active", c.active, "ready", c.ready, "closed", c.s.closed)
}

// Write forwards input only from the current, ready attachment. The manager
// lock covers the ownership check and PTY write so revocation cannot race a
// stale client into the shell.
func (c *Client) Write(data []byte) {
	m := c.m
	m.mu.Lock()
	defer m.mu.Unlock()
	if c.s.closed || c.s.client != c || !c.active || !c.ready {
		slog.Debug("session input rejected", "key", c.s.key, "attachment", c.id, "closed", c.s.closed, "current", c.s.client == c, "active", c.active, "ready", c.ready, "bytes", len(data))
		return
	}
	slog.Debug("session input accepted", "key", c.s.key, "attachment", c.id, "bytes", len(data))
	// A TUI that exits without restoring mouse modes can leave the browser
	// emitting mouse reports after the shell regains the foreground. Keep
	// ordinary keyboard input intact, but discard recognized mouse reports at
	// the PTY boundary while the shell itself is foreground.
	_, foreground := pty.GetSessionState(c.s.pty.Pid())
	if foreground == "" {
		data = pty.StripMouseReports(data)
	}
	if len(data) == 0 {
		return
	}
	_, _ = c.s.pty.Write(data)
}

func (c *Client) Resize(cols, rows uint16) {
	m := c.m
	m.mu.Lock()
	defer m.mu.Unlock()
	if c.s.closed || c.s.client != c || !c.active || !c.ready || cols == 0 || rows == 0 {
		return
	}
	m.resizeLocked(c.s, cols, rows)
}

// Refresh asks the foreground app in this session's PTY to repaint by
// signalling its process group with SIGWINCH. Unlike Resize it leaves the grid
// untouched, so there is no reflow and nothing to undo. Full-screen TUIs
// redraw on SIGWINCH; a shell at a prompt repaints its line. Used after a
// client-side terminal reset (term.reset) wipes the browser screen, which the
// server-side app would otherwise never notice.
func (c *Client) Refresh() {
	m := c.m
	m.mu.Lock()
	defer m.mu.Unlock()
	if c.s.closed || c.s.client != c || !c.active || !c.ready {
		return
	}
	if err := c.s.pty.SignalForeground(syscall.SIGWINCH); err != nil {
		slog.Debug("session refresh signal failed", "key", c.s.key, "error", err)
	}
}

func (c *Client) Detach() {
	m := c.m
	m.mu.Lock()
	defer m.mu.Unlock()
	if c.s.closed || c.s.client != c {
		return
	}
	m.detachLocked(c.s)
}

// Attach returns the live session for key, creating one if necessary, and
// registers one writable browser attachment. An existing attachment is
// revoked before the new snapshot is produced.
//
// If cwd is non-empty and a new session is created, the shell starts there.
// Existing sessions ignore cwd. The snapshot is empty for a new session and
// otherwise reconstructs the server-side VT screen.
func (m *Manager) Attach(key string, cols, rows uint16, cwd string) (*Client, []byte, bool, error) {
	if key == "" {
		key = randomKey()
	}
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	s := m.sessions[key]
	if s != nil && (s.closed || s.exited) {
		delete(m.sessions, key)
		s = nil
	}

	created := s == nil
	if created {
		var err error
		if s, err = m.start(key, cols, rows, cwd); err != nil {
			return nil, nil, false, err
		}
	} else {
		if s.timer != nil {
			s.timer.Stop()
			s.timer = nil
		}
		m.resizeLocked(s, cols, rows)
		m.revokeLocked(s)
	}

	dump, err := s.vt.DumpVT(vt.ExtrasRestore)
	if err != nil {
		return nil, nil, false, fmt.Errorf("session: dump screen state: %w", err)
	}

	m.nextID++
	c := &Client{m: m, s: s, ch: make(chan []byte, subBuffer), id: m.nextID, active: true}
	s.client = c
	var snapshot []byte
	if !created {
		snapshot = dump
	}
	return c, snapshot, created, nil
}

func (m *Manager) start(key string, cols, rows uint16, cwd string) (*session, error) {
	slog.Debug("session start", "key", key, "cols", cols, "rows", rows, "cwd", cwd)
	ps, err := pty.StartWithCWD(cols, rows, cwd)
	if err != nil {
		return nil, fmt.Errorf("session: start shell: %w", err)
	}
	term, err := m.rt.NewTerminal(cols, rows, vtScrollback)
	if err != nil {
		_ = ps.Kill()
		return nil, fmt.Errorf("session: create emulator: %w", err)
	}

	s := &session{key: key, pty: ps, vt: term, cols: cols, rows: rows, done: make(chan struct{}), pollerDone: make(chan struct{})}
	m.sessions[key] = s
	go m.readLoop(s)
	go m.statePoller(s)
	return s, nil
}

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

func (m *Manager) broadcast(s *session, data []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s.closed {
		return
	}

	// vt_write cannot fail: malformed PTY output is logged inside the
	// library and never corrupts the screen.
	_ = s.vt.Write(data)

	c := s.client
	if c == nil || !c.active {
		return
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	select {
	case c.ch <- cp:
	default:
		m.revokeLocked(s)
	}
}

func (m *Manager) statePoller(s *session) {
	defer close(s.pollerDone)
	ticker := time.NewTicker(statePollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			m.pollState(s)
		case <-s.done:
			return
		}
	}
}

func (m *Manager) pollState(s *session) {
	pid := s.pty.Pid()
	if pid <= 0 {
		return
	}
	cwd, fg := pty.GetSessionState(pid)
	s.stateMu.Lock()
	s.state = SessionState{
		CWD:        cwd,
		Foreground: fg,
		UpdatedAt:  time.Now().UnixMilli(),
	}
	s.stateMu.Unlock()
}

func (m *Manager) finish(s *session, code int) {
	slog.Debug("session finish", "key", s.key, "exit_code", code)
	m.mu.Lock()
	if s.closed {
		m.mu.Unlock()
		return
	}
	s.exited = true
	s.closed = true
	close(s.done) // stop state poller
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	if cur, ok := m.sessions[s.key]; ok && cur == s {
		delete(m.sessions, s.key)
	}
	if c := s.client; c != nil && c.active {
		msg := []byte("\r\n\x1b[33mShell exited (code: " + strconv.Itoa(code) + ")\x1b[0m\r\n")
		select {
		case c.ch <- msg:
		default:
		}
		m.revokeLocked(s)
	}
	m.mu.Unlock()

	s.releaseVT()
}

func (m *Manager) expire(s *session) {
	slog.Debug("session expire", "key", s.key)
	m.mu.Lock()
	if s.closed || s.client != nil {
		m.mu.Unlock()
		return
	}
	s.closed = true
	close(s.done) // stop state poller
	s.timer = nil
	if cur, ok := m.sessions[s.key]; ok && cur == s {
		delete(m.sessions, s.key)
	}
	m.mu.Unlock()

	_ = s.pty.Kill()
	s.releaseVT()
}

func (m *Manager) detachLocked(s *session) {
	m.revokeLocked(s)
	if s.timer == nil && !s.closed {
		s.timer = time.AfterFunc(m.ttl, func() { m.expire(s) })
	}
}

// revokeLocked closes the current attachment's frame stream and removes its
// write authority. It is idempotent and must be called with m.mu held.
func (m *Manager) revokeLocked(s *session) {
	c := s.client
	if c == nil {
		return
	}
	s.client = nil
	if c.active {
		c.active = false
		c.ready = false
		close(c.ch)
	}
}

// resizeLocked adopts a new grid size for the PTY and emulator.
func (m *Manager) resizeLocked(s *session, cols, rows uint16) {
	if cols == 0 || rows == 0 || (s.cols == cols && s.rows == rows) {
		return
	}
	_ = s.pty.Resize(cols, rows)
	_ = s.vt.Resize(cols, rows)
	s.cols, s.rows = cols, rows
}

// session is one shell PTY plus its emulator twin. All fields are guarded by
// the owning Manager's mutex.
type session struct {
	key    string
	pty    *pty.Session
	vt     *vt.Terminal
	vtOnce sync.Once

	cols, rows uint16
	client     *Client
	timer      *time.Timer
	exited     bool
	closed     bool

	// State tracking — polled periodically from /proc.
	state      SessionState
	stateMu    sync.RWMutex
	done       chan struct{} // closed on session exit to stop state poller
	pollerDone chan struct{} // closed when the state poller has exited
}

func (s *session) releaseVT() {
	s.vtOnce.Do(func() {
		_ = s.vt.Close()
	})
}

// State returns a snapshot of the current session state.
func (s *session) State() SessionState {
	s.stateMu.RLock()
	defer s.stateMu.RUnlock()
	return s.state
}

func randomKey() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(buf)
}
