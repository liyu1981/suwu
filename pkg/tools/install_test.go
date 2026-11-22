package tools

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"suwu/pkg/bindir"
)

func hexSum(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// tgz builds a .tar.gz from name->body, with an optional prefix directory.
func tgz(t *testing.T, prefix string, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if prefix != "" {
		if err := tw.WriteHeader(&tar.Header{Name: prefix + "/", Typeflag: tar.TypeDir, Mode: 0o755}); err != nil {
			t.Fatal(err)
		}
	}
	for name, body := range files {
		hdr := &tar.Header{Name: prefix + "/" + name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func testDataDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	abs, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

func rgSpec(archive []byte, sha string) Spec {
	return Spec{
		Name: "rg", Version: "15.2.0",
		GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
		Archive: ArchiveTarGz, Strip: 1,
		Entries: []Entry{{File: "rg", Mode: "0755"}},
		SHA256:  sha,
		URL:     "https://example.test/rg.tar.gz",
	}
}

func TestInstallFromArchiveWritesFileAndStamp(t *testing.T) {
	dataDir := testDataDir(t)
	archive := tgz(t, "ripgrep-15.2.0", map[string]string{"rg": "#!/bin/sh\necho hi\n"})
	res, err := InstallFromArchive(rgSpec(archive, hexSum(archive)), Options{DataDir: dataDir}, bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	if res.Skipped || res.Replaced {
		t.Fatalf("unexpected result: %+v", res)
	}
	bin := bindir.Dir(dataDir)
	info, err := os.Stat(filepath.Join(bin, "rg"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("mode %o, want 0755", info.Mode().Perm())
	}
	stamp, err := ReadStamp(dataDir, "rg")
	if err != nil {
		t.Fatal(err)
	}
	if stamp.Version != "15.2.0" || stamp.Origin != OriginTools {
		t.Fatalf("stamp %+v", stamp)
	}
	if len(stamp.Files) != 1 || stamp.Files[0].SHA256 != hexSum([]byte("#!/bin/sh\necho hi\n")) {
		t.Fatalf("stamp files %+v", stamp.Files)
	}
	// Re-installing the same version is a no-op, not a rewrite.
	again, err := InstallFromArchive(rgSpec(archive, hexSum(archive)), Options{DataDir: dataDir}, bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	if !again.Skipped {
		t.Fatalf("second install should be skipped: %+v", again)
	}
}

func TestInstallRejectsChecksumMismatch(t *testing.T) {
	dataDir := testDataDir(t)
	archive := tgz(t, "p", map[string]string{"rg": "x"})
	_, err := InstallFromArchive(rgSpec(archive, strings.Repeat("0", 64)), Options{DataDir: dataDir}, bytes.NewReader(archive), int64(len(archive)))
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("want a checksum error, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(bindir.Dir(dataDir), "rg")); !os.IsNotExist(statErr) {
		t.Fatal("a failed install left a file behind")
	}
}

func TestInstallRefusesToReplaceWithoutForce(t *testing.T) {
	dataDir := testDataDir(t)
	// A file that no stamp owns.
	bin, err := bindir.Ensure(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "rg"), []byte("hand made"), 0o755); err != nil {
		t.Fatal(err)
	}
	archive := tgz(t, "p", map[string]string{"rg": "tool"})
	_, err = InstallFromArchive(rgSpec(archive, hexSum(archive)), Options{DataDir: dataDir}, bytes.NewReader(archive), int64(len(archive)))
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("want a refusal, got %v", err)
	}
	if body, _ := os.ReadFile(filepath.Join(bin, "rg")); string(body) != "hand made" {
		t.Fatal("the unmanaged file was modified")
	}
	// With Force the file is replaced and the backup is gone afterwards.
	if _, err := InstallFromArchive(rgSpec(archive, hexSum(archive)), Options{DataDir: dataDir, Force: true}, bytes.NewReader(archive), int64(len(archive))); err != nil {
		t.Fatal(err)
	}
	if body, _ := os.ReadFile(filepath.Join(bin, "rg")); string(body) != "tool" {
		t.Fatalf("file not replaced: %q", body)
	}
	entries, _ := os.ReadDir(bin)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".bak-") {
			t.Fatalf("backup left behind: %s", e.Name())
		}
	}
}

func TestInstallFromURLEndToEnd(t *testing.T) {
	dataDir := testDataDir(t)
	archive := tgz(t, "fzf-0.74.5", map[string]string{"fzf": "binary"})
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if r.Header.Get("User-Agent") == "" {
			t.Error("no user agent")
		}
		_, _ = w.Write(archive)
	}))
	defer srv.Close()

	spec := Spec{
		Name: "fzf", Version: "0.74.5", GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
		Archive: ArchiveZip, // deliberately wrong: the extractor must complain
		Entries: []Entry{{File: "fzf", Mode: "0755"}},
		SHA256:  hexSum(archive), URL: srv.URL,
	}
	spec.Archive = ArchiveTarGz
	spec.Strip = 1
	res, err := InstallFromURL(t.Context(), spec, Options{DataDir: dataDir})
	if err != nil {
		t.Fatal(err)
	}
	if res.Files[0] != "fzf" || atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("result %+v, hits %d", res, hits)
	}
	// The downloaded archive is spooled, not kept.
	entries, _ := os.ReadDir(filepath.Join(dataDir, "tmp"))
	if len(entries) != 0 {
		t.Fatalf("tmp dir not cleaned: %v", entries)
	}
}

