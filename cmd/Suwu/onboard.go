package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/mattn/go-isatty"

	"suwu/pkg/certs"
	"suwu/pkg/envfile"
	"suwu/pkg/gencerts"
)

// envExample is the default ~/.config/suwu/.env template written by onboard.
const envExample = `# Suwu user-global configuration.
# Values already present in the shell environment take precedence over this file.

# Dev mode: set to true for air hot-reload defaults (port 8000, dev banner).
#SUWU_DEV=false

# Bind address (default 127.0.0.1). Use 0.0.0.0 to expose on all interfaces.
# Use "auto" to auto-detect machine addresses.
HOST=127.0.0.1

# Server mode: https, http, or https+http (default https).
SERVER_MODE=https

# HTTPS and HTTP listener ports.
HTTPS_PORT=8181
HTTP_PORT=8180

# Extra hostnames/IPs accepted in Host and Origin headers.
# Example: EXTRA_HOSTS=terminal.example.com,*.lan.example
#EXTRA_HOSTS=

# Data directory for logs and PID (default ~/.suwu).
#SUWU_VAR=

# Password hash (sha256 hex). Required for web access and configured by
# 'suwu onboard' (the plaintext password is shown once at the end).
#AUTH_PASS=

# TLS certificates for the default HTTPS mode. Onboarding generates a pair
# automatically; run 'suwu gencerts' to regenerate or set both paths explicitly.
# Browsers expose clipboard APIs on secure contexts, so HTTPS is recommended
# for non-localhost access.
#TLS_CERT_FILE=
#TLS_KEY_FILE=
`

type onboardProfile string

const (
	profileLocal  onboardProfile = "local"
	profileLAN    onboardProfile = "lan"
	profileProxy  onboardProfile = "proxy"
	profileCustom onboardProfile = "custom"
)

type onboardPlan struct {
	home, cfgDir, envPath string
	profile               onboardProfile
	host                  string
	mode                  string
	httpsPort             int
	httpPort              int
	extraHosts            string
	sessionTTL            time.Duration
	varDir                string
	password              string
	authHash              string
	existingAuth          bool
	generateTLS           bool
	certFile              string
	keyFile               string
	installService        bool
	startService          bool
	shellIntegration      bool
	devenv                devenvPlan
	existingService       bool
	legacyKeys            []string
}

func onboard() error {
	if err := requireInteractiveOnboarding(); err != nil {
		return err
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve home: %w", err)
	}
	cfgDir := filepath.Join(home, ".config", "suwu")
	envPath := filepath.Join(cfgDir, ".env")
	values, err := readOnboardEnv(envPath)
	if err != nil {
		return fmt.Errorf("read existing configuration: %w", err)
	}

	plan := onboardPlan{
		home:            home,
		cfgDir:          cfgDir,
		envPath:         envPath,
		profile:         profileLocal,
		host:            envValue(values, "HOST", "127.0.0.1"),
		mode:            envValue(values, "SERVER_MODE", "https"),
		httpsPort:       onboardPort(envValue(values, "HTTPS_PORT", "8181"), 8181),
		httpPort:        onboardPort(envValue(values, "HTTP_PORT", "8180"), 8180),
		extraHosts:      values["EXTRA_HOSTS"],
		sessionTTL:      onboardDuration(envValue(values, "SESSION_TTL", "24h"), 24*time.Hour),
		varDir:          envValue(values, "SUWU_VAR", filepath.Join(home, ".suwu")),
		authHash:        values["AUTH_PASS"],
		existingAuth:    values["AUTH_PASS"] != "",
		certFile:        values["TLS_CERT_FILE"],
		keyFile:         values["TLS_KEY_FILE"],
		existingService: hasSystemdUserService(),
	}
	if plan.certFile == "" {
		plan.certFile = filepath.Join(cfgDir, "tls-cert.pem")
	}
	if plan.keyFile == "" {
		plan.keyFile = filepath.Join(cfgDir, "tls-key.pem")
	}
	if plan.mode != "https" && plan.mode != "http" && plan.mode != "https+http" {
		plan.mode = "https"
	}
	plan.legacyKeys = findLegacyOnboardKeys(values)

	printOnboardPreflight(plan)

	if err := collectOnboardProfile(&plan); err != nil {
		return err
	}
	if err := collectOnboardServer(&plan); err != nil {
		return err
	}
	if err := collectOnboardAuth(&plan); err != nil {
		return err
	}
	if err := collectOnboardTLS(&plan); err != nil {
		return err
	}
	if err := collectOnboardRuntime(&plan); err != nil {
		return err
	}
	devenv, err := collectDevenvPlan()
	if err != nil {
		return err
	}
	plan.devenv = devenv
	if err := collectOnboardShellIntegration(&plan); err != nil {
		return err
	}

	confirmed, err := reviewOnboardPlan(&plan)
	if err != nil {
		return err
	}
	if !confirmed {
		fmt.Println("\n  Onboarding cancelled. No changes were made.")
		return nil
	}

	return executeOnboardPlan(plan)
}

