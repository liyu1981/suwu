package main

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

//go:embed serve_suwu.sh
var serveScript string

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

	// 1. ~/.local/bin/ — write serve_suwu.sh
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", binDir, err)
	}
	script := filepath.Join(binDir, "serve_suwu.sh")
	if err := os.WriteFile(script, []byte(serveScript), 0o755); err != nil {
		return fmt.Errorf("write %s: %w", script, err)
	}
	fmt.Printf("  ✅ wrote %s\n", script)

	// 2. /var/log/suwu/ — create if missing (best-effort, hint on failure)
	logDir := "/var/log/suwu"
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		if strings.Contains(err.Error(), "permission denied") {
			fmt.Printf("  ⚠️  %s requires root: run 'sudo mkdir -p %s && sudo chown $(id -u):$(id -g) %s'\n", logDir, logDir, logDir)
		} else {
			return fmt.Errorf("create %s: %w", logDir, err)
		}
	} else {
		fmt.Printf("  ✅ ensured %s\n", logDir)
	}

	// 3. ~/.config/suwu/.env — seed from .env.example if missing
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

	fmt.Println()
	fmt.Println("  ▶️  serve_suwu.sh {start|stop|restart|status|logs}")
	return nil
}
