package server

import (
	"context"
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

func compareTestRepo(t *testing.T) (string, func(...string) string, func(string, string)) {
	t.Helper()
	repo := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, out, err)
		}
		return strings.TrimSpace(string(out))
	}
	put := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	run("init")
	run("config", "user.name", "Test")
	run("config", "user.email", "test@example.invalid")
	run("config", "commit.gpgsign", "false")
	return repo, run, put
}

func TestGitCompareEndpoint(t *testing.T) {
	repo, git, put := compareTestRepo(t)
	put("file.txt", "one\ntwo\nthree\n")
	git("add", ".")
	git("commit", "-m", "first")
	base := git("rev-parse", "HEAD")
	put("file.txt", "one\nnew two\nextra\nthree\n")
	git("add", ".")
	git("commit", "-m", "second")
	target := git("rev-parse", "HEAD")
	s := New(&auth.Config{Token: "test-token", AllowedHosts: []string{"localhost"}}, nil, nil, nil, nil, "")
	request := func(path string, q url.Values, out any) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "http://localhost"+path+"?"+q.Encode(), nil)
		r.Header.Set("Authorization", "Bearer test-token")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("HTTP %d: %s", w.Code, w.Body.String())
		}
		if err := json.Unmarshal(w.Body.Bytes(), out); err != nil {
			t.Fatal(err)
		}
	}
	q := url.Values{"path": {repo}, "base": {base}, "target": {target}}
	var c gitComparison
	request("/api/git/compare", q, &c)
	if c.Base != base || c.Target != target || len(c.Files) != 1 || c.Adds != 2 || c.Dels != 1 {
		t.Fatalf("unexpected comparison: %+v", c)
	}
	if c.Files[0].NewPath != "file.txt" || c.Files[0].Status != "M" {
		t.Fatalf("unexpected file: %+v", c.Files[0])
	}
	q.Set("file", c.Files[0].ID)
	var p comparePatch
	request("/api/git/compare/file", q, &p)
	if len(p.Hunks) != 1 || len(p.Hunks[0].Lines) != 5 {
		t.Fatalf("unexpected patch: %+v", p)
	}
	if line := p.Hunks[0].Lines[2]; line.Kind != "add" || line.New == nil || *line.New != 2 || line.Old != nil {
		t.Fatalf("unexpected line: %+v", line)
	}
	q.Del("base")
	request("/api/git/compare", q, &c)
	if c.Base != base {
		t.Fatalf("parent = %s", c.Base)
	}
	q.Set("target", base)
	request("/api/git/compare", q, &c)
	if c.Base != "EMPTY" || c.Adds != 3 {
		t.Fatalf("root: %+v", c)
	}
	q.Set("base", "EMPTY")
	q.Set("file", c.Files[0].ID)
	request("/api/git/compare/file", q, &p)
	if len(p.Hunks) != 1 {
		t.Fatal("root patch missing")
	}
	q.Set("base", base)
	request("/api/git/compare", q, &c)
	if len(c.Files) != 0 {
		t.Fatal("identical comparison should be empty")
	}
}

