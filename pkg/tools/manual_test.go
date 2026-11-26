package tools

import (
	"os"
	"path/filepath"
	"testing"
)

func writeExecutable(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

// A manual tool is detected even when the server started before the shell put
// it on PATH: the managed bin dir, ~/.local/bin and the asdf shims count.
func TestManualToolDetection(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir()) // nothing of ours is on PATH
	t.Setenv("SUWU_VAR", "")
	t.Setenv("ASDF_DATA_DIR", "")

	var git ManualTool
	for _, m := range ManualTools() {
		if m.Name == "git" {
			git = m
		}
	}
	if git.Name == "" {
		t.Fatal("git is missing from the manual tools")
	}
	if git.Installed() {
		t.Fatal("git was detected before anything was installed")
	}

	writeExecutable(t, filepath.Join(home, ".asdf", "shims", "git"), 0o755)
	if !git.Installed() {
		t.Fatal("asdf shims were not probed")
	}

	writeExecutable(t, filepath.Join(home, ".suwu", "bin", "vim"), 0o755)
	var vim ManualTool
	for _, m := range ManualTools() {
		if m.Name == "vim" {
			vim = m
		}
	}
	if !vim.Installed() {
		t.Fatal("~/.suwu/bin was not probed")
	}

	// A non-executable file is not an installed tool.
	writeExecutable(t, filepath.Join(home, ".local", "bin", "pnpm"), 0o644)
	var pnpm ManualTool
	for _, m := range ManualTools() {
		if m.Name == "pnpm" {
			pnpm = m
		}
	}
	if pnpm.Installed() {
		t.Fatal("a non-executable file counted as installed")
	}
}

func TestManualStatusesCarryInstructions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir())
	t.Setenv("SUWU_VAR", "")
	t.Setenv("ASDF_DATA_DIR", "")

	cat, err := Builtin()
	if err != nil {
		t.Fatal(err)
	}
	statuses := ManualStatuses(cat)
	if len(statuses) != len(cat.Manual) {
		t.Fatalf("statuses = %d, catalog manual tools = %d", len(statuses), len(cat.Manual))
	}
	seen := map[string]bool{}
	for _, s := range statuses {
		if !s.Manual || s.Instruction == "" || s.Available {
			t.Errorf("%s: manual=%v available=%v instruction=%q", s.Name, s.Manual, s.Available, s.Instruction)
		}
		if s.State != StateManual && s.State != StateInstalled {
			t.Errorf("%s: state %s", s.Name, s.State)
		}
		if seen[s.Name] {
			t.Errorf("duplicate manual tool %s", s.Name)
		}
		seen[s.Name] = true
	}
}