func TestInstallDryRunTouchesNothing(t *testing.T) {
	dataDir := testDataDir(t)
	archive := tgz(t, "p", map[string]string{"rg": "x"})
	res, err := InstallFromArchive(rgSpec(archive, hexSum(archive)), Options{DataDir: dataDir, DryRun: true}, bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 {
		t.Fatalf("dry run reported %v", res.Files)
	}
	if _, err := os.Stat(filepath.Join(bindir.Dir(dataDir), "rg")); !os.IsNotExist(err) {
		t.Fatal("dry run wrote a file")
	}
	if _, err := ReadStamp(dataDir, "rg"); err == nil {
		t.Fatal("dry run wrote a stamp")
	}
}

func TestExtractOnlyDeclaredEntries(t *testing.T) {
	dataDir := testDataDir(t)
	// A release archive with a wrapper dir and a second binary we did not ask for.
	archive := tgz(t, "tool-1.0", map[string]string{
		"tool":     "main",
		"extra":    "must not be installed",
		"README":   "docs",
		"sub/x.sh": "nested",
	})
	spec := Spec{
		Name: "tool", Version: "1.0", Archive: ArchiveTarGz, Strip: 1,
		Entries: []Entry{{File: "tool", Mode: "0755"}},
		SHA256:  hexSum(archive), URL: "https://example.test/tool.tar.gz",
	}
	if _, err := InstallFromArchive(spec, Options{DataDir: dataDir}, bytes.NewReader(archive), int64(len(archive))); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(bindir.Dir(dataDir))
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) != 2 { // + .tools
		t.Fatalf("bin dir has %v, want only the declared file and metadata", names)
	}
}