func requireInteractiveOnboarding() error {
	stdinTTY := isatty.IsTerminal(os.Stdin.Fd()) || isatty.IsCygwinTerminal(os.Stdin.Fd())
	stdoutTTY := isatty.IsTerminal(os.Stdout.Fd()) || isatty.IsCygwinTerminal(os.Stdout.Fd())
	if !stdinTTY || !stdoutTTY {
		return fmt.Errorf("suwu onboard requires an interactive terminal; run 'suwu onboard' from a terminal session")
	}
	return nil
}

func readOnboardEnv(path string) (map[string]string, error) {
	values := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return values, nil
		}
		return nil, err
	}
	defer f.Close()
	if err := envfile.LoadFrom(f, func(key, value string) { values[key] = value }); err != nil {
		return nil, err
	}
	return values, nil
}

func envValue(values map[string]string, key, fallback string) string {
	if value := strings.TrimSpace(values[key]); value != "" {
		return value
	}
	return fallback
}

func onboardPort(value string, fallback int) int {
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return fallback
	}
	return port
}

func onboardDuration(value string, fallback time.Duration) time.Duration {
	duration, err := time.ParseDuration(value)
	if err != nil || duration <= 0 {
		return fallback
	}
	return duration
}

func findLegacyOnboardKeys(values map[string]string) []string {
	legacy := []string{"PORT", "HTTP_ENABLED", "NO_TLS", "SUWU_PASSWORD"}
	var found []string
	for _, key := range legacy {
		if values[key] != "" {
			found = append(found, key)
		}
	}
	return found
}

func printOnboardPreflight(plan onboardPlan) {
	fmt.Println("\nSuwu onboarding")
	fmt.Println("\n  Preflight")
	if _, err := os.Stat(plan.envPath); err == nil {
		fmt.Printf("    ✅ existing configuration: %s\n", plan.envPath)
	} else {
		fmt.Printf("    ℹ️  new configuration: %s\n", plan.envPath)
	}
	if plan.existingAuth {
		fmt.Println("    ✅ existing authentication hash found")
	} else {
		fmt.Println("    ⚠️  no authentication password configured")
	}
	if _, err := os.Stat(plan.certFile); err == nil {
		if _, keyErr := os.Stat(plan.keyFile); keyErr == nil {
			fmt.Println("    ✅ existing TLS certificate pair found")
		} else {
			fmt.Println("    ⚠️  TLS certificate exists without its key")
		}
	} else {
		fmt.Println("    ℹ️  TLS certificate pair will be generated or selected")
	}
	if plan.existingService {
		fmt.Println("    ✅ existing systemd user service found")
	} else if hasSystemctl() {
		fmt.Println("    ℹ️  systemd user service is available")
	} else {
		fmt.Println("    ℹ️  systemd is not available")
	}
	if len(plan.legacyKeys) > 0 {
		fmt.Printf("    ⚠️  legacy configuration keys found: %s\n", strings.Join(plan.legacyKeys, ", "))
	}
}

