package maxbundle

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"testing/fstest"
)

// buildBundle makes an in-memory payload for the current platform.
func buildBundle(t *testing.T, version string, files map[string]string) fs.FS {
	t.Helper()
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		if names[i] == MainBinary {
			return true
		}
		if names[j] == MainBinary {
			return false
		}
		return names[i] < names[j]
	})

	var raw bytes.Buffer
	gz := gzip.NewWriter(&raw)
	tw := tar.NewWriter(gz)
	entries := make([]Entry, 0, len(names))
	for _, name := range names {
		data := []byte(files[name])
		mode := int64(0o644)
		if name == MainBinary || !strings.Contains(name, ".") {
			mode = 0o755
		}
		if err := tw.WriteHeader(&tar.Header{
			Name:     name,
			Mode:     mode,
			Size:     int64(len(data)),
			Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		entries = append(entries, Entry{
			Name:   filepath.Base(name),
			File:   name,
			Mode:   fmt.Sprintf("%04o", mode),
			SHA256: hex.EncodeToString(sum[:]),
		})
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}

	manifest := Manifest{
		Schema:  SchemaVersion,
		Version: version,
		GOOS:    runtime.GOOS,
		GOARCH:  runtime.GOARCH,
		Entries: entries,
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return fstest.MapFS{
		"manifest.json": {Data: data},
		"bundle.tar.gz": {Data: raw.Bytes()},
	}
}

func TestEnsureExtractsAndStamps(t *testing.T) {
	bundle := buildBundle(t, "1.2.3", map[string]string{
		"suwu":             "SUWU-BINARY",
		"rg":               "RG-BINARY",
		"tools/pig/NOTICE": "notice",
	})
	dir := t.TempDir()

	res, err := Ensure(bundle, dir, false)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if !res.FirstRun {
		t.Fatal("expected a first run")
	}
	for name, want := range map[string]string{
		"suwu":             "SUWU-BINARY",
		"rg":               "RG-BINARY",
		"tools/pig/NOTICE": "notice",
	} {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || string(got) != want {
			t.Fatalf("%s = %q err=%v", name, got, err)
		}
	}
	info, err := os.Stat(filepath.Join(dir, "suwu"))
	if err != nil || info.Mode()&0o111 == 0 {
		t.Fatalf("suwu is not executable: %v %v", info, err)
	}
	if _, err := os.Stat(filepath.Join(dir, StampFile)); err != nil {
		t.Fatalf("stamp missing: %v", err)
	}
	// No staging directory is left behind.
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".staging-") {
			t.Fatalf("staging left behind: %s", entry.Name())
		}
	}
}

func TestEnsureSecondRunSkips(t *testing.T) {
	bundle := buildBundle(t, "1.2.3", map[string]string{"suwu": "A", "rg": "B"})
	dir := t.TempDir()
	if _, err := Ensure(bundle, dir, false); err != nil {
		t.Fatal(err)
	}
	res, err := Ensure(bundle, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.FirstRun || !res.Skipped {
		t.Fatalf("expected a skip, got %+v", res)
	}
}

func TestEnsureReExtractsWhenFileMissing(t *testing.T) {
	bundle := buildBundle(t, "1.2.3", map[string]string{"suwu": "A", "rg": "B"})
	dir := t.TempDir()
	if _, err := Ensure(bundle, dir, false); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "rg")); err != nil {
		t.Fatal(err)
	}
	res, err := Ensure(bundle, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if !res.FirstRun {
		t.Fatal("expected a re-extract when a file is missing")
	}
	if _, err := os.Stat(filepath.Join(dir, "rg")); err != nil {
		t.Fatalf("rg not restored: %v", err)
	}
}

// The stamp is presence-only by design: a tool's self-update must survive until
// the next suwu-max version.
func TestEnsurePresenceOnlyKeepsModifiedTool(t *testing.T) {
	bundle := buildBundle(t, "1.2.3", map[string]string{"suwu": "A", "rg": "B"})
	dir := t.TempDir()
	if _, err := Ensure(bundle, dir, false); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "rg"), []byte("SELF-UPDATED"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Ensure(bundle, dir, false); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "rg"))
	if string(got) != "SELF-UPDATED" {
		t.Fatalf("self-updated tool was overwritten: %q", got)
	}
}

func TestEnsureBacksUpExistingSuwu(t *testing.T) {
	bundle := buildBundle(t, "1.2.3", map[string]string{"suwu": "NEW", "rg": "B"})
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, MainBinary), []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Ensure(bundle, dir, false); err != nil {
		t.Fatal(err)
	}
	prev, err := os.ReadFile(filepath.Join(dir, MainBinary+".prev"))
	if err != nil || string(prev) != "OLD" {
		t.Fatalf("suwu.prev = %q err=%v", prev, err)
	}
	now, _ := os.ReadFile(filepath.Join(dir, MainBinary))
	if string(now) != "NEW" {
		t.Fatalf("suwu = %q", now)
	}
}

