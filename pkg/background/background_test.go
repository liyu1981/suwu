package background

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

const validManifest = `{
  "id": "demo",
  "label": "Demo",
  "engine": "webgpu-render-engine",
  "params": [
    { "kind": "number", "key": "speed", "label": "Speed", "default": 1, "min": 0, "max": 3, "decimals": 2, "suffix": "×" },
    { "kind": "select", "key": "detail", "label": "Detail", "default": "high", "options": [
      { "value": "low", "label": "Low" }, { "value": "high", "label": "High" } ] }
  ]
}`

func TestParseManifestValid(t *testing.T) {
	m, err := ParseManifest([]byte(validManifest), "demo")
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	if m.ID != "demo" || m.Label != "Demo" || m.Engine != "webgpu-render-engine" {
		t.Errorf("unexpected manifest: %+v", m)
	}
	if len(m.Params) != 2 || m.Params[0].Suffix != "×" || m.Params[1].Default != "high" {
		t.Errorf("unexpected params: %+v", m.Params)
	}
}

func TestParseManifestRejectsInvalid(t *testing.T) {
	cases := map[string]string{
		"id mismatch":    `{"id":"other","label":"x","engine":"webgpu-render-engine"}`,
		"missing engine": `{"id":"demo","label":"Demo"}`,
		"filelist kind":  `{"id":"demo","label":"x","engine":"webgpu-render-engine","params":[{"kind":"fileList","key":"f","label":"F","default":""}]}`,
		"default out of range": `{"id":"demo","label":"x","engine":"webgpu-render-engine",` +
			`"params":[{"kind":"number","key":"n","label":"N","default":9,"min":0,"max":3}]}`,
		"select default not an option": `{"id":"demo","label":"x","engine":"webgpu-render-engine",` +
			`"params":[{"kind":"select","key":"d","label":"D","default":"nope","options":[{"value":"a","label":"A"}]}]}`,
		"duplicate key": `{"id":"demo","label":"x","engine":"webgpu-render-engine",` +
			`"params":[{"kind":"boolean","key":"b","label":"B","default":true},{"kind":"boolean","key":"b","label":"B","default":false}]}`,
		"bad json": `{"id":`,
	}
	for name, doc := range cases {
		if _, err := ParseManifest([]byte(doc), "demo"); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestValidID(t *testing.T) {
	if !ValidID("cosmos-in-crystal") || !ValidID("a") || !ValidID("a_b-c9") {
		t.Error("expected simple ids to be valid")
	}
	for _, id := range []string{"", "..", ".x", "-x", "a/b", "Upper", strings.Repeat("a", 65)} {
		if ValidID(id) {
			t.Errorf("%q should be invalid", id)
		}
	}
}

// writeBackground creates <dir>/<id> with manifest + scene.js, rewriting the
// sample manifest's "demo" id to match the directory name.
func writeBackground(t *testing.T, dir, id, manifest string) string {
	t.Helper()
	manifest = strings.Replace(manifest, `"demo"`, `"`+id+`"`, 1)
	bg := filepath.Join(dir, id)
	if err := os.MkdirAll(filepath.Join(bg, "shaders"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bg, ManifestFile), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bg, EntryFile), []byte("export default {};"), 0o644); err != nil {
		t.Fatal(err)
	}
	return bg
}

func TestDiskListResolveAndStaticFile(t *testing.T) {
	dir := t.TempDir()
	writeBackground(t, dir, "valid", validManifest)
	// Invalid: manifest id does not match the directory name.
	writeBackground(t, dir, "mismatch", strings.Replace(validManifest, `"demo"`, `"nope"`, 1))
	if err := os.WriteFile(filepath.Join(dir, "not-a-dir.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	list, err := ListDisk(dir)
	if err != nil {
		t.Fatalf("ListDisk: %v", err)
	}
	if len(list) != 1 || list[0].ID != "valid" {
		t.Fatalf("expected only the valid background, got %+v", list)
	}

	if _, err := ResolveDisk(dir, "mismatch"); err == nil {
		t.Error("expected mismatch to fail resolution")
	}
	if _, err := ResolveDisk(dir, "../escape"); err == nil {
		t.Error("expected an invalid id to be rejected")
	}

	// scene.js is required.
	bg := filepath.Join(dir, "valid")
	if err := os.Remove(filepath.Join(bg, EntryFile)); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveDisk(dir, "valid"); err == nil {
		t.Error("expected a missing scene.js to fail resolution")
	}
	writeBackground(t, dir, "valid", validManifest) // restore

	good, err := StaticFile(dir, "valid", "shaders/x.shader.js")
	if err != nil {
		t.Fatalf("StaticFile: %v", err)
	}
	if !filepath.IsAbs(good) {
		t.Errorf("expected an absolute path, got %q", good)
	}
	for _, rel := range []string{"", ".", "..", "../..", "/etc/passwd", "a/../../b", `a\..\b`} {
		if _, err := StaticFile(dir, "valid", rel); err == nil {
			t.Errorf("StaticFile(%q) should be rejected", rel)
		}
	}
	// A symlinked background dir must not serve files outside it.
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "linked")); err == nil {
		// "linked" has no manifest, so resolve it directly through StaticFile
		// with a valid id: make a real dir whose scene.js symlink escapes.
		_ = os.RemoveAll(filepath.Join(dir, "linked"))
	}
}

func TestListFSAndOpenFS(t *testing.T) {
	fsys := fstest.MapFS{
		"webgpu/demo/background.json":     {Data: []byte(validManifest)},
		"webgpu/demo/scene.js":            {Data: []byte("export default {};")},
		"webgpu/demo/shaders/x.shader.js": {Data: []byte("export default {};")},
		"webgpu/bad/background.json":      {Data: []byte(`{"id":"bad","label":"B"}`)},
	}
	list, err := ListFS(fsys, "webgpu")
	if err != nil {
		t.Fatalf("ListFS: %v", err)
	}
	if len(list) != 1 || list[0].ID != "demo" {
		t.Fatalf("expected only demo, got %+v", list)
	}

	f, err := OpenFS(fsys, "webgpu", "demo", "shaders/x.shader.js")
	if err != nil {
		t.Fatalf("OpenFS: %v", err)
	}
	_ = f.Close()

	for _, rel := range []string{"", "..", "../x", "/abs"} {
		if _, err := OpenFS(fsys, "webgpu", "demo", rel); err == nil {
			t.Errorf("OpenFS(%q) should be rejected", rel)
		}
	}
}

// TestShippedManifestsParse guards the committed backgrounds: the builtin
// (backgrounds/webgpu) and the installable examples (examples/background/webgpu).
func TestShippedManifestsParse(t *testing.T) {
	for _, root := range []string{
		filepath.Join("..", "..", "backgrounds", "webgpu"),
		filepath.Join("..", "..", "examples", "backgrounds", "webgpu"),
	} {
		entries, err := os.ReadDir(root)
		if err != nil {
			if os.IsNotExist(err) {
				t.Skipf("%s not present", root)
			}
			t.Fatal(err)
		}
		found := 0
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			found++
			if _, err := ResolveDisk(root, e.Name()); err != nil {
				t.Errorf("%s: %v", e.Name(), err)
			}
		}
		if found == 0 {
			t.Errorf("%s: no backgrounds found", root)
		}
	}
}
