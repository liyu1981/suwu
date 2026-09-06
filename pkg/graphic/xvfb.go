package graphic

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// displayRe matches local virtual display numbers (":99", ":1", ...).
var displayRe = regexp.MustCompile(`^:(\d+)$`)

// DepComponent describes one system dependency.
type DepComponent struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Installed   bool   `json:"installed"`
}

// DepError is returned when required system dependencies are missing.
type DepError struct {
	Components []DepComponent     `json:"components"`
	Install    map[string]string  `json:"install"` // distro -> install command
}

func (e *DepError) Error() string {
	var missing []string
	for _, c := range e.Components {
		if !c.Installed {
			missing = append(missing, c.Name)
		}
	}
	return fmt.Sprintf("missing dependencies: %s", strings.Join(missing, ", "))
}

// requiredBins lists the binaries that must exist on the system.
var requiredBins = []struct {
	Bin         string
	Description string
}{
	{"Xorg", "X server"},
	{"xdotool", "input injection"},
	{"picom", "compositor"},
}

// distroPackages maps distro families to their package names for each
// required binary (same order as requiredBins).
var distroPackages = map[string][]string{
	"debian": {"xserver-xorg-core", "xserver-xorg-video-dummy", "xdotool", "picom"},
	"redhat": {"xorg-x11-server-Xorg", "xorg-x11-dummy-driver", "xdotool", "picom"},
	"arch":   {"xorg-server", "xf86-video-dummy", "xdotool", "picom"},
}

// distroInstallCmd maps distro families to one-liner install commands.
var distroInstallCmd = map[string]string{
	"debian": "sudo apt install xserver-xorg-core xserver-xorg-video-dummy xdotool picom",
	"redhat": "sudo dnf install xorg-x11-server-Xorg xorg-x11-dummy-driver xdotool picom",
	"arch":   "sudo pacman -S xorg-server xf86-video-dummy xdotool picom",
}

// CheckDependencies verifies that all required system binaries are
// available. Returns nil if everything is installed, or a *DepError
// describing what's missing and how to install it.
func CheckDependencies() *DepError {
	var components []DepComponent
	allOk := true

	for _, req := range requiredBins {
		_, err := exec.LookPath(req.Bin)
		components = append(components, DepComponent{
			Name:        req.Bin,
			Description: req.Description,
			Installed:   err == nil,
		})
		if err != nil {
			allOk = false
		}
	}

	if allOk {
		return nil
	}

	// Build filtered install command (only missing packages).
	install := buildInstallCommands(components)

	return &DepError{
		Components: components,
		Install:    install,
	}
}

// detectDistro reads /etc/os-release to determine the distro family.
func detectDistro() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		if runtime.GOOS == "linux" {
			return "debian" // fallback
		}
		return ""
	}
	content := strings.ToLower(string(data))
	switch {
	case strings.Contains(content, "id=ubuntu") || strings.Contains(content, "id=debian") ||
		strings.Contains(content, "id=linuxmint") || strings.Contains(content, "id=pop"):
		return "debian"
	case strings.Contains(content, "id=fedora") || strings.Contains(content, "id=centos") ||
		strings.Contains(content, "id=rhel") || strings.Contains(content, "id=rocky") ||
		strings.Contains(content, "id=almalinux"):
		return "redhat"
	case strings.Contains(content, "id=arch") || strings.Contains(content, "id=endeavouros"):
		return "arch"
	default:
		return "debian" // fallback
	}
}

// buildInstallCommands builds per-distro install commands containing
// only the missing packages.
func buildInstallCommands(components []DepComponent) map[string]string {
	// Collect missing package names per distro.
	allMissing := map[string][]string{}
	for distro, pkgs := range distroPackages {
		for i, comp := range components {
			if !comp.Installed {
				allMissing[distro] = append(allMissing[distro], pkgs[i])
			}
		}
	}

	result := map[string]string{}
	result["debian"] = "sudo apt install " + strings.Join(allMissing["debian"], " ")
	result["redhat"] = "sudo dnf install " + strings.Join(allMissing["redhat"], " ")
	result["arch"] = "sudo pacman -S " + strings.Join(allMissing["arch"], " ")
	return result
}

// xorgCmd/picomCmd track running processes so StopDisplay can kill them
// when the server shuts down (avoids orphaned processes).
var xorgCmd, picomCmd *exec.Cmd

