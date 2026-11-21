package herdr

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestBaseName(t *testing.T) {
	home := "/home/yli"
	cases := map[string]string{
		"/home/yli":       "~",
		"/home/yli/suwu":  "suwu",
		"/":               "/",
		"":                "",
		"/home/yli/suwu/": "suwu",
		"/var/lib/../tmp": "tmp",
	}
	for cwd, want := range cases {
		if got := BaseName(filepath.Clean(cwd), home); got != want {
			t.Errorf("BaseName(%q) = %q, want %q", cwd, got, want)
		}
	}
}

func TestColourForIsStableAndInPalette(t *testing.T) {
	first := ColourFor("b1a2c3")
	if first != ColourFor("b1a2c3") {
		t.Fatal("colour must be deterministic for an id")
	}
	if ColourFor("b1a2c4") == first && len(SpaceColours) > 1 {
		// Not a hard guarantee, but a hash that never moves is useless.
		t.Log("two ids share a colour; acceptable but worth knowing")
	}
	allowed := map[string]bool{}
	for _, c := range SpaceColours {
		allowed[c] = true
	}
	if !allowed[first] {
		t.Fatalf("colour %q is not in the palette", first)
	}
}

func TestDeriveLabelPrefersRepositoryName(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	repo := t.TempDir() + "/my-project"
	if err := exec.Command("git", "init", "-q", repo).Run(); err != nil {
		t.Skipf("git init: %v", err)
	}
	nested := repo + "/src/inner"
	if err := exec.Command("mkdir", "-p", nested).Run(); err != nil {
		t.Skipf("mkdir: %v", err)
	}

	roots := newGitRootCache()
	if got := DeriveLabel(context.Background(), roots, nested, "/home/yli"); got != "my-project" {
		t.Errorf("inside a repo: %q, want the repository name", got)
	}
	plain := t.TempDir()
	if got := DeriveLabel(context.Background(), roots, plain, "/home/yli"); got != filepath.Base(plain) {
		t.Errorf("plain dir: %q, want %q", got, filepath.Base(plain))
	}
	if got := DeriveLabel(context.Background(), roots, "/home/yli", "/home/yli"); got != "~" {
		t.Errorf("home: %q, want ~", got)
	}
}

func TestDisplayName(t *testing.T) {
	roots := newGitRootCache()
	if got := DisplayName("pinned", "/somewhere", "/home/yli", roots); got != "pinned" {
		t.Errorf("custom name must win, got %q", got)
	}
	if got := DisplayName("", "/home/yli", "/home/yli", roots); got != "~" {
		t.Errorf("home fallback = %q", got)
	}
}
