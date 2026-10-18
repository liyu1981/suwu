package server

// Tests for the commit-context pull: a checked-out branch is merged from its
// remote, an un-checked-out branch is fast-forwarded in place.

import (
	"os"
	"path/filepath"
	"testing"
)

// advanceOriginFromClone clones the bare remote, commits a file, pushes it, and
// returns the new remote head for branch.
func advanceOriginFromClone(t *testing.T, remote, branch string) string {
	t.Helper()
	parent := t.TempDir()
	clone := filepath.Join(parent, "clone")
	runGitIn(t, parent, "clone", remote, clone)
	runGitIn(t, clone, "config", "user.name", "Other")
	runGitIn(t, clone, "config", "user.email", "other@example.invalid")
	runGitIn(t, clone, "checkout", branch)
	if err := os.WriteFile(filepath.Join(clone, "b.txt"), []byte("two"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitIn(t, clone, "add", ".")
	runGitIn(t, clone, "commit", "-m", "second")
	runGitIn(t, clone, "push", "origin", branch)
	return runGitIn(t, remote, "rev-parse", "refs/heads/"+branch)
}

func TestActionPullCommitUpdatesCheckedOutBranch(t *testing.T) {
	repo, remote, run, put := pushTestRepo(t)
	put("a.txt", "one")
	run("add", ".")
	run("commit", "-m", "first")
	branch := run("branch", "--show-current")
	run("push", "-u", "origin", branch)

	remoteHead := advanceOriginFromClone(t, remote, branch)

	if err := actionPullBranch(repo, map[string]string{
		"localBranch": branch, "remote": "origin", "remoteBranch": branch,
	}); err != nil {
		t.Fatal(err)
	}
	if got := run("rev-parse", "HEAD"); got != remoteHead {
		t.Fatalf("local HEAD = %s, want %s", got, remoteHead)
	}
}

func TestActionPullCommitFastForwardsOtherBranch(t *testing.T) {
	repo, remote, run, put := pushTestRepo(t)
	put("a.txt", "one")
	run("add", ".")
	run("commit", "-m", "first")
	branch := run("branch", "--show-current")
	if branch == "feature" {
		t.Skip("default branch name collides with the fixture branch")
	}
	run("branch", "feature")
	run("push", "origin", "feature")

	remoteFeature := advanceOriginFromClone(t, remote, "feature")

	if err := actionPullBranch(repo, map[string]string{
		"localBranch": "feature", "remote": "origin", "remoteBranch": "feature",
	}); err != nil {
		t.Fatal(err)
	}
	if got := run("rev-parse", "refs/heads/feature"); got != remoteFeature {
		t.Fatalf("local feature = %s, want %s", got, remoteFeature)
	}
	// The checked-out branch must not have moved.
	if got := run("rev-parse", "HEAD"); got == remoteFeature {
		t.Fatal("checked-out branch was modified by a pull of another branch")
	}
}
