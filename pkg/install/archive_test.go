package install

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"suwu/pkg/extension"
)

// validExtension returns a minimal but resolvable extension payload.
func validExtension() map[string]string {
	return map[string]string{
		"index.js":            "function handler() { return { body: '<!doctype html><p>hi</p>' }; }",
		extension.PackageFile: `{"name":"Demo","description":"a demo"}`,
		"public/style.css":    "body{color:#000}",
	}
}

// validBackground returns a minimal but resolvable background payload.
func validBackground() map[string]string {
	return map[string]string{
		"background.json":        `{"id":"rain","label":"Rain","engine":"webgpu-render-engine"}`,
		"scene.js":               "export default function create(){ return { start(){} }; }",
		"shaders/rain.wgsl":      "@fragment fn main() {}",
		"shaders/rain.shader.js": "export default { version: 1, wgsl: '' };",
	}
}

// buildZip writes a zip in memory from an ordered list of entries. An entry
// whose name ends in "/" is written as a directory.
func buildZip(t *testing.T, entries [][2]string) ([]byte, int64) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		name, body := e[0], e[1]
		if strings.HasSuffix(name, "/") {
			if _, err := zw.Create(name); err != nil {
				t.Fatalf("create dir %s: %v", name, err)
			}
			continue
		}
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes(), int64(buf.Len())
}

// extensionZip packages a valid extension under the given prefix.
func extensionZip(t *testing.T, prefix string) ([]byte, int64) {
	t.Helper()
	var entries [][2]string
	for name, body := range validExtension() {
		entries = append(entries, [2]string{prefix + name, body})
	}
	return buildZip(t, entries)
}

// ── layout detection ───────────────────────────────────────────────

func TestFindArchiveRoot(t *testing.T) {
	tests := []struct {
		name    string
		kind    Kind
		entries []string
		wantID  string
		wantErr string
	}{
		{
			name:    "canonical extension prefix",
			kind:    KindExtension,
			entries: []string{"extension/eye/index.js", "extension/eye/public/style.css"},
			wantID:  "eye",
		},
		{
			name:    "legacy plural prefix still installs",
			kind:    KindExtension,
			entries: []string{"extensions/eye/index.js"},
			wantID:  "eye",
		},
		{
			name:    "bare directory",
			kind:    KindExtension,
			entries: []string{"eye/index.js", "eye/package.json"},
			wantID:  "eye",
		},
		{
			name:    "canonical background prefix",
			kind:    KindBackground,
			entries: []string{"background/webgpu/rain/background.json", "background/webgpu/rain/scene.js"},
			wantID:  "rain",
		},
		{
			name:    "background webgpu prefix",
			kind:    KindBackground,
			entries: []string{"webgpu/rain/background.json"},
			wantID:  "rain",
		},
		{
			name:    "two payload directories are ambiguous",
			kind:    KindExtension,
			entries: []string{"extension/a/index.js", "extension/b/index.js"},
			wantErr: "contains 2 payload directories",
		},
		{
			name:    "a stray top-level directory is not a payload",
			kind:    KindExtension,
			entries: []string{"readme.txt", "docs/notes.md"},
			wantErr: "no extension/<id>/ directory",
		},
		{
			name:    "two bare payload directories are ambiguous",
			kind:    KindExtension,
			entries: []string{"a/package.json", "b/package.json"},
			wantErr: "no extension/ prefix and 2 top-level directories",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := findArchiveRoot(tc.kind, tc.entries)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want it to contain %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.id != tc.wantID {
				t.Errorf("id = %q, want %q", got.id, tc.wantID)
			}
		})
	}
}

func TestFindArchiveRootRejectsInvalidID(t *testing.T) {
	// Uppercase and dots are outside the id grammar, so the payload cannot be
	// installed even though the archive is otherwise well-formed.
	_, err := findArchiveRoot(KindExtension, []string{"extension/Bad.ID/index.js"})
	if err == nil || !strings.Contains(err.Error(), "invalid extension id") {
		t.Fatalf("err = %v, want an invalid id error", err)
	}
}

