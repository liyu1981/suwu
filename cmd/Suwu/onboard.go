package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/mattn/go-isatty"

	"suwu/pkg/certs"
	"suwu/pkg/gencerts"
)

// envExample is the default ~/.config/suwu/.env template written by onboard.
// Keep in sync with .env.example at the project root.
const envExample = `# Suwu user-global configuration.
# Values already present in the shell environment take precedence over this file.

# Dev mode: set to true for air hot-reload defaults (port 8000, dev banner).
#SUWU_DEV=false

# Bind address (default 127.0.0.1). Use 0.0.0.0 to expose on all interfaces.
# Use "auto" to auto-detect machine addresses (no password required).
HOST=127.0.0.1

# HTTP port (default 8181).
PORT=8181

# Data directory for logs and PID (default ~/.suwu).
#SUWU_VAR=

# Password hash (sha256 hex). Required when HOST is set to a specific address
# (not 127.0.0.1 or auto). Generate with: suwu onboard
#AUTH_PASS=

# TLS (opt-in). Set both to enable https:// — browsers only expose clipboard
# APIs (terminal paste) on secure contexts, so non-localhost HTTP access
# cannot paste into the terminal. Easiest: run 'suwu gencerts', which writes
# a cert pair into ~/.config/suwu/ and records the paths in this file.
#TLS_CERT_FILE=
#TLS_KEY_FILE=
`

func onboard() error {
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

	// 3. Bind host + password setup (always in interactive mode)
	if isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd()) {
		if err := setupAuth(envPath); err != nil {
			return fmt.Errorf("auth setup: %w", err)
		}
	} else {
		fmt.Println("  ⏭️  skipping auth setup (non-interactive)")
	}

	// 4. Generate self-signed TLS certs (interactive mode only)
	if isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd()) {
		if err := generateCerts(home, cfgDir); err != nil {
			fmt.Printf("  ⚠️  cert generation: %v\n", err)
		}
	}

	// 5. Ensure ~/.local/bin is in PATH (needed for tool installs)
	ensureLocalBinInPath(home)

	// 6. Set ASDF_DATA_DIR to ~/.asdf explicitly
	ensureAsdfDataDir(home)

	// 7. Prepare local dev environment (interactive only)
	if isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd()) {
		if err := runDevenvSetup(); err != nil {
			fmt.Printf("  ⚠️  devenv setup: %v\n", err)
		}
	}

	fmt.Println()
	fmt.Println("  ▶️  suwu serve              run the server in the foreground")
	fmt.Println("  ▶️  suwu daemon start       run as a background daemon")
	return nil
}

func setupAuth(envPath string) error {
	var hostChoice string
	var password string
	var confirm string
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Bind host — who should be able to connect?").
			Options(
				huh.NewOption("127.0.0.1  (local only)", "local"),
				huh.NewOption("auto  (detect machine addresses)", "auto"),
				huh.NewOption("custom  (specific address)", "custom"),
			).
			Value(&hostChoice),
		huh.NewInput().
			Title("Set a connection password (optional)").
			Description("Leave empty to skip password protection.").
			Password(true).
			Value(&password),
		huh.NewInput().
			Title("Confirm password").
			Password(true).
			Value(&confirm),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		return fmt.Errorf("host prompt: %w", err)
	}

	var hostValue string

	switch hostChoice {
	case "local":
		hostValue = "127.0.0.1"
	case "auto":
		hostValue = "auto"
	case "custom":
		var customHost string
		inputForm := huh.NewForm(huh.NewGroup(
			huh.NewInput().
				Title("Enter the bind address (IP or hostname)").
				Placeholder("e.g. 0.0.0.0, myhost.local").
				Value(&customHost),
		)).WithTheme(huh.ThemeCatppuccin())
		if err := inputForm.Run(); err != nil {
			return fmt.Errorf("host input: %w", err)
		}
		customHost = strings.TrimSpace(customHost)
		if customHost == "" {
			return fmt.Errorf("bind address cannot be empty")
		}
		hostValue = customHost
	}

	updates := map[string]string{"HOST": hostValue}

	password = strings.TrimSpace(password)
	if password != "" {
		if confirm != password {
			return fmt.Errorf("passwords do not match")
		}
		hash := sha256.Sum256([]byte(password))
		hashHex := fmt.Sprintf("%x", hash)
		updates["AUTH_PASS"] = hashHex
		fmt.Printf("  ✅ password set (sha256: %s…)\n", hashHex[:16])
	} else {
		fmt.Println("  🔓 No password set")
	}

	if err := upsertEnv(envPath, updates); err != nil {
		return fmt.Errorf("write auth config: %w", err)
	}

	if hostValue == "127.0.0.1" {
		fmt.Println("  🔓 Binding to localhost only")
	} else if hostValue == "auto" {
		fmt.Println("  🔓 Auto-detecting machine addresses")
	} else {
		fmt.Printf("  🔐 Binding to %s\n", hostValue)
	}

	return nil
}

