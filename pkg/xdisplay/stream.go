package xdisplay

import (
	"context"
	"encoding/json"
	"fmt"
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

// activeDisplays tracks which displays are currently in use.
// Key is the display string (e.g. ":99"), value is the connection ID.
var activeDisplays = map[string]string{}
var activeDisplaysMu sync.Mutex

// displayReapers tracks cleanup timers for disconnected displays.
// When a display disconnects, a 10-minute timer starts to kill the Xorg.
// If someone reconnects before the timer fires, it's cancelled.
var displayReapers = map[string]*time.Timer{}
const reaperTimeout = 10 * time.Minute

// DisplayInUseError is returned when a display is already connected.
type DisplayInUseError struct {
	Type      string `json:"type"`
	Display   string `json:"display"`
	Connected string `json:"connected"` // connection ID
}

func (e *DisplayInUseError) Error() string {
	return fmt.Sprintf("display %s is already in use", e.Display)
}

// TryAcquireDisplay attempts to register a display as in-use.
// Returns nil if successful, or *DisplayInUseError if already taken.
// Cancels any pending reaper timer for the display.
func TryAcquireDisplay(display, connectionID string) error {
	activeDisplaysMu.Lock()
	defer activeDisplaysMu.Unlock()

	// Cancel any pending reaper — someone is reconnecting.
	if timer, ok := displayReapers[display]; ok {
		timer.Stop()
		delete(displayReapers, display)
		slog.Debug("graphic: reaper cancelled", "display", display)
	}

	if existing, ok := activeDisplays[display]; ok {
		return &DisplayInUseError{Type: "display_in_use", Display: display, Connected: existing}
	}
	activeDisplays[display] = connectionID
	return nil
}

// ReleaseDisplay removes a display from the active map.
// If no more connections remain, starts a reaper timer to kill the Xorg.
func ReleaseDisplay(display, connectionID string) {
	activeDisplaysMu.Lock()
	defer activeDisplaysMu.Unlock()
	// Only release if we own it (prevents stale releases).
	if activeDisplays[display] == connectionID {
		delete(activeDisplays, display)
		startReaper(display)
	}
}

// ListActiveDisplays returns a list of currently active display numbers.
func ListActiveDisplays() []string {
	activeDisplaysMu.Lock()
	defer activeDisplaysMu.Unlock()

	var displays []string
	for display := range activeDisplays {
		// Strip the colon prefix for display number.
		num := display
		if len(num) > 0 && num[0] == ':' {
			num = num[1:]
		}
		displays = append(displays, num)
	}
	return displays
}

// startReaper starts a timer to kill the Xorg after reaperTimeout.
// Must be called with activeDisplaysMu held.
func startReaper(display string) {
	// Cancel existing reaper if any.
	if timer, ok := displayReapers[display]; ok {
		timer.Stop()
	}
	displayReapers[display] = time.AfterFunc(reaperTimeout, func() {
		slog.Info("graphic: reaper killing idle display", "display", display)
		KillDisplay(display)
		activeDisplaysMu.Lock()
		delete(displayReapers, display)
		activeDisplaysMu.Unlock()
	})
	slog.Debug("graphic: reaper started", "display", display, "timeout", reaperTimeout)
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

	// Check system dependencies before attempting to start the display.
	if depErr := CheckDependencies(); depErr != nil {
		slog.Warn("graphic: missing dependencies", "error", depErr)
		data, _ := json.Marshal(depErr)
		_ = conn.Write(ctx, websocket.MessageText, data)
		_ = conn.Close(websocket.StatusPolicyViolation, "missing dependencies")
		return
	}

	// Generate a unique connection ID for this session.
	connectionID := fmt.Sprintf("%p", conn)

	// Try to acquire the display — reject if already in use.
	if err := TryAcquireDisplay(params.Display, connectionID); err != nil {
		slog.Warn("graphic: display in use", "display", params.Display, "error", err)
		data, _ := json.Marshal(err)
		_ = conn.Write(ctx, websocket.MessageText, data)
		_ = conn.Close(websocket.StatusPolicyViolation, "display in use")
		return
	}
	defer ReleaseDisplay(params.Display, connectionID)

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