func TestEnsureRejectsBadChecksum(t *testing.T) {
	bundle := buildBundle(t, "1.2.3", map[string]string{"suwu": "A", "rg": "B"})
	data, _ := fs.ReadFile(bundle, "manifest.json")
	manifest, _ := ParseManifest(data)
	manifest.Entries[1].SHA256 = strings.Repeat("0", 64)
	bad, _ := json.Marshal(manifest)
	bundle = fstest.MapFS{
		"manifest.json": {Data: bad},
		"bundle.tar.gz": {Data: mustRead(t, bundle, "bundle.tar.gz")},
	}
	dir := t.TempDir()
	if _, err := Ensure(bundle, dir, false); err == nil {
		t.Fatal("expected a checksum error")
	}
	if _, err := os.Stat(filepath.Join(dir, "suwu")); err == nil {
		t.Fatal("nothing should be promoted after a checksum failure")
	}
}

func TestParseManifestRejectsTraversal(t *testing.T) {
	for _, file := range []string{"../evil", "/abs", "a/../../b"} {
		blob, _ := json.Marshal(Manifest{
			Schema:  SchemaVersion,
			Entries: []Entry{{File: file, Mode: "0755", SHA256: "x"}},
		})
		if _, err := ParseManifest(blob); err == nil {
			t.Errorf("expected %q to be rejected", file)
		}
	}
}

func TestPathEnsureAndRemove(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	bashrc := filepath.Join(home, ".bashrc")
	if err := os.WriteFile(bashrc, []byte("export EDITOR=vim\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	zshrc := filepath.Join(home, ".zshrc")
	if err := os.WriteFile(zshrc, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	fishDir := filepath.Join(home, ".config", "fish")
	if err := os.MkdirAll(fishDir, 0o755); err != nil {
		t.Fatal(err)
	}
	fishCfg := filepath.Join(fishDir, "config.fish")
	if err := os.WriteFile(fishCfg, []byte("set -gx EDITOR vim\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	dir := filepath.Join(home, ".suwu", "bin")
	changed, err := EnsurePath(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) < 3 {
		t.Fatalf("expected bash/zsh/fish changes, got %v", changed)
	}
	bash, _ := os.ReadFile(bashrc)
	if !strings.Contains(string(bash), blockStart) || !strings.Contains(string(bash), "$HOME/.suwu/bin") {
		t.Fatalf("bashrc block missing:\n%s", bash)
	}
	if !strings.Contains(string(bash), "export EDITOR=vim") {
		t.Fatal("bashrc lost unrelated content")
	}
	fish, _ := os.ReadFile(fishCfg)
	if !strings.Contains(string(fish), "set -gx PATH") {
		t.Fatalf("fish block missing:\n%s", fish)
	}
	if _, err := os.Stat(bashrc + ".suwu-max.bak"); err != nil {
		t.Fatalf("backup missing: %v", err)
	}

	// Idempotent: a second run changes nothing.
	again, err := EnsurePath(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 0 {
		t.Fatalf("second run changed %v", again)
	}

	removed, err := RemovePath()
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) < 3 {
		t.Fatalf("expected removals, got %v", removed)
	}
	bash, _ = os.ReadFile(bashrc)
	if strings.Contains(string(bash), blockStart) {
		t.Fatalf("block not removed:\n%s", bash)
	}
	if !strings.Contains(string(bash), "export EDITOR=vim") {
		t.Fatal("removal lost unrelated content")
	}
}

func TestPathCreatesProfileWhenNoRcExists(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if _, err := EnsurePath(filepath.Join(home, ".suwu", "bin")); err != nil {
		t.Fatal(err)
	}
	profile, err := os.ReadFile(filepath.Join(home, ".profile"))
	if err != nil {
		t.Fatalf("profile not created: %v", err)
	}
	if !strings.Contains(string(profile), blockStart) {
		t.Fatalf("profile block missing:\n%s", profile)
	}
}

func TestWithPath(t *testing.T) {
	env := []string{"HOME=/x", "PATH=/usr/bin:/bin"}
	got := withPath(env, "/home/u/.suwu/bin")
	sep := string(os.PathListSeparator)
	if !contains(got, "PATH=/home/u/.suwu/bin"+sep+"/usr/bin:/bin") {
		t.Fatalf("PATH not prepended: %v", got)
	}
	if !contains(got, "HOME=/x") {
		t.Fatal("unrelated env lost")
	}
}

func mustRead(t *testing.T, fsys fs.FS, name string) []byte {
	t.Helper()
	data, err := fs.ReadFile(fsys, name)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}
