package extension

// Tests for suwu.static pointing at a zip archive instead of a directory.

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeStaticZip writes a zip fixture with the given entries (name → body).
func writeStaticZip(t *testing.T, path string, entries map[string]string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	zw := zip.NewWriter(f)
	// Deterministic order so the fixture is stable.
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	for i := 1; i < len(names); i++ {
		for j := i; j > 0 && names[j] < names[j-1]; j-- {
			names[j], names[j-1] = names[j-1], names[j]
		}
	}
	for _, name := range names {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(entries[name])); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
}

// zipExt installs an extension whose static source is dist.zip.
func zipExt(t *testing.T) (dir, id string) {
	t.Helper()
	dir = t.TempDir()
	id = "bundled"
	writeExt(t, dir, id,
		`{"name":"Bundled","suwu":{"static":"dist.zip"}}`,
		`function handler(){return "page"}`)
	writeStaticZip(t, filepath.Join(dir, id, "dist.zip"), map[string]string{
		"assets/app-abc123.js": "export const x = 1;",
		"assets/app.css":       "body{color:red}",
		"fonts/Font.woff2":     "wOF2data",
		"page.html":            "<!doctype html><p>hi</p>",
		"notes.md":             "# not in the allow-list",
	})
	return dir, id
}

func TestResolveStaticZip(t *testing.T) {
	dir, id := zipExt(t)

	ext, err := Resolve(dir, id)
	if err != nil {
		t.Fatal(err)
	}
	if ext.Static != "dist.zip" {
		t.Fatalf("static = %q", ext.Static)
	}
	if got := ext.StaticKind(); got != StaticZip {
		t.Fatalf("StaticKind = %v, want StaticZip", got)
	}
	if p, err := ext.StaticArchivePath(); err != nil || !strings.HasSuffix(p, "dist.zip") {
		t.Fatalf("StaticArchivePath = %q, %v", p, err)
	}
	// StaticPath is the directory resolver; it must not be used for a zip.
	if _, err := ext.StaticPath("assets/app-abc123.js"); err == nil {
		// It returns the would-be path; StaticAsset is the one that reads.
		if _, err := ext.StaticAsset("assets/app-abc123.js", 1<<20); err != nil {
			t.Fatalf("StaticAsset through a zip: %v", err)
		}
	}
}

