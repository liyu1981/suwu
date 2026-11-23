package server

// Tests for the "push commit" path: the /api/git/push-info suggestion and the
// push-commit action, against a local bare "origin".

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"suwu/pkg/auth"
)

// runGitIn runs git in dir and fails the test on error.
func runGitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git -C %s %v: %s: %v", dir, args, out, err)
	}
	return strings.TrimSpace(string(out))
}

// pushTestRepo builds a local repo with a bare "origin" remote.
func pushTestRepo(t *testing.T) (repo, remote string, run func(...string) string, put func(string, string)) {
	t.Helper()
	base := t.TempDir()
	repo = filepath.Join(base, "repo")
	remote = filepath.Join(base, "remote.git")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	runGitIn(t, base, "init", "--bare", remote)
	runGitIn(t, repo, "init")
	runGitIn(t, repo, "config", "user.name", "Test")
	runGitIn(t, repo, "config", "user.email", "test@example.invalid")
	runGitIn(t, repo, "config", "commit.gpgsign", "false")
	runGitIn(t, repo, "remote", "add", "origin", remote)

	run = func(args ...string) string { return runGitIn(t, repo, args...) }
	put = func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return repo, remote, run, put
}

func TestGitPushInfoUntracked(t *testing.T) {
	repo, _, run, put := pushTestRepo(t)
	put("a.txt", "one")
	run("add", ".")
	run("commit", "-m", "first")
	head := run("rev-parse", "HEAD")
	branch := run("branch", "--show-current")

	info, err := getGitPushInfo(repo, head)
	if err != nil {
		t.Fatal(err)
	}
	if info.Suggested.Tracking {
		t.Fatalf("expected an untracked suggestion, got %+v", info.Suggested)
	}
	if info.Suggested.LocalBranch != branch || info.Suggested.RemoteBranch != branch {
		t.Fatalf("unexpected suggestion %+v for branch %q", info.Suggested, branch)
	}
	if info.Suggested.Remote != "origin" {
		t.Fatalf("remote = %q", info.Suggested.Remote)
	}
}

func TestGitPushInfoTracking(t *testing.T) {
	repo, _, run, put := pushTestRepo(t)
	put("a.txt", "one")
	run("add", ".")
	run("commit", "-m", "first")
	branch := run("branch", "--show-current")
	head := run("rev-parse", "HEAD")
	run("push", "-u", "origin", branch)

	info, err := getGitPushInfo(repo, head)
	if err != nil {
		t.Fatal(err)
	}
	if !info.Suggested.Tracking {
		t.Fatalf("expected a tracking suggestion, got %+v", info.Suggested)
	}
	if info.Suggested.LocalBranch != branch ||
		info.Suggested.Remote != "origin" ||
		info.Suggested.RemoteBranch != branch {
		t.Fatalf("unexpected suggestion %+v", info.Suggested)
	}
}

func TestActionPushCommitUntrackedToNewBranch(t *testing.T) {
	repo, remote, run, put := pushTestRepo(t)
	put("a.txt", "one")
	run("add", ".")
	run("commit", "-m", "first")
	head := run("rev-parse", "HEAD")

	if err := actionPushCommit(repo, map[string]string{
		"hash": head, "remote": "origin", "remoteBranch": "feature",
	}); err != nil {
		t.Fatal(err)
	}
	if got := runGitIn(t, remote, "rev-parse", "refs/heads/feature"); got != head {
		t.Fatalf("remote feature = %s, want %s", got, head)
	}
}

func TestActionPushCommitTracking(t *testing.T) {
	repo, remote, run, put := pushTestRepo(t)
	put("a.txt", "one")
	run("add", ".")
	run("commit", "-m", "first")
	branch := run("branch", "--show-current")
	run("push", "-u", "origin", branch)

	put("a.txt", "two")
	run("add", ".")
	run("commit", "-m", "second")
	head := run("rev-parse", "HEAD")

	if err := actionPushCommit(repo, map[string]string{"hash": head, "localBranch": branch}); err != nil {
		t.Fatal(err)
	}
	if got := runGitIn(t, remote, "rev-parse", "refs/heads/"+branch); got != head {
		t.Fatalf("remote %s = %s, want %s", branch, got, head)
	}
}

func TestActionPushCommitUntrackedNeedsBranch(t *testing.T) {
	repo, _, run, put := pushTestRepo(t)
	put("a.txt", "one")
	run("add", ".")
	run("commit", "-m", "first")
	head := run("rev-parse", "HEAD")

	if err := actionPushCommit(repo, map[string]string{"hash": head}); err == nil {
		t.Fatal("expected an error for an untracked commit with no branch")
	}
}

func TestValidatePushName(t *testing.T) {
	if err := validatePushName("branch", "--force"); err == nil {
		t.Fatal("expected option-like names to be rejected")
	}
	if err := validatePushName("branch", "feature/x"); err != nil {
		t.Fatalf("valid branch rejected: %v", err)
	}
}

