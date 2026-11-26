package tools

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ManualTools returns the non-installable tools the catalog carries.
func ManualTools() []ManualTool {
	cat, err := Builtin()
	if err != nil {
		return nil
	}
	return cat.Manual
}

// Installed reports whether the tool is already reachable. Suwu's own bin
// directory, ~/.local/bin and the asdf shims are checked in addition to PATH:
// the server may have been started before the shell exported them.
func (m ManualTool) Installed() bool {
	if m.CheckBinary != "" {
		if _, err := exec.LookPath(m.CheckBinary); err == nil {
			return true
		}
		for _, dir := range manualLookupDirs() {
			if pathIsExecutable(filepath.Join(dir, m.CheckBinary)) {
				return true
			}
		}
	}
	if m.CheckCmd != "" {
		return exec.Command("sh", "-c", m.CheckCmd).Run() == nil
	}
	return false
}

// ResolvedPath returns the detected location, or the bare name.
func (m ManualTool) ResolvedPath() string {
	if m.CheckBinary == "" {
		return m.Name
	}
	if found, err := exec.LookPath(m.CheckBinary); err == nil {
		return found
	}
	for _, dir := range manualLookupDirs() {
		candidate := filepath.Join(dir, m.CheckBinary)
		if pathIsExecutable(candidate) {
			return candidate
		}
	}
	return m.CheckBinary
}

func manualLookupDirs() []string {
	var dirs []string
	add := func(dir string) {
		if strings.TrimSpace(dir) == "" {
			return
		}
		for _, existing := range dirs {
			if existing == dir {
				return
			}
		}
		dirs = append(dirs, dir)
	}
	if data := strings.TrimSpace(os.Getenv("SUWU_VAR")); data != "" {
		add(filepath.Join(data, "bin"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		add(filepath.Join(home, ".suwu", "bin"))
		add(filepath.Join(home, ".local", "bin"))
	}
	if asdf := strings.TrimSpace(os.Getenv("ASDF_DATA_DIR")); asdf != "" {
		add(filepath.Join(asdf, "shims"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		add(filepath.Join(home, ".asdf", "shims"))
	}
	return dirs
}

func pathIsExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	return info.Mode().Perm()&0o111 != 0
}