func collectOnboardProfile(plan *onboardPlan) error {
	choice := string(plan.profile)
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("How will you access Suwu?").
			Options(
				huh.NewOption("Local workstation — localhost only", string(profileLocal)),
				huh.NewOption("LAN access — other devices on this network", string(profileLAN)),
				huh.NewOption("Reverse proxy — TLS terminates outside Suwu", string(profileProxy)),
				huh.NewOption("Advanced configuration", string(profileCustom)),
			).
			Value(&choice),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		return fmt.Errorf("profile prompt: %w", err)
	}
	plan.profile = onboardProfile(choice)
	switch plan.profile {
	case profileLocal:
		plan.host, plan.mode = "127.0.0.1", "https"
	case profileLAN:
		plan.host, plan.mode = "auto", "https"
	case profileProxy:
		plan.host, plan.mode = "127.0.0.1", "http"
	}
	return nil
}

func collectOnboardServer(plan *onboardPlan) error {
	hostChoice := "custom"
	switch plan.host {
	case "127.0.0.1":
		hostChoice = "local"
	case "auto":
		hostChoice = "auto"
	}
	mode := plan.mode
	httpsPort := strconv.Itoa(plan.httpsPort)
	httpPort := strconv.Itoa(plan.httpPort)
	extraHosts := plan.extraHosts
	ttl := plan.sessionTTL.String()
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Bind host — who should be able to connect?").
			Options(
				huh.NewOption("127.0.0.1 — local only", "local"),
				huh.NewOption("auto — detect machine addresses", "auto"),
				huh.NewOption("custom — enter an address", "custom"),
			).
			Value(&hostChoice),
		huh.NewSelect[string]().
			Title("Server mode").
			Options(
				huh.NewOption("HTTPS — recommended", "https"),
				huh.NewOption("HTTP — reverse proxy or trusted local network", "http"),
				huh.NewOption("HTTPS + HTTP — expose both listeners", "https+http"),
			).
			Value(&mode),
		huh.NewInput().Title("HTTPS port").Value(&httpsPort),
		huh.NewInput().Title("HTTP port").Value(&httpPort),
		huh.NewInput().Title("Extra hosts (comma-separated, optional)").Value(&extraHosts),
		huh.NewInput().Title("Detached session timeout").Description("Go duration, for example 24h or 30m").Value(&ttl),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		return fmt.Errorf("server settings prompt: %w", err)
	}
	if hostChoice == "local" {
		plan.host = "127.0.0.1"
	} else if hostChoice == "auto" {
		plan.host = "auto"
	} else {
		var customHost string
		customForm := huh.NewForm(huh.NewGroup(
			huh.NewInput().Title("Enter the bind address").Placeholder("0.0.0.0 or myhost.local").Value(&customHost),
		)).WithTheme(huh.ThemeCatppuccin())
		if err := customForm.Run(); err != nil {
			return fmt.Errorf("custom host prompt: %w", err)
		}
		plan.host = strings.TrimSpace(customHost)
		if plan.host == "" {
			return fmt.Errorf("bind address cannot be empty")
		}
	}
	var err error
	plan.httpsPort, err = parseOnboardPortInput(httpsPort, "HTTPS_PORT")
	if err != nil {
		return err
	}
	plan.httpPort, err = parseOnboardPortInput(httpPort, "HTTP_PORT")
	if err != nil {
		return err
	}
	if mode == "https+http" && plan.httpsPort == plan.httpPort {
		return fmt.Errorf("HTTPS_PORT and HTTP_PORT must be different in dual-listener mode")
	}
	plan.mode = mode
	plan.extraHosts = strings.TrimSpace(extraHosts)
	plan.sessionTTL, err = time.ParseDuration(strings.TrimSpace(ttl))
	if err != nil || plan.sessionTTL <= 0 {
		return fmt.Errorf("invalid session timeout %q", ttl)
	}
	return nil
}

func parseOnboardPortInput(value, name string) (int, error) {
	port, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("%s must be an integer from 1 to 65535", name)
	}
	return port, nil
}

