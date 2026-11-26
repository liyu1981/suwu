package tools

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ManualTool is a tool Suwu cannot install because it is not a single binary:
// a package-manager install, a language runtime, or an npm global. The Tools
// screen still lists it, detects whether it is already on PATH and shows the
// command the user has to run. It never gets an Install button.
type ManualTool struct {
	Name    string `json:"name"`
	Label   string `json:"label"`
	Summary string `json:"summary"`
	// Command is the instruction shown verbatim in the UI and in onboarding.
	Command string `json:"command"`
	// CheckBinary is the executable that proves the tool is present.
	CheckBinary string `json:"-"`
	// CheckCmd is the fallback for tools without a single binary.
	CheckCmd string `json:"-"`
}

// manualTools is the onboarding-era list that the tool catalog does not cover.
// It lives here, beside the catalog, so the Tools screen and `suwu onboard
// --tools` cannot drift apart.
var manualTools = []ManualTool{
	{
		Name:        "git",
		Label:       "git",
		Summary:     "Version control system.",
		CheckBinary: "git",
		Command:     "if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y git; elif command -v dnf >/dev/null 2>&1; then dnf install -y git; elif command -v yum >/dev/null 2>&1; then yum install -y git; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm git; elif command -v apk >/dev/null 2>&1; then apk add git; else echo 'install git with your package manager' && exit 1; fi",
	},
	{
		Name:        "vim",
		Label:       "vim",
		Summary:     "Terminal text editor.",
		CheckBinary: "vim",
		Command:     "if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y vim; elif command -v dnf >/dev/null 2>&1; then dnf install -y vim-enhanced; elif command -v yum >/dev/null 2>&1; then yum install -y vim-enhanced; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm vim; elif command -v apk >/dev/null 2>&1; then apk add vim; else echo 'install vim with your package manager' && exit 1; fi",
	},
	{
		Name:        "nodejs",
		Label:       "nodejs",
		Summary:     "Node.js LTS via asdf (install asdf from the catalog first).",
		CheckBinary: "node",
		Command:     "asdf plugin add nodejs https://github.com/asdf-vm/asdf-nodejs.git && asdf install nodejs 24.21.0 && asdf set -u nodejs 24.21.0 && asdf reshim nodejs",
	},
	{
		Name:        "pnpm",
		Label:       "pnpm",
		Summary:     "Frontend package manager.",
		CheckBinary: "pnpm",
		Command:     "curl -fsSL https://get.pnpm.io/install.sh | sh -",
	},
	{
		Name:        "pi",
		Label:       "pi",
		Summary:     "Minimal terminal AI coding agent.",
		CheckBinary: "pi",
		Command:     "npm install -g @mariozechner/pi-coding-agent && asdf reshim",
	},
	{
		Name:        "opencode",
		Label:       "opencode",
		Summary:     "AI coding assistant for the terminal.",
		CheckBinary: "opencode",
		Command:     "curl -fsSL https://opencode.ai/install | bash",
	},
}

// ManualTools returns the tools Suwu can only instruct the user to install.
func ManualTools() []ManualTool {
	out := make([]ManualTool, len(manualTools))
	copy(out, manualTools)
	return out
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