func TestGitPushInfoEndpoint(t *testing.T) {
	repo, _, run, put := pushTestRepo(t)
	put("a.txt", "one")
	run("add", ".")
	run("commit", "-m", "first")
	head := run("rev-parse", "HEAD")

	s := New(&auth.Config{Token: "test-token", AllowedHosts: []string{"localhost"}}, nil, nil, nil, nil, "")
	q := url.Values{"path": {repo}, "hash": {head}}
	r := httptest.NewRequest(http.MethodGet, "http://localhost/api/git/push-info?"+q.Encode(), nil)
	r.Header.Set("Authorization", "Bearer test-token")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("HTTP %d: %s", w.Code, w.Body.String())
	}

	var info GitPushInfo
	if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info.Hash != head || info.CurrentBranch == "" || len(info.Branches) == 0 {
		t.Fatalf("unexpected push info: %+v", info)
	}
}

// `git push origin <branch>` without `-u` leaves a remote-tracking ref and no
// upstream. Suwu used to read only the upstream, so it asked "where should this
// go?" on every push of a branch that had been pushed many times. The remote ref
// is the answer.
func TestGitPushInfoInferrsARemoteBranchWithoutUpstream(t *testing.T) {
	repo, _, run, put := pushTestRepo(t)
	put("a.txt", "one")
	run("add", ".")
	run("commit", "-m", "first")
	branch := run("branch", "--show-current")
	head := run("rev-parse", "HEAD")
	// Push without -u: the remote branch exists, the branch does not track it.
	run("push", "origin", branch)
	if out, err := exec.Command("git", "-C", repo, "config", "--get", "branch."+branch+".merge").CombinedOutput(); err == nil {
		t.Fatalf("the test needs an untracked branch, got merge=%q", strings.TrimSpace(string(out)))
	}
	// A second commit on the branch, so the suggestion is not "the tip is there".
	put("b.txt", "two")
	run("add", ".")
	run("commit", "-m", "second")
	head = run("rev-parse", "HEAD")

	info, err := getGitPushInfo(repo, head)
	if err != nil {
		t.Fatal(err)
	}
	s := info.Suggested
	if !s.Tracking || !s.Inferred {
		t.Fatalf("expected an inferred tracking suggestion, got %+v", s)
	}
	if s.Remote != "origin" || s.RemoteBranch != branch || s.LocalBranch != branch {
		t.Fatalf("unexpected suggestion %+v", s)
	}
	if s.Reason != "current-remote-exists" {
		t.Fatalf("reason %q", s.Reason)
	}
}

func TestGitPushInfoAmbiguousRemotesStillAsk(t *testing.T) {
	repo, _, run, put := pushTestRepo(t)
	// A second remote with the same branch: the destination is a real choice.
	other := filepath.Join(t.TempDir(), "other.git")
	runGitIn(t, filepath.Dir(other), "init", "--bare", other)
	run("remote", "add", "mirror", other)
	put("a.txt", "one")
	run("add", ".")
	run("commit", "-m", "first")
	branch := run("branch", "--show-current")
	head := run("rev-parse", "HEAD")
	run("push", "origin", branch)
	run("push", "mirror", branch)

	info, err := getGitPushInfo(repo, head)
	if err != nil {
		t.Fatal(err)
	}
	if info.Suggested.Tracking {
		t.Fatalf("two remotes cannot be inferred: %+v", info.Suggested)
	}
}

func TestGitPushInfoStillUntrackedForANewBranch(t *testing.T) {
	repo, _, run, put := pushTestRepo(t)
	put("a.txt", "one")
	run("add", ".")
	run("commit", "-m", "first")
	head := run("rev-parse", "HEAD")
	info, err := getGitPushInfo(repo, head)
	if err != nil {
		t.Fatal(err)
	}
	if info.Suggested.Tracking || info.Suggested.Inferred {
		t.Fatalf("a never-pushed branch must still ask: %+v", info.Suggested)
	}
}

func TestGitPushInfoPrefersAConfiguredUpstream(t *testing.T) {
	repo, _, run, put := pushTestRepo(t)
	put("a.txt", "one")
	run("add", ".")
	run("commit", "-m", "first")
	branch := run("branch", "--show-current")
	// An upstream with a *different* remote branch name wins over the
	// same-named ref, because that is what git itself would push to.
	run("push", "-u", "origin", branch+":published")
	head := run("rev-parse", "HEAD")
	info, err := getGitPushInfo(repo, head)
	if err != nil {
		t.Fatal(err)
	}
	s := info.Suggested
	if !s.Tracking || s.Inferred || s.RemoteBranch != "published" {
		t.Fatalf("unexpected suggestion %+v", s)
	}
}