func collectOnboardAuth(plan *onboardPlan) error {
	mode := "generated"
	options := []huh.Option[string]{
		huh.NewOption("Generate a secure password", "generated"),
		huh.NewOption("Choose a password", "custom"),
	}
	if plan.existingAuth {
		options = append([]huh.Option[string]{huh.NewOption("Keep the existing password", "keep")}, options...)
		mode = "keep"
	}
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().Title("Connection password").Options(options...).Value(&mode),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		return fmt.Errorf("authentication prompt: %w", err)
	}
	if mode == "keep" {
		plan.password = ""
		return nil
	}
	if mode == "generated" {
		password, err := generatePassword()
		if err != nil {
			return fmt.Errorf("generate password: %w", err)
		}
		plan.password = password
		plan.authHash = hashPassword(password)
		return nil
	}
	var password, confirm string
	form = huh.NewForm(huh.NewGroup(
		huh.NewInput().Title("Set a connection password").Description("Use at least 12 characters.").EchoMode(huh.EchoModePassword).Value(&password),
		huh.NewInput().Title("Confirm password").EchoMode(huh.EchoModePassword).Value(&confirm),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		return fmt.Errorf("password prompt: %w", err)
	}
	password = strings.TrimSpace(password)
	if len(password) < 12 {
		return fmt.Errorf("password must be at least 12 characters")
	}
	if password != confirm {
		return fmt.Errorf("passwords do not match")
	}
	plan.password = password
	plan.authHash = hashPassword(password)
	return nil
}

func collectOnboardTLS(plan *onboardPlan) error {
	if plan.mode == "http" {
		plan.generateTLS = false
		return nil
	}
	existing := fileExists(plan.certFile) && fileExists(plan.keyFile)
	mode := "generate"
	options := []huh.Option[string]{huh.NewOption("Generate a local certificate", "generate")}
	if existing {
		options = append([]huh.Option[string]{huh.NewOption("Use the existing certificate pair", "keep")}, options...)
		mode = "keep"
	}
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().Title("TLS certificate setup").Options(options...).Value(&mode),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		return fmt.Errorf("TLS prompt: %w", err)
	}
	if mode == "keep" {
		plan.generateTLS = false
		return nil
	}
	plan.generateTLS = true
	return nil
}

func collectOnboardRuntime(plan *onboardPlan) error {
	varDirChoice := "home"
	if plan.varDir == "/var/log/suwu" {
		varDirChoice = "system"
	} else if plan.varDir != filepath.Join(plan.home, ".suwu") {
		varDirChoice = "custom"
	}
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Where should logs and PID files live?").
			Options(
				huh.NewOption("~/.suwu — recommended, no sudo needed", "home"),
				huh.NewOption("/var/log/suwu — system-wide", "system"),
				huh.NewOption("Custom directory", "custom"),
			).
			Value(&varDirChoice),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		return fmt.Errorf("data directory prompt: %w", err)
	}
	switch varDirChoice {
	case "home":
		plan.varDir = filepath.Join(plan.home, ".suwu")
	case "system":
		plan.varDir = "/var/log/suwu"
	case "custom":
		var custom string
		customForm := huh.NewForm(huh.NewGroup(
			huh.NewInput().Title("Enter the data directory").Value(&custom),
		)).WithTheme(huh.ThemeCatppuccin())
		if err := customForm.Run(); err != nil {
			return fmt.Errorf("data directory prompt: %w", err)
		}
		plan.varDir = strings.TrimSpace(custom)
		if plan.varDir == "" {
			return fmt.Errorf("data directory cannot be empty")
		}
	}

	if hasSystemctl() {
		install := !plan.existingService
		form = huh.NewForm(huh.NewGroup(
			huh.NewConfirm().Title("Install a systemd user service?").Description("Suwu can restart automatically and start on login.").Value(&install),
		)).WithTheme(huh.ThemeCatppuccin())
		if err := form.Run(); err != nil {
			return fmt.Errorf("service prompt: %w", err)
		}
		plan.installService = install && !plan.existingService
		start := plan.installService
		form = huh.NewForm(huh.NewGroup(
			huh.NewConfirm().Title("Start the Suwu service after setup?").Value(&start),
		)).WithTheme(huh.ThemeCatppuccin())
		if err := form.Run(); err != nil {
			return fmt.Errorf("service start prompt: %w", err)
		}
		plan.startService = start
	}
	return nil
}

