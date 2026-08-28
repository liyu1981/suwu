package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/charmbracelet/huh"
	"github.com/mattn/go-isatty"
)

// envExample is the default ~/.config/suwu/.env template written by install.
// Keep in sync with .env.example at the project root.
const envExample = `# Suwu user-global configuration.
# Values already present in the shell environment take precedence over this file.

# Dev mode: set to true for air hot-reload defaults (port 8000, dev banner).
#SUWU_DEV=false

# Bind address (default 127.0.0.1). Use 0.0.0.0 to expose on all interfaces.
HOST=127.0.0.1

# HTTP port (default 8080).
PORT=8080

# Data directory for logs and PID (default ~/.suwu).
#SUWU_VAR=

# TLS (opt-in). Set both to enable https:// — browsers only expose clipboard
# APIs (terminal paste) on secure contexts, so non-localhost HTTP access
# cannot paste into the terminal. Easiest: run 'suwu gencerts', which writes
# a cert pair into ~/.config/suwu/ and records the paths in this file.
#TLS_CERT_FILE=
#TLS_KEY_FILE=
`

func install() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve home: %w", err)
	}

	// 1. ~/.config/suwu/.env — seed from defaults if missing
	cfgDir := filepath.Join(home, ".config", "suwu")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", cfgDir, err)
	}
	envPath := filepath.Join(cfgDir, ".env")
	if _, err := os.Stat(envPath); os.IsNotExist(err) {
		if err := os.WriteFile(envPath, []byte(envExample), 0o600); err != nil {
			return fmt.Errorf("write %s: %w", envPath, err)
		}
		fmt.Printf("  ✅ wrote %s (seeded from defaults)\n", envPath)
	} else {
		fmt.Printf("  ⏭️  %s already exists, skipping\n", envPath)
	}

	// 2. Choose data directory for logs and PID
	var varDir string
	if isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd()) {
		var choice string
		form := huh.NewForm(huh.NewGroup(
			huh.NewSelect[string]().
				Title("Where should logs and PID files live?").
				Options(
					huh.NewOption("~/.suwu  (recommended, no sudo needed)", "home"),
					huh.NewOption("/var/log/suwu  (system-wide, requires sudo)", "system"),
				).
				Value(&choice),
		)).WithTheme(huh.ThemeCatppuccin())
		if err := form.Run(); err != nil {
			return fmt.Errorf("interactive prompt: %w", err)
		}
		if choice == "system" {
			varDir = "/var/log/suwu"
		} else {
			varDir = filepath.Join(home, ".suwu")
		}
	} else {
		// Non-interactive: default to ~/.suwu
		varDir = filepath.Join(home, ".suwu")
	}

	if err := os.MkdirAll(varDir, 0o755); err != nil {
		// If /var/log/suwu failed, try creating with sudo
		if varDir == "/var/log/suwu" {
			fmt.Printf("  ⚠️  Cannot create %s (permission denied)\n", varDir)
			fmt.Printf("     Try: sudo mkdir -p %s && sudo chown $(id -u):$(id -g) %s\n", varDir, varDir)
			// Fall back to ~/.suwu
			varDir = filepath.Join(home, ".suwu")
			if err := os.MkdirAll(varDir, 0o755); err != nil {
				return fmt.Errorf("create %s: %w", varDir, err)
			}
		} else {
			return fmt.Errorf("create %s: %w", varDir, err)
		}
	}
	fmt.Printf("  ✅ data directory: %s\n", varDir)

	// If /var/log/suwu was chosen and we have sudo access, try to set
	// ownership so future runs don't need sudo.
	if varDir == "/var/log/suwu" {
		uid := fmt.Sprintf("%d", os.Getuid())
		gid := fmt.Sprintf("%d", os.Getgid())
		cmd := exec.Command("sudo", "chown", uid+":"+gid, varDir)
		if err := cmd.Run(); err != nil {
			fmt.Printf("     (sudo chown failed; you may need to run: sudo chown %s:%s %s)\n", uid, gid, varDir)
		}
	}

	// Write SUWU_VAR to .env if a non-default dir was chosen
	if varDir != filepath.Join(home, ".suwu") {
		envKey := "SUWU_VAR=" + varDir + "\n"
		f, err := os.OpenFile(envPath, os.O_APPEND|os.O_WRONLY, 0o600)
		if err == nil {
			defer f.Close()
			_, _ = f.WriteString(envKey)
			fmt.Printf("  ✅ appended SUWU_VAR to %s\n", envPath)
		}
	}

	fmt.Println()
	fmt.Println("  ▶️  suwu serve              run the server in the foreground")
	fmt.Println("  ▶️  suwu daemon start       run as a background daemon")
	return nil
}
