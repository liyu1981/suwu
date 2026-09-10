package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"syscall"

	"github.com/charmbracelet/huh"
	"github.com/mattn/go-isatty"

	"suwu/pkg/notify"
)

// displayRe matches local virtual display numbers (":99", ":1", ...).
var displayRe = regexp.MustCompile(`^:(\d+)$`)

// useCmd implements `suwu use <command>`.
// It shows a TUI to select an X display, then runs the command with
// DISPLAY=:<selected> prepended.
func useCmd(args []string) error {
	fs := flag.NewFlagSet("use", flag.ContinueOnError)
	sockPath := fs.String("sock", "", "path to the notify socket (default ~/.suwu/suwu.sock)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	remaining := fs.Args()
	if len(remaining) == 0 {
		return fmt.Errorf("usage: suwu use [--sock <path>] <command> [args]")
	}

	// Get list of available displays.
	displays := queryDisplays(*sockPath)
	if len(displays) == 0 {
		return fmt.Errorf("no X displays found; start an XDisplay tile first")
	}

	// Show TUI selection.
	display, err := selectDisplay(displays)
	if err != nil {
		return err
	}

	// Run the command with DISPLAY=:N.
	return runWithDisplay(display, remaining)
}

// queryDisplays queries the server for active displays, falls back to local detection.
func queryDisplays(sockPath string) []string {
	// Try server query first.
	if displays := queryServerDisplays(sockPath); len(displays) > 0 {
		return displays
	}

	// Fallback: local detection.
	return localDisplays()
}

// queryServerDisplays asks the server which displays are in use.
func queryServerDisplays(sockPath string) []string {
	if sockPath == "" {
		path, err := notify.SocketPath()
		if err != nil {
			return nil
		}
		sockPath = path
	}

	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return nil
	}
	defer conn.Close()

	// Send a display-list request.
	req := notify.Command{
		Action:  "xdisplay-list",
		Payload: json.RawMessage(`{}`),
	}
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return nil
	}

	// Read response.
	var resp notify.CommandResponse
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		return nil
	}

	if !resp.OK {
		return nil
	}

	// Parse response data.
	var data struct {
		Displays []string `json:"displays"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return nil
	}

	return data.Displays
}

// localDisplays checks for running Xorg processes locally.
func localDisplays() []string {
	var displays []string

	// Check common display numbers.
	for _, num := range []string{"99", "0", "1", "2", "3", "4", "5"} {
		display := ":" + num
		if isDisplayActive(display) {
			displays = append(displays, num)
		}
	}

	return displays
}

// isDisplayActive checks if a display has a running Xorg process.
func isDisplayActive(display string) bool {
	m := displayRe.FindStringSubmatch(display)
	if m == nil {
		return false
	}
	num := m[1]

	// Check lock file for PID.
	lockPath := fmt.Sprintf("/tmp/.X%s-lock", num)
	lockBytes, err := os.ReadFile(lockPath)
	if err != nil {
		return false
	}

	pid := 0
	fmt.Sscanf(string(lockBytes), "%d", &pid)
	if pid <= 0 {
		return false
	}

	// Check if process is alive.
	if syscall.Kill(pid, 0) != nil {
		return false
	}

	// Check socket exists.
	sockPath := fmt.Sprintf("/tmp/.X11-unix/X%s", num)
	_, err = os.Stat(sockPath)
	return err == nil
}

// selectDisplay shows a TUI menu to select a display.
func selectDisplay(displays []string) (string, error) {
	// Build options for huh select.
	options := make([]huh.Option[string], len(displays))
	for i, num := range displays {
		options[i] = huh.NewOption(":"+num, num)
	}

	var selected string

	if isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd()) {
		// Interactive TUI mode.
		form := huh.NewForm(huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select X display to use").
				Options(options...).
				Value(&selected),
		)).WithTheme(huh.ThemeCatppuccin())

		if err := form.Run(); err != nil {
			return "", fmt.Errorf("interactive prompt: %w", err)
		}
	} else {
		// Non-interactive: use first display.
		selected = displays[0]
		fmt.Fprintf(os.Stderr, "Using display :%s\n", selected)
	}

	if selected == "" {
		return "", fmt.Errorf("no display selected")
	}

	return selected, nil
}

// runWithDisplay runs a command with DISPLAY=:N set.
func runWithDisplay(display string, args []string) error {
	displayEnv := ":" + display

	cmd := exec.Command(args[0], args[1:]...)
	cmd.Env = append(os.Environ(), "DISPLAY="+displayEnv)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	// Handle signals.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		if cmd.Process != nil {
			cmd.Process.Signal(sig)
		}
	}()

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start command: %w", err)
	}

	return cmd.Wait()
}
