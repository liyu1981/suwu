package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

//go:embed devenv-checklist.json
var devenvChecklistJSON string

type checklistItem struct {
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	Category        string         `json:"category"`
	DefaultSelected bool           `json:"default_selected"`
	Hidden          bool           `json:"hidden,omitempty"`
	Description     string         `json:"description"`
	CheckBinary     string         `json:"check_binary"`
	CheckCmd        string         `json:"check_cmd,omitempty"`
	Depends         string         `json:"depends,omitempty"`
	InstallCmd      string         `json:"install_cmd,omitempty"`
	PostInstallCmd  string         `json:"post_install_cmd,omitempty"`
	GitHubRelease   *githubRelease `json:"github_release,omitempty"`
}

type githubRelease struct {
	Repo          string `json:"repo"`
	AssetPattern  string `json:"asset_pattern"`
	ExtractBinary string `json:"extract_binary"`
	ArchOverride  string `json:"arch_override,omitempty"`
	// InstallLocalBin prefers ~/.local/bin (created as needed) over
	// /usr/local/bin, which usually requires root.
	InstallLocalBin bool `json:"install_to_local_bin,omitempty"`
	// TagPrefix matches releases whose tags carry the conventional "v"
	// prefix (e.g. junegunn/fzf v0.44.0). It defaults to true; set it to
	// false for projects like BurntSushi/ripgrep whose tags are bare
	// versions (15.2.0), since download URLs omit the "v".
	TagPrefix *bool `json:"tag_prefix,omitempty"`
}

func loadChecklist() ([]checklistItem, error) {
	var items []checklistItem
	if err := json.Unmarshal([]byte(devenvChecklistJSON), &items); err != nil {
		return nil, fmt.Errorf("parse checklist: %w", err)
	}
	return items, nil
}

// catalogTools maps a checklist entry onto the name of the same tool in
// tools/catalog.json. Everything else in the checklist is not managed by Suwu,
// so onboarding prints it as a manual step instead of installing it.
var catalogTools = map[string]string{
	"ripgrep": "rg",
	"fzf":     "fzf",
	"asdf":    "asdf",
	"witr":    "witr",
	"pig":     "pig",
	"herdr":   "herdr",
	"fresh":   "fresh",
	"lazygit": "lazygit",
	"oxker":   "oxker",
}

// catalogChecklist returns the checklist entries the Tools screen can install.
func catalogChecklist(items []checklistItem) []checklistItem {
	var out []checklistItem
	for _, item := range items {
		if _, ok := catalogTools[item.ID]; ok {
			out = append(out, item)
		}
	}
	return out
}

// manualSetupStep is one checklist entry that Suwu does not install. Onboarding
// shows it as an instruction for the user to run.
type manualSetupStep struct {
	Name        string
	Description string
	Command     string
	Installed   bool
}

// manualSetupSteps returns every checklist entry outside the tool catalog,
// with its install command so onboarding can print it verbatim.
func manualSetupSteps() ([]manualSetupStep, error) {
	items, err := loadChecklist()
	if err != nil {
		return nil, err
	}
	installed := detectDevenvTools(items)
	var steps []manualSetupStep
	for _, item := range items {
		if _, ok := catalogTools[item.ID]; ok {
			continue
		}
		command := strings.TrimSpace(item.InstallCmd)
		if command == "" {
			command = "install " + item.Name + " with your package manager"
		}
		steps = append(steps, manualSetupStep{
			Name:        item.Name,
			Description: item.Description,
			Command:     command,
			Installed:   installed[item.ID],
		})
	}
	return steps, nil
}

