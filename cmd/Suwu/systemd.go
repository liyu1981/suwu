package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/template"
)

// systemdServiceTemplate is the unit file for the Suwu user service.
// ExecStart uses the absolute path to the binary so systemd can find it
// even without a login session. Environment variables mirror the ones the
// daemon script sets so `suwu serve` behaves the same way.
const systemdServiceTemplate = `[Unit]
Description=Suwu Terminal Server
After=network.target

[Service]
Type=simple
ExecStart={{.Bin}} serve
Restart=on-failure
RestartSec=2
Environment=SUWU_BIN={{.Bin}}
Environment=SUWU_VAR={{.VarDir}}
Environment=SUWU_CONFIG_DIR={{.ConfigDir}}

[Install]
WantedBy=default.target
`

// servicePaths returns the canonical paths used by the systemd integration.
func servicePaths() (bin, varDir, configDir, serviceFile string, err error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", "", "", fmt.Errorf("resolve home: %w", err)
	}

	binPath, err := os.Executable()
	if err != nil {
		return "", "", "", "", fmt.Errorf("resolve executable: %w", err)
	}
	binPath, err = filepath.EvalSymlinks(binPath)
	if err != nil {
		return "", "", "", "", fmt.Errorf("resolve symlinks: %w", err)
	}

	varDir = filepath.Join(home, ".suwu")
	if v := os.Getenv("SUWU_VAR"); v != "" {
		varDir = v
	}

	configDir = filepath.Join(home, ".config", "suwu")
	if v := os.Getenv("SUWU_CONFIG_DIR"); v != "" {
		configDir = v
	}

	serviceDir := filepath.Join(home, ".config", "systemd", "user")
	serviceFile = filepath.Join(serviceDir, "suwu.service")

	return binPath, varDir, configDir, serviceFile, nil
}

// hasSystemctl returns true if the systemctl binary is in PATH.
func hasSystemctl() bool {
	_, err := exec.LookPath("systemctl")
	return err == nil
}

// hasSystemdUserService returns true if the service file is installed.
func hasSystemdUserService() bool {
	_, _, _, serviceFile, err := servicePaths()
	if err != nil {
		return false
	}
	_, err = os.Stat(serviceFile)
	return err == nil
}

// isLingerEnabled returns true if loginctl linger is enabled for the current
// user. When linger is on, the user's systemd instance starts at boot (before
// any login), so services like suwu start automatically.
func isLingerEnabled() bool {
	user := os.Getenv("USER")
	if user == "" {
		return false
	}
	_, err := os.Stat(filepath.Join("/var/lib/systemd/linger", user))
	return err == nil
}

// installSystemdService writes the service file, reloads the daemon, enables
// the service, and enables linger so it starts on boot.
func installSystemdService() error {
	bin, varDir, configDir, serviceFile, err := servicePaths()
	if err != nil {
		return err
	}

	// Ensure the service directory exists.
	serviceDir := filepath.Dir(serviceFile)
	if err := os.MkdirAll(serviceDir, 0o755); err != nil {
		return fmt.Errorf("create systemd user dir: %w", err)
	}

	// Render the service file from the template.
	tmpl, err := template.New("service").Parse(systemdServiceTemplate)
	if err != nil {
		return fmt.Errorf("parse template: %w", err)
	}

	f, err := os.Create(serviceFile)
	if err != nil {
		return fmt.Errorf("write service file: %w", err)
	}
	defer f.Close()

	data := struct{ Bin, VarDir, ConfigDir string }{bin, varDir, configDir}
	if err := tmpl.Execute(f, data); err != nil {
		f.Close()
		return fmt.Errorf("render service file: %w", err)
	}
	f.Close()
	fmt.Printf("  ✅ wrote %s\n", serviceFile)

	// Reload systemd, enable, and optionally start.
	for _, args := range [][]string{
		{"systemctl", "--user", "daemon-reload"},
		{"systemctl", "--user", "enable", "suwu"},
	} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			return fmt.Errorf("%s: %s (%w)", strings.Join(args, " "), strings.TrimSpace(string(out)), err)
		}
	}
	fmt.Println("  ✅ enabled suwu.service")

	// Enable linger so the service starts at boot without a login session.
	if !isLingerEnabled() {
		user := os.Getenv("USER")
		// Try without sudo first; fall back to sudo if needed.
		if out, err := exec.Command("loginctl", "enable-linger", user).CombinedOutput(); err != nil {
			if out2, err2 := exec.Command("sudo", "loginctl", "enable-linger", user).CombinedOutput(); err2 != nil {
				fmt.Printf("  ⚠️  could not enable linger: %s\n", strings.TrimSpace(string(out2)))
				fmt.Println("     service will start on login but not on boot")
			} else {
				_ = out2
				fmt.Println("  ✅ enabled linger (service starts on boot)")
			}
		} else {
			_ = out
			fmt.Println("  ✅ enabled linger (service starts on boot)")
		}
	} else {
		fmt.Println("  ✅ linger already enabled")
	}

	return nil
}

// uninstallSystemdService stops the service, disables it, removes the file,
// and reloads the daemon.
func uninstallSystemdService() error {
	_, _, _, serviceFile, err := servicePaths()
	if err != nil {
		return err
	}

	// Best-effort stop and disable — ignore errors if not running.
	_ = exec.Command("systemctl", "--user", "stop", "suwu").Run()
	_ = exec.Command("systemctl", "--user", "disable", "suwu").Run()

	if err := os.Remove(serviceFile); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove service file: %w", err)
	}
	fmt.Printf("  ✅ removed %s\n", serviceFile)

	if out, err := exec.Command("systemctl", "--user", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("daemon-reload: %s (%w)", strings.TrimSpace(string(out)), err)
	}

	return nil
}

// systemctlUser runs a systemctl --user command and forwards stdout/stderr.
func systemctlUser(args ...string) error {
	fullArgs := append([]string{"--user"}, args...)
	cmd := exec.Command("systemctl", fullArgs...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// journalctlUser follows the suwu service logs via journalctl --user.
func journalctlUser() error {
	cmd := exec.Command("journalctl", "--user", "-u", "suwu", "-f")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
