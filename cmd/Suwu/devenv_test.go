package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTool(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), mode); err != nil {
		t.Fatal(err)
	}
	// WriteFile honours the umask; force the mode the test cares about.
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func TestBinaryExistsProbesSuwuBinEnv(t *testing.T) {
	dir := t.TempDir()
	writeTool(t, filepath.Join(dir, "suwu-max-tool-env"), 0o755)
	writeTool(t, filepath.Join(dir, "suwu-max-tool-noexec"), 0o644)
	t.Setenv("SUWU_BIN", dir)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ASDF_DATA_DIR", "")

	if !binaryExists("suwu-max-tool-env") {
		t.Fatal("an executable in SUWU_BIN must be detected")
	}
	if binaryExists("suwu-max-tool-noexec") {
		t.Fatal("a non-executable file must not count as installed")
	}
	if binaryExists("suwu-max-tool-missing") {
		t.Fatal("a missing tool must not count as installed")
	}
}

func TestBinaryExistsProbesDefaultSuwuBin(t *testing.T) {
	home := t.TempDir()
	writeTool(t, filepath.Join(home, ".suwu", "bin", "suwu-max-tool-default"), 0o755)
	t.Setenv("HOME", home)
	t.Setenv("SUWU_BIN", "")
	t.Setenv("ASDF_DATA_DIR", "")

	if !binaryExists("suwu-max-tool-default") {
		t.Fatal("~/.suwu/bin must be probed even without SUWU_BIN")
	}
}

func TestBinaryExistsProbesAsdfShims(t *testing.T) {
	data := t.TempDir()
	writeTool(t, filepath.Join(data, "shims", "suwu-max-tool-shim"), 0o755)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUWU_BIN", "")
	t.Setenv("ASDF_DATA_DIR", data)

	if !binaryExists("suwu-max-tool-shim") {
		t.Fatal("asdf shims must be probed")
	}
}

func TestEnvWithToolDirsPrependsSuwuBin(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SUWU_BIN", dir)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ASDF_DATA_DIR", "")

	env := envWithToolDirs()
	want := "PATH=" + dir + string(os.PathListSeparator)
	found := false
	for _, kv := range env {
		if strings.HasPrefix(kv, want) {
			found = true
		}
	}
	if !found {
		t.Fatalf("PATH does not start with %q: %v", dir, env)
	}
}
