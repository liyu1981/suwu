package bindir

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrependProcessPATH(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "bin")
	sep := string(os.PathListSeparator)

	// A directory that does not exist is not added.
	t.Setenv("PATH", "/usr/bin"+sep+"/bin")
	if PrependProcessPATH(dir) {
		t.Fatal("added a directory that does not exist")
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if !PrependProcessPATH(dir) {
		t.Fatal("did not add an existing directory")
	}
	if got := os.Getenv("PATH"); got != dir+sep+"/usr/bin"+sep+"/bin" {
		t.Fatalf("PATH = %q", got)
	}
	// Idempotent: a second call is a no-op, not a second entry.
	if PrependProcessPATH(dir) {
		t.Fatal("added a directory that was already first")
	}
	if got := os.Getenv("PATH"); strings.Count(got, dir) != 1 {
		t.Fatalf("duplicate entry: %q", got)
	}
}

func TestPrependProcessPATHWithEmptyPATH(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "")
	if !PrependProcessPATH(dir) {
		t.Fatal("did not set PATH")
	}
	if got := os.Getenv("PATH"); got != dir {
		t.Fatalf("PATH = %q", got)
	}
}

// The optional shell setup writes the tool-specific line, not a PATH block:
// fzf needs its completion script evaluated, asdf needs its shims on PATH.
func TestToolSetupWritesTheToolSpecificLine(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	bashrc := filepath.Join(home, ".bashrc")
	fishrc := filepath.Join(home, ".config", "fish", "config.fish")
	if err := os.WriteFile(bashrc, []byte("export EDITOR=vim\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(fishrc), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fishrc, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := EnsureToolSetup("nope"); err == nil {
		t.Fatal("unknown tool setup was accepted")
	}
	if _, err := EnsureToolSetup("fzf"); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(bashrc)
	if !strings.Contains(string(body), FzfBlock.Start) || !strings.Contains(string(body), `eval "$(fzf --bash)"`) {
		t.Fatalf("fzf bash setup missing:\n%s", body)
	}
	if !strings.Contains(string(body), "export EDITOR=vim") {
		t.Fatal("unrelated content lost")
	}
	fish, _ := os.ReadFile(fishrc)
	if !strings.Contains(string(fish), "fzf --fish | source") {
		t.Fatalf("fzf fish setup missing:\n%s", fish)
	}

	if _, err := EnsureToolSetup("asdf"); err != nil {
		t.Fatal(err)
	}
	body, _ = os.ReadFile(bashrc)
	if !strings.Contains(string(body), AsdfBlock.Start) || !strings.Contains(string(body), `export PATH="${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$PATH"`) {
		t.Fatalf("asdf setup missing:\n%s", body)
	}

	files, err := ToolSetupFiles("fzf")
	if err != nil || len(files) != 2 {
		t.Fatalf("fzf setup files = %v (%v), want bashrc and fish", files, err)
	}
	if _, err := RemoveToolSetup("fzf"); err != nil {
		t.Fatal(err)
	}
	body, _ = os.ReadFile(bashrc)
	if strings.Contains(string(body), FzfBlock.Start) {
		t.Fatalf("fzf setup not removed:\n%s", body)
	}
	if !strings.Contains(string(body), AsdfBlock.Start) {
		t.Fatal("removing fzf also removed the asdf setup")
	}
}
