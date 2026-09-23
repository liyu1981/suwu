// Command suwu agent detects installed AI coding agents and installs the
// suwu-tools skill so those agents know how to drive the running Suwu
// browser session (notifications, file/code/diff/gitgraph opening, port
// forwarding and X-display command execution).
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/mattn/go-isatty"
)

// suwuSkillName is the directory (and skill) name written under each agent's
// skills directory.
const suwuSkillName = "suwu-tools"

// agentTarget describes one agent and where it looks for project/global skills.
type agentTarget struct {
	ID     string
	Name   string
	Binary string // PATH probe; empty for the portable Agent Skills target
	// Project is the skills directory relative to the repository root.
	Project string
	// Global is the skills directory relative to the user home.
	Global string
	// Portable marks the Agent Skills specification location, which is
	// always offered even when no agent binary is detected.
	Portable bool
}

// agentTargets is the ordered list of agents offered by `suwu agent`.
// Paths follow each agent's documented skill discovery:
//   - opencode: .opencode/skills/ and ~/.config/opencode/skills/
//   - pi:       .pi/skills/ and ~/.pi/skills/
//   - Claude:   .claude/skills/ and ~/.claude/skills/
//   - portable: .agents/skills/ and ~/.agents/skills/ (Agent Skills spec)
var agentTargets = []agentTarget{
	{
		ID:      "opencode",
		Name:    "opencode",
		Binary:  "opencode",
		Project: filepath.Join(".opencode", "skills"),
		Global:  filepath.Join(".config", "opencode", "skills"),
	},
	{
		ID:      "pi",
		Name:    "pi",
		Binary:  "pi",
		Project: filepath.Join(".pi", "skills"),
		Global:  filepath.Join(".pi", "skills"),
	},
	{
		ID:      "claude",
		Name:    "Claude Code",
		Binary:  "claude",
		Project: filepath.Join(".claude", "skills"),
		Global:  filepath.Join(".claude", "skills"),
	},
	{
		ID:       "agents",
		Name:     "Agent Skills (portable)",
		Project:  filepath.Join(".agents", "skills"),
		Global:   filepath.Join(".agents", "skills"),
		Portable: true,
	},
}

// agentScope selects project-local or user-global installation.
type agentScope int

const (
	agentScopeProject agentScope = iota
	agentScopeGlobal
)

// agentStatus is the detection result for one target.
type agentStatus struct {
	target agentTarget
	found  bool
}

func agentCmd(args []string) error {
	fs := flag.NewFlagSet("agent", flag.ContinueOnError)
	fs.Usage = printAgentUsage
	var (
		listOnly  = fs.Bool("list", false, "list detected agents and exit")
		printOnly = fs.Bool("print", false, "print the suwu-tools skill to stdout and exit")
		useGlobal = fs.Bool("global", false, "install to user-global skill directories")
		force     = fs.Bool("force", false, "overwrite an existing skill file")
		agentIDs  = fs.String("agent", "", "comma-separated agent ids to install for (default: detected agents)")
		root      = fs.String("dir", "", "repository root (default: detected from the current directory)")
	)
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q; run 'suwu help agent'", fs.Arg(0))
	}

	if *printOnly {
		fmt.Print(suwuToolsSkill)
		return nil
	}

	statuses := detectAgents()
	printAgentStatus(statuses)
	if *listOnly {
		return nil
	}

	repoRoot, err := resolveRepoRoot(*root)
	if err != nil {
		return err
	}

	selected, err := parseAgentSelection(*agentIDs)
	if err != nil {
		return err
	}

	interactive := isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd())
	if len(selected) == 0 {
		if !interactive {
			return fmt.Errorf("no agent selected and no interactive terminal; pass --agent <id> (see 'suwu agent --list')")
		}
		selected, err = selectAgents(statuses)
		if err != nil {
			return err
		}
	}
	if len(selected) == 0 {
		fmt.Println("  No agents selected. Nothing to do.")
		return nil
	}

	scope := agentScopeProject
	if *useGlobal {
		scope = agentScopeGlobal
	} else if interactive {
		scope, err = selectAgentScope()
		if err != nil {
			return err
		}
	}

	type install struct {
		name string
		path string
	}
	installs := make([]install, 0, len(selected))
	for _, st := range statuses {
		if !containsString(selected, st.target.ID) {
			continue
		}
		path, err := skillPath(st.target, scope, repoRoot)
		if err != nil {
			return err
		}
		installs = append(installs, install{name: st.target.Name, path: path})
	}

	// Collect existing files so an overwrite is an explicit decision.
	var existing []string
	for _, in := range installs {
		if _, err := os.Stat(in.path); err == nil {
			existing = append(existing, in.path)
		}
	}
	if len(existing) > 0 && !*force {
		if !interactive {
			return fmt.Errorf("skill already installed (use --force to overwrite): %s", strings.Join(existing, ", "))
		}
		overwrite := false
		form := huh.NewForm(huh.NewGroup(
			huh.NewConfirm().
				Title(fmt.Sprintf("%d skill file(s) already exist. Overwrite?", len(existing))).
				Description(strings.Join(existing, "\n")).
				Affirmative("Overwrite").
				Negative("Cancel").
				Value(&overwrite),
		)).WithTheme(tuiTheme())
		if err := form.Run(); err != nil {
			return fmt.Errorf("overwrite confirmation: %w", err)
		}
		if !overwrite {
			fmt.Println("  Cancelled. No changes were made.")
			return nil
		}
	}

	for _, in := range installs {
		if err := writeSkill(in.path, suwuToolsSkill); err != nil {
			return fmt.Errorf("install for %s: %w", in.name, err)
		}
		fmt.Printf("  ✅ %-28s %s\n", in.name, in.path)
	}
	fmt.Printf("\n  Installed the %q skill for %d agent(s).\n", suwuSkillName, len(installs))
	return nil
}

