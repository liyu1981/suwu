package server

import (
	"log/slog"
	"net/http"
	"strconv"

	"suwu/pkg/auth"
	"suwu/pkg/graphic"

	"github.com/coder/websocket"
)

// handleGraphicWS handles GET /ws/graphic — streams a remote X11 display
// (usually a headless Xvfb framebuffer) to the browser and injects the
// browser's mouse/keyboard events back into the display.
func (s *Server) handleGraphicWS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writePlain(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	q := r.URL.Query()
	params := graphic.StreamParams{
		Display:     q.Get("display"),
		WindowTitle: q.Get("title"),
	}
	if params.Display == "" {
		params.Display = ":99"
	}
	// Default: capture the full desktop so composited overlays (popup menus,
	// tooltips) are visible. desktop=0 also uses full desktop; this is the
	// only mode that works correctly with a compositor like picom.
	// Single-window mode (desktop=1) captures the window directly and misses
	// override-redirect overlays like Chromium's burger menu.
	params.Mode = graphic.CaptureFullDesktop
	if q.Get("desktop") == "0" {
		params.Mode = graphic.CaptureFullDesktop
	}
	if fps, err := strconv.Atoi(q.Get("fps")); err == nil && fps > 0 {
		params.FPS = fps
	}
	if w, err := strconv.Atoi(q.Get("w")); err == nil && w > 0 {
		params.Width = w
	}
	if h, err := strconv.Atoi(q.Get("h")); err == nil && h > 0 {
		params.Height = h
	}

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

	connMu.Lock()
	conns[conn] = struct{}{}
	connMu.Unlock()
	defer func() {
		connMu.Lock()
		delete(conns, conn)
		connMu.Unlock()
	}()
	defer conn.Close(websocket.StatusInternalError, "")

	slog.Debug("graphic stream", "display", params.Display, "title", params.WindowTitle, "fps", params.FPS)
	graphic.HandleStream(r.Context(), conn, params)
}
