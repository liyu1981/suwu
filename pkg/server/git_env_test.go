package server

// Tests for the PATH augmentation used by every git command suwu runs. The
// server is commonly started by systemd, whose minimal PATH omits user bin
// directories, which made git fail to find git-lfs for the pre-push hook.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// pathValue extracts the PATH entry from an environment slice.
func pathValue(t *testing.T, env []string) string {
	t.Helper()
	found := ""
	count := 0
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			found = strings.TrimPrefix(kv, "PATH=")
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly one PATH entry, got %d", count)
	}
	return found
}

// TestGitEnvAddsUserToolDirs checks that existing $HOME bin directories are
// prepended to PATH and that the inherited entries survive.
func TestGitEnvAddsUserToolDirs(t *testing.T) {
	home := t.TempDir()
	localBin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(localBin, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/usr/bin:/bin")

	entries := strings.Split(pathValue(t, gitEnv()), string(os.PathListSeparator))
	if len(entries) == 0 || entries[0] != localBin {
		t.Fatalf("expected %q first, got %v", localBin, entries)
	}
	for _, want := range []string{"/usr/bin", "/bin"} {
		if !strings.Contains(strings.Join(entries, ":"), want) {
			t.Errorf("inherited PATH entry %q missing from %v", want, entries)
		}
	}
}

// TestGitEnvSkipsMissingAndDuplicateDirs checks that directories that do not
// exist are not added and that no entry appears twice.
func TestGitEnvSkipsMissingAndDuplicateDirs(t *testing.T) {
	home := t.TempDir()
	localBin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(localBin, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/usr/bin:"+localBin+":/usr/bin")

	entries := strings.Split(pathValue(t, gitEnv()), string(os.PathListSeparator))
	seen := make(map[string]int, len(entries))
	for _, entry := range entries {
		if entry == "" {
			t.Fatalf("empty PATH entry in %v", entries)
		}
		seen[entry]++
	}
	for entry, n := range seen {
		if n > 1 {
			t.Errorf("duplicate PATH entry %q in %v", entry, entries)
		}
	}
	if _, ok := seen[filepath.Join(home, "bin")]; ok {
		t.Errorf("missing directory %q should not be added: %v", filepath.Join(home, "bin"), entries)
	}
	if _, ok := seen[localBin]; !ok {
		t.Errorf("existing user dir %q missing from %v", localBin, entries)
	}
	if entries[0] != localBin {
		t.Errorf("existing user dir should move to the front, got %v", entries)
	}
}

// TestGitEnvAddsPathWhenUnset checks the append fallback when the process has
// no PATH at all.
func TestGitEnvAddsPathWhenUnset(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", "")

	got := pathValue(t, gitEnv())
	if strings.HasPrefix(got, string(os.PathListSeparator)) {
		t.Errorf("PATH must not start with a separator: %q", got)
	}
	if !strings.Contains(got, "/usr/bin") {
		t.Errorf("expected fallback system dirs in PATH, got %q", got)
	}
}

// TestNewGitCmdRootsRepo checks the command carries -C <repo> and the
// augmented environment.
func TestNewGitCmdRootsRepo(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cmd := newGitCmd("/some/repo", "status", "--short")
	if got := strings.Join(cmd.Args, " "); got != "git -C /some/repo status --short" {
		t.Errorf("unexpected args: %s", got)
	}
	if len(cmd.Env) == 0 {
		t.Error("expected env to be set")
	}
}

// TestGitSeesUserInstalledLfsHooks is the end-to-end regression test for the
// reported bug: a server started with systemd's minimal PATH failed to push
// because git could not find git-lfs from the pre-push hook. With gitEnv the
// user's ~/.local/bin is on PATH, so the hook resolves.
func TestGitSeesUserInstalledLfsHooks(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	base := t.TempDir()
	home := filepath.Join(base, "home")
	repo := filepath.Join(base, "repo")
	localBin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(localBin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}

	// A stand-in for git-lfs: the pre-push hook only has to resolve it.
	fakeLfs := filepath.Join(localBin, "git-lfs")
	if err := os.WriteFile(fakeLfs, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	runGit := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s: %v", args, out, err)
		}
	}
	runGit(repo, "init", "-q", ".")
	hook := filepath.Join(repo, ".git", "hooks", "pre-push")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\ngit-lfs pre-push \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(repo, "commit", "-q", "--allow-empty", "-m", "init")

	// Emulate the systemd-launched server: no user bin dir on PATH.
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")

	// Baseline: a bare exec.Command cannot find git-lfs, which is the bug.
	plain := exec.Command("git", "-C", repo, "push", "--dry-run", ".", "HEAD")
	plain.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
	if out, err := plain.CombinedOutput(); err == nil {
		t.Fatalf("expected the bare command to fail without git-lfs on PATH, got: %s", out)
	}

	if out, err := git(repo, "push", "--dry-run", ".", "HEAD"); err != nil {
		t.Fatalf("push via git() should find git-lfs: %s: %v", out, err)
	}
}
