package install

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"suwu/pkg/extension"
)

// stageExtension fills a stage with a valid extension payload.
func stageExtension(t *testing.T, dataDir, id string) *Stage {
	t.Helper()
	stage, err := NewStage(dataDir, KindExtension, id)
	if err != nil {
		t.Fatalf("NewStage: %v", err)
	}
	for name, body := range validExtension() {
		if _, err := stage.WriteBytes(name, []byte(body)); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return stage
}

func TestNewStageRejectsBadInput(t *testing.T) {
	dir := t.TempDir()
	for _, tc := range []struct{ name, id, dataDir string }{
		{"traversal id", "../../etc", dir},
		{"uppercase id", "Eye", dir},
		{"dotted id", "eye.v2", dir},
		{"relative data dir", "eye", "relative/path"},
		{"unclean data dir", "eye", dir + "/./"},
		{"empty data dir", "eye", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewStage(tc.dataDir, KindExtension, tc.id); err == nil {
				t.Fatalf("NewStage(%q, %q) was accepted", tc.dataDir, tc.id)
			}
		})
	}
}

func TestStageWriteFileRejectsBadPaths(t *testing.T) {
	stage := stageExtension(t, t.TempDir(), "eye")
	for _, rel := range []string{
		"../escape.js", "nested/../../escape.js", "/etc/passwd", `a\b.js`, "", "./x.js", "a//b.js",
	} {
		if _, err := stage.WriteFile(rel, strings.NewReader("x")); err == nil {
			t.Errorf("WriteFile(%q) was accepted", rel)
		}
	}
	// A path that is merely long or dotted-but-inside is fine.
	if _, err := stage.WriteFile("public/a.b.c.js", strings.NewReader("x")); err != nil {
		t.Errorf("WriteFile on a nested dotted name: %v", err)
	}
}

func TestCommitInstallsAndValidates(t *testing.T) {
	dir := t.TempDir()
	stage := stageExtension(t, dir, "eye")
	files, bytesN := stage.Stats()
	if files != len(validExtension()) {
		t.Errorf("files = %d, want %d", files, len(validExtension()))
	}
	if bytesN == 0 {
		t.Error("bytes = 0, want the payload size")
	}

	item, err := stage.Commit(Options{DataDir: dir})
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if item.Files != files || item.Bytes != bytesN {
		t.Errorf("item counts = %d/%d, want %d/%d", item.Files, item.Bytes, files, bytesN)
	}
	if item.Replaced {
		t.Error("Replaced = true on a first install")
	}
	if _, err := extension.Resolve(extension.Dir(dir), "eye"); err != nil {
		t.Errorf("the server cannot resolve the install: %v", err)
	}
	// The legacy tree must not have been created.
	if _, err := os.Stat(extension.LegacyDir(dir)); err == nil {
		t.Error("an install wrote to the legacy extensions/ tree")
	}
	assertNoResidue(t, dir)
}

func TestCommitRejectsInvalidPayload(t *testing.T) {
	dir := t.TempDir()
	stage, err := NewStage(dir, KindExtension, "eye")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stage.WriteBytes("package.json", []byte(`{"name":"Demo"}`)); err != nil {
		t.Fatal(err)
	}
	// No index.js: the resolver must reject it and nothing may be created.
	if _, err := stage.Commit(Options{DataDir: dir}); err == nil || !strings.Contains(err.Error(), "not a valid extension") {
		t.Fatalf("err = %v, want a resolver rejection", err)
	}
	assertNotInstalled(t, dir, KindExtension, "eye")
	assertNoResidue(t, dir)
}

func TestCommitRefusesExistingWithoutForce(t *testing.T) {
	dir := t.TempDir()
	if _, err := stageExtension(t, dir, "eye").Commit(Options{DataDir: dir}); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(extension.Dir(dir), "eye", "marker.txt")
	if err := os.WriteFile(marker, []byte("first"), 0o644); err != nil {
		t.Fatal(err)
	}

	// A second install must refuse and leave the first untouched.
	_, err := stageExtension(t, dir, "eye").Commit(Options{DataDir: dir})
	if err == nil || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("err = %v, want a --force requirement", err)
	}
	if got, _ := os.ReadFile(marker); string(got) != "first" {
		t.Error("the existing install was modified by a refused install")
	}

	// With --force the install is replaced and the marker is gone.
	item, err := stageExtension(t, dir, "eye").Commit(Options{DataDir: dir, Force: true})
	if err != nil {
		t.Fatalf("forced install: %v", err)
	}
	if !item.Replaced {
		t.Error("Replaced = false, want true")
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("the old install survived a forced replacement")
	}
	// No backup left behind.
	entries, _ := os.ReadDir(extension.Dir(dir))
	for _, e := range entries {
		if strings.Contains(e.Name(), ".bak-") {
			t.Errorf("backup directory left behind: %s", e.Name())
		}
	}
	assertNoResidue(t, dir)
}

