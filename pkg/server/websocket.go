package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"

	"suwu/pkg/auth"
	"suwu/pkg/pty"

	"github.com/coder/websocket"
)

var (
	welcomeBanner = "" +
		"\x1b[1;36m╔══════════════════════════════════════════════════════════════╗\x1b[0m\r\n" +
		"\x1b[1;36m║\x1b[0m  \x1b[1;32mWelcome to Suwu!\x1b[0m                                            \x1b[1;36m║\x1b[0m\r\n" +
		"\x1b[1;36m║\x1b[0m                                                              \x1b[1;36m║\x1b[0m\r\n" +
		"\x1b[1;36m║\x1b[0m  You have a real shell session with full PTY support.        \x1b[1;36m║\x1b[0m\r\n" +
		"\x1b[1;36m║\x1b[0m  Try: \x1b[1;33mls\x1b[0m, \x1b[1;33mcd\x1b[0m, \x1b[1;33mtop\x1b[0m, \x1b[1;33mvim\x1b[0m, or any command!                      \x1b[1;36m║\x1b[0m\r\n" +
		"\x1b[1;36m╚══════════════════════════════════════════════════════════════╝\x1b[0m\r\n\r\n"

	// connMu guards the set of active websocket connections for shutdown.
	connMu sync.Mutex
	conns  = make(map[*websocket.Conn]struct{})
)

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cols := atoiDefault(q.Get("cols"), 80)
	rows := atoiDefault(q.Get("rows"), 24)

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

	sess, err := pty.Start(uint16(cols), uint16(rows))
	if err != nil {
		_ = conn.Close(websocket.StatusInternalError, "failed to start shell")
		return
	}
	defer sess.Kill()

	// PTY output is arbitrary bytes (apps may split multi-byte UTF-8 across
	// read boundaries or emit invalid UTF-8), so it must be relayed as binary
	// frames — text frames make browsers abort the connection with "Could not
	// decode a text frame as UTF-8". xterm handles partial sequences itself.
	if err := conn.Write(ctx, websocket.MessageBinary, []byte(welcomeBanner)); err != nil {
		return
	}

	// PTY -> WebSocket.
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 32*1024)
		for {
			n, err := sess.Read(buf)
			if n > 0 {
				if werr := conn.Write(ctx, websocket.MessageBinary, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				break
			}
		}
	}()

	// Wait for shell exit, then send an exit notice and close.
	go func() {
		<-done
		code := sess.Wait()
		msg := "\r\n\x1b[33mShell exited (code: " + strconv.Itoa(code) + ")\x1b[0m\r\n"
		_ = conn.Write(context.Background(), websocket.MessageBinary, []byte(msg))
		_ = conn.Close(websocket.StatusNormalClosure, "shell exited")
	}()

	// WebSocket -> PTY.
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
				_ = sess.Resize(uint16(m.Cols), uint16(m.Rows))
				continue
			}
		}
		_, _ = sess.Write(data)
	}
}

// CloseAll closes every active websocket connection, which in turn kills the
// associated PTY sessions.
func CloseAll() {
	connMu.Lock()
	defer connMu.Unlock()
	for c := range conns {
		_ = c.Close(websocket.StatusGoingAway, "server shutting down")
	}
}