func collectOnboardShellIntegration(plan *onboardPlan) error {
	apply := true
	form := huh.NewForm(huh.NewGroup(
		huh.NewConfirm().
			Title("Apply shell integration?").
			Description("Add ~/.local/bin and asdf shims to your shell configuration.").
			Value(&apply),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		return fmt.Errorf("shell integration prompt: %w", err)
	}
	plan.shellIntegration = apply
	return nil
}

func printOnboardReview(plan onboardPlan) {
	fmt.Println("\n  ── review onboarding plan ──")
	fmt.Printf("\n  Server\n    Profile:        %s\n    Bind:           %s\n    Mode:           %s\n    HTTPS port:     %d\n    HTTP port:      %d\n    Session TTL:    %s\n", plan.profile, plan.host, plan.mode, plan.httpsPort, plan.httpPort, plan.sessionTTL)
	fmt.Printf("    Extra hosts:    %s\n", valueOrDash(plan.extraHosts))
	fmt.Printf("\n  Security\n    Password:       %s\n", passwordReview(plan))
	if plan.mode == "http" {
		fmt.Println("    TLS:            terminated by reverse proxy")
	} else if plan.generateTLS {
		fmt.Printf("    TLS:            generate %s\n", plan.certFile)
	} else {
		fmt.Printf("    TLS:            keep %s\n", plan.certFile)
	}
	fmt.Printf("\n  Runtime\n    Data directory: %s\n    Systemd:        %s\n    Start service:  %s\n    Shell changes:  %s\n", plan.varDir, yesNo(plan.installService || plan.existingService), yesNo(plan.startService), yesNo(plan.shellIntegration))
	fmt.Println("\n  Advanced tools")
	selected := selectedDevenvNames(plan.devenv)
	if len(selected) == 0 {
		fmt.Println("    none selected")
	} else {
		fmt.Printf("    %s\n", strings.Join(selected, ", "))
	}
	if len(plan.legacyKeys) > 0 {
		fmt.Printf("\n  ⚠️  Legacy keys will be reviewed during configuration write: %s\n", strings.Join(plan.legacyKeys, ", "))
	}
}

func reviewOnboardPlan(plan *onboardPlan) (bool, error) {
	for {
		printOnboardReview(*plan)
		var action string
		form := huh.NewForm(huh.NewGroup(
			huh.NewSelect[string]().
				Title("What would you like to do?").
				Options(
					huh.NewOption("Execute this plan", "execute"),
					huh.NewOption("Edit a section", "edit"),
					huh.NewOption("Cancel without changes", "cancel"),
				).
				Value(&action),
		)).WithTheme(huh.ThemeCatppuccin())
		if err := form.Run(); err != nil {
			return false, fmt.Errorf("review action: %w", err)
		}
		switch action {
		case "execute":
			var confirmed bool
			confirmForm := huh.NewForm(huh.NewGroup(
				huh.NewConfirm().
					Title("Execute this onboarding plan now?").
					Affirmative("Execute").
					Negative("Back").
					Value(&confirmed),
			)).WithTheme(huh.ThemeCatppuccin())
			if err := confirmForm.Run(); err != nil {
				return false, fmt.Errorf("final confirmation: %w", err)
			}
			if confirmed {
				return true, nil
			}
		case "edit":
			if err := editOnboardSection(plan); err != nil {
				return false, err
			}
		case "cancel":
			return false, nil
		}
	}
}

func editOnboardSection(plan *onboardPlan) error {
	var section string
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Which section should be edited?").
			Options(
				huh.NewOption("Deployment profile and server settings", "server"),
				huh.NewOption("Authentication", "auth"),
				huh.NewOption("TLS", "tls"),
				huh.NewOption("Runtime and service", "runtime"),
				huh.NewOption("Development tools", "tools"),
				huh.NewOption("Shell integration", "shell"),
			).
			Value(&section),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		return fmt.Errorf("edit section prompt: %w", err)
	}
	switch section {
	case "server":
		if err := collectOnboardProfile(plan); err != nil {
			return err
		}
		return collectOnboardServer(plan)
	case "auth":
		return collectOnboardAuth(plan)
	case "tls":
		return collectOnboardTLS(plan)
	case "runtime":
		return collectOnboardRuntime(plan)
	case "tools":
		devenv, err := collectDevenvPlan()
		if err == nil {
			plan.devenv = devenv
		}
		return err
	case "shell":
		return collectOnboardShellIntegration(plan)
	default:
		return fmt.Errorf("unknown onboarding section %q", section)
	}
}

