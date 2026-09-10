package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"

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
)

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
		writePlain(w, d.Status, d.Reason)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusInternalError, "")

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
	if werr := conn.Write(ctx, websocket.MessageText, attachInfo); werr != nil {
		return
	}

	if len(snapshot) > 0 {
		if werr := conn.Write(ctx, websocket.MessageBinary, snapshot); werr != nil {
			return
		}
	}

	readyInfo, _ := json.Marshal(map[string]interface{}{
		"type":       "ready",
		"attachment": client.AttachmentID(),
		"input":      false,
	})
	if werr := conn.Write(ctx, websocket.MessageText, readyInfo); werr != nil {
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
			if werr := conn.Write(ctx, websocket.MessageBinary, data); werr != nil {
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
				if msg.Type == "resize" {
					client.Resize(wsDimension(msg.Cols, int(cols), maxWSCols), wsDimension(msg.Rows, int(rows), maxWSRows))
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