// Xorg+dummy virtual buffer ceiling (matches the generated xorg.conf's
// Virtual option — any pane size up to 4K fits without a server restart).
const virtualW, virtualH = 3840, 2160

// clampSize keeps requested dimensions within framebuffer bounds and
// rounds to even numbers (video/JPEG encoders prefer even sizes).
func clampSize(v int) int {
	if v < 320 {
		v = 320
	}
	if v > 3840 {
		v = 3840
	}
	return v &^ 1
}

// EnsureDisplay makes sure an Xorg server with the dummy video driver is
// listening on the display, starting one for local virtual displays when
// none is reachable. The dummy driver's framebuffer is a resizable virtual
// buffer, so the graphic tile can follow pane resizes via ResizeDisplay.
//
// Xvfb is NOT supported — it registers a single fixed mode and rejects
// RANDR resize. If Xorg is missing, an error is returned instructing the
// user to install the required packages.
func EnsureDisplay(display string, width, height int) error {
	if probeDisplay(display) {
		slog.Debug("graphic: display already ready", "display", display)
		return nil
	}

	if width <= 0 {
		width = DefaultWidth
	}
	if height <= 0 {
		height = DefaultHeight
	}
	width, height = clampSize(width), clampSize(height)

	slog.Debug("graphic: starting Xorg", "display", display, "size", fmt.Sprintf("%dx%d", width, height))
	cmd, err := startXorg(display, width, height)
	if err != nil {
		slog.Error("graphic: startXorg failed", "error", err)
		return err
	}
	xorgCmd = cmd

	if waitReady(display, 5*time.Second) {
		slog.Debug("graphic: Xorg ready", "display", display)
		startPicom(display)
		return nil
	}

	_ = cmd.Process.Kill()
	slog.Error("graphic: Xorg did not start in time", "display", display)
	return fmt.Errorf("Xorg on display %s did not start; check that xserver-xorg-video-dummy is installed", display)
}

