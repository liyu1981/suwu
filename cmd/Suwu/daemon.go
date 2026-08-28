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
// variables (SUWU_BIN, SUWU_LOG_DIR, SUWU_CONFIG_DIR) are set so the
// script manages the correct binary and data paths.
func daemon(args []string) error {
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
	// Logs and PID live in /var/log by default (override with SUWU_LOG_DIR).
	if os.Getenv("SUWU_LOG_DIR") == "" {
		os.Setenv("SUWU_LOG_DIR", "/var/log")
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
