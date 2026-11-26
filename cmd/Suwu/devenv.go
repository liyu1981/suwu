package main

import (
	_ "embed"
	"encoding/json"
	"fmt"

	"suwu/pkg/tools"
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
	steps := tools.ManualTools()
	if len(steps) == 0 {
		return
	}
	fmt.Println("\n  Not covered by the Suwu catalog — run these yourself (also listed in Tools):")
	for _, step := range steps {
		state := ""
		if step.Installed() {
			state = " (already installed)"
		}
		fmt.Printf("\n    %s%s — %s\n", step.Name, state, step.Summary)
		if !step.Installed() {
			fmt.Printf("      %s\n", step.Command)
		}
	}
}
