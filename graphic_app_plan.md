# Graphic App Streaming Plan — Revised

> **Status**: Revised after investigation. See [XGB Investigation](#xgb-investigation) for findings.

## Overview

This plan captures the screen from a headless Xvfb server, compresses each frame as a JPEG, and streams it via WebSocket to an HTML5 canvas in the browser. Mouse/keyboard events are sent back and injected into the X11 display using `xdotool`.

### Capture Modes

| Mode | Description | Pros | Cons |
|------|-------------|------|------|
| **Full Desktop** | Capture root window (`screen.Root`) | Simple, always works, no WM needed | New windows obscure old ones |
| **Single Window** | Find target by WM_CLASS/title, capture that window | Stable, immune to window overlap | Needs window discovery logic |

**Recommendation**: Start with full desktop capture. Optimize to single window if needed.

### ⚠️ Known Issue: New Window Obscuring

When capturing the full desktop (root window), if a new Chrome window opens (not a new tab), it appears on top and obscures the original window:

```
Before new window:          After new window:
┌─────────────────┐        ┌─────────────────┐
│                  │        │  New Chrome Win  │  ← You see this
│   Chrome (FS)    │   →    │  (overlaid)      │
│                  │        ├─────────────────┤
│                  │        │  Old Chrome (FS) │  ← Hidden underneath
└─────────────────┘        └─────────────────┘
```

**Mitigations**:
1. Launch Chrome with `--new-window` to force URLs into tabs
2. Implement single-window capture (see below)
3. Accept the behavior (new window is usually what you want anyway)

---

## Part 1: The Remote Linux Server Setup

```bash
# 1. Install Xvfb and basic X11 utilities
sudo apt-get update
sudo apt-get install -y xvfb xdotool

# 2. Start the headless virtual frame buffer on display port :99
# Resolution: 1280x720 with 24-bit true color
Xvfb :99 -screen 0 1280x720x24 &

# 3. Launch your target app inside this hidden display environment
# Use --new-window to force all URLs into tabs (avoids new window obscuring)
DISPLAY=:99 google-chrome --new-window --no-first-run --disable-gpu http://localhost:3000 &
```

---

## Part 2: XGB Investigation — The Right Library for Linux

### Problem with `kbinani/screenshot`

The original plan used `github.com/kbinani/screenshot`. This library:
- Relies on `lxn/win` on Windows, C-bindings on macOS
- On Linux, expects a real Xorg desktop — **fails on headless Xvfb**
- Often returns blank frames or compilation errors in virtual display contexts

### Solution: XGB (X Go Binding)

**`github.com/jezek/xgb`** — Pure Go implementation of the X11 protocol.

| Metric | Value |
|--------|-------|
| Stars | 182 |
| Forks | 15 |
| Open Issues | 0 |
| Last Push | 2026-04-18 (actively maintained) |
| Go Version | go 1.11+ |
| License | BSD-style |
| CGo | No (pure Go) |

**Why XGB is correct**:
- Communicates directly with Xvfb over Unix socket (`/tmp/.X11-unix/X99`)
- No physical display needed — perfect for headless environments
- Thread-safe, improves with `GOMAXPROCS > 1`
- Zero external dependencies

### Key Packages

| Package | Purpose |
|---------|---------|
| `github.com/jezek/xgb` | Core connection, authentication, protocol |
| `github.com/jezek/xgb/xproto` | X11 protocol: windows, pixmaps, images, events |
| `github.com/jezek/xgbutil` | Higher-level utilities |
| `github.com/jezek/xgbutil/xgraphics` | Image capture/draw |
| `github.com/jezek/xgbutil/ewmh` | Window manager properties (find windows) |
| `github.com/jezek/xgbutil/icccm` | ICCCM properties (WM_CLASS, WM_NAME) |

### Screen Capture API

**Full desktop capture** (simplest):
```go
// Capture root window — everything visible on the display
reply, err := xproto.GetImage(X, xproto.ImageFormatZPixmap,
    xproto.Drawable(screen.Root),
    0, 0, 1280, 720, 0xffffffff).Reply()
// reply.Data contains raw BGRA pixels
```

**Single window capture** (recommended for stability):
```go
// 1. Find window by WM_CLASS or _NET_WM_NAME
clientIDs, _ := ewmh.ClientListGet(X)
for _, id := range clientIDs {
    class, _ := icccm.WmClassGet(X, id)
    if class.Instance == "chrome" {
        // 2. Get window geometry
        geom, _ := xwindow.New(X, id).DecorGeometry()
        // 3. Capture that specific window
        reply, _ := xproto.GetImage(X, xproto.ImageFormatZPixmap,
            xproto.Drawable(id),
            0, 0, uint16(geom.Width()), uint16(geom.Height()), 0xffffffff).Reply()
    }
}
```

### BGRA Handling

X11 ZPixmap format uses **BGRA** byte order (not RGBA). For JPEG encoding, swap B and R channels:

```go
for i := 0; i < len(reply.Data); i += 4 {
    b := reply.Data[i]
    r := reply.Data[i+2]
    reply.Data[i] = r     // R channel
    reply.Data[i+2] = b   // B channel
    reply.Data[i+3] = 255 // Force full alpha
}
```

### Window Discovery Without a Window Manager

EWMH properties (`_NET_CLIENT_LIST`) require a window manager. Without a WM on Xvfb, use `QueryTree`:

```go
// Walk the window tree manually
tree, _ := xproto.QueryTree(X, screen.Root).Reply()
for _, childID := range tree.Children {
    class, _ := icccm.WmClassGet(X, childID)
    name, _ := icccm.WmNameGet(X, childID)
    // Find Chrome by class/name
}
```

### Compatibility with Suwu

| Aspect | Assessment |
|--------|------------|
| Go module (1.25) | ✅ Works (requires 1.11+) |
| WebSocket lib (`coder/websocket`) | ✅ Independent — no conflict |
| Linux/Xvfb | ✅ Native support |
| No CGo | ✅ Builds anywhere |
| Image format | ⚠️ BGRA → needs swizzling (trivial) |

---

## Part 3: The Go Backend

### Dependencies

```bash
# X11 protocol (core capture)
go get github.com/jezek/xgb

# Higher-level utilities (window discovery, geometry)
go get github.com/jezek/xgbutil

# WebSocket (matching Suwu's existing dependency)
go get github.com/coder/websocket
```

### Architecture

```
pkg/graphic/
  manager.go      # Session management (modeled on pkg/session/)
  capture.go      # X11 screen capture loop
  input.go        # xdotool input injection
  server.go       # WebSocket endpoint handler
```

### Code: Screen Capture Backend

```go
package graphic

import (
    "bytes"
    "image/jpeg"
    "log/slog"
    "time"

    "github.com/coder/websocket"
    "github.com/jezek/xgb"
    "github.com/jezek/xgb/xproto"
    "github.com/jezek/xgbutil"
    "github.com/jezek/xgbutil/ewmh"
    "github.com/jezek/xgbutil/icccm"
    "github.com/jezek/xgbutil/xwindow"
)

const (
    DisplayWidth  = 1280
    DisplayHeight = 720
    FPS           = 30
    JPEGQuality   = 60
)

type CaptureMode int

const (
    CaptureFullDesktop CaptureMode = iota
    CaptureSingleWindow
)

// Session represents a graphic app streaming session
type Session struct {
    conn        *websocket.Conn
    xConn       *xgbutil.XUtil
    display     string
    mode        CaptureMode
    windowTitle string // for single-window mode
    windowID    xproto.Window
}

// NewSession creates a new graphic session connected to Xvfb
func NewSession(display string, mode CaptureMode, windowTitle string) (*Session, error) {
    xu, err := xgbutil.NewConnDisplay(display)
    if err != nil {
        return nil, err
    }

    s := &Session{
        xConn:       xu,
        display:     display,
        mode:        mode,
        windowTitle: windowTitle,
    }

    // If single-window mode, find the target window
    if mode == CaptureSingleWindow && windowTitle != "" {
        if err := s.findTargetWindow(); err != nil {
            slog.Warn("could not find target window, falling back to full desktop", "error", err)
            s.mode = CaptureFullDesktop
        }
    }

    return s, nil
}

// findTargetWindow locates the window by WM_CLASS or _NET_WM_NAME
func (s *Session) findTargetWindow() error {
    clientIDs, err := ewmh.ClientListGet(s.xConn)
    if err != nil {
        // No EWMH support (no window manager) — fall back to QueryTree
        return s.findWindowByTree()
    }

    for _, id := range clientIDs {
        // Check WM_CLASS
        class, err := icccm.WmClassGet(s.xConn, id)
        if err == nil && class != nil {
            if class.Instance == s.windowTitle || class.Class == s.windowTitle {
                s.windowID = id
                return nil
            }
        }

        // Check _NET_WM_NAME
        name, err := ewmh.WmNameGet(s.xConn, id)
        if err == nil && name == s.windowTitle {
            s.windowID = id
            return nil
        }

        // Check WM_NAME (fallback)
        name, err = icccm.WmNameGet(s.xConn, id)
        if err == nil && name == s.windowTitle {
            s.windowID = id
            return nil
        }
    }

    return ErrWindowNotFound
}

// findWindowByTree walks the X11 tree when no WM is running
func (s *Session) findWindowByTree() error {
    setup := xproto.Setup(s.xConn.Conn())
    screen := setup.DefaultScreen(s.xConn.Conn())

    tree, err := xproto.QueryTree(s.xConn.Conn(), screen.Root).Reply()
    if err != nil {
        return err
    }

    for _, childID := range tree.Children {
        class, err := icccm.WmClassGet(s.xConn, childID)
        if err == nil && class != nil {
            if class.Instance == s.windowTitle || class.Class == s.windowTitle {
                s.windowID = childID
                return nil
            }
        }
        name, err := icccm.WmNameGet(s.xConn, childID)
        if err == nil && name == s.windowTitle {
            s.windowID = childID
            return nil
        }
    }

    return ErrWindowNotFound
}

// CaptureFrame grabs a single frame and returns JPEG bytes
func (s *Session) CaptureFrame() ([]byte, error) {
    setup := xproto.Setup(s.xConn.Conn())
    screen := setup.DefaultScreen(s.xConn.Conn())

    var drawable xproto.Drawable
    var width, height uint16

    if s.mode == CaptureSingleWindow && s.windowID != 0 {
        // Capture specific window
        geom, err := xwindow.New(s.xConn, s.windowID).DecorGeometry()
        if err != nil {
            // Window might have been closed — try to re-find it
            if findErr := s.findTargetWindow(); findErr != nil {
                return nil, ErrWindowNotFound
            }
            geom, err = xwindow.New(s.xConn, s.windowID).DecorGeometry()
            if err != nil {
                return nil, err
            }
        }
        drawable = xproto.Drawable(s.windowID)
        width = uint16(geom.Width())
        height = uint16(geom.Height())
    } else {
        // Capture full desktop
        drawable = xproto.Drawable(screen.Root)
        width = DisplayWidth
        height = DisplayHeight
    }

    // Grab raw pixels via X11 protocol
    reply, err := xproto.GetImage(s.xConn.Conn(), xproto.ImageFormatZPixmap,
        drawable, 0, 0, width, height, 0xffffffff).Reply()
    if err != nil {
        return nil, err
    }

    // Swizzle BGRA → RGBA and force alpha to 255
    for i := 0; i < len(reply.Data); i += 4 {
        b := reply.Data[i]
        r := reply.Data[i+2]
        reply.Data[i] = r
        reply.Data[i+2] = b
        reply.Data[i+3] = 255
    }

    // Encode to JPEG
    img := &image.RGBA{
        Pix:    reply.Data,
        Stride: int(width) * 4,
        Rect:   image.Rect(0, 0, int(width), int(height)),
    }

    var buf bytes.Buffer
    if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: JPEGQuality}); err != nil {
        return nil, err
    }

    return buf.Bytes(), nil
}

// Close cleans up resources
func (s *Session) Close() {
    if s.xConn != nil {
        s.xConn.Close()
    }
}
```

### Code: Input Injection

```go
package graphic

import (
    "fmt"
    "os"
    "os/exec"
)

type InputEvent struct {
    Type   string `json:"type"`   // "mousemove", "mousedown", "mouseup", "keydown"
    X      int    `json:"x"`      // Mouse X coordinate
    Y      int    `json:"y"`      // Mouse Y coordinate
    Button int    `json:"button"` // 1 = Left, 2 = Middle, 3 = Right
    Key    string `json:"key"`    // e.g., "Return", "a", "BackSpace"
}

// InjectInput sends mouse/keyboard events to the X11 display via xdotool
func InjectInput(display string, event InputEvent) {
    var cmd *exec.Cmd

    switch event.Type {
    case "mousemove":
        cmd = exec.Command("xdotool", "mousemove",
            fmt.Sprintf("%d", event.X), fmt.Sprintf("%d", event.Y))
    case "mousedown":
        cmd = exec.Command("xdotool", "mousedown",
            fmt.Sprintf("%d", event.Button))
    case "mouseup":
        cmd = exec.Command("xdotool", "mouseup",
            fmt.Sprintf("%d", event.Button))
    case "keydown":
        x11Key := event.Key
        if x11Key == "Enter" {
            x11Key = "Return"
        }
        cmd = exec.Command("xdotool", "key", x11Key)
    default:
        return
    }

    if cmd != nil {
        cmd.Env = append(os.Environ(), "DISPLAY="+display)
        _ = cmd.Run()
    }
}
```

### Code: WebSocket Handler (for Suwu integration)

```go
package graphic

import (
    "encoding/json"
    "log/slog"
    "time"

    "github.com/coder/websocket"
)

// HandleStream manages a single graphic streaming session
func HandleStream(conn *websocket.Conn, display string, mode CaptureMode, windowTitle string) {
    session, err := NewSession(display, mode, windowTitle)
    if err != nil {
        slog.Error("failed to create graphic session", "error", err)
        conn.Close(websocket.StatusInternalError, "failed to start session")
        return
    }
    defer session.Close()

    ctx := conn.CloseRead(conn.CloseReadDone())

    // Input loop: browser → xdotool
    go func() {
        for {
            _, message, err := conn.Read(ctx)
            if err != nil {
                return
            }
            var event InputEvent
            if err := json.Unmarshal(message, &event); err == nil {
                InjectInput(display, event)
            }
        }
    }()

    // Display loop: X11 → browser
    ticker := time.NewTicker(time.Second / FPS)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            frame, err := session.CaptureFrame()
            if err != nil {
                slog.Debug("capture error", "error", err)
                continue
            }
            if err := conn.Write(ctx, websocket.MessageBinary, frame); err != nil {
                return
            }
        }
    }
}
```

---

## Part 4: The Frontend

### React Component (for Suwu integration)

```tsx
// frontend/src/components/GraphicAppPane.tsx
import { useEffect, useRef, useState } from 'react'

interface GraphicAppProps {
  display?: string
  windowTitle?: string
}

export function GraphicAppPane({ display = ':99', windowTitle }: GraphicAppProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Connect to WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/graphic?display=${display}${windowTitle ? `&title=${windowTitle}` : ''}`

    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'blob'
    wsRef.current = ws

    ws.onmessage = (event) => {
      if (event.data instanceof Blob) {
        const url = URL.createObjectURL(event.data)
        const img = new Image()
        img.onload = () => {
          ctx.drawImage(img, 0, 0)
          URL.revokeObjectURL(url)
        }
        img.src = url
      }
    }

    return () => {
      ws.close()
    }
  }, [display, windowTitle])

  // Mouse/keyboard event handlers
  const getCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    }
  }

  const sendEvent = (event: Record<string, unknown>) => {
    wsRef.current?.send(JSON.stringify(event))
  }

  return (
    <canvas
      ref={canvasRef}
      width={1280}
      height={720}
      className="max-w-full h-auto cursor-default"
      onMouseMove={(e) => {
        const coords = getCanvasCoords(e)
        sendEvent({ type: 'mousemove', x: coords.x, y: coords.y })
      }}
      onMouseDown={(e) => {
        const buttonMap = { 0: 1, 1: 2, 2: 3 }
        sendEvent({ type: 'mousedown', button: buttonMap[e.button as keyof typeof buttonMap] || 1 })
      }}
      onMouseUp={(e) => {
        const buttonMap = { 0: 1, 1: 2, 2: 3 }
        sendEvent({ type: 'mouseup', button: buttonMap[e.button as keyof typeof buttonMap] || 1 })
      }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (['Space', 'Tab', 'Backspace'].includes(e.code)) {
          e.preventDefault()
        }
        sendEvent({ type: 'keydown', key: e.key })
      }}
      tabIndex={0}
    />
  )
}
```

---

## Part 5: Server Route Integration (for Suwu)

Add to `pkg/server/server.go`:

```go
if r.URL.Path == "/ws/graphic" {
    s.handleGraphicWS(w, r)
    return
}
```

Add handler to `pkg/server/graphic.go`:

```go
func (s *Server) handleGraphicWS(w http.ResponseWriter, r *http.Request) {
    q := r.URL.Query()
    display := q.Get("display")
    if display == "" {
        display = ":99"
    }
    title := q.Get("title")
    mode := graphic.CaptureFullDesktop
    if title != "" {
        mode = graphic.CaptureSingleWindow
    }

    // Auth check
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

    graphic.HandleStream(conn, display, mode, title)
}
```

---

## Performance Characteristics

| Metric | Value |
|--------|-------|
| **Capture latency** | < 3ms per frame (native X11 protocol) |
| **JPEG size (1280×720, 60%)** | ~30-80 KB per frame |
| **Bandwidth at 30 FPS** | ~15-20 Mbps (fits easily on intranet) |
| **CPU usage** | Low — pure Go, no CGo, no process spawning |
| **Memory** | Minimal — single frame buffer |

---

## Implementation Roadmap

| Phase | Task | Effort |
|-------|------|--------|
| 1 | `pkg/graphic/capture.go` — X11 capture with XGB | 2-3 hours |
| 2 | `pkg/graphic/input.go` — xdotool injection | 1 hour |
| 3 | `pkg/graphic/manager.go` — Session management | 2-3 hours |
| 4 | Server route `/ws/graphic` | 1 hour |
| 5 | `GraphicAppPane.tsx` — React component | 2-3 hours |
| 6 | WM integration (new pane type) | 2-3 hours |
| 7 | Testing & polish | 2-3 hours |
| **Total** | | **~2-3 days** |

---

## Future Enhancements

- [ ] Clipboard sync between browser and remote X11
- [ ] Audio streaming via Web Audio APIs
- [ ] Multi-user concurrent sessions
- [ ] Window resize handling (dynamic resolution)
- [ ] Cursor shape tracking (use XFixes extension)
- [ ] MIT-SHM extension for zero-copy capture (performance optimization)