// waitReady polls until an X server accepts connections on display.
func waitReady(display string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if probeDisplay(display) {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// probeDisplay reports whether an X server is listening on display
// by checking for the Unix socket file and verifying the process is alive.
// Stale sockets (dead process, leftover files) are cleaned up.
func probeDisplay(display string) bool {
	m := displayRe.FindStringSubmatch(display)
	if m == nil {
		return false
	}
	num := m[1]

	// Check the lock file — contains the PID of the X server.
	lockPath := fmt.Sprintf("/tmp/.X%s-lock", num)
	lockBytes, err := os.ReadFile(lockPath)
	if err == nil {
		// Parse PID and check if the process is alive.
		pid := 0
		fmt.Sscanf(string(lockBytes), "%d", &pid)
		if pid > 0 {
			// kill(pid, 0) checks existence without sending a signal.
			if syscall.Kill(pid, 0) == nil {
				// Process alive — verify the socket exists.
				sockPath := fmt.Sprintf("/tmp/.X11-unix/X%s", num)
				info, err := os.Stat(sockPath)
				return err == nil && info.Mode()&os.ModeSocket != 0
			}
			// Process dead — clean up stale files.
			slog.Warn("graphic: cleaning stale X server", "display", display, "pid", pid)
			_ = os.Remove(lockPath)
			_ = os.Remove(fmt.Sprintf("/tmp/.X11-unix/X%s", num))
		}
	}

	// No lock file or process dead — check socket as fallback.
	sockPath := fmt.Sprintf("/tmp/.X11-unix/X%s", num)
	info, err := os.Stat(sockPath)
	if err == nil && info.Mode()&os.ModeSocket != 0 {
		// Socket exists but no valid lock — stale, clean up.
		_ = os.Remove(sockPath)
	}
	return false
}

// xorgConf renders an xorg.conf for a headless dummy-graphics server:
// no input devices (input is injected via xdotool), a dummy video card
// with a large virtual framebuffer, and the requested initial mode.
// The Modeline is required: the dummy driver only auto-generates standard
// VESA modes, so an arbitrary pane size would otherwise be ignored.
func xorgConf(width, height int) string {
	ht, vt := width+160, height+24
	dotClock := ht * vt * 60
	modeline := fmt.Sprintf("Modeline \"%s%dx%d\" %d %d %d %d %d %d %d %d %d -HSync +Vsync",
		modePrefix, width, height, dotClock, width, width+64, width+96, ht,
		height, height+4, height+12, vt)
	return fmt.Sprintf(`Section "ServerFlags"
  Option "DontVTSwitch" "true"
  Option "AllowMouseOpenFail" "true"
  Option "PciForceNone" "true"
  Option "AutoEnableDevices" "false"
  Option "AutoAddDevices" "false"
EndSection

Section "Device"
  Identifier "device0"
  Driver "dummy"
  VideoRam 1024000
  Option "Virtual" "%dx%d"
EndSection

Section "Monitor"
  Identifier "monitor0"
  HorizSync 5.0 - 1000.0
  VertRefresh 5.0 - 200.0
  %s
EndSection

Section "Screen"
  Identifier "screen0"
  Device "device0"
  Monitor "monitor0"
  DefaultDepth 24
  SubSection "Display"
    Depth 24
    Modes "%s%dx%d"
    Virtual %d %d
  EndSubSection
EndSection
`, virtualW, virtualH, modeline, modePrefix, width, height, virtualW, virtualH)
}

// startXorg launches a headless Xorg with the dummy video driver on a
// local virtual display (":N"), running as the current (non-root) user.
func startXorg(display string, width, height int) (*exec.Cmd, error) {
	m := displayRe.FindStringSubmatch(display)
	if m == nil {
		return nil, fmt.Errorf("display %s is not reachable and cannot be started automatically", display)
	}
	if _, err := exec.LookPath("Xorg"); err != nil {
		return nil, fmt.Errorf("Xorg not installed (apt-get install xserver-xorg-core xserver-xorg-video-dummy)")
	}

	num, _ := strconv.Atoi(m[1])
	confPath := fmt.Sprintf("/tmp/suwu-graphic-xorg-%d.conf", num)
	logPath := fmt.Sprintf("/tmp/suwu-graphic-xorg-%d.log", num)
	if err := os.WriteFile(confPath, []byte(xorgConf(width, height)), 0644); err != nil {
		return nil, fmt.Errorf("write xorg.conf: %w", err)
	}

	cmd := exec.Command("Xorg", fmt.Sprintf(":%d", num),
		"-config", confPath,
		"-nolisten", "tcp",
		"-noreset",
		"-logfile", logPath)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start Xorg on %s: %w", display, err)
	}
	// Detach: let the X server outlive the request that started it.
	go func() { _ = cmd.Wait() }()
	return cmd, nil
}

// startPicom launches picom (compositor) on the display so that ARGB
// windows (like Chromium's popup menus) are properly composited. Without
// a compositor, transparent areas appear black because the raw premultiplied
// RGB values are captured instead of the blended result.
func startPicom(display string) {
	if _, err := exec.LookPath("picom"); err != nil {
		slog.Warn("graphic: picom not installed, ARGB menus may appear black")
		return
	}
	cmd := exec.Command("picom",
		"--daemon",
		"--backend", "xrender",
		"--vsync",
		"--no-fading-openclose",
	)
	cmd.Env = append(os.Environ(), "DISPLAY="+display)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		slog.Warn("graphic: failed to start picom", "error", err)
		return
	}
	picomCmd = cmd
	go func() { _ = cmd.Wait() }()
	slog.Debug("graphic: picom started", "display", display)
}

// StopDisplay kills the Xorg and picom processes started by
// EnsureDisplay, cleaning up socket and lock files. Called by the server
// on shutdown so these processes don't outlive their owner.
func StopDisplay() {
	if picomCmd != nil && picomCmd.Process != nil {
		slog.Debug("graphic: stopping picom", "pid", picomCmd.Process.Pid)
		_ = picomCmd.Process.Kill()
		_ = picomCmd.Wait()
		picomCmd = nil
	}
	if xorgCmd != nil && xorgCmd.Process != nil {
		slog.Debug("graphic: stopping Xorg", "pid", xorgCmd.Process.Pid)
		_ = xorgCmd.Process.Kill()
		_ = xorgCmd.Wait()
		xorgCmd = nil
	}
	// Also remove stale socket/lock files (may be from a previous server
	// instance that didn't have StopDisplay).
	for _, num := range []string{"99"} {
		lock := fmt.Sprintf("/tmp/.X%s-lock", num)
		sock := fmt.Sprintf("/tmp/.X11-unix/X%s", num)
		_ = os.Remove(lock)
		_ = os.Remove(sock)
	}
}
