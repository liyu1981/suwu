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