func TestStaticAssetFromZip(t *testing.T) {
	dir, id := zipExt(t)
	ext, err := Resolve(dir, id)
	if err != nil {
		t.Fatal(err)
	}

	asset, err := ext.StaticAsset("assets/app-abc123.js", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if string(asset.Data) != "export const x = 1;" {
		t.Errorf("data = %q", asset.Data)
	}
	if asset.Name != "assets/app-abc123.js" {
		t.Errorf("name = %q", asset.Name)
	}
	if asset.ModTime.IsZero() {
		t.Error("modtime is zero: Last-Modified would be missing")
	}

	// Nested and top-level entries both resolve.
	if _, err := ext.StaticAsset("fonts/Font.woff2", 1<<20); err != nil {
		t.Errorf("nested entry: %v", err)
	}
	if _, err := ext.StaticAsset("page.html", 1<<20); err != nil {
		t.Errorf("top-level entry: %v", err)
	}

	t.Run("missing entry", func(t *testing.T) {
		if _, err := ext.StaticAsset("assets/nope.js", 1<<20); err == nil {
			t.Error("a missing entry must fail")
		}
	})

	t.Run("cap", func(t *testing.T) {
		_, err := ext.StaticAsset("assets/app-abc123.js", 4)
		if err == nil {
			t.Fatal("a body over the cap must fail")
		}
		if err != ErrStaticTooLarge {
			t.Errorf("err = %v, want ErrStaticTooLarge", err)
		}
	})

	t.Run("untrusted paths never reach the archive", func(t *testing.T) {
		for _, rel := range []string{
			"../dist.zip", "assets/../../etc/passwd", "/etc/passwd",
			"assets/./app-abc123.js", "assets//app-abc123.js", ".env",
		} {
			if _, err := ext.StaticAsset(rel, 1<<20); err == nil {
				t.Errorf("StaticAsset(%q) must be refused", rel)
			}
		}
	})
}

// A hostile archive cannot be used to escape: entry names with "../" or an
// absolute prefix simply never match a validated request path.
func TestStaticZipEntryNameEscape(t *testing.T) {
	dir := t.TempDir()
	const id = "hostile"
	writeExt(t, dir, id, `{"name":"Hostile","suwu":{"static":"dist.zip"}}`, `function handler(){}`)
	writeStaticZip(t, filepath.Join(dir, id, "dist.zip"), map[string]string{
		"../../etc/passwd": "root:x:0:0",
		"/etc/shadow":      "nope",
		"ok.js":            "export {};",
	})

	ext, err := Resolve(dir, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ext.StaticAsset("ok.js", 1<<20); err != nil {
		t.Errorf("legitimate entry: %v", err)
	}
	for _, rel := range []string{"../../etc/passwd", "etc/passwd", "etc/shadow"} {
		if _, err := ext.StaticAsset(rel, 1<<20); err == nil {
			t.Errorf("StaticAsset(%q) must not resolve to an escape-named entry", rel)
		}
	}
}

// The declared source must exist and be the right kind: a directory path that
// only has a zip, or a .zip path that is a directory, both fail resolution.
func TestResolveStaticSourceKind(t *testing.T) {
	dir := t.TempDir()

	writeExt(t, dir, "missingzip", `{"name":"M","suwu":{"static":"dist.zip"}}`, `function handler(){}`)
	if _, err := Resolve(dir, "missingzip"); err == nil {
		t.Error("a declared suwu.static zip that does not exist must fail Resolve")
	}

	writeExt(t, dir, "zipisdir", `{"name":"M","suwu":{"static":"dist.zip"}}`, `function handler(){}`)
	if err := os.MkdirAll(filepath.Join(dir, "zipisdir", "dist.zip"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(dir, "zipisdir"); err == nil {
		t.Error("a .zip static source that is a directory must fail Resolve")
	}

	writeExt(t, dir, "diriszip", `{"name":"M","suwu":{"static":"public"}}`, `function handler(){}`)
	if err := os.WriteFile(filepath.Join(dir, "diriszip", "public"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(dir, "diriszip"); err == nil {
		t.Error("a directory static source that is a file must fail Resolve")
	}

	// Upper-case .ZIP is still an archive.
	writeExt(t, dir, "upper", `{"name":"M","suwu":{"static":"DIST.ZIP"}}`, `function handler(){}`)
	if err := os.WriteFile(filepath.Join(dir, "upper", "DIST.ZIP"), []byte("PK"), 0o644); err != nil {
		t.Fatal(err)
	}
	ext, err := Resolve(dir, "upper")
	if err != nil {
		t.Fatalf("upper-case archive: %v", err)
	}
	if got := ext.StaticKind(); got != StaticZip {
		t.Errorf("StaticKind = %v, want StaticZip", got)
	}
}

// An extension may not smuggle its archive outside its own directory.
func TestStaticZipPathContainment(t *testing.T) {
	dir := t.TempDir()
	writeExt(t, dir, "escape", `{"name":"E","suwu":{"static":"dist.zip"}}`, `function handler(){}`)
	// Replace the archive with a symlink pointing outside the extension.
	outside := filepath.Join(t.TempDir(), "outside.zip")
	writeStaticZip(t, outside, map[string]string{"x.js": "export {};"})
	if err := os.Symlink(outside, filepath.Join(dir, "escape", "dist.zip")); err != nil {
		t.Skip("symlinks unsupported here")
	}
	if _, err := Resolve(dir, "escape"); err == nil {
		t.Error("a symlinked archive escaping the extension directory must fail Resolve")
	}
}

// bytes.Reader over the asset keeps Range/HEAD working; this is the contract the
// server relies on, so assert the bytes are a plain readable copy.
func TestStaticAssetIsPlainBytes(t *testing.T) {
	dir, id := zipExt(t)
	ext, err := Resolve(dir, id)
	if err != nil {
		t.Fatal(err)
	}
	a, err := ext.StaticAsset("page.html", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(a.Data, []byte("<!doctype html>")) {
		t.Errorf("data = %q", a.Data)
	}
}
