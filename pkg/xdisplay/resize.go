package xdisplay

import (
	"fmt"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/randr"
	"github.com/jezek/xgb/xproto"
)

// modePrefix marks this app's dynamically created RANDR modes, so stale
// ones (from earlier resize runs) can be identified and destroyed.
const modePrefix = "suwu-"

// ResizeDisplay changes the framebuffer of a running X server to exactly
// width x height using the RANDR protocol. It accepts an optional cached
// connection (from the stream session) to avoid the connection churn that
// causes the dummy driver to reset clients. Pass nil to open a fresh one.
func ResizeDisplay(display string, width, height int, cachedConn ...*xgb.Conn) error {
	width, height = clampSize(width), clampSize(height)

	var ownConn bool
	X := firstConn(cachedConn)
	if X == nil {
		var err error
		X, err = xgb.NewConnDisplay(display)
		if err != nil {
			return err
		}
		ownConn = true
	}
	defer func() {
		if ownConn {
			X.Close()
		}
	}()

	if err := randr.Init(X); err != nil {
		return err
	}

	root := xproto.Setup(X).DefaultScreen(X).Root
	res, err := randr.GetScreenResources(X, root).Reply()
	if err != nil {
		return err
	}
	if len(res.Outputs) == 0 || len(res.Crtcs) == 0 {
		return fmt.Errorf("no RANDR outputs/crtcs on %s", display)
	}
	output := res.Outputs[0]
	crtc := res.Crtcs[0]
	ci, err := randr.GetCrtcInfo(X, crtc, res.ConfigTimestamp).Reply()
	if err != nil {
		return err
	}

	// Find or create a mode of exactly the target size. Lookup is pure
	// client-side over res.Modes (no GetOutputInfo — xgb's reply parser
	// for that request corrupts connection framing nondeterministically).
	// AddOutputMode is idempotent; stale modes are never destroyed — the
	// dummy driver crashes when an RRCreateMode mode is destroyed.
	var mode randr.Mode
	for _, m := range res.Modes {
		if int(m.Width) == width && int(m.Height) == height {
			mode = randr.Mode(m.Id)
			break
		}
	}
	if mode == 0 {
		ht, vt := width+160, height+24
		name := fmt.Sprintf("%s%dx%d", modePrefix, width, height)
		cm, err := randr.CreateMode(X, root, randr.ModeInfo{
			Width:      uint16(width),
			Height:     uint16(height),
			DotClock:   uint32(ht * vt * 60),
			HsyncStart: uint16(width + 64),
			HsyncEnd:   uint16(width + 96),
			Htotal:     uint16(ht),
			VsyncStart: uint16(height + 4),
			VsyncEnd:   uint16(height + 12),
			Vtotal:     uint16(vt),
			NameLen:    uint16(len(name)),
		}, name).Reply()
		if err != nil {
			return fmt.Errorf("create mode %dx%d: %w", width, height, err)
		}
		mode = cm.Mode
	}
	// Ensure the mode is attached to the output (idempotent).
	if err := randr.AddOutputModeChecked(X, output, mode).Check(); err != nil {
		return fmt.Errorf("attach mode %dx%d: %w", width, height, err)
	}

	// Reconcile the framebuffer: SetCrtcConfig requires the mode to
	// fit the current framebuffer, SetScreenSize requires all CRTCs to fit.
	// Growing the FB to max(current CRTC, target) breaks the deadlock
	// in both directions (verified against xorg-server 21.1).
	curW, curH := int(ci.Width), int(ci.Height)
	iW, iH := width, height
	if curW > iW {
		iW = curW
	}
	if curH > iH {
		iH = curH
	}
	if iW != curW || iH != curH {
		if err := randr.SetScreenSizeChecked(X, root, uint16(iW), uint16(iH),
			dpiMM(iW), dpiMM(iH)).Check(); err != nil {
			return fmt.Errorf("grow framebuffer to %dx%d: %w", iW, iH, err)
		}
	}

	// Switch the CRTC to the target mode.
	outputs := ci.Outputs
	if len(outputs) == 0 {
		outputs = []randr.Output{output}
	}
	cc, err := randr.SetCrtcConfig(X, crtc, ci.Timestamp, res.ConfigTimestamp,
		0, 0, mode, randr.RotationRotate0, outputs).Reply()
	if err != nil {
		return fmt.Errorf("set CRTC to %dx%d: %w", width, height, err)
	}
	if cc.Status != randr.SetConfigSuccess {
		return fmt.Errorf("set CRTC to %dx%d: status %d", width, height, cc.Status)
	}

	// Shrink the framebuffer to the exact target.
	if iW != width || iH != height {
		if err := randr.SetScreenSizeChecked(X, root, uint16(width), uint16(height),
			dpiMM(width), dpiMM(height)).Check(); err != nil {
			return fmt.Errorf("shrink framebuffer to %dx%d: %w", width, height, err)
		}
	}
	return nil
}

// dpiMM converts pixels to millimetres at 96 DPI.
func dpiMM(px int) uint32 {
	return uint32(px) * 254 / 960
}

func firstConn(conns []*xgb.Conn) *xgb.Conn {
	if len(conns) > 0 {
		return conns[0]
	}
	return nil
}
