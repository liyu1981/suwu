package xdisplay

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"unicode"
)

// InputEvent is one mouse or keyboard action sent from the browser.
type InputEvent struct {
	Type   string `json:"type"`   // "mousemove" | "mousedown" | "mouseup" | "keydown" | "wheel"
	X      int    `json:"x"`      // Mouse X in display coordinates
	Y      int    `json:"y"`      // Mouse Y in display coordinates
	Button int    `json:"button"` // 1 = left, 2 = middle, 3 = right
	Key    string `json:"key"`    // Browser key name, e.g. "a", "Enter", "ArrowUp"
	W      int    `json:"w,omitempty"` // resize: desired display width
	H      int    `json:"h,omitempty"` // resize: desired display height
	Dx     int    `json:"dx,omitempty"` // wheel: horizontal delta (+right)
	Dy     int    `json:"dy,omitempty"` // wheel: vertical delta (+down)
	Ctrl   bool   `json:"ctrl,omitempty"`
	Alt    bool   `json:"alt,omitempty"`
	Meta   bool   `json:"meta,omitempty"`
	Shift  bool   `json:"shift,omitempty"`
}

// keysymMap translates browser KeyboardEvent.key names that differ from
// X11 keysym names. Single printable characters never reach this map —
// they go through `xdotool type` which resolves keysym+shift correctly.
var keysymMap = map[string]string{
	"Enter":      "Return",
	" ":          "space",
	"ArrowUp":    "Up",
	"ArrowDown":  "Down",
	"ArrowLeft":  "Left",
	"ArrowRight": "Right",
	"Backspace":  "BackSpace",
	"PageUp":     "Page_Up",
	"PageDown":   "Page_Down",
	"Esc":        "Escape",
	"Del":        "Delete",
	"Shift":      "Shift_L",
	"Control":    "Control_L",
	"Alt":        "Alt_L",
	"Meta":       "Super_L",
	"CapsLock":   "Caps_Lock",
	"ScrollLock": "Scroll_Lock",
	"NumLock":    "Num_Lock",
	"Insert":     "Insert",
}

// toKeysym converts a browser key name to an X11 keysym for xdotool.
func toKeysym(key string) string {
	if mapped, ok := keysymMap[key]; ok {
		return mapped
	}
	return key
}

// InjectInput forwards one input event to the X display via xdotool.
// xdotool is spawned per event — negligible overhead at human input rates
// and it keeps the package free of X input protocol code.
func InjectInput(display string, event InputEvent) {
	if display == "" {
		return
	}

	var args []string
	switch event.Type {
	case "mousemove":
		args = []string{"mousemove", fmt.Sprintf("%d", event.X), fmt.Sprintf("%d", event.Y)}

	case "mousedown":
		if event.Button < 1 || event.Button > 3 {
			return
		}
		args = []string{"mousedown", fmt.Sprintf("%d", event.Button)}

	case "mouseup":
		if event.Button < 1 || event.Button > 3 {
			return
		}
		args = []string{"mouseup", fmt.Sprintf("%d", event.Button)}

	case "wheel":
		// Browser deltas: +y = scroll down, +x = scroll right.
		// X11 button 4/5 = wheel up/down, 6/7 = wheel left/right.
		btn := 0
		switch {
		case abs(event.Dy) >= abs(event.Dx) && event.Dy > 0:
			btn = 5
		case abs(event.Dy) >= abs(event.Dx) && event.Dy < 0:
			btn = 4
		case event.Dx > 0:
			btn = 7
		case event.Dx < 0:
			btn = 6
		}
		if btn == 0 {
			return
		}
		// Chained commands: position the pointer, then click the wheel button.
		args = []string{
			"mousemove", fmt.Sprintf("%d", event.X), fmt.Sprintf("%d", event.Y),
			"click", fmt.Sprintf("%d", btn),
		}

	case "keydown":
		args = keydownArgs(event)

	default:
		return
	}

	cmd := exec.Command("xdotool", args...)
	cmd.Env = append(os.Environ(), "DISPLAY="+display)
	_ = cmd.Run()
}

// keydownArgs builds the xdotool invocation for a keyboard event.
func keydownArgs(event InputEvent) []string {
	// Modifier combos (Ctrl+C, Alt+Arrow...) go through `key` with prefixes.
	if event.Ctrl || event.Alt || event.Meta {
		mods := ""
		if event.Ctrl {
			mods += "ctrl+"
		}
		if event.Alt {
			mods += "alt+"
		}
		if event.Meta {
			mods += "meta+"
		}
		if event.Shift {
			mods += "shift+"
		}
		return []string{"key", "--", mods + toKeysym(event.Key)}
	}

	// Plain printable characters ("." , "A", "@"...) go through `type`,
	// which resolves the correct keysym and shift state — raw keysym
	// lookup fails for most punctuation.
	if r := []rune(event.Key); len(r) == 1 && !unicode.IsControl(r[0]) {
		return []string{"type", "--", event.Key}
	}

	key := toKeysym(event.Key)
	if key == "" || strings.ContainsAny(key, "\x00\r\n") {
		return nil
	}
	return []string{"key", "--", key}
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