// toolDirs lists the directories where Suwu itself may have installed tools,
// in probe order:
//
//   - SUWU_BIN — set by the suwu-max launcher to its extraction directory;
//   - the running binary's own directory (suwu-max lives in ~/.suwu/bin);
//   - ~/.suwu/bin — the suwu-max install target, even when another suwu is
//     running from elsewhere;
//   - asdf shims — after `asdf install` a shim may exist on disk but not yet be
//     on the current shell's PATH.
//
// Onboarding must see these because the rc PATH patch only affects new shells,
// and `suwu-max --no-path` skips it entirely.
func toolDirs() []string {
	var dirs []string
	add := func(dir string) {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			return
		}
		for _, existing := range dirs {
			if existing == dir {
				return
			}
		}
		dirs = append(dirs, dir)
	}
	add(os.Getenv("SUWU_BIN"))
	if exe, err := os.Executable(); err == nil {
		add(filepath.Dir(exe))
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		add(filepath.Join(home, ".suwu", "bin"))
	}
	add(asdfShimsDir())
	return dirs
}

// isExecutableFile reports whether file is a regular executable. On Windows
// the mode bits are not meaningful, so existence is enough there.
func isExecutableFile(file string) bool {
	info, err := os.Stat(file)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode()&0o111 != 0
}

func binaryExists(name string) bool {
	if strings.TrimSpace(name) == "" {
		return false
	}
	if _, err := exec.LookPath(name); err == nil {
		return true
	}
	for _, dir := range toolDirs() {
		if isExecutableFile(filepath.Join(dir, name)) {
			return true
		}
	}
	return false
}

// asdfShimsDir returns the asdf shims directory, checking ASDF_DATA_DIR first
// then falling back to ~/.asdf/shims.
func asdfShimsDir() string {
	if dir := os.Getenv("ASDF_DATA_DIR"); dir != "" {
		return dir + "/shims"
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		return home + "/.asdf/shims"
	}
	return ""
}

// envWithToolDirs returns os.Environ() with the tool directories (including
// ~/.suwu/bin and asdf shims) prepended to PATH, so a check command can find
// binaries that are installed but not yet on the current shell's PATH.
func envWithToolDirs() []string {
	dirs := toolDirs()
	if len(dirs) == 0 {
		return os.Environ()
	}
	sep := string(os.PathListSeparator)
	path := strings.Join(dirs, sep) + sep + os.Getenv("PATH")
	env := make([]string, 0, len(os.Environ())+1)
	env = append(env, "PATH="+path)
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "PATH=") {
			env = append(env, e)
		}
	}
	return env
}

func detectDevenvTools(items []checklistItem) map[string]bool {
	installed := make(map[string]bool, len(items))
	for _, item := range items {
		if item.CheckBinary != "" {
			installed[item.ID] = binaryExists(item.CheckBinary)
		} else if item.CheckCmd != "" {
			cmd := exec.Command("bash", "-c", item.CheckCmd)
			cmd.Env = envWithToolDirs()
			installed[item.ID] = cmd.Run() == nil
		}
	}
	return installed
}

// printOnboardTools is the development-tools section of onboarding. Suwu no
// longer installs tools there: the Tools screen owns the catalog, and anything
// outside the catalog is an instruction the user runs themselves.
func printOnboardTools() {
	items, err := loadChecklist()
	if err != nil {
		fmt.Printf("\n  ⚠️  could not read the development-tools checklist: %v\n", err)
		return
	}
	fmt.Println("\n  ── development tools ──")
	fmt.Println("\n  Managed by Suwu (install them from Tools in the menu, or run 'suwu tools install <name>'):")
	for _, item := range catalogChecklist(items) {
		fmt.Printf("    %-12s %s\n", catalogTools[item.ID], item.Description)
	}
	steps, err := manualSetupSteps()
	if err != nil {
		fmt.Printf("\n  ⚠️  could not read the manual setup steps: %v\n", err)
		return
	}
	if len(steps) == 0 {
		return
	}
	fmt.Println("\n  Not covered by the Suwu catalog — run these yourself:")
	for _, step := range steps {
		state := ""
		if step.Installed {
			state = " (already installed)"
		}
		fmt.Printf("\n    %s%s — %s\n", step.Name, state, step.Description)
		if !step.Installed {
			fmt.Printf("      %s\n", step.Command)
		}
	}
}
