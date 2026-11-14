package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"suwu/pkg/auth"

	"github.com/coder/websocket"
)

// notifyPingInterval is how often the server pings a notification socket.
//
// Two reasons. It gives the handler something to fail on when the peer is gone
// (together with the reader below), and it keeps an otherwise idle WebSocket
// from being reaped by an intermediary: Cloudflare closes idle WebSockets after
// roughly 100 s, and every reap used to leave an orphaned connection behind.
const notifyPingInterval = 30 * time.Second

// handleNotifyWS upgrades the request to a WebSocket and streams
// Notification messages from the notify listener to the client. Messages
// are JSON text frames: {"id":"...","message":"...","timestamp":...}
//
// The server is the only sender, which is exactly why this handler needs a
// reader and a ping: without them it parks on the subscriber channel, notices
// nothing about a peer that goes away, and never runs its deferred Close or
// Unsubscribe. On a tunnel-fronted deployment that leaked one accepted
// connection (and its fd) per abandoned socket — 2244 of them on the ARM box,
// see docs/MEMORY_GROWTH_INVESTIGATION.md §5.
func (s *Server) handleNotifyWS(w http.ResponseWriter, r *http.Request) {
	d := auth.ValidateWebSocketRequest(s.cfg, r.Host, r.Header.Get("Origin"), r.URL.Query().Get("token"))
	if !d.OK {
		writePlain(w, d.Status, d.Reason)
		return
	}
	s.clients.Touch(r.RemoteAddr)

	if s.notify == nil {
		writePlain(w, http.StatusServiceUnavailable, "notifications not available")
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	// Closing here is what releases the fd; every return path below reaches it.
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

	// Liveness. readCtx is cancelled when the peer closes the socket (Read
	// returns an error) or when the request context ends, and the loop below
	// selects on it, so the handler cannot outlive its client.
	readCtx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		defer cancel()
		for {
			if _, _, err := conn.Read(readCtx); err != nil {
				return
			}
		}
	}()

	ping := time.NewTicker(notifyPingInterval)
	defer ping.Stop()

	for {
		select {
		case <-readCtx.Done():
			return
		case <-ping.C:
			pctx, pcancel := context.WithTimeout(readCtx, wsWriteTimeout)
			err := conn.Ping(pctx)
			pcancel()
			if err != nil {
				return
			}
		case n, ok := <-ch:
			if !ok {
				// The listener closed (shutdown): say so politely, then let the
				// deferred Close release the fd.
				_ = conn.Close(websocket.StatusNormalClosure, "notifications closed")
				return
			}
			data, err := json.Marshal(n)
			if err != nil {
				continue
			}
			if err := writeWS(readCtx, conn, websocket.MessageText, data); err != nil {
				return
			}
		}
	}
}