// ── happy paths ────────────────────────────────────────────────────

func TestFromArchiveInstallsExtension(t *testing.T) {
	for _, prefix := range []string{"extension/eye/", "extensions/eye/", "eye/"} {
		t.Run("prefix "+prefix, func(t *testing.T) {
			data, size := extensionZip(t, prefix)
			dir := t.TempDir()
			item, err := FromArchive(KindExtension, bytes.NewReader(data), size, Options{DataDir: dir})
			if err != nil {
				t.Fatalf("install: %v", err)
			}
			if item.ID != "eye" || item.Name != "Demo" {
				t.Errorf("item = %+v, want id eye named Demo", item)
			}
			if item.Dir != filepath.Join(extension.Dir(dir), "eye") {
				t.Errorf("Dir = %q, want the current extension tree", item.Dir)
			}
			// The server must now see it.
			if _, err := extension.Resolve(extension.Dir(dir), "eye"); err != nil {
				t.Errorf("extension.Resolve after install: %v", err)
			}
			if _, err := os.Stat(filepath.Join(item.Dir, "public", "style.css")); err != nil {
				t.Errorf("nested file missing: %v", err)
			}
		})
	}
}

func TestFromArchiveInstallsBackground(t *testing.T) {
	data, size := buildZip(t, [][2]string{
		{"background/webgpu/rain/background.json", `{"id":"rain","label":"Rain","engine":"webgpu-render-engine"}`},
		{"background/webgpu/rain/scene.js", "export default function create(){ return { start(){} }; }"},
		{"background/webgpu/rain/shaders/rain.wgsl", "@fragment fn main() {}"},
		// No compiled artifact: a warning, not a failure.
	})
	dir := t.TempDir()
	item, err := FromArchive(KindBackground, bytes.NewReader(data), size, Options{DataDir: dir})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if item.Name != "Rain" {
		t.Errorf("Name = %q, want Rain", item.Name)
	}
	if len(item.Warnings) != 1 || !strings.Contains(item.Warnings[0], "rain.shader.js") {
		t.Errorf("Warnings = %v, want one about the missing compiled shader", item.Warnings)
	}
}

func TestFromArchiveWarnsOnStaleBackgroundArtifacts(t *testing.T) {
	data, size := buildZip(t, [][2]string{
		{"background/webgpu/rain/background.json", `{"id":"rain","label":"Rain","engine":"webgpu-render-engine"}`},
		{"background/webgpu/rain/scene.js", "export default function create(){ return { start(){} }; }"},
		{"background/webgpu/rain/shaders/a.wgsl", "@fragment fn main() {}"},
		{"background/webgpu/rain/shaders/a.shader.js", "export default { version: 1, wgsl: '' };"},
		{"background/webgpu/rain/shaders/helper.wgsl", "fn helper() {}"},
	})
	dir := t.TempDir()
	item, err := FromArchive(KindBackground, bytes.NewReader(data), size, Options{DataDir: dir})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	// helper.wgsl has no @fragment, so it is inlined, not compiled: no warning.
	if len(item.Warnings) != 0 {
		t.Errorf("Warnings = %v, want none (a helper module is inlined)", item.Warnings)
	}
}

func TestFromArchiveSkipsMacNoise(t *testing.T) {
	data, size := buildZip(t, [][2]string{
		{"extension/eye/index.js", validExtension()["index.js"]},
		{"extension/eye/package.json", validExtension()[extension.PackageFile]},
		{"__MACOSX/extension/eye/._index.js", "junk"},
		{"extension/eye/.DS_Store", "junk"},
	})
	dir := t.TempDir()
	if _, err := FromArchive(KindExtension, bytes.NewReader(data), size, Options{DataDir: dir}); err != nil {
		t.Fatalf("install: %v", err)
	}
	if _, err := os.Stat(filepath.Join(extension.Dir(dir), "eye", ".DS_Store")); err == nil {
		t.Error("packaging noise was extracted")
	}
}