func selectedDevenvNames(plan devenvPlan) []string {
	var names []string
	for _, item := range plan.Items {
		if item.Category == "advanced" && plan.Selected[item.ID] {
			names = append(names, item.Name)
		}
	}
	return names
}

func passwordReview(plan onboardPlan) string {
	if plan.password != "" {
		return "new password will be shown once after success"
	}
	return "existing password retained"
}

func valueOrDash(value string) string {
	if strings.TrimSpace(value) == "" {
		return "—"
	}
	return value
}

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

func executeOnboardPlan(plan onboardPlan) error {
	const total = 7
	step := 0
	warnings := []string{}
	runStep := func(label string, action func() error) error {
		step++
		started := time.Now()
		fmt.Printf("\n  [%d/%d] %s...\n", step, total, label)
		if err := action(); err != nil {
			fmt.Printf("    ❌ failed after %s: %v\n", time.Since(started).Round(time.Millisecond), err)
			return err
		}
		fmt.Printf("    ✅ done (%s)\n", time.Since(started).Round(time.Millisecond))
		return nil
	}

	if err := runStep("Preparing configuration", func() error {
		if err := os.MkdirAll(plan.cfgDir, 0o700); err != nil {
			return err
		}
		if err := os.MkdirAll(plan.varDir, 0o755); err != nil {
			return fmt.Errorf("create data directory %s: %w", plan.varDir, err)
		}
		if data, err := os.ReadFile(plan.envPath); err == nil {
			backup := plan.envPath + ".backup-" + time.Now().Format("20060102-150405")
			if err := os.WriteFile(backup, data, 0o600); err != nil {
				return fmt.Errorf("backup configuration: %w", err)
			}
			fmt.Printf("    backup: %s\n", backup)
		} else if !os.IsNotExist(err) {
			return err
		}
		if _, err := os.Stat(plan.envPath); os.IsNotExist(err) {
			if err := os.WriteFile(plan.envPath, []byte(envExample), 0o600); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}

	if plan.generateTLS {
		if err := runStep("Generating TLS certificate", func() error {
			hosts := onboardingTLSHosts(plan)
			fmt.Printf("    hosts: %s\n", strings.Join(hosts, ", "))
			return generateCerts(plan.cfgDir, hosts)
		}); err != nil {
			return err
		}
	} else {
		step++
		fmt.Printf("\n  [%d/%d] TLS certificate generation... skipped\n", step, total)
	}

	if err := runStep("Writing server configuration", func() error {
		values := map[string]string{
			"HOST":        plan.host,
			"SERVER_MODE": plan.mode,
			"HTTPS_PORT":  strconv.Itoa(plan.httpsPort),
			"HTTP_PORT":   strconv.Itoa(plan.httpPort),
			"EXTRA_HOSTS": plan.extraHosts,
			"SESSION_TTL": plan.sessionTTL.String(),
			"SUWU_VAR":    plan.varDir,
		}
		if plan.authHash != "" {
			values["AUTH_PASS"] = plan.authHash
		}
		if plan.mode != "http" {
			values["TLS_CERT_FILE"] = plan.certFile
			values["TLS_KEY_FILE"] = plan.keyFile
		}
		if err := upsertEnv(plan.envPath, values); err != nil {
			return err
		}
		if err := removeLegacyOnboardKeys(plan.envPath); err != nil {
			return err
		}
		os.Setenv("HOST", plan.host)
		os.Setenv("SERVER_MODE", plan.mode)
		os.Setenv("HTTPS_PORT", strconv.Itoa(plan.httpsPort))
		os.Setenv("HTTP_PORT", strconv.Itoa(plan.httpPort))
		os.Setenv("SUWU_VAR", plan.varDir)
		if plan.mode != "http" {
			os.Setenv("TLS_CERT_FILE", plan.certFile)
			os.Setenv("TLS_KEY_FILE", plan.keyFile)
		}
		return nil
	}); err != nil {
		return err
	}

	if err := runStep("Applying shell integration", func() error {
		if !plan.shellIntegration {
			fmt.Println("    skipped by user")
			return nil
		}
		ensureLocalBinInPath(plan.home, true)
		ensureAsdfDataDir(plan.home, true)
		return nil
	}); err != nil {
		return err
	}

	if err := runStep("Installing development tools", func() error {
		if err := installDevenvPlan(plan.devenv); err != nil {
			warnings = append(warnings, err.Error())
		}
		return nil
	}); err != nil {
		return err
	}

	if err := runStep("Configuring background service", func() error {
		if !plan.installService && !plan.startService {
			fmt.Println("    skipped by user")
			return nil
		}
		if plan.installService {
			if err := installSystemdService(); err != nil {
				return err
			}
		}
		if plan.startService {
			if err := systemctlUser("start", "suwu"); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}

	if err := runStep("Verifying setup", func() error {
		return verifyOnboardPlan(plan)
	}); err != nil {
		return err
	}

	fmt.Println("\n  ✅ Suwu onboarding complete")
	if plan.password != "" {
		fmt.Println("\n  🔐 Your new connection password (save it securely; it will not be shown again):")
		fmt.Printf("     \033[1;97;44m %s \033[0m\n", plan.password)
	} else {
		fmt.Println("\n  🔐 Existing connection password retained")
	}
	fmt.Printf("\n  Open: %s://%s:%d\n", onboardScheme(plan.mode), displayOnboardHost(plan.host), onboardDisplayPort(plan))
	fmt.Println("  ▶️  suwu daemon status")
	fmt.Println("  ▶️  suwu daemon logs")
	if len(warnings) > 0 {
		fmt.Println("\n  ⚠️  Warnings:")
		for _, warning := range warnings {
			fmt.Printf("     - %s\n", warning)
		}
	}
	return nil
}

func onboardingTLSHosts(plan onboardPlan) []string {
	seen := map[string]bool{}
	hosts := []string{}
	add := func(host string) {
		host = strings.TrimSpace(host)
		if host != "" && host != "auto" && !seen[host] {
			seen[host] = true
			hosts = append(hosts, host)
		}
	}
	for _, host := range certs.DetectHosts() {
		add(host)
	}
	if plan.host != "auto" {
		add(plan.host)
	}
	for _, host := range strings.Split(plan.extraHosts, ",") {
		add(host)
	}
	if len(hosts) == 0 {
		hosts = []string{"localhost"}
	}
	return hosts
}

func generateCerts(cfgDir string, hosts []string) error {
	if err := gencerts.Run([]string{
		"--hosts", strings.Join(hosts, ","),
		"--out", cfgDir,
		"--force",
		"--no-env",
	}); err != nil {
		return fmt.Errorf("gencerts: %w", err)
	}
	return nil
}

func verifyOnboardPlan(plan onboardPlan) error {
	if plan.authHash == "" && !plan.existingAuth {
		return fmt.Errorf("no authentication password is configured")
	}
	if plan.authHash != "" && len(plan.authHash) != sha256.Size*2 {
		return fmt.Errorf("authentication hash is not a SHA-256 hex value")
	}
	if plan.mode != "http" {
		if !fileExists(plan.certFile) || !fileExists(plan.keyFile) {
			return fmt.Errorf("TLS certificate pair is incomplete")
		}
		if _, err := tls.LoadX509KeyPair(plan.certFile, plan.keyFile); err != nil {
			return fmt.Errorf("TLS certificate and key do not match: %w", err)
		}
	}
	if _, err := os.Stat(plan.varDir); err != nil {
		return fmt.Errorf("data directory %s: %w", plan.varDir, err)
	}
	if plan.startService {
		if err := systemctlUser("is-active", "--quiet", "suwu"); err != nil {
			return fmt.Errorf("suwu systemd service is not active: %w", err)
		}
	}
	return nil
}

func onboardScheme(mode string) string {
	if mode == "http" {
		return "http"
	}
	return "https"
}

func displayOnboardHost(host string) string {
	if host == "auto" || host == "0.0.0.0" || host == "::" {
		return "localhost"
	}
	return host
}

func onboardDisplayPort(plan onboardPlan) int {
	if plan.mode == "http" {
		return plan.httpPort
	}
	return plan.httpsPort
}

func hashPassword(password string) string {
	hash := sha256.Sum256([]byte(password))
	return fmt.Sprintf("%x", hash)
}

func generatePassword() (string, error) {
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// ensureLocalBinInPath adds ~/.local/bin to PATH in shell config files when
// persist is true, and always updates the current process PATH.
func ensureLocalBinInPath(home string, persist bool) {
	localBin := home + "/.local/bin"
	pathLine := `export PATH="$HOME/.local/bin:$PATH"`
	alreadyInPath := false
	for _, p := range strings.Split(os.Getenv("PATH"), ":") {
		if p == localBin {
			alreadyInPath = true
			break
		}
	}
	if persist && !alreadyInPath {
		for _, cfg := range []string{".bashrc", ".profile", ".zshrc"} {
			path := home + "/" + cfg
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			if strings.Contains(string(data), ".local/bin") {
				alreadyInPath = true
				break
			}
			f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
			if err == nil {
				fmt.Fprintf(f, "\n# Suwu: add ~/.local/bin to PATH\n%s\n", pathLine)
				f.Close()
				fmt.Printf("    added ~/.local/bin to ~/%s\n", cfg)
				alreadyInPath = true
				break
			}
		}
	}
	if !alreadyInPath && persist {
		path := home + "/.profile"
		if f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
			fmt.Fprintf(f, "# Suwu: add ~/.local/bin to PATH\n%s\n", pathLine)
			f.Close()
			fmt.Println("    added ~/.local/bin to ~/.profile")
		}
	}
	os.Setenv("PATH", localBin+":"+os.Getenv("PATH"))
}

// ensureAsdfDataDir configures asdf for the current process and optionally
// persists the setting in a shell profile.
func ensureAsdfDataDir(home string, persist bool) {
	asdfDir := home + "/.asdf"
	envLine := `export ASDF_DATA_DIR="$HOME/.asdf"`
	os.Setenv("ASDF_DATA_DIR", asdfDir)
	if !persist {
		return
	}
	for _, cfg := range []string{".bashrc", ".profile", ".zshrc"} {
		path := home + "/" + cfg
		data, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(data), "ASDF_DATA_DIR") {
			return
		}
		if err != nil {
			continue
		}
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
		if err == nil {
			fmt.Fprintf(f, "\n# Suwu: set ASDF_DATA_DIR\n%s\n", envLine)
			f.Close()
			fmt.Printf("    set ASDF_DATA_DIR in ~/%s\n", cfg)
			return
		}
	}
}

func upsertEnv(path string, kv map[string]string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	updated := map[string]bool{}
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		for key, value := range kv {
			if strings.HasPrefix(trimmed, key+"=") || strings.HasPrefix(trimmed, "#"+key+"=") {
				lines[i] = key + "=" + formatOnboardEnvValue(value)
				updated[key] = true
			}
		}
	}
	for key, value := range kv {
		if !updated[key] {
			lines = append(lines, key+"="+formatOnboardEnvValue(value))
		}
	}
	content := strings.Join(lines, "\n") + "\n"
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func formatOnboardEnvValue(value string) string {
	if strings.ContainsAny(value, " \t#\"'") {
		return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
	}
	return value
}

func removeLegacyOnboardKeys(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	legacy := map[string]bool{
		"PORT":          true,
		"HTTP_ENABLED":  true,
		"NO_TLS":        true,
		"SUWU_PASSWORD": true,
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		key := trimmed
		if strings.HasPrefix(key, "export ") {
			key = strings.TrimSpace(strings.TrimPrefix(key, "export "))
		}
		if index := strings.IndexByte(key, '='); index >= 0 {
			key = strings.TrimSpace(key[:index])
		}
		if legacy[key] {
			continue
		}
		kept = append(kept, line)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(strings.Join(kept, "\n")+"\n"), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