// generateCerts creates a self-signed TLS certificate pair signed by suwu's
// persistent local CA. It auto-detects hostnames/IPs and writes certs to
// ~/.config/suwu/, then records the paths in .env so suwu serve enables
// https automatically.
func generateCerts(home, cfgDir string) error {
	// Check if certs already exist — skip silently
	certPath := filepath.Join(cfgDir, "tls-cert.pem")
	keyPath := filepath.Join(cfgDir, "tls-key.pem")
	if _, err := os.Stat(certPath); err == nil {
		if _, err := os.Stat(keyPath); err == nil {
			fmt.Printf("  ⏭️  TLS certs already exist in %s\n", cfgDir)
			return nil
		}
	}

	hosts := certs.DetectHosts()
	if len(hosts) == 0 {
		hosts = []string{"localhost"}
	}

	fmt.Printf("  → generating TLS certs for: %s\n", strings.Join(hosts, ", "))

	// Use gencerts non-interactively: --hosts, --out, --force, --no-env
	// We write TLS paths to .env ourselves below.
	if err := gencerts.Run([]string{
		"--hosts", strings.Join(hosts, ","),
		"--out", cfgDir,
		"--force",
		"--no-env",
	}); err != nil {
		return fmt.Errorf("gencerts: %w", err)
	}

	// Record TLS paths in .env
	if err := upsertEnv(filepath.Join(cfgDir, ".env"), map[string]string{
		"TLS_CERT_FILE": certPath,
		"TLS_KEY_FILE":  keyPath,
	}); err != nil {
		return fmt.Errorf("write TLS config: %w", err)
	}

	return nil
}

// ensureLocalBinInPath adds ~/.local/bin to PATH in shell config files
// if it is not already present, and updates the current process PATH so
// subsequent exec.Command calls can find binaries there.
func ensureLocalBinInPath(home string) {
	localBin := home + "/.local/bin"
	pathLine := `export PATH="$HOME/.local/bin:$PATH"`

	// Check if already in current PATH
	alreadyInPath := false
	for _, p := range strings.Split(os.Getenv("PATH"), ":") {
		if p == localBin {
			alreadyInPath = true
			break
		}
	}

	if !alreadyInPath {
		// Shell config files to patch (first match wins)
		shellConfigs := []string{".bashrc", ".profile", ".zshrc"}
		patched := false
		for _, cfg := range shellConfigs {
			path := home + "/" + cfg
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			content := string(data)
			if strings.Contains(content, ".local/bin") {
				patched = true
				break
			}
			f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
			if err != nil {
				continue
			}
			fmt.Fprintf(f, "\n# Suwu: add ~/.local/bin to PATH\n%s\n", pathLine)
			f.Close()
			fmt.Printf("  ✅ added ~/.local/bin to PATH in ~/%s\n", cfg)
			patched = true
			break
		}

		if !patched {
			// Fallback: create ~/.profile if none exist
			path := home + "/.profile"
			f, err := os.Create(path)
			if err != nil {
				fmt.Printf("  ⚠️  could not add ~/.local/bin to PATH — add it manually\n")
			} else {
				fmt.Fprintf(f, "# Suwu: add ~/.local/bin to PATH\n%s\n", pathLine)
				f.Close()
				fmt.Printf("  ✅ created ~/.profile with ~/.local/bin in PATH\n")
			}
		}
	}

	// Update the current process PATH so exec.Command picks it up
	// immediately without needing a new shell session.
	os.Setenv("PATH", localBin+":"+os.Getenv("PATH"))
}

// ensureAsdfDataDir sets ASDF_DATA_DIR=~/.asdf in shell config and the
// current process so asdf commands work correctly.
func ensureAsdfDataDir(home string) {
	asdfDir := home + "/.asdf"
	envLine := `export ASDF_DATA_DIR="$HOME/.asdf"`

	// Already set in current process?
	if os.Getenv("ASDF_DATA_DIR") == asdfDir {
		return
	}

	// Check shell configs
	shellConfigs := []string{".bashrc", ".profile", ".zshrc"}
	for _, cfg := range shellConfigs {
		path := home + "/" + cfg
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if strings.Contains(string(data), "ASDF_DATA_DIR") {
			// Already configured — just set in current process
			os.Setenv("ASDF_DATA_DIR", asdfDir)
			return
		}
	}

	// Not found — append to first available shell config
	for _, cfg := range shellConfigs {
		path := home + "/" + cfg
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			continue
		}
		fmt.Fprintf(f, "\n# Suwu: set ASDF_DATA_DIR\n%s\n", envLine)
		f.Close()
		fmt.Printf("  ✅ set ASDF_DATA_DIR in ~/%s\n", cfg)
		os.Setenv("ASDF_DATA_DIR", asdfDir)
		return
	}

	// Fallback: create ~/.profile
	path := home + "/.profile"
	f, err := os.Create(path)
	if err != nil {
		fmt.Printf("  ⚠️  could not set ASDF_DATA_DIR — add it manually\n")
		return
	}
	fmt.Fprintf(f, "# Suwu: set ASDF_DATA_DIR\n%s\n", envLine)
	f.Close()
	fmt.Printf("  ✅ created ~/.profile with ASDF_DATA_DIR\n")
	os.Setenv("ASDF_DATA_DIR", asdfDir)
}

// upsertEnv updates keys in a dotenv file. If the key exists, its line is
// replaced; otherwise it is appended. Lines starting with '#' (comments) and
// blank lines are preserved.
func upsertEnv(path string, kv map[string]string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	lines := strings.Split(string(data), "\n")
	updated := map[string]bool{}

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		for key, val := range kv {
			// Match "KEY=" or "#KEY=" (commented out defaults)
			if strings.HasPrefix(trimmed, key+"=") || strings.HasPrefix(trimmed, "#"+key+"=") {
				lines[i] = key + "=" + val
				updated[key] = true
			}
		}
	}

	// Append any keys not yet in the file
	for key, val := range kv {
		if !updated[key] {
			lines = append(lines, key+"="+val)
		}
	}

	return os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600)
}
