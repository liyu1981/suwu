package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentTargetsAreUniqueAndComplete(t *testing.T) {
	seen := map[string]bool{}
	for _, target := range agentTargets {
		if target.ID == "" || target.Name == "" {
			t.Errorf("agent target has empty id/name: %+v", target)
		}
		if seen[target.ID] {
			t.Errorf("duplicate agent id %q", target.ID)
		}
		seen[target.ID] = true
		if target.Project == "" || target.Global == "" {
			t.Errorf("%s: project/global dirs must be set", target.ID)
		}
		if target.Portable && target.Binary != "" {
			t.Errorf("%s: portable target must not have a binary probe", target.ID)
		}
		if !target.Portable && target.Binary == "" {
			t.Errorf("%s: non-portable target needs a binary probe", target.ID)
		}
	}
}

func TestParseAgentSelection(t *testing.T) {
	got, err := parseAgentSelection(" pi , opencode,pi ")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"pi", "opencode"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("parseAgentSelection = %v, want %v", got, want)
	}

	if got, err := parseAgentSelection(""); err != nil || got != nil {
		t.Errorf("empty selection = %v, %v; want nil, nil", got, err)
	}

	if _, err := parseAgentSelection("pi,nope"); err == nil {
		t.Error("expected an error for an unknown agent id")
	}
}

func TestSkillPathProjectAndGlobal(t *testing.T) {
	repo := t.TempDir()
	var opencode agentTarget
	for _, target := range agentTargets {
		if target.ID == "opencode" {
			opencode = target
		}
	}
	if opencode.ID == "" {
		t.Fatal("opencode target missing")
	}

	project, err := skillPath(opencode, agentScopeProject, repo)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(repo, ".opencode", "skills", suwuSkillName, "SKILL.md")
	if project != want {
		t.Errorf("project path = %q, want %q", project, want)
	}

	global, err := skillPath(opencode, agentScopeGlobal, repo)
	if err != nil {
		t.Fatal(err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	wantGlobal := filepath.Join(home, ".config", "opencode", "skills", suwuSkillName, "SKILL.md")
	if global != wantGlobal {
		t.Errorf("global path = %q, want %q", global, wantGlobal)
	}
}

func TestWriteSkillCreatesNestedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a", "b", "SKILL.md")
	if err := writeSkill(path, "hello"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" {
		t.Errorf("content = %q, want hello", data)
	}
	// Overwrite works.
	if err := writeSkill(path, "world"); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(path)
	if string(data) != "world" {
		t.Errorf("content = %q, want world", data)
	}
}

func TestResolveRepoRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "frontend", "src")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := resolveRepoRoot(nested)
	if err != nil {
		t.Fatal(err)
	}
	// macOS temp dirs are symlinked; compare resolved paths.
	wantResolved, _ := filepath.EvalSymlinks(root)
	gotResolved, _ := filepath.EvalSymlinks(got)
	if gotResolved != wantResolved {
		t.Errorf("resolveRepoRoot = %q, want %q", gotResolved, wantResolved)
	}

	// No .git anywhere up the chain (within the temp dir) still returns an
	// absolute path rather than failing.
	lonely := filepath.Join(t.TempDir(), "x")
	if err := os.MkdirAll(lonely, 0o755); err != nil {
		t.Fatal(err)
	}
	if got, err := resolveRepoRoot(lonely); err != nil || !filepath.IsAbs(got) {
		t.Errorf("resolveRepoRoot(no .git) = %q, %v; want absolute path", got, err)
	}
}

func TestSuwuToolsSkillContent(t *testing.T) {
	if !strings.HasPrefix(suwuToolsSkill, "---\n") {
		t.Fatal("skill must start with YAML frontmatter")
	}
	for _, want := range []string{
		"name: suwu-tools",
		"description:",
		"suwu send",
		"suwu open",
		"suwu code",
		"suwu diff",
		"suwu gitgraph",
		"suwu forward",
		"suwu use",
		"--sock",
		"--proto",
		"--stop",
		"--list",
	} {
		if !strings.Contains(suwuToolsSkill, want) {
			t.Errorf("skill is missing %q", want)
		}
	}
}
