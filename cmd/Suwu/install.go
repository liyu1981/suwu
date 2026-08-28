package main

import (
	"fmt"
	"os"
	"path/filepath"
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

	// ~/.config/suwu/.env — seed from defaults if missing
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
	fmt.Println("  ▶️  suwu serve              run the server in the foreground")
	fmt.Println("  ▶️  suwu daemon start       run as a background daemon (logs in /var/log)")
	return nil
}
