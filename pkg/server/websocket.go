package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"suwu/pkg/auth"

	"github.com/coder/websocket"
)

var (
	connMu sync.Mutex
	conns  = make(map[*websocket.Conn]struct{})
)

const (
	defaultWSCols = 80
	defaultWSRows = 24
	maxWSCols     = 4096
	maxWSRows     = 4096

	// maxInputFrame bounds a single input frame.
	//
	// A browser paste arrives as one xterm onData event, so the whole payload —
	// a 92 KB log file, say — lands in one WebSocket frame. coder/websocket's
	// default read limit is 32 KiB, and past it the library closes the
	// connection with StatusMessageTooBig; the browser reports that as a lost
	// connection and reattaches, losing the paste (and anything typed
	// afterwards). The client chunks its input (lib/wsChunks.ts), so this is
	// the backstop for clients that do not, and the ceiling on what one
	// attachment may ask the server to buffer.
	maxInputFrame = 4 << 20
)

// wsWriteTimeout bounds a single WebSocket write.
//
// The request context of a hijacked connection is never cancelled when the peer
// disappears, so an unbounded Write parks the goroutine that owns the socket —
// and with it the fd — for as long as the peer keeps the socket open without
// reading. cloudflared does exactly this when it drops a tunnel connection
// (see docs/MEMORY_GROWTH_INVESTIGATION.md §5), so every write that can outlive
// a request must carry its own deadline.
const wsWriteTimeout = 15 * time.Second

// writeWS writes one frame with a deadline, so a stuck peer cannot pin the
// handler that owns the connection.
func writeWS(ctx context.Context, conn *websocket.Conn, mt websocket.MessageType, data []byte) error {
	wctx, cancel := context.WithTimeout(ctx, wsWriteTimeout)
	defer cancel()
	return conn.Write(wctx, mt, data)
}

