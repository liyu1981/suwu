package main

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

//go:embed serve_suwu.sh
var serveScript string

// daemon executes the embedded serve_suwu.sh via bash -s, forwarding the
// given subcommand (start, stop, restart, status, logs). Environment
// variables (SUWU_BIN, SUWU_VAR, SUWU_CONFIG_DIR) are set so the script
// manages the correct binary and data paths.
//
// When a systemd user service is installed, the standard subcommands
// (start, stop, restart, status, logs) are redirected to systemctl/journalctl
// so the service gets systemd's crash recovery and lifecycle management.
func daemon(args []string) error {
	// ── Systemd redirect ─────────────────────────────────────────────
	// If the systemd service file is installed, delegate to systemctl
	// for the standard subcommands. This gives the service auto-restart
	// on crash, clean stop semantics, and journal-based logs.
	if hasSystemdUserService() && len(args) > 0 {
		switch args[0] {
		case "start", "stop", "restart", "status":
			return systemctlUser(args[0], "suwu")
		case "logs":
			return journalctlUser()
		case "install":
			fmt.Println("systemd service already installed")
			return nil
		case "uninstall":
			return uninstallSystemdService()
		}
		// Fall through for unknown subcommands.
	}

	// ── Embedded bash-script fallback ────────────────────────────────
	// When systemd is not in use, the original shell-script daemon
	// manager handles start/stop/restart/status/logs.
	bin, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}
	bin, err = filepath.EvalSymlinks(bin)
	if err != nil {
		return fmt.Errorf("resolve symlinks: %w", err)
	}

	home, _ := os.UserHomeDir()

	// Let the script find the binary that is currently running.
	if os.Getenv("SUWU_BIN") == "" {
		os.Setenv("SUWU_BIN", bin)
	}
	// Data dir for logs and PID (default ~/.suwu, override with SUWU_VAR).
	if os.Getenv("SUWU_VAR") == "" && home != "" {
		os.Setenv("SUWU_VAR", filepath.Join(home, ".suwu"))
	}
	// Config lives in ~/.config/suwu/ (override with SUWU_CONFIG_DIR).
	if os.Getenv("SUWU_CONFIG_DIR") == "" && home != "" {
		os.Setenv("SUWU_CONFIG_DIR", filepath.Join(home, ".config", "suwu"))
	}

	cmd := exec.Command("bash", "-s")
	cmd.Args = append([]string{"bash", "-s"}, args...)
	cmd.Stdin = strings.NewReader(serveScript)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		return err
	}
	return nil
}
