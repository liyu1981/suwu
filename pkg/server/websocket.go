package server

import (
	"encoding/json"
	"net/http"
	"sync"

	"suwu/pkg/auth"

	"github.com/coder/websocket"
)

// connMu guards the set of active websocket connections for shutdown.
var (
	connMu sync.Mutex
	conns  = make(map[*websocket.Conn]struct{})
)

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cols := atoiDefault(q.Get("cols"), 80)
	rows := atoiDefault(q.Get("rows"), 24)
	// Opaque reattach key. The tiling WM passes its stable pane id, so a
	// page refresh reattaches to the same shell instead of spawning a new
	// one; an empty key gets a fresh random one.
	key := q.Get("session")

	d := auth.ValidateWebSocketRequest(s.cfg, r.Host, r.Header.Get("Origin"), q.Get("token"))
	if !d.OK {
		writePlain(w, d.Status, d.Reason)
		return
	}

	// Origin and host were already validated; skip the library's own origin
	// check so our auth logic remains authoritative.
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

	client, snapshot, err := s.sessions.Attach(key, uint16(cols), uint16(rows))
	if err != nil {
		_ = conn.Close(websocket.StatusInternalError, "failed to start shell")
		return
	}
	defer client.Detach()

	// Reattach: replay the emulator's current screen state before live
	// frames so a refreshed page resumes where it left off. The attach
	// registered us as a subscriber under the same lock the PTY fan-out
	// holds, so nothing can slip between snapshot and live stream.
	if len(snapshot) > 0 {
		if werr := conn.Write(ctx, websocket.MessageBinary, snapshot); werr != nil {
			return
		}
	}

	// Session PTY -> WebSocket. The frames channel closes when the shell
	// exits (exit notice is the final frame) or the client is dropped.
	go func() {
		for data := range client.Frames() {
			// PTY output is arbitrary bytes (apps may split multi-byte UTF-8
			// across read boundaries or emit invalid UTF-8), so it must be
			// relayed as binary frames — text frames make browsers abort the
			// connection with "Could not decode a text frame as UTF-8".
			// xterm handles partial sequences itself.
			if werr := conn.Write(ctx, websocket.MessageBinary, data); werr != nil {
				return
			}
		}
		_ = conn.Close(websocket.StatusNormalClosure, "shell exited")
	}()

	// WebSocket -> Session PTY.
	for {
		mt, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if mt != websocket.MessageText && mt != websocket.MessageBinary {
			continue
		}
		if len(data) > 0 && data[0] == '{' {
			var m struct {
				Type string `json:"type"`
				Cols int    `json:"cols"`
				Rows int    `json:"rows"`
			}
			if json.Unmarshal(data, &m) == nil && m.Type == "resize" {
				client.Resize(uint16(m.Cols), uint16(m.Rows))
				continue
			}
		}
		client.Write(data)
	}
}

// CloseAll closes every active websocket connection, which detaches the
// associated session clients (sessions themselves live in the Manager).
func CloseAll() {
	connMu.Lock()
	defer connMu.Unlock()
	for c := range conns {
		_ = c.Close(websocket.StatusGoingAway, "server shutting down")
	}
}
