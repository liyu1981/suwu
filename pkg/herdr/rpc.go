package herdr

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// CallTimeout bounds one JSON-RPC request. Starting a shell or reading a screen
// is local work; anything slower means the core is wedged.
const CallTimeout = 10 * time.Second

// Conn is one framed JSON-RPC connection to a core.
type Conn struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	reader *bufio.Reader

	// wmu serialises every frame write: JSON-RPC calls, attach input, credit and
	// close frames all share one pipe, and interleaved bytes corrupt the stream.
	wmu sync.Mutex

	nextID  atomic.Uint64
	pmu     sync.Mutex
	pending map[uint64]chan callReply

	hmu      sync.Mutex
	streams  map[uint32]chan Frame
	onEvent  func([]byte)
	closed   atomic.Bool
	done     chan struct{}
	closeErr error

	// Hello result.
	CoreName string
	Version  string
	Features []string
	Session  string
}

type callReply struct {
	result json.RawMessage
	err    error
}

// ConnOptions configures a core connection.
type ConnOptions struct {
	// Path is the herdr-core binary. Empty means Resolve().
	Path string
	// Session selects a core session (HC_SESSION). Empty means the default one.
	Session string
}

// Dial starts `herdr-core connect` and completes the framed handshake.
func Dial(ctx context.Context, opts ConnOptions) (*Conn, error) {
	path := opts.Path
	if path == "" {
		resolved, err := Resolve()
		if err != nil {
			return nil, err
		}
		path = resolved.Path
	}

	args := []string{"connect"}
	if opts.Session != "" {
		args = append(args, "--session", opts.Session)
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = os.Environ()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	// stderr is diagnostic only: core logs there, and swallowing it keeps a
	// chatty core from filling a pipe nobody reads.
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("herdr: start %s: %w", path, err)
	}

	c := &Conn{
		cmd:     cmd,
		stdin:   stdin,
		reader:  bufio.NewReaderSize(stdout, 64<<10),
		pending: make(map[uint64]chan callReply),
		streams: make(map[uint32]chan Frame),
		done:    make(chan struct{}),
		Session: opts.Session,
	}
	if err := c.handshake(); err != nil {
		_ = c.Close()
		return nil, err
	}
	go c.readLoop()
	return c, nil
}

// newConn builds a Conn over in-memory pipes (tests).
func newConn(rw io.ReadWriter) *Conn {
	c := &Conn{
		stdin:   nopWriteCloser{Writer: rw},
		reader:  bufio.NewReader(rw),
		pending: make(map[uint64]chan callReply),
		streams: make(map[uint32]chan Frame),
		done:    make(chan struct{}),
	}
	go c.readLoop()
	return c
}

type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }

