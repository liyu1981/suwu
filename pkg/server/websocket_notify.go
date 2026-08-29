package server

import (
	"encoding/json"
	"net/http"

	"suwu/pkg/auth"

	"github.com/coder/websocket"
)

// handleNotifyWS upgrades the request to a WebSocket and streams
// Notification messages from the notify listener to the client. Messages
// are JSON text frames: {"id":"...","message":"...","timestamp":...}
func (s *Server) handleNotifyWS(w http.ResponseWriter, r *http.Request) {
	d := auth.ValidateWebSocketRequest(s.cfg, r.Host, r.Header.Get("Origin"), r.URL.Query().Get("token"))
	if !d.OK {
		writePlain(w, d.Status, d.Reason)
		return
	}

	if s.notify == nil {
		writePlain(w, http.StatusServiceUnavailable, "notifications not available")
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

	ch := s.notify.Subscribe()
	defer s.notify.Unsubscribe(ch)

	ctx := r.Context()
	for n := range ch {
		data, err := json.Marshal(n)
		if err != nil {
			continue
		}
		if werr := conn.Write(ctx, websocket.MessageText, data); werr != nil {
			return
		}
	}
	_ = conn.Close(websocket.StatusNormalClosure, "notifications closed")
}
