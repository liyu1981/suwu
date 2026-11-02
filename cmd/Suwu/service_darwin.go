//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/template"
)

const launchdLabel = "com.suwu.suwu"

func hasLaunchctl() bool {
	_, err := exec.LookPath("launchctl")
	return err == nil
}

func launchdPaths() (plist string, err error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist"), nil
}

func hasLaunchdUserService() bool {
	plist, err := launchdPaths()
	if err != nil {
		return false
	}
	_, err = os.Stat(plist)
	return err == nil
}

func renderLaunchdPlist(bin, varDir, configDir string) (string, error) {
	tmpl := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{{.Label}}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{{.Bin}}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{{.ConfigDir}}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{{.VarDir}}/suwu.log</string>
  <key>StandardErrorPath</key>
  <string>{{.VarDir}}/suwu.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SUWU_BIN</key>
    <string>{{.Bin}}</string>
    <key>SUWU_VAR</key>
    <string>{{.VarDir}}</string>
    <key>SUWU_CONFIG_DIR</key>
    <string>{{.ConfigDir}}</string>
  </dict>
</dict>
</plist>
`
	t, err := template.New("plist").Parse(tmpl)
	if err != nil {
		return "", err
	}
	var buf strings.Builder
	data := struct {
		Label     string
		Bin       string
		VarDir    string
		ConfigDir string
	}{launchdLabel, bin, varDir, configDir}
	if err := t.Execute(&buf, data); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func installLaunchdService() error {
	if !hasLaunchctl() {
		return fmt.Errorf("launchctl not found")
	}
	bin, varDir, configDir, err := servicePathsDarwin()
	if err != nil {
		return err
	}
	plist, err := launchdPaths()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(plist), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(varDir, 0o755); err != nil {
		return err
	}
	content, err := renderLaunchdPlist(bin, varDir, configDir)
	if err != nil {
		return err
	}
	if err := os.WriteFile(plist, []byte(content), 0o644); err != nil {
		return err
	}
	fmt.Printf("  ✅ wrote %s\n", plist)
	uid := os.Getuid()
	domain := fmt.Sprintf("gui/%d", uid)
	// Best-effort bootout of any previous instance.
	_ = exec.Command("launchctl", "bootout", domain+"/"+launchdLabel).Run()
	if out, err := exec.Command("launchctl", "bootstrap", domain, plist).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootstrap: %s (%w)", strings.TrimSpace(string(out)), err)
	}
	_ = exec.Command("launchctl", "enable", domain+"/"+launchdLabel).Run()
	fmt.Println("  ✅ enabled launchd agent")
	return nil
}

func uninstallLaunchdService() error {
	plist, err := launchdPaths()
	if err != nil {
		return err
	}
	uid := os.Getuid()
	domain := fmt.Sprintf("gui/%d", uid)
	_ = exec.Command("launchctl", "bootout", domain+"/"+launchdLabel).Run()
	if err := os.Remove(plist); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Printf("  ✅ removed %s\n", plist)
	return nil
}

func startLaunchdService() error {
	uid := os.Getuid()
	domain := fmt.Sprintf("gui/%d", uid)
	out, err := exec.Command("launchctl", "kickstart", "-k", domain+"/"+launchdLabel).CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl kickstart: %s (%w)", strings.TrimSpace(string(out)), err)
	}
	return nil
}

func stopLaunchdService() error {
	uid := os.Getuid()
	domain := fmt.Sprintf("gui/%d", uid)
	out, err := exec.Command("launchctl", "kill", "SIGTERM", domain+"/"+launchdLabel).CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl kill: %s (%w)", strings.TrimSpace(string(out)), err)
	}
	return nil
}

func restartLaunchdService() error {
	if err := stopLaunchdService(); err != nil {
		// ignore
	}
	return startLaunchdService()
}

func statusLaunchdService() error {
	uid := os.Getuid()
	domain := fmt.Sprintf("gui/%d", uid)
	cmd := exec.Command("launchctl", "print", domain+"/"+launchdLabel)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func logsLaunchdService() error {
	home, _ := os.UserHomeDir()
	logPath := filepath.Join(home, ".suwu", "suwu.log")
	cmd := exec.Command("tail", "-f", logPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// servicePathsDarwin returns canonical paths (no systemd service file).
func servicePathsDarwin() (bin, varDir, configDir string, err error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", "", err
	}
	binPath, err := os.Executable()
	if err != nil {
		return "", "", "", err
	}
	binPath, err = filepath.EvalSymlinks(binPath)
	if err != nil {
		return "", "", "", err
	}
	varDir = filepath.Join(home, ".suwu")
	if v := os.Getenv("SUWU_VAR"); v != "" {
		varDir = v
	}
	configDir = filepath.Join(home, ".config", "suwu")
	if v := os.Getenv("SUWU_CONFIG_DIR"); v != "" {
		configDir = v
	}
	return binPath, varDir, configDir, nil
}

func hasUserService() bool        { return hasLaunchctl() }
func installUserService() error   { return installLaunchdService() }
func uninstallUserService() error { return uninstallLaunchdService() }
func startUserService() error     { return startLaunchdService() }

func userServiceRedirect(args []string) (bool, error) {
	if !hasLaunchdUserService() || len(args) == 0 {
		return false, nil
	}
	switch args[0] {
	case "start":
		return true, startLaunchdService()
	case "stop":
		return true, stopLaunchdService()
	case "restart":
		return true, restartLaunchdService()
	case "status":
		return true, statusLaunchdService()
	case "logs":
		return true, logsLaunchdService()
	case "install":
		fmt.Println("launchd service already installed")
		return true, nil
	case "uninstall":
		return true, uninstallLaunchdService()
	}
	return false, nil
}