func printAgentUsage() {
	fmt.Print(`Usage: suwu agent [flags]

Detect popular AI coding agents (opencode, pi, Claude Code, …) and install
the suwu-tools skill so they can drive the running Suwu browser session.

With no flags an interactive TUI asks which detected agents to install for
and whether the skill goes into this repository or the user-global directory.
Without a terminal, pass --agent to select non-interactively.

Flags:
  --list            list detected agents and exit
  --print           print the suwu-tools skill to stdout and exit
  --agent <ids>     comma-separated agent ids to install for
                    (opencode, pi, claude, agents)
  --global          install to user-global skill directories
  --force           overwrite an existing skill file
  --dir <path>      repository root (default: detected from the cwd)

Examples:
  suwu agent                 # detect, then install via TUI
  suwu agent --list          # show which agents are installed
  suwu agent --agent pi,opencode
  suwu agent --agent claude --global
  suwu agent --print > /tmp/suwu-tools.md
`)
}

// detectAgents probes PATH for each target's binary.
func detectAgents() []agentStatus {
	statuses := make([]agentStatus, 0, len(agentTargets))
	for _, target := range agentTargets {
		found := false
		if target.Binary != "" {
			if _, err := exec.LookPath(target.Binary); err == nil {
				found = true
			}
		}
		statuses = append(statuses, agentStatus{target: target, found: found})
	}
	return statuses
}

func printAgentStatus(statuses []agentStatus) {
	fmt.Println()
	fmt.Println("  ── AI coding agents ──")
	for _, st := range statuses {
		mark, detail := "❌", "not found"
		switch {
		case st.found:
			mark, detail = "✅", "found"
		case st.target.Portable:
			mark, detail = "•", "always available"
		}
		fmt.Printf("    %s %-28s %s\n", mark, st.target.Name, detail)
	}
	fmt.Println()
}

// selectAgents runs the multi-select TUI. Detected agents are pre-selected;
// when nothing is detected the portable target is pre-selected instead.
func selectAgents(statuses []agentStatus) ([]string, error) {
	anyFound := false
	for _, st := range statuses {
		if st.found {
			anyFound = true
		}
	}

	options := make([]huh.Option[string], 0, len(statuses))
	for _, st := range statuses {
		label := st.target.Name
		if st.found {
			label += " — detected"
		}
		selected := st.found || (!anyFound && st.target.Portable)
		options = append(options, huh.NewOption(label, st.target.ID).Selected(selected))
	}

	var selected []string
	form := huh.NewForm(huh.NewGroup(
		huh.NewMultiSelect[string]().
			Title("Install the suwu-tools skill for which agents?").
			Description("Detected agents are pre-selected. Space toggles, enter confirms.").
			Options(options...).
			Value(&selected),
	)).WithTheme(tuiTheme())
	if err := form.Run(); err != nil {
		return nil, fmt.Errorf("agent selection: %w", err)
	}
	return selected, nil
}

func selectAgentScope() (agentScope, error) {
	scope := "project"
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Where should the suwu-tools skill be installed?").
			Options(
				huh.NewOption("This repository (project-local)", "project"),
				huh.NewOption("User-global (all repositories)", "global"),
			).
			Value(&scope),
	)).WithTheme(tuiTheme())
	if err := form.Run(); err != nil {
		return agentScopeProject, fmt.Errorf("scope selection: %w", err)
	}
	if scope == "global" {
		return agentScopeGlobal, nil
	}
	return agentScopeProject, nil
}

// skillPath resolves the SKILL.md path for a target and scope.
func skillPath(target agentTarget, scope agentScope, repoRoot string) (string, error) {
	if scope == agentScopeGlobal {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		return filepath.Join(home, target.Global, suwuSkillName, "SKILL.md"), nil
	}
	return filepath.Join(repoRoot, target.Project, suwuSkillName, "SKILL.md"), nil
}

func writeSkill(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

// resolveRepoRoot returns dir, or walks up from the working directory to the
// nearest ancestor containing a .git entry. Falls back to the start directory.
func resolveRepoRoot(dir string) (string, error) {
	start := dir
	if start == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return "", fmt.Errorf("resolve working directory: %w", err)
		}
		start = cwd
	}
	abs, err := filepath.Abs(start)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", start, err)
	}
	for cur := abs; ; {
		if _, err := os.Stat(filepath.Join(cur, ".git")); err == nil {
			return cur, nil
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return abs, nil
		}
		cur = parent
	}
}

// parseAgentSelection maps a comma-separated id list to a deduplicated,
// validated slice. An empty string yields nil (meaning "ask the TUI").
func parseAgentSelection(csv string) ([]string, error) {
	if strings.TrimSpace(csv) == "" {
		return nil, nil
	}
	known := make(map[string]bool, len(agentTargets))
	for _, target := range agentTargets {
		known[target.ID] = true
	}
	seen := make(map[string]bool)
	var out []string
	for _, part := range strings.Split(csv, ",") {
		id := strings.ToLower(strings.TrimSpace(part))
		if id == "" {
			continue
		}
		if !known[id] {
			return nil, fmt.Errorf("unknown agent %q; valid ids: %s", id, strings.Join(agentIDs(), ", "))
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

func agentIDs() []string {
	ids := make([]string, 0, len(agentTargets))
	for _, target := range agentTargets {
		ids = append(ids, target.ID)
	}
	return ids
}

func containsString(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}
