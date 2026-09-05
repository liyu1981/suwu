package graphic

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/jezek/xgb"
	"github.com/coder/websocket"
)

// StreamParams configures a graphic streaming session.
type StreamParams struct {
	Display     string
	Mode        CaptureMode
	WindowTitle string
	FPS         int
	// Width/Height are the client's pane size — used as the initial
	// framebuffer size when a fresh Xvfb has to be started (0 = default).
	Width  int
	Height int
}

// HandleStream runs one graphic session over an accepted WebSocket:
// browser → X11 input events on a reader goroutine, X11 → browser JPEG
// frames on a capture ticker. Frames identical to the previous one are
// skipped so a static screen costs no bandwidth.
func HandleStream(ctx context.Context, conn *websocket.Conn, params StreamParams) {
	if params.Display == "" {
		params.Display = ":99"
	}
	if params.FPS <= 0 {
		params.FPS = DefaultFPS
	}
	if params.FPS > MaxFPS {
		params.FPS = MaxFPS
	}

	if err := EnsureDisplay(params.Display, params.Width, params.Height); err != nil {
		slog.Warn("graphic: display not available", "display", params.Display, "error", err)
		_ = conn.Close(websocket.StatusInternalError, err.Error())
		return
	}

	session, err := NewSession(params.Display, params.Mode, params.WindowTitle)
	if err != nil {
		slog.Error("graphic: failed to create session", "display", params.Display, "error", err)
		_ = conn.Close(websocket.StatusInternalError, "failed to start session: "+err.Error())
		return
	}
	defer session.Close()

	// Persistent RANDR connection for the whole session — avoids the
	// connection churn that causes the dummy driver to reset clients.
	resizeConn, err := xgb.NewConnDisplay(params.Display)
	if err != nil {
		slog.Warn("graphic: could not open RANDR connection", "error", err)
	} else {
		defer resizeConn.Close()
	}

	// Desired display size, updated by client resize messages. The periodic
	// tick below re-asserts it: the dummy driver occasionally drops the
	// client mid-resize (connection reset, server survives), so a failed
	// resize is corrected on the next tick rather than leaving the display
	// stale until the user resizes again.
	var sizeMu sync.Mutex
	desiredW, desiredH := params.Width, params.Height
	setDesired := func(w, h int) {
		sizeMu.Lock()
		desiredW, desiredH = w, h
		sizeMu.Unlock()
	}

	// Fit the app window to the display (WM-less geometry management).
	// Best-effort: the window may not exist yet — a periodic tick below
	// retries, so apps launched later get fitted too.
	if err := session.FitWindow(); err != nil {
		slog.Debug("graphic: initial fit failed", "error", err)
	}

	// Reader: browser input events → xdotool. CloseRead stops the library
	// from enforcing its own read side; we drive reads here instead.
	readCtx, cancelRead := context.WithCancel(ctx)
	defer cancelRead()
	go func() {
		defer cancelRead()
		for {
			_, data, err := conn.Read(readCtx)
			if err != nil {
				return
			}
			var event InputEvent
			if json.Unmarshal(data, &event) != nil {
				continue
			}
			if event.Type == "resize" {
				// Client pane changed size — try to grow/shrink the display
				// to match (best-effort; see ResizeDisplay), then re-fit the
				// app window into the new framebuffer. The periodic tick also
				// re-asserts the size, masking the dummy driver's flaky drops.
				setDesired(event.W, event.H)
				if err := ResizeDisplay(params.Display, event.W, event.H, resizeConn); err != nil {
					slog.Warn("graphic: display resize failed (Xvfb has a fixed framebuffer; install xserver-xorg-video-dummy for resizable displays)", "error", err)
				}
				if err := session.FitWindow(); err != nil {
					slog.Debug("graphic: fit after resize failed", "error", err)
				}
				continue
			}
			InjectInput(params.Display, event)
		}
	}()

	// Writer: X11 frames → browser.
	ticker := time.NewTicker(time.Second / time.Duration(params.FPS))
	defer ticker.Stop()
	// Periodic window re-fit: newly launched windows get sized to fill the
	// display, replacing the window manager that Xvfb doesn't have.
	refit := time.NewTicker(5 * time.Second)
	defer refit.Stop()

	var lastFrame []byte
	for {
		select {
		case <-ctx.Done():
			return
		case <-readCtx.Done():
			return
		case <-refit.C:
			sizeMu.Lock()
			w, h := desiredW, desiredH
			sizeMu.Unlock()
			if w > 0 && h > 0 {
				if err := ResizeDisplay(params.Display, w, h, resizeConn); err != nil {
					slog.Debug("graphic: periodic resize failed", "error", err)
				}
			}
			if err := session.FitWindow(); err != nil {
				slog.Debug("graphic: periodic fit failed", "error", err)
			}
			continue
		case <-ticker.C:
			frame, err := session.CaptureFrame()
			if err != nil {
				slog.Debug("graphic: capture error", "error", err)
				continue
			}
			if bytesEqual(frame, lastFrame) {
				continue
			}
			if err := conn.Write(ctx, websocket.MessageBinary, frame); err != nil {
				return
			}
			lastFrame = frame
		}
	}
}

func bytesEqual(a, b []byte) bool {
	return len(a) == len(b) && (len(a) == 0 || string(a) == string(b))
}