func TestGitCompareWorktreeEndpoint(t *testing.T) {
	repo, git, put := compareTestRepo(t)
	put("file.txt", "one\ntwo\n")
	git("add", ".")
	git("commit", "-m", "first")
	head := git("rev-parse", "HEAD")
	put("file.txt", "one\nchanged\n")
	put("new.txt", "untracked\n")

	s := New(&auth.Config{Token: "test-token", AllowedHosts: []string{"localhost"}}, nil, nil, nil, nil, "")
	request := func(path string, q url.Values, out any) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "http://localhost"+path+"?"+q.Encode(), nil)
		r.Header.Set("Authorization", "Bearer test-token")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("HTTP %d: %s", w.Code, w.Body.String())
		}
		if err := json.Unmarshal(w.Body.Bytes(), out); err != nil {
			t.Fatal(err)
		}
	}
	q := url.Values{"path": {repo}, "base": {head}, "target": {worktreeRef}}
	var c gitComparison
	request("/api/git/compare", q, &c)
	// The tracked modification is reported; the untracked file is excluded,
	// matching the inline UNCOMMITTED diff (`git diff HEAD`).
	if c.Base != head || c.Target != worktreeRef || len(c.Parents) != 0 {
		t.Fatalf("worktree comparison: %+v", c)
	}
	if len(c.Files) != 1 || c.Adds != 1 || c.Dels != 1 {
		t.Fatalf("worktree files: %+v", c.Files)
	}
	if c.Files[0].NewPath != "file.txt" || c.Files[0].Status != "M" {
		t.Fatalf("worktree file: %+v", c.Files[0])
	}
	q.Set("file", c.Files[0].ID)
	var p comparePatch
	request("/api/git/compare/file", q, &p)
	if len(p.Hunks) != 1 {
		t.Fatalf("worktree patch: %+v", p)
	}
}

func TestGitCompareRenamesAndMetadata(t *testing.T) {
	repo, git, put := compareTestRepo(t)
	old := "odd\tname\nold.txt"
	newPath := "odd\tname\nnew.txt"
	put(old, strings.Repeat("same content\n", 10))
	put("binary.dat", "a\x00b")
	put("mode.sh", "echo hi\n")
	git("add", ".")
	git("commit", "-m", "first")
	base := git("rev-parse", "HEAD")
	git("mv", old, newPath)
	put("binary.dat", "b\x00c")
	git("update-index", "--chmod=+x", "mode.sh")
	git("add", "binary.dat")
	git("commit", "-m", "second")
	c, err := loadComparison(context.Background(), repo, base, "HEAD", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Files) != 3 {
		t.Fatalf("files: %+v", c.Files)
	}
	for _, f := range c.Files {
		switch f.NewPath {
		case newPath:
			if f.Status != "R" || f.OldPath != old {
				t.Fatalf("rename: %+v", f)
			}
		case "binary.dat":
			if !f.Binary {
				t.Fatal("binary not detected")
			}
		case "mode.sh":
			if f.OldMode == f.NewMode {
				t.Fatal("mode change missing")
			}
		}
	}
}

func TestGitCompareMergeParents(t *testing.T) {
	repo, git, put := compareTestRepo(t)
	put("base.txt", "base\n")
	git("add", ".")
	git("commit", "-m", "base")
	branch := git("branch", "--show-current")
	git("checkout", "-b", "side")
	put("side.txt", "side\n")
	git("add", ".")
	git("commit", "-m", "side")
	side := git("rev-parse", "HEAD")
	git("checkout", branch)
	put("main.txt", "main\n")
	git("add", ".")
	git("commit", "-m", "main")
	main := git("rev-parse", "HEAD")
	git("merge", "--no-ff", "side", "-m", "merge")
	for i, expected := range []string{main, side} {
		c, err := loadComparison(context.Background(), repo, "", "HEAD", i+1)
		if err != nil {
			t.Fatal(err)
		}
		if c.Base != expected || len(c.Parents) != 2 || len(c.Files) != 1 {
			t.Fatalf("merge: %+v", c)
		}
	}
	if _, err := loadComparison(context.Background(), repo, "", "HEAD", 3); err == nil {
		t.Fatal("invalid parent accepted")
	}
	if _, err := resolveCompareCommit(context.Background(), repo, "missing-ref"); err == nil {
		t.Fatal("missing ref accepted")
	}
}

func TestCompareOutputLimitAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	b := compareOutput{limit: 2, cancel: cancel}
	if _, err := b.Write([]byte("abc")); err != errCompareLimit || ctx.Err() == nil {
		t.Fatal("output cap must cancel process")
	}
	repo, _, _ := compareTestRepo(t)
	if _, err := compareGit(ctx, repo, "status"); err == nil {
		t.Fatal("cancelled command succeeded")
	}
}