func TestCommitRefusesSymlinkTarget(t *testing.T) {
	dir := t.TempDir()
	root := extension.Dir(dir)
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	link := filepath.Join(root, "eye")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	if _, err := stageExtension(t, dir, "eye").Commit(Options{DataDir: dir, Force: true}); err == nil {
		t.Fatal("a symlinked target was replaced")
	}
	// The link must still point where it did, and the outside dir must be empty.
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Error("the symlink was replaced instead of refused")
	}
	if entries, _ := os.ReadDir(outside); len(entries) > 0 {
		t.Errorf("the symlink target was written through: %v", entries)
	}
}

func TestCommitDryRunChangesNothing(t *testing.T) {
	dir := t.TempDir()
	item, err := stageExtension(t, dir, "eye").Commit(Options{DataDir: dir, DryRun: true})
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if item.Name != "Demo" {
		t.Errorf("a dry run should still report the manifest name, got %q", item.Name)
	}
	if _, err := os.Stat(filepath.Join(extension.Dir(dir), "eye")); err == nil {
		t.Error("a dry run created the destination")
	}
	assertNoResidue(t, dir)
}

func TestDiscardIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	stage := stageExtension(t, dir, "eye")
	if err := stage.Discard(); err != nil {
		t.Fatalf("Discard: %v", err)
	}
	if err := stage.Discard(); err != nil {
		t.Fatalf("second Discard: %v", err)
	}
	assertNoResidue(t, dir)
}

func TestStageVerifyRejectsSymlinkInTree(t *testing.T) {
	dir := t.TempDir()
	stage := stageExtension(t, dir, "eye")
	// Slip a symlink into the staged tree behind WriteFile's back, the way a
	// compromised or buggy extractor might.
	if err := os.Symlink(stage.Dir(), filepath.Join(stage.Dir(), "link.js")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := stage.Commit(Options{DataDir: dir}); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("err = %v, want the staged tree walk to reject a symlink", err)
	}
	assertNoResidue(t, dir)
}

func TestKindRootAndInstalled(t *testing.T) {
	dir := t.TempDir()
	if got, want := KindExtension.Root(dir), extension.Dir(dir); got != want {
		t.Errorf("extension root = %q, want %q", got, want)
	}
	if got, want := KindBackground.Root(dir), filepath.Join(dir, "background", "webgpu"); got != want {
		t.Errorf("background root = %q, want %q", got, want)
	}
	if KindExtension.Installed(dir, "eye") {
		t.Error("Installed = true for a fresh data dir")
	}
	if _, err := stageExtension(t, dir, "eye").Commit(Options{DataDir: dir}); err != nil {
		t.Fatal(err)
	}
	if !KindExtension.Installed(dir, "eye") {
		t.Error("Installed = false after a successful install")
	}
}

func TestKindFromString(t *testing.T) {
	for in, want := range map[string]Kind{"extension": KindExtension, " Background ": KindBackground, "BACKGROUND": KindBackground} {
		got, err := KindFromString(in)
		if err != nil || got != want {
			t.Errorf("KindFromString(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := KindFromString(""); err == nil {
		t.Error("an empty kind was accepted")
	}
	if _, err := KindFromString("theme"); err == nil {
		t.Error("an unknown kind was accepted")
	}
}

// TestFromArchiveFile covers the path-based entry point end to end.
func TestFromArchiveFile(t *testing.T) {
	data, _ := extensionZip(t, "extension/eye/")
	zipPath := filepath.Join(t.TempDir(), "eye.zip")
	if err := os.WriteFile(zipPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	item, err := FromArchiveFile(KindExtension, zipPath, Options{DataDir: dir})
	if err != nil {
		t.Fatalf("FromArchiveFile: %v", err)
	}
	if item.ID != "eye" {
		t.Errorf("ID = %q, want eye", item.ID)
	}

	// A directory is not an archive.
	if _, err := FromArchiveFile(KindExtension, dir, Options{DataDir: dir}); err == nil {
		t.Error("a directory was accepted as an archive")
	}
	// A non-zip file is a clean error, not a panic.
	junk := filepath.Join(t.TempDir(), "junk.zip")
	if err := os.WriteFile(junk, []byte("not a zip"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := FromArchiveFile(KindExtension, junk, Options{DataDir: dir}); err == nil {
		t.Error("a non-archive file was accepted")
	}
}

// TestStageCountsLargePayload checks the byte accounting on a big-ish payload
// without writing tens of megabytes.
func TestStageCountsLargePayload(t *testing.T) {
	dir := t.TempDir()
	stage, err := NewStage(dir, KindExtension, "eye")
	if err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("a"), 1<<20)
	if _, err := stage.WriteBytes("package.json", []byte(`{"name":"Demo"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := stage.WriteBytes("index.js", payload); err != nil {
		t.Fatal(err)
	}
	_, bytesN := stage.Stats()
	if bytesN != int64(len(payload)+len(`{"name":"Demo"}`)) {
		t.Errorf("bytes = %d, want %d", bytesN, len(payload)+len(`{"name":"Demo"}`))
	}
}
