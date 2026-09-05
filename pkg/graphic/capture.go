// Package graphic streams a remote X11 display (typically a headless Xvfb
// server) to the browser: frames are captured via the X11 protocol, encoded
// as JPEG, and pushed over WebSocket; mouse/keyboard events flow back and
// are injected with xdotool.
package graphic

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"sync"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgbutil"
	"github.com/jezek/xgbutil/ewmh"
	"github.com/jezek/xgbutil/icccm"
	"github.com/jezek/xgbutil/xwindow"
)

// Capture tuning knobs (per the graphic app plan).
const (
	DefaultWidth  = 1280
	DefaultHeight = 720
	DefaultFPS    = 30
	MaxFPS        = 60
	JPEGQuality   = 60
)

// CaptureMode selects what part of the display is captured.
type CaptureMode int

const (
	CaptureFullDesktop CaptureMode = iota
	CaptureSingleWindow
)

// ErrWindowNotFound is returned when single-window capture cannot locate the
// requested window (by WM_CLASS or name).
var ErrWindowNotFound = errors.New("window not found")

// Session holds one graphic-streaming session: a connection to the X display
// plus the capture target (a single window or the full desktop).
type Session struct {
	X           *xgbutil.XUtil
	display     string
	mode        CaptureMode
	windowTitle string

	// mu guards the target-window cache below; xgb's connection itself is
	// goroutine-safe but these fields are touched from both the input and
	// the capture loops.
	mu        sync.Mutex
	windowID  xproto.Window
	lastPick  time.Time
}

// repickInterval bounds how often the auto-picked target is re-evaluated
// (new windows appear / old ones close); pinned titles re-find only on error.
const repickInterval = time.Second

// NewSession connects to the X display and prepares the capture target.
// In single-window mode with a title the target is looked up by WM_CLASS
// instance/class or by name (EWMH first, plain QueryTree walk as fallback
// when no window manager is running, which is the norm on Xvfb). With an
// empty title the largest mapped top-level window is picked dynamically —
// falling back to the full desktop while no app window exists.
func NewSession(display string, mode CaptureMode, windowTitle string) (*Session, error) {
	xu, err := xgbutil.NewConnDisplay(display)
	if err != nil {
		return nil, err
	}

	s := &Session{
		X:           xu,
		display:     display,
		mode:        mode,
		windowTitle: windowTitle,
	}

	if mode == CaptureSingleWindow && windowTitle != "" {
		if err := s.findTargetWindow(); err != nil {
			return nil, err
		}
	}

	return s, nil
}

// findTargetWindow locates the capture target by WM_CLASS (instance or
// class) or by window name (_NET_WM_NAME, then WM_NAME).
func (s *Session) findTargetWindow() error {
	if ids, err := ewmh.ClientListGet(s.X); err == nil {
		for _, id := range ids {
			if s.matchesWindow(id) {
				s.windowID = id
				return nil
			}
		}
	}
	// No EWMH support (no window manager) — walk the window tree.
	return s.findWindowByTree()
}

// findWindowByTree walks the root window's children looking for the target.
func (s *Session) findWindowByTree() error {
	setup := xproto.Setup(s.X.Conn())
	screen := setup.DefaultScreen(s.X.Conn())

	tree, err := xproto.QueryTree(s.X.Conn(), screen.Root).Reply()
	if err != nil {
		return err
	}

	for _, id := range tree.Children {
		if s.matchesWindow(id) {
			s.windowID = id
			return nil
		}
	}
	return ErrWindowNotFound
}

// matchesWindow reports whether the window's class or name equals the
// session's window title.
func (s *Session) matchesWindow(id xproto.Window) bool {
	if class, err := icccm.WmClassGet(s.X, id); err == nil && class != nil {
		if class.Instance == s.windowTitle || class.Class == s.windowTitle {
			return true
		}
	}
	if name, err := ewmh.WmNameGet(s.X, id); err == nil && name == s.windowTitle {
		return true
	}
	if name, err := icccm.WmNameGet(s.X, id); err == nil && name == s.windowTitle {
		return true
	}
	return false
}

// refreshTarget re-evaluates the capture target if the cache is stale and
// returns the window id (0 = none found).
func (s *Session) refreshTarget(force bool) xproto.Window {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !force && s.windowID != 0 && time.Since(s.lastPick) < repickInterval {
		return s.windowID
	}
	s.lastPick = time.Now()
	if s.windowTitle != "" {
		// Pinned target: re-find by title.
		if err := s.findTargetWindow(); err != nil {
			s.windowID = 0
		}
		return s.windowID
	}
	// Auto: largest mapped top-level window.
	s.windowID = s.findLargestWindow()
	return s.windowID
}

// invalidateTarget drops the cached target (window closed, geometry gone).
func (s *Session) invalidateTarget() {
	s.mu.Lock()
	s.windowID = 0
	s.mu.Unlock()
}