func TestExtractRejectsHostileArchives(t *testing.T) {
	dir := t.TempDir()
	spec := Spec{Name: "t", Archive: ArchiveTarGz, Entries: []Entry{{File: "t", Mode: "0755"}}}
	declared, err := wants(spec)
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string][]byte{
		"traversal": tarWith(t, &tar.Header{Name: "../../t", Mode: 0o755, Size: 1, Typeflag: tar.TypeReg}, "x"),
		"symlink":   tarWith(t, &tar.Header{Name: "t", Linkname: "/etc/passwd", Mode: 0o777, Typeflag: tar.TypeSymlink}),
		"hardlink":  tarWith(t, &tar.Header{Name: "t", Linkname: "/etc/passwd", Mode: 0o777, Typeflag: tar.TypeLink}),
		"device":    tarWith(t, &tar.Header{Name: "t", Mode: 0o755, Typeflag: tar.TypeChar}),
		"missing":   tarWith(t, &tar.Header{Name: "other", Mode: 0o755, Size: 1, Typeflag: tar.TypeReg}, "x"),
	}
	for name, body := range cases {
		src := filepath.Join(dir, name+".tar.gz")
		if err := os.WriteFile(src, body, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := Extract(spec, src, filepath.Join(dir, name), declared); err == nil {
			t.Errorf("%s: archive accepted", name)
		}
	}
}

func tarWith(t *testing.T, hdr *tar.Header, body ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatal(err)
	}
	for _, b := range body {
		if _, err := tw.Write([]byte(b)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestZipExtraction(t *testing.T) {
	dir := t.TempDir()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range map[string]string{"wrapper/tool": "zip body", "wrapper/other": "nope"} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	spec := Spec{Name: "tool", Archive: ArchiveZip, Strip: 1, Entries: []Entry{{File: "tool", Mode: "0755"}}}
	declared, _ := wants(spec)
	src := filepath.Join(dir, "tool.zip")
	if err := os.WriteFile(src, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "out")
	if err := Extract(spec, src, dst, declared); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(filepath.Join(dst, "tool")); err != nil || string(body) != "zip body" {
		t.Fatalf("got %q, %v", body, err)
	}
}

func TestUninstallRemovesOnlyOwnedFiles(t *testing.T) {
	dataDir := testDataDir(t)
	archive := tgz(t, "p", map[string]string{"rg": "mine"})
	if _, err := InstallFromArchive(rgSpec(archive, hexSum(archive)), Options{DataDir: dataDir}, bytes.NewReader(archive), int64(len(archive))); err != nil {
		t.Fatal(err)
	}
	bin := bindir.Dir(dataDir)
	if err := os.WriteFile(filepath.Join(bin, "other"), []byte("not mine"), 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := Uninstall(Options{DataDir: dataDir}, "rg")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0] != "rg" {
		t.Fatalf("removed %v", res.Files)
	}
	if _, err := os.Stat(filepath.Join(bin, "rg")); !os.IsNotExist(err) {
		t.Fatal("rg still there")
	}
	if _, err := os.Stat(filepath.Join(bin, "other")); err != nil {
		t.Fatal("an unrelated file was removed")
	}
	if _, err := ReadStamp(dataDir, "rg"); err == nil {
		t.Fatal("stamp survived")
	}
	// A second removal says so, rather than pretending it did something.
	if _, err := Uninstall(Options{DataDir: dataDir}, "rg"); err == nil {
		t.Fatal("second uninstall should fail")
	}
}

func TestUnmanagedToolIsNotUninstalled(t *testing.T) {
	dataDir := testDataDir(t)
	bin, _ := bindir.Ensure(dataDir)
	if err := os.WriteFile(filepath.Join(bin, "rg"), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Uninstall(Options{DataDir: dataDir}, "rg"); err == nil {
		t.Fatal("unmanaged file removed")
	}
	if _, err := os.Stat(filepath.Join(bin, "rg")); err != nil {
		t.Fatal("unmanaged file disappeared")
	}
}

func TestOriginMaxAndPrecedence(t *testing.T) {
	dataDir := testDataDir(t)
	archive := tgz(t, "p", map[string]string{"rg": "bundle"})
	spec := rgSpec(archive, hexSum(archive))
	if _, err := InstallFromArchive(spec, Options{DataDir: dataDir, Origin: OriginMax}, bytes.NewReader(archive), int64(len(archive))); err != nil {
		t.Fatal(err)
	}
	s, err := ReadStamp(dataDir, "rg")
	if err != nil || s.Origin != OriginMax {
		t.Fatalf("stamp %+v, %v", s, err)
	}
	// The page's install replaces a bundled copy even without --force: an
	// explicit install beats the bundle (docs/TOOLS_PLAN.md §7.1).
	spec.Version = "15.3.0"
	archive2 := tgz(t, "p", map[string]string{"rg": "ours"})
	spec.SHA256 = hexSum(archive2)
	if _, err := InstallFromArchive(spec, Options{DataDir: dataDir}, bytes.NewReader(archive2), int64(len(archive2))); err != nil {
		t.Fatal(err)
	}
	s, _ = ReadStamp(dataDir, "rg")
	if s.Origin != OriginTools || s.Version != "15.3.0" {
		t.Fatalf("stamp %+v", s)
	}
}

func TestInstallFromFiles(t *testing.T) {
	dataDir := testDataDir(t)
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "rg"), []byte("staged"), 0o755); err != nil {
		t.Fatal(err)
	}
	spec := Spec{
		Name: "rg", Version: "1.0", Archive: ArchiveTarGz,
		Entries: []Entry{{File: "rg", Mode: "0755"}}, URL: "embedded",
	}
	if _, err := InstallFromFiles(spec, Options{DataDir: dataDir, Origin: OriginMax}, src); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(bindir.Dir(dataDir), "rg"))
	if err != nil || string(body) != "staged" {
		t.Fatalf("got %q, %v", body, err)
	}
}