func wsDimension(value, fallback, maximum int) uint16 {
	if value <= 0 {
		value = fallback
	}
	if value > maximum {
		value = maximum
	}
	return uint16(value)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cols := wsDimension(atoiDefault(q.Get("cols"), defaultWSCols), defaultWSCols, maxWSCols)
	rows := wsDimension(atoiDefault(q.Get("rows"), defaultWSRows), defaultWSRows, maxWSRows)
	key := q.Get("session")
	cwd := q.Get("cwd")

	slog.Debug("ws connect", "cols", cols, "rows", rows, "session", key, "cwd", cwd)

	d := auth.ValidateWebSocketRequest(s.cfg, r.Host, r.Header.Get("Origin"), q.Get("token"))
	if !d.OK {
		// A rejected WebSocket is invisible in the browser (the API gives the
		// page no access to the handshake's response), so it is worth a line in
		// the log: "the terminal keeps connecting" is otherwise a mystery. The
		// usual cause is a reverse-proxy hostname missing from EXTRA_HOSTS.
		slog.Warn("websocket rejected", "host", r.Host, "origin", r.Header.Get("Origin"),
			"status", d.Status, "reason", d.Reason)
		writePlain(w, d.Status, d.Reason)
		return
	}
	s.clients.Touch(r.RemoteAddr)

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusInternalError, "")
	conn.SetReadLimit(maxInputFrame)

	connMu.Lock()
	conns[conn] = struct{}{}
	connMu.Unlock()
	defer func() {
		connMu.Lock()
		delete(conns, conn)
		connMu.Unlock()
	}()

	ctx := r.Context()

	client, snapshot, created, err := s.sessions.Attach(key, cols, rows, cwd)
	if err != nil {
		_ = conn.Close(websocket.StatusInternalError, "failed to start shell")
		return
	}
	defer client.Detach()

	// The browser must treat the xterm instance as disposable. It may not send
	// input until the attach metadata, snapshot, and ready message have all
	// been delivered and the client attachment has been activated below.
	attachInfo, _ := json.Marshal(map[string]interface{}{
		"type":       "attach",
		"created":    created,
		"snapshot":   len(snapshot) > 0,
		"attachment": client.AttachmentID(),
		"cols":       cols,
		"rows":       rows,
	})
	if werr := writeWS(ctx, conn, websocket.MessageText, attachInfo); werr != nil {
		return
	}

	if len(snapshot) > 0 {
		if werr := writeWS(ctx, conn, websocket.MessageBinary, snapshot); werr != nil {
			return
		}
	}

	readyInfo, _ := json.Marshal(map[string]interface{}{
		"type":       "ready",
		"attachment": client.AttachmentID(),
		"input":      false,
	})
	if werr := writeWS(ctx, conn, websocket.MessageText, readyInfo); werr != nil {
		return
	}
	// The browser acknowledges the ready message after it has applied the
	// snapshot. Until that acknowledgement, Client.Write and Client.Resize
	// reject all input from this attachment.

	// Session PTY -> WebSocket. The frame writer starts only after the full
	// attach/snapshot/ready prefix, so live output cannot overtake the replay.
	go func() {
		for data := range client.Frames() {
			// PTY output is arbitrary bytes, so it must remain binary all the way
			// to the browser. The browser xterm accepts Uint8Array directly.
			if werr := writeWS(ctx, conn, websocket.MessageBinary, data); werr != nil {
				return
			}
		}
		_ = conn.Close(websocket.StatusNormalClosure, "session detached")
	}()

	// WebSocket -> Session PTY. Client.Write and Client.Resize enforce both
	// attachment ownership and ready state, so stale sockets are harmless.
	for {
		mt, data, err := conn.Read(ctx)
		if err != nil {
			// A connection that ends for an unexpected reason is worth a line at
			// Warn: "the terminal reconnected" is the visible symptom of a
			// protocol or size problem (see maxInputFrame and
			// docs/TERM_INPUT_LIMITS.md). A clean close stays at Debug.
			status := websocket.CloseStatus(err)
			if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway || status < 0 {
				slog.Debug("ws read ended", "session", key, "error", err)
			} else {
				slog.Warn("ws read ended", "session", key, "status", status, "error", err)
			}
			return
		}
		if mt != websocket.MessageText && mt != websocket.MessageBinary {
			continue
		}
		if len(data) > 0 && data[0] == '{' {
			var msg struct {
				Type string `json:"type"`
				Cols int    `json:"cols"`
				Rows int    `json:"rows"`
			}
			if json.Unmarshal(data, &msg) == nil {
				if msg.Type == "ping" {
					// Piggyback session state on pong response.
					resp := map[string]any{"type": "pong"}
					if state, ok := s.sessions.State(key); ok {
						resp["state"] = state
					}
					if jsonData, err := json.Marshal(resp); err == nil {
						_ = writeWS(ctx, conn, websocket.MessageText, jsonData)
					}
					continue
				}
				if msg.Type == "resize" {
					client.Resize(wsDimension(msg.Cols, int(cols), maxWSCols), wsDimension(msg.Rows, int(rows), maxWSRows))
					continue
				}
				if msg.Type == "refresh" {
					// Ask the foreground app to repaint at its current size so a
					// client that just wiped its terminal (term.reset) rebuilds.
					client.Refresh()
					continue
				}
				if msg.Type == "ready" {
					client.Activate()
					continue
				}
			}
		}
		client.Write(data)
	}
}

// ConnCount reports how many WebSocket connections this process is serving:
// terminal panes, notification subscribers and X display streams. Diagnostics
// only, and the number to watch when a deployment leaks connections (the fd
// leak of docs/MEMORY_GROWTH_INVESTIGATION.md §5 showed up as thousands).
func ConnCount() int {
	connMu.Lock()
	defer connMu.Unlock()
	return len(conns)
}

// CloseAll closes every active websocket connection, which detaches the
// associated session clients. Sessions themselves live in the Manager until
// their normal idle TTL expires.
func CloseAll() {
	connMu.Lock()
	defer connMu.Unlock()
	for c := range conns {
		_ = c.Close(websocket.StatusGoingAway, "server shutting down")
	}
}
