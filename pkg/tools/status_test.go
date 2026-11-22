package tools

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"suwu/pkg/bindir"
)

func installForTest(t *testing.T, dataDir, name, version string) {
	t.Helper()
	archive := tgz(t, "p", map[string]string{name: version})
	spec := Spec{
		Name: name, Version: version,
		GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
		Archive: ArchiveTarGz, Strip: 1,
		Entries: []Entry{{File: name, Mode: "0755"}},
		SHA256:  hexSum(archive), URL: "https://example.test/" + name,
	}
	if _, err := InstallFromArchive(spec, Options{DataDir: dataDir}, bytes.NewReader(archive), int64(len(archive))); err != nil {
		t.Fatal(err)
	}
}

func TestStatusesCoverEveryState(t *testing.T) {
	cat, err := Builtin()
	if err != nil {
		t.Fatal(err)
	}
	dataDir := testDataDir(t)
	// The catalog's current version, whatever it is: a hard-coded one made this
	// test fail on every version bump instead of on a real regression.
	fzfTool, _ := cat.Find("fzf")
	installForTest(t, dataDir, "fzf", fzfTool.Version)
	installForTest(t, dataDir, "rg", "0.0.1") // older than the catalog
	// A hand-installed file with a catalog name.
	bin, _ := bindir.Ensure(dataDir)
	if err := os.WriteFile(filepath.Join(bin, "asdf"), []byte("mine"), 0o755); err != nil {
		t.Fatal(err)
	}

	list, err := Statuses(cat, runtime.GOOS, runtime.GOARCH, dataDir)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]Status{}
	for _, s := range list {
		byName[s.Name] = s
	}
	if byName["fzf"].State != StateInstalled {
		t.Errorf("fzf: %s", byName["fzf"].State)
	}
	if byName["rg"].State != StateUpdate {
		t.Errorf("rg: %s", byName["rg"].State)
	}
	if byName["asdf"].State != StateUnmanaged {
		t.Errorf("asdf: %s", byName["asdf"].State)
	}
	if byName["pig"].State != StateMissing {
		t.Errorf("pig: %s", byName["pig"].State)
	}
	// A platform the catalog does not cover is reported, not hidden.
	if runtime.GOOS != "linux" {
		if byName["witr"].State != StateUnsupported || byName["witr"].Available {
			t.Errorf("witr: %s available=%v", byName["witr"].State, byName["witr"].Available)
		}
	} else if !byName["witr"].Available {
		t.Error("witr should be available on linux")
	}
	for _, s := range list {
		if !s.Available && s.State != StateUnsupported {
			t.Errorf("%s: unavailable but state %s", s.Name, s.State)
		}
	}
}

func TestResolveExecutable(t *testing.T) {
	dataDir := testDataDir(t)
	if _, ok := ResolveExecutable(dataDir, "../sh"); ok {
		t.Fatal("a traversing name resolved")
	}
	if _, ok := ResolveExecutable(dataDir, "rg"); ok {
		t.Fatal("a missing tool resolved")
	}
	installForTest(t, dataDir, "rg", "1")
	p, ok := ResolveExecutable(dataDir, "rg")
	if !ok {
		t.Fatal("an installed tool did not resolve")
	}
	if p != filepath.Join(bindir.Dir(dataDir), "rg") {
		t.Fatalf("path %q", p)
	}
	if names, err := InstalledNames(dataDir); err != nil || len(names) != 1 || names[0] != "rg" {
		t.Fatalf("names %v %v", names, err)
	}
}
