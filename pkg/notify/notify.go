// Package notify implements a lightweight notification hub: a Unix domain
// socket accepts one-shot messages from CLI clients (suwu ping) and fans
// them out to connected WebSocket subscribers (the browser frontend).
// It also supports request-response commands (suwu forward).
package notify

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Notification is a single message flowing through the hub.
type Notification struct {
	ID        string          `json:"id"`
	Message   string          `json:"message"`
	Data      json.RawMessage `json:"data,omitempty"`
	Timestamp int64           `json:"timestamp"`
}

// Command is a request-response message from CLI to server.
type Command struct {
	Action   string          `json:"action"`
	Payload  json.RawMessage `json:"payload,omitempty"`
}

// CommandResponse is the server's reply to a Command.
type CommandResponse struct {
	OK      bool            `json:"ok"`
	Error   string          `json:"error,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
	Message string          `json:"message,omitempty"`
	ID      string          `json:"id,omitempty"`
}

// CommandHandler processes a Command and returns a response.
type CommandHandler func(cmd Command) CommandResponse

// sub pairs a bidirectional channel (for sending/closing) with its
// receive-only view (returned to callers).
type sub struct {
	ch  chan Notification
	out <-chan Notification
}

// Listener is the notification hub. It listens on a Unix domain socket for
// incoming messages and broadcasts them to all subscribed WebSocket handlers.
type Listener struct {
	sockPath string
	listener net.Listener
	mu       sync.Mutex
	subs     map[*sub]struct{}
	done     chan struct{}
	handlers map[string]CommandHandler
}

// SocketPath returns the Unix socket path. Resolution:
//  1. SUWU_SOCK_PATH env var (explicit path)
//  2. ~/.suwu/suwu.sock (same directory as logs)
func SocketPath() (string, error) {
	if p := os.Getenv("SUWU_SOCK_PATH"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home dir: %w", err)
	}
	return filepath.Join(home, ".suwu", "suwu.sock"), nil
}

// NewListener creates a Listener on the given socket path. It removes any
// stale socket file, starts accepting connections, and returns. The caller
// must call Close() when done.
func NewListener(socketPath string) (*Listener, error) {
	slog.Debug("notify listener", "socket", socketPath)
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return nil, fmt.Errorf("notify: mkdir: %w", err)
	}
	// Remove stale socket from a previous unclean shutdown.
	_ = os.Remove(socketPath)

	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("notify: listen %s: %w", socketPath, err)
	}

	l := &Listener{
		sockPath: socketPath,
		listener: ln,
		subs:     make(map[*sub]struct{}),
		done:     make(chan struct{}),
		handlers: make(map[string]CommandHandler),
	}
	go l.acceptLoop()
	return l, nil
}

// acceptLoop handles incoming Unix socket connections. Each connection sends
// a single newline-terminated message line.
func (l *Listener) acceptLoop() {
	defer close(l.done)
	for {
		conn, err := l.listener.Accept()
		if err != nil {
			// Listener was closed.
			return
		}
		go l.handleConn(conn)
	}
}

func (l *Listener) handleConn(conn net.Conn) {
	defer conn.Close()
	scanner := bufio.NewScanner(conn)
	// Limit message to 64 KiB — generous for a notification.
	scanner.Buffer(make([]byte, 0, 256), 64*1024)
	for scanner.Scan() {
		raw := scanner.Text()
		if raw == "" {
			continue
		}

		// Try to parse as a Command (request-response pattern).
		var cmd Command
		if err := json.Unmarshal([]byte(raw), &cmd); err == nil && cmd.Action != "" {
			resp := l.handleCommand(cmd)
			data, _ := json.Marshal(resp)
			data = append(data, '\n')
			conn.Write(data)
			return // command connections are single-request
		}

		// Try to parse as a full Notification JSON (used by `suwu open`).
		// Falls back to treating the raw text as a plain message string.
		var n Notification
		if err := json.Unmarshal([]byte(raw), &n); err == nil && (n.Message != "" || n.Data != nil) {
			if n.ID == "" {
				n.ID = randomID()
			}
			if n.Timestamp == 0 {
				n.Timestamp = time.Now().UnixMilli()
			}
			l.broadcast(n)
			continue
		}

		l.broadcast(Notification{
			ID:        randomID(),
			Message:   raw,
			Timestamp: time.Now().UnixMilli(),
		})
	}
}

func (l *Listener) handleCommand(cmd Command) CommandResponse {
	l.mu.Lock()
	handler, ok := l.handlers[cmd.Action]
	l.mu.Unlock()

	if !ok {
		return CommandResponse{OK: false, Error: fmt.Sprintf("unknown action: %s", cmd.Action)}
	}

	return handler(cmd)
}

func (l *Listener) broadcast(n Notification) {
	slog.Debug("notify broadcast", "id", n.ID, "message", n.Message, "subscribers", len(l.subs))
	l.mu.Lock()
	defer l.mu.Unlock()
	for s := range l.subs {
		select {
		case s.ch <- n:
		default:
			// Slow subscriber — drop the message rather than blocking.
		}
	}
}

// Broadcast sends a Notification to all subscribers. Used by command
// handlers (e.g. forward-start) that want to surface an action to the UI.
func (l *Listener) Broadcast(n Notification) {
	l.broadcast(n)
}

// Subscribe returns a channel that receives every Notification. The channel
// has a small buffer; slow subscribers miss messages (non-blocking send).
func (l *Listener) Subscribe() <-chan Notification {
	ch := make(chan Notification, 32)
	s := &sub{ch: ch, out: ch}
	l.mu.Lock()
	l.subs[s] = struct{}{}
	l.mu.Unlock()
	return s.out
}

// Unsubscribe removes a channel returned by Subscribe and closes it.
func (l *Listener) Unsubscribe(out <-chan Notification) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for s := range l.subs {
		if s.out == out {
			delete(l.subs, s)
			close(s.ch)
			return
		}
	}
}

// RegisterHandler registers a handler for a command action.
func (l *Listener) RegisterHandler(action string, handler CommandHandler) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.handlers[action] = handler
}

// Close shuts down the listener, removes the socket file, and closes all
// subscriber channels.
func (l *Listener) Close() error {
	err := l.listener.Close()
	<-l.done // wait for acceptLoop to exit
	_ = os.Remove(l.sockPath)

	l.mu.Lock()
	for s := range l.subs {
		close(s.ch)
	}
	l.subs = make(map[*sub]struct{})
	l.mu.Unlock()

	return err
}

func randomID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