// handshake sends hello in plain mode. Its reply is the last line before the
// connection switches to frames — the core states this explicitly.
func (c *Conn) handshake() error {
	hello := map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "hello",
		"params":  map[string]any{"framed": true, "generation": 1},
	}
	line, err := json.Marshal(hello)
	if err != nil {
		return err
	}
	if _, err := c.stdin.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("herdr: hello: %w", err)
	}

	reply, err := c.reader.ReadBytes('\n')
	if err != nil {
		return fmt.Errorf("herdr: read hello reply: %w", err)
	}
	var msg struct {
		Result struct {
			Core struct {
				Name string `json:"name"`
			} `json:"core"`
			Version  string   `json:"version"`
			Features []string `json:"features"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(reply, &msg); err != nil {
		return fmt.Errorf("herdr: decode hello reply: %w", err)
	}
	if msg.Error != nil {
		return fmt.Errorf("herdr: hello rejected: %s", msg.Error.Message)
	}
	c.CoreName = msg.Result.Core.Name
	c.Version = msg.Result.Version
	c.Features = msg.Result.Features
	return nil
}

func (c *Conn) readLoop() {
	defer close(c.done)
	for {
		f, err := readFrame(c.reader)
		if err != nil {
			c.fail(err)
			return
		}
		if f.Channel == 0 {
			c.handleControl(f.Payload)
			continue
		}
		c.hmu.Lock()
		ch := c.streams[f.Channel]
		c.hmu.Unlock()
		if ch != nil {
			select {
			case ch <- f:
			case <-c.done:
				return
			}
		}
	}
}

// handleControl dispatches a channel-0 DATA frame: a call reply or a
// notification (events arrive this way before subscribe returns its channel).
func (c *Conn) handleControl(payload []byte) {
	var msg struct {
		ID     uint64          `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string          `json:"message"`
			Data    json.RawMessage `json:"data"`
		} `json:"error"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		slog.Debug("herdr: undecodable control frame", "err", err)
		return
	}
	if msg.Method == "event" || msg.Method == "heartbeat" || msg.Method == "missed" {
		c.pmu.Lock()
		handler := c.onEvent
		c.pmu.Unlock()
		if handler != nil {
			handler(payload)
		}
		return
	}
	if msg.ID == 0 {
		return
	}
	c.pmu.Lock()
	waiter := c.pending[msg.ID]
	delete(c.pending, msg.ID)
	c.pmu.Unlock()
	if waiter == nil {
		return
	}
	if msg.Error != nil {
		waiter <- callReply{err: fmt.Errorf("herdr: %s%s", msg.Error.Message, hint(msg.Error.Data))}
		return
	}
	waiter <- callReply{result: msg.Result}
}

func hint(data json.RawMessage) string {
	if len(data) == 0 {
		return ""
	}
	var d struct {
		Hint string `json:"hint"`
		Kind string `json:"kind"`
	}
	if json.Unmarshal(data, &d) != nil || (d.Hint == "" && d.Kind == "") {
		return ""
	}
	if d.Hint != "" {
		return " (" + d.Hint + ")"
	}
	return " (" + d.Kind + ")"
}

// Call performs one JSON-RPC request and decodes its result into out (which may
// be nil).
func (c *Conn) Call(ctx context.Context, method string, params any, out any) error {
	if c.closed.Load() {
		return errClosed
	}
	id := c.nextID.Add(1)
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	})
	if err != nil {
		return err
	}
	reply := make(chan callReply, 1)
	c.pmu.Lock()
	c.pending[id] = reply
	c.pmu.Unlock()

	if err := c.writeFrame(Frame{Channel: 0, Kind: KindData, Payload: body}); err != nil {
		c.pmu.Lock()
		delete(c.pending, id)
		c.pmu.Unlock()
		return fmt.Errorf("herdr: write %s: %w", method, err)
	}

	timer := time.NewTimer(CallTimeout)
	defer timer.Stop()
	select {
	case r := <-reply:
		if r.err != nil {
			return r.err
		}
		if out != nil && len(r.result) > 0 {
			if err := json.Unmarshal(r.result, out); err != nil {
				return fmt.Errorf("herdr: decode %s result: %w", method, err)
			}
		}
		return nil
	case <-timer.C:
		c.pmu.Lock()
		delete(c.pending, id)
		c.pmu.Unlock()
		return fmt.Errorf("herdr: %s timed out", method)
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		return errClosed
	}
}

// SetEventHandler registers the notification callback (one at a time). The
// payload is the raw notification line.
func (c *Conn) SetEventHandler(fn func([]byte)) {
	c.pmu.Lock()
	c.onEvent = fn
	c.pmu.Unlock()
}

// RegisterStream routes frames of one channel to ch.
func (c *Conn) RegisterStream(channel uint32, ch chan Frame) {
	c.hmu.Lock()
	c.streams[channel] = ch
	c.hmu.Unlock()
}

// UnregisterStream stops routing a channel.
func (c *Conn) UnregisterStream(channel uint32) {
	c.hmu.Lock()
	delete(c.streams, channel)
	c.hmu.Unlock()
}

// writeFrame serialises one frame onto the connection.
func (c *Conn) writeFrame(f Frame) error {
	if c.closed.Load() {
		return errClosed
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return writeFrame(c.stdin, f)
}

// writeStreamFrame sends a frame on a stream channel.
func (c *Conn) writeStreamFrame(f Frame) error { return c.writeFrame(f) }

// Done is closed when the connection is gone.
func (c *Conn) Done() <-chan struct{} { return c.done }

// Err reports why the connection ended.
func (c *Conn) Err() error {
	c.pmu.Lock()
	defer c.pmu.Unlock()
	return c.closeErr
}

func (c *Conn) fail(err error) {
	if c.closed.Swap(true) {
		return
	}
	c.pmu.Lock()
	c.closeErr = err
	callbacks := make([]chan callReply, 0, len(c.pending))
	for id, ch := range c.pending {
		callbacks = append(callbacks, ch)
		delete(c.pending, id)
	}
	c.pmu.Unlock()
	for _, ch := range callbacks {
		select {
		case ch <- callReply{err: err}:
		default:
		}
	}
}

// Close ends the connection and the child process.
func (c *Conn) Close() error {
	c.fail(errClosed)
	if c.cmd != nil {
		_ = c.stdin.Close()
		_ = c.cmd.Process.Kill()
		_ = c.cmd.Wait()
	}
	return nil
}

// Stream is one attached terminal channel.
type Stream struct {
	conn     *Conn
	Channel  uint32
	Terminal Terminal

	data   chan []byte
	closed chan struct{}
	reason atomic.Value // string

	creditSent atomic.Int64
	creditMu   sync.Mutex
}

// Attach opens a terminal for viewing at cols×rows. observe makes it read-only.
func (c *Conn) Attach(ctx context.Context, terminal string, cols, rows int, history int, observe bool) (*Stream, error) {
	params := map[string]any{
		"terminal": terminal,
		"cols":     cols,
		"rows":     rows,
		"history":  history,
		"observe":  observe,
	}
	var res struct {
		Channel        uint32   `json:"channel"`
		Terminal       Terminal `json:"terminal"`
		ResizeNotes    bool     `json:"resize_notifications"`
		AutomaticInput bool     `json:"automatic_input"`
	}
	if err := c.Call(ctx, "terminal.attach", params, &res); err != nil {
		return nil, err
	}

	frames := make(chan Frame, 32)
	c.RegisterStream(res.Channel, frames)
	s := &Stream{
		conn:     c,
		Channel:  res.Channel,
		Terminal: res.Terminal,
		data:     make(chan []byte, 64),
		closed:   make(chan struct{}),
	}
	go func() {
		defer close(s.closed)
		defer c.UnregisterStream(res.Channel)
		for f := range frames {
			switch f.Kind {
			case KindData:
				select {
				case s.data <- f.Payload:
				case <-c.done:
					return
				}
			case KindClose:
				s.reason.Store(closeReason(f.Payload))
				_ = s.writeFrame(Frame{Channel: res.Channel, Kind: KindClose})
				return
			case KindResize:
				// The core resized the terminal elsewhere; the pane learns the
				// new grid from the size event in the snapshot.
			}
		}
	}()
	return s, nil
}

func (s *Stream) writeFrame(f Frame) error { return s.conn.writeStreamFrame(f) }

// Data delivers terminal bytes.
func (s *Stream) Data() <-chan []byte { return s.data }

// Closed is closed when the stream ends (detach, program exit, core loss).
func (s *Stream) Closed() <-chan struct{} { return s.closed }

// Reason is the core's close reason, if it sent one.
func (s *Stream) Reason() string {
	if v, ok := s.reason.Load().(string); ok {
		return v
	}
	return ""
}

// Write sends keyboard bytes to the terminal.
func (s *Stream) Write(p []byte) error {
	return s.writeFrame(Frame{Channel: s.Channel, Kind: KindData, Payload: p})
}

// Resize tells the core the viewer's grid.
func (s *Stream) Resize(cols, rows int) error {
	return s.writeFrame(Frame{Channel: s.Channel, Kind: KindResize, Payload: resizePayload(cols, rows)})
}

// Credit acknowledges bytes written out to the browser. Core starts a stream
// with 256 KiB and repaints a viewer that falls 4 MiB behind, so an unacked
// stream degrades to repaints rather than stalling.
func (s *Stream) Credit(n int) {
	if n <= 0 {
		return
	}
	s.creditMu.Lock()
	s.creditSent.Add(int64(n))
	s.creditMu.Unlock()
	_ = s.writeFrame(Frame{Channel: s.Channel, Kind: KindCredit, Payload: creditPayload(n)})
}

// Close detaches without touching the program.
func (s *Stream) Close() error {
	return s.writeFrame(Frame{Channel: s.Channel, Kind: KindClose})
}