// ── hostile archives ───────────────────────────────────────────────

// TestFromArchiveRejectsTraversal is the zip-slip case: an entry that would
// escape the staging directory must abort the whole install.
func TestFromArchiveRejectsTraversal(t *testing.T) {
	attacks := []struct {
		name  string
		entry string
	}{
		{"dot dot in the middle", "extension/eye/../../escaped.js"},
		{"dot dot at the root of the payload", "extension/../evil.js"},
		{"dot segment", "extension/eye/./index.js"},
		{"backslash separator", `extension\eye\index.js`},
		{"absolute path", "extension/eye//etc/passwd"},
		{"nul byte", "extension/eye/ind\x00ex.js"},
	}
	for _, tc := range attacks {
		t.Run(tc.name, func(t *testing.T) {
			data, size := buildZip(t, [][2]string{
				{"extension/eye/index.js", validExtension()["index.js"]},
				{"extension/eye/package.json", validExtension()[extension.PackageFile]},
				{tc.entry, "payload"},
			})
			dir := t.TempDir()
			_, err := FromArchive(KindExtension, bytes.NewReader(data), size, Options{DataDir: dir})
			if err == nil {
				t.Fatalf("entry %q was accepted", tc.entry)
			}
			// Nothing may be left behind, inside or outside the tree.
			assertNoResidue(t, dir)
		})
	}
}

func TestFromArchiveRejectsNonRegularEntries(t *testing.T) {
	for _, mode := range []struct {
		name string
		mode os.FileMode
	}{
		{"symlink", os.ModeSymlink | 0o777},
		{"device", os.ModeDevice | 0o666},
		{"fifo", os.ModeNamedPipe | 0o644},
		{"socket", os.ModeSocket | 0o644},
	} {
		t.Run(mode.name, func(t *testing.T) {
			var buf bytes.Buffer
			zw := zip.NewWriter(&buf)
			for name, body := range validExtension() {
				w, err := zw.Create("extension/eye/" + name)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := w.Write([]byte(body)); err != nil {
					t.Fatal(err)
				}
			}
			hdr := &zip.FileHeader{Name: "extension/eye/evil", Method: zip.Deflate}
			hdr.SetMode(mode.mode)
			w, err := zw.CreateHeader(hdr)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := w.Write([]byte("target")); err != nil {
				t.Fatal(err)
			}
			if err := zw.Close(); err != nil {
				t.Fatal(err)
			}

			dir := t.TempDir()
			_, err = FromArchive(KindExtension, bytes.NewReader(buf.Bytes()), int64(buf.Len()), Options{DataDir: dir})
			if err == nil || !strings.Contains(err.Error(), "not a regular file") {
				t.Fatalf("err = %v, want a not-a-regular-file rejection", err)
			}
			assertNoResidue(t, dir)
		})
	}
}

func TestCheckSize(t *testing.T) {
	if err := checkSize("a.js", MaxFileBytes, 0); err != nil {
		t.Errorf("a file exactly at the limit was rejected: %v", err)
	}
	if err := checkSize("a.js", MaxFileBytes+1, 0); err == nil || !strings.Contains(err.Error(), "per-file limit") {
		t.Errorf("err = %v, want a per-file limit error", err)
	}
	if err := checkSize("b.js", MaxFileBytes, MaxTotalBytes-MaxFileBytes); err != nil {
		t.Errorf("an item exactly at the total limit was rejected: %v", err)
	}
	if err := checkSize("b.js", 1, MaxTotalBytes); err == nil || !strings.Contains(err.Error(), "total size") {
		t.Errorf("err = %v, want a total size error", err)
	}
}