func TestInvalidSpecsAreRefused(t *testing.T) {
	dataDir := testDataDir(t)
	base := Spec{Name: "rg", Version: "1", Archive: ArchiveTarGz, Strip: 0, Entries: []Entry{{File: "rg", Mode: "0755"}}}
	cases := map[string]func(*Spec){
		"name":       func(s *Spec) { s.Name = "../rg" },
		"no version": func(s *Spec) { s.Version = "" },
		"no entries": func(s *Spec) { s.Entries = nil },
		"mode":       func(s *Spec) { s.Entries[0].Mode = "4755" },
		"dot file":   func(s *Spec) { s.Entries[0].File = ".tools/rg.json" },
		"absolute":   func(s *Spec) { s.Entries[0].File = "/usr/bin/rg" },
	}
	for name, mutate := range cases {
		spec := base
		spec.Entries = append([]Entry(nil), base.Entries...)
		mutate(&spec)
		if _, err := install(spec, Options{DataDir: dataDir}, func(string) error { return nil }); err == nil {
			t.Errorf("%s: spec accepted", name)
		}
	}
}

func TestStampsListsEverything(t *testing.T) {
	dataDir := testDataDir(t)
	for _, name := range []string{"rg", "fzf"} {
		archive := tgz(t, "p", map[string]string{name: name})
		spec := rgSpec(archive, hexSum(archive))
		spec.Name = name
		spec.Entries = []Entry{{File: name, Mode: "0755"}}
		if _, err := InstallFromArchive(spec, Options{DataDir: dataDir}, bytes.NewReader(archive), int64(len(archive))); err != nil {
			t.Fatal(err)
		}
	}
	stamps, err := Stamps(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(stamps) != 2 || stamps["rg"].Name != "rg" {
		t.Fatalf("stamps %v", stamps)
	}
}

func TestProgressIsReported(t *testing.T) {
	dataDir := testDataDir(t)
	archive := tgz(t, "p", map[string]string{"rg": strings.Repeat("x", 4096)})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(archive)))
		_, _ = w.Write(archive)
	}))
	defer srv.Close()
	spec := rgSpec(archive, hexSum(archive))
	spec.URL = srv.URL
	var seen int64
	_, err := InstallFromURL(t.Context(), spec, Options{
		DataDir:  dataDir,
		Progress: func(name string, done, total int64) { seen = done },
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen != int64(len(archive)) {
		t.Fatalf("progress reported %d of %d", seen, len(archive))
	}
}

// An update of a tool we installed must not ask for --force: the stamp is proof
// we own the files, and "update" means "replace". This is the bug the Tools page
// hit — `pig 0.5.3 · origin tools` refused to become 0.7.0.
func TestUpdateReplacesOurOwnFilesWithoutForce(t *testing.T) {
	dataDir := testDataDir(t)
	old := tgz(t, "p", map[string]string{"rg": "0.5.3"})
	if _, err := InstallFromArchive(rgSpec(old, hexSum(old)), Options{DataDir: dataDir}, bytes.NewReader(old), int64(len(old))); err != nil {
		t.Fatal(err)
	}
	newer := tgz(t, "p", map[string]string{"rg": "0.7.0"})
	spec := rgSpec(newer, hexSum(newer))
	spec.Version = "0.7.0"
	res, err := InstallFromArchive(spec, Options{DataDir: dataDir}, bytes.NewReader(newer), int64(len(newer)))
	if err != nil {
		t.Fatalf("upgrade refused: %v", err)
	}
	if !res.Replaced || res.Skipped {
		t.Fatalf("result %+v", res)
	}
	if body, _ := os.ReadFile(filepath.Join(bindir.Dir(dataDir), "rg")); string(body) != "0.7.0" {
		t.Fatalf("file not replaced: %q", body)
	}
	if s, _ := ReadStamp(dataDir, "rg"); s.Version != "0.7.0" {
		t.Fatalf("stamp %+v", s)
	}
}

// An upgrade whose payload changed shape drops the files the old version owned
// and the new one does not — and never touches anything it did not own.
func TestUpdatePrunesOrphanedFiles(t *testing.T) {
	dataDir := testDataDir(t)
	bin, err := bindir.Ensure(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	// The old install owned two files.
	old := tgz(t, "p", map[string]string{"rg": "1", "rg.1": "man page"})
	spec := rgSpec(old, hexSum(old))
	spec.Entries = []Entry{{File: "rg", Mode: "0755"}, {File: "rg.1", Mode: "0644"}}
	spec.Version = "1.0"
	if _, err := InstallFromArchive(spec, Options{DataDir: dataDir}, bytes.NewReader(old), int64(len(old))); err != nil {
		t.Fatal(err)
	}
	// A stranger's file in the same directory must survive every upgrade.
	if err := os.WriteFile(filepath.Join(bin, "not-mine"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	newer := tgz(t, "p", map[string]string{"rg": "2"})
	spec = rgSpec(newer, hexSum(newer))
	spec.Version = "2.0"
	if _, err := InstallFromArchive(spec, Options{DataDir: dataDir}, bytes.NewReader(newer), int64(len(newer))); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(bin, "rg.1")); !os.IsNotExist(err) {
		t.Fatal("the orphaned man page survived the upgrade")
	}
	if _, err := os.Stat(filepath.Join(bin, "not-mine")); err != nil {
		t.Fatal("an unowned file was removed")
	}
	if s, _ := ReadStamp(dataDir, "rg"); len(s.Files) != 1 || s.Files[0].File != "rg" {
		t.Fatalf("stamp %+v", s)
	}
}

// A file nobody's stamp owns still needs --force: the stamp is the difference
// between "our old copy" and "somebody else's binary".
func TestUnmanagedFileStillNeedsForce(t *testing.T) {
	dataDir := testDataDir(t)
	bin, err := bindir.Ensure(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "rg"), []byte("hand made"), 0o755); err != nil {
		t.Fatal(err)
	}
	archive := tgz(t, "p", map[string]string{"rg": "ours"})
	if _, err := InstallFromArchive(rgSpec(archive, hexSum(archive)), Options{DataDir: dataDir}, bytes.NewReader(archive), int64(len(archive))); err == nil {
		t.Fatal("an unmanaged file was replaced without --force")
	}
}