// findLargestWindow scans the root's mapped, non-override-redirect children
// and returns the one with the largest area (the "main" app window on a
// WM-less Xvfb display).
func (s *Session) findLargestWindow() xproto.Window {
	conn := s.X.Conn()
	setup := xproto.Setup(conn)
	root := setup.DefaultScreen(conn).Root

	tree, err := xproto.QueryTree(conn, root).Reply()
	if err != nil {
		return 0
	}

	var best xproto.Window
	var bestArea int
	for _, id := range tree.Children {
		attrs, err := xproto.GetWindowAttributes(conn, id).Reply()
		if err != nil || attrs.OverrideRedirect || attrs.MapState != xproto.MapStateViewable {
			continue
		}
		geom, err := xproto.GetGeometry(conn, xproto.Drawable(id)).Reply()
		if err != nil {
			continue
		}
		if area := int(geom.Width) * int(geom.Height); area > bestArea {
			bestArea = area
			best = id
		}
	}
	return best
}

// liveRootGeometry queries the X server for the current root window
// geometry — unlike xproto.Setup() which caches values from the initial
// handshake and never updates after SetScreenSize.
func liveRootGeometry(conn *xgb.Conn) (xproto.Drawable, uint16, uint16, error) {
	setup := xproto.Setup(conn)
	root := setup.DefaultScreen(conn).Root
	g, err := xproto.GetGeometry(conn, xproto.Drawable(root)).Reply()
	if err != nil {
		return 0, 0, 0, err
	}
	return xproto.Drawable(root), g.Width, g.Height, nil
}

// TargetGeometry returns the capture region for the current mode. In
// single-window mode the target is picked dynamically (pinned title or
// largest window) and falls back to the full desktop when no window is
// available — so the stream always has something to show.
func (s *Session) TargetGeometry() (xproto.Drawable, uint16, uint16, error) {
	fallback := func() (xproto.Drawable, uint16, uint16, error) {
		return liveRootGeometry(s.X.Conn())
	}

	if s.mode != CaptureSingleWindow {
		return fallback()
	}

	// Two attempts: on the second, force a fresh pick (the cached window
	// may have been closed).
	for attempt := 0; attempt < 2; attempt++ {
		id := s.refreshTarget(attempt > 0)
		if id == 0 {
			break
		}
		geom, err := xwindow.New(s.X, id).DecorGeometry()
		if err != nil {
			s.invalidateTarget()
			continue
		}
		w, h := geom.Width(), geom.Height()
		if w <= 0 || h <= 0 {
			s.invalidateTarget()
			continue
		}
		return xproto.Drawable(id), uint16(w), uint16(h), nil
	}
	return fallback()
}

// FitWindow resizes and moves the current target window to fill the entire
// display — standing in for the missing window manager. Without this, apps
// keep their launch-time geometry and the display's root shows around them.
// Called on session start, on client resizes, and periodically, so newly
// launched windows get fitted too. Apps reflow their content on resize.
func (s *Session) FitWindow() error {
	conn := s.X.Conn()

	id := s.refreshTarget(true)
	if id == 0 {
		return nil // nothing to fit yet — the periodic tick will retry
	}

	// Query the live display size (not the stale cached setup).
	_, dw, dh, err := liveRootGeometry(conn)
	if err != nil {
		return err
	}

	mask := uint32(xproto.ConfigWindowX | xproto.ConfigWindowY |
		xproto.ConfigWindowWidth | xproto.ConfigWindowHeight)
	vals := []uint32{
		0, 0,
		uint32(dw), uint32(dh),
	}
	return xproto.ConfigureWindowChecked(conn, id, uint16(mask), vals).Check()
}

// CaptureFrame grabs one frame from the X server and returns JPEG bytes.
// X11 ZPixmap pixels arrive in server byte order (BGRX on little-endian
// servers); rows are padded to 32-bit boundaries and must be copied with
// the real stride. The alpha byte is meaningless at depth 24 and forced
// to 255.
func (s *Session) CaptureFrame() ([]byte, error) {
	setup := xproto.Setup(s.X.Conn())

	// Capture with one automatic retry: a resize happening between
	// TargetGeometry and GetImage causes a transient BadMatch that
	// resolves on the next attempt with fresh geometry.
	for attempt := 0; attempt < 2; attempt++ {
		drawable, width, height, err := s.TargetGeometry()
		if err != nil {
			return nil, err
		}

		reply, err := xproto.GetImage(s.X.Conn(), xproto.ImageFormatZPixmap,
			drawable, 0, 0, width, height, 0xffffffff).Reply()
		if err != nil {
			continue // retry with fresh geometry
		}

		srcStride := ((int(width) * 4) + 3) &^ 3 // rows padded to 32 bits
		dstStride := int(width) * 4
		pix := make([]byte, dstStride*int(height))

		lsbFirst := setup.ImageByteOrder == xproto.ImageOrderLSBFirst
		for y := 0; y < int(height); y++ {
			src := reply.Data[y*srcStride : y*srcStride+dstStride]
			dst := pix[y*dstStride : (y+1)*dstStride]
			for x := 0; x < dstStride; x += 4 {
				b0, b1, b2 := src[x], src[x+1], src[x+2]
				if lsbFirst {
					dst[x], dst[x+1], dst[x+2] = b2, b1, b0
				} else {
					dst[x], dst[x+1], dst[x+2] = b1, b2, src[x+3]
				}
				dst[x+3] = 255
			}
		}

		img := &image.RGBA{
			Pix:    pix,
			Stride: dstStride,
			Rect:   image.Rect(0, 0, int(width), int(height)),
		}

		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: JPEGQuality}); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	}
	return nil, fmt.Errorf("capture failed after retry")
}

// Close releases the X connection.
func (s *Session) Close() {
	if s.X != nil {
		s.X.Conn().Close()
	}
}