// TestFromArchiveRejectsDuplicateEntry pins the O_EXCL behaviour: a duplicate
// member name in one archive is a packaging bug, and letting it overwrite would
// make the installed bytes order-dependent.
func TestFromArchiveRejectsDuplicateEntry(t *testing.T) {
	data, size := buildZip(t, [][2]string{
		{"extension/eye/index.js", validExtension()["index.js"]},
		{"extension/eye/index.js", "second copy"},
		{"extension/eye/package.json", validExtension()[extension.PackageFile]},
	})
	dir := t.TempDir()
	if _, err := FromArchive(KindExtension, bytes.NewReader(data), size, Options{DataDir: dir}); err == nil {
		t.Fatal("a duplicate entry was accepted")
	}
	assertNoResidue(t, dir)
}

func TestFromArchiveRejectsInvalidPayload(t *testing.T) {
	cases := map[string][][2]string{
		"no package.json": {
			{"extension/eye/index.js", validExtension()["index.js"]},
		},
		"malformed package.json": {
			{"extension/eye/index.js", validExtension()["index.js"]},
			{"extension/eye/package.json", "{not json"},
		},
		"no index.js": {
			{"extension/eye/package.json", validExtension()[extension.PackageFile]},
		},
		"a bad api registration fails the whole extension": {
			{"extension/eye/index.js", validExtension()["index.js"]},
			{"extension/eye/package.json", `{"name":"Demo","suwu":{"api":[{"route":"/x","handler":"../escape.js"}]}}`},
		},
	}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			data, size := buildZip(t, entries)
			dir := t.TempDir()
			_, err := FromArchive(KindExtension, bytes.NewReader(data), size, Options{DataDir: dir})
			if err == nil || !strings.Contains(err.Error(), "not a valid extension") {
				t.Fatalf("err = %v, want the resolver to reject the payload", err)
			}
			if _, err := os.Stat(filepath.Join(extension.Dir(dir), "eye")); err == nil {
				t.Error("a rejected payload was still installed")
			}
			assertNoResidue(t, dir)
		})
	}
}

func TestFromArchiveRejectsEmpty(t *testing.T) {
	data, size := buildZip(t, nil)
	dir := t.TempDir()
	if _, err := FromArchive(KindExtension, bytes.NewReader(data), size, Options{DataDir: dir}); err == nil {
		t.Fatal("an empty archive was accepted")
	}
}

// TestFromArchiveNormalisesPermissions proves the zip's mode bits are ignored:
// a setuid, world-writable entry still lands as 0644.
func TestFromArchiveNormalisesPermissions(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	hdr := &zip.FileHeader{Name: "extension/eye/index.js", Method: zip.Deflate}
	hdr.SetMode(0o4777)
	w, err := zw.CreateHeader(hdr)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(validExtension()["index.js"])); err != nil {
		t.Fatal(err)
	}
	pkg, err := zw.Create("extension/eye/package.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pkg.Write([]byte(validExtension()[extension.PackageFile])); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	item, err := FromArchive(KindExtension, bytes.NewReader(buf.Bytes()), int64(buf.Len()), Options{DataDir: dir})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	info, err := os.Stat(filepath.Join(item.Dir, "index.js"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o644 {
		t.Errorf("mode = %v, want 0644 (the zip's mode bits must be ignored)", perm)
	}
}

// assertNoResidue fails when the scratch tree survived — a successful or
// rejected install must leave no .install directory behind.
func assertNoResidue(t *testing.T, dataDir string) {
	t.Helper()
	stage := filepath.Join(dataDir, StageDirName)
	if _, err := os.Stat(stage); err == nil {
		var left []string
		_ = filepath.WalkDir(stage, func(p string, d os.DirEntry, err error) error {
			if err == nil && d != nil {
				left = append(left, p)
			}
			return nil
		})
		t.Errorf("staging residue left behind: %v", left)
	}
}

// assertNotInstalled fails when id is present in a kind's destination tree.
func assertNotInstalled(t *testing.T, dataDir string, kind Kind, id string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(kind.Root(dataDir), id)); err == nil {
		t.Errorf("%s %q was installed despite the failure", kind.Label(), id)
	}
}
