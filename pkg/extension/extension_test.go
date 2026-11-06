package extension

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestValidID(t *testing.T) {
	valid := []string{"eye", "a", "eye-chart", "my_ext", "a1-b2_c3"}
	invalid := []string{"", "Eye", "eye.js", "../eye", "a/b", ".eye", "-eye", "a b", strings.Repeat("a", 65)}
	for _, id := range valid {
		if !ValidID(id) {
			t.Errorf("ValidID(%q) = false, want true", id)
		}
	}
	for _, id := range invalid {
		if ValidID(id) {
			t.Errorf("ValidID(%q) = true, want false", id)
		}
	}
}

func writeExt(t *testing.T, dir, id, pkg, entry string) {
	t.Helper()
	extDir := filepath.Join(dir, id)
	if err := os.MkdirAll(extDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if pkg != "" {
		if err := os.WriteFile(filepath.Join(extDir, PackageFile), []byte(pkg), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if entry != "" {
		if err := os.WriteFile(filepath.Join(extDir, EntryFile), []byte(entry), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// mkdirExt creates one directory inside an extension fixture (e.g. its static
// root): Resolve now refuses a declared suwu.static that does not exist.
func mkdirExt(t *testing.T, dir, id, sub string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, id, sub), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestResolve(t *testing.T) {
	dir := t.TempDir()
	writeExt(t, dir, "eye",
		`{"name":"Eye","description":"eye demo","suwu":{"params":[{"key":"size","label":"Size"}]}}`,
		`function handler(){return "x"}`)

	ext, err := Resolve(dir, "eye")
	if err != nil {
		t.Fatal(err)
	}
	if ext.ID != "eye" || ext.Name != "Eye" || ext.Description != "eye demo" {
		t.Errorf("ext = %+v", ext)
	}
	if len(ext.Params) != 1 || ext.Params[0].Key != "size" || ext.Params[0].Label != "Size" {
		t.Errorf("params = %+v", ext.Params)
	}
	if ext.Entry != filepath.Join(dir, "eye", EntryFile) {
		t.Errorf("entry = %q", ext.Entry)
	}
	if ext.Dir != filepath.Join(dir, "eye") {
		t.Errorf("dir = %q", ext.Dir)
	}
}

func TestResolveErrors(t *testing.T) {
	dir := t.TempDir()

	if _, err := Resolve(dir, "../evil"); err == nil {
		t.Error("expected error for invalid id")
	}
	if _, err := Resolve(dir, "missing"); err == nil {
		t.Error("expected error for missing extension")
	}

	// name defaults to the directory id when omitted from package.json
	writeExt(t, dir, "unnamed", `{}`, `function handler(){return "x"}`)
	ext, err := Resolve(dir, "unnamed")
	if err != nil {
		t.Fatal(err)
	}
	if ext.Name != "unnamed" {
		t.Errorf("name = %q, want unnamed", ext.Name)
	}

	// missing entry
	writeExt(t, dir, "noidx", `{"name":"x"}`, "")
	if _, err := Resolve(dir, "noidx"); err == nil {
		t.Error("expected error for missing index.js")
	}

	// missing package.json (no legacy meta.json fallback)
	writeExt(t, dir, "nopkg", "", `function handler(){}`)
	if _, err := Resolve(dir, "nopkg"); err == nil || !strings.Contains(err.Error(), "missing package.json") {
		t.Errorf("err = %v, want missing package.json", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "nopkg", "meta.json"), []byte(`{"name":"Legacy"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(dir, "nopkg"); err == nil {
		t.Error("legacy meta.json must not substitute for package.json")
	}

	// invalid package.json
	writeExt(t, dir, "badpkg", `{not json}`, `function handler(){}`)
	if _, err := Resolve(dir, "badpkg"); err == nil {
		t.Error("expected error for invalid package.json")
	}
}

func TestList(t *testing.T) {
	dir := t.TempDir()

	// Missing dir → empty, no error.
	if got, err := List(dir); err != nil || len(got) != 0 {
		t.Errorf("List(missing) = %v, %v; want empty, nil", got, err)
	}

	writeExt(t, dir, "beta", `{"name":"Beta"}`, `function handler(){return "b"}`)
	writeExt(t, dir, "alpha", `{"name":"Alpha"}`, `function handler(){return "a"}`)
	// Broken entries are skipped.
	writeExt(t, dir, "broken", `{bad`, `function handler(){}`)
	writeExt(t, dir, "noidx", `{"name":"n"}`, "")
	// A stray file (not a dir) is ignored.
	if err := os.WriteFile(filepath.Join(dir, "stray.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := List(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (%+v)", len(got), got)
	}
	if got[0].ID != "alpha" || got[1].ID != "beta" {
		t.Errorf("order = [%s %s], want [alpha beta]", got[0].ID, got[1].ID)
	}
}

// The suwu object is the single home for Suwu's own settings; the top level
// belongs to npm. Display fields therefore resolve suwu-first with a deprecated
// top-level fallback, and suwu.version never inherits the npm version.
func TestResolveDisplayFields(t *testing.T) {
	dir := t.TempDir()

	// suwu wins over the npm fields in the same file.
	writeExt(t, dir, "draw", `{
		"name": "npm-package-name",
		"version": "9.9.9",
		"description": "npm description",
		"suwu": {
			"name": "Excalidraw",
			"description": "hand-drawn whiteboard",
			"version": "1.2.3"
		}
	}`, `function handler(){}`)
	ext, err := Resolve(dir, "draw")
	if err != nil {
		t.Fatal(err)
	}
	if ext.Name != "Excalidraw" || ext.Description != "hand-drawn whiteboard" || ext.Version != "1.2.3" {
		t.Errorf("display = %q / %q / %q", ext.Name, ext.Description, ext.Version)
	}

	// Legacy install: only the top-level npm fields exist.
	writeExt(t, dir, "legacy", `{"name":"Legacy Eye","version":"0.4.0","description":"old style"}`, `function handler(){}`)
	ext, err = Resolve(dir, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	if ext.Name != "Legacy Eye" || ext.Description != "old style" {
		t.Errorf("legacy fallback = %q / %q", ext.Name, ext.Description)
	}
	if ext.Version != "" {
		t.Errorf("version = %q, want empty: the npm version is not the tile version", ext.Version)
	}

	// Nothing declared at all: the id is the name.
	writeExt(t, dir, "bare", `{}`, `function handler(){}`)
	ext, err = Resolve(dir, "bare")
	if err != nil {
		t.Fatal(err)
	}
	if ext.Name != "bare" || ext.Description != "" || ext.Version != "" {
		t.Errorf("bare = %q / %q / %q", ext.Name, ext.Description, ext.Version)
	}

	// Whitespace is trimmed, empty-after-trim counts as absent.
	writeExt(t, dir, "padded", `{"suwu":{"name":"  Padded  ","description":"   "}}`, `function handler(){}`)
	ext, err = Resolve(dir, "padded")
	if err != nil {
		t.Fatal(err)
	}
	if ext.Name != "Padded" || ext.Description != "" {
		t.Errorf("padded = %q / %q", ext.Name, ext.Description)
	}
}

func TestResolveRejectsBadDisplayFields(t *testing.T) {
	dir := t.TempDir()
	long := strings.Repeat("x", maxDescriptionRunes+1)

	bad := map[string]string{
		"overlong name":        `{"suwu":{"name":"` + strings.Repeat("n", maxDisplayNameRunes+1) + `"}}`,
		"overlong description": `{"suwu":{"description":"` + long + `"}}`,
		"overlong version":     `{"suwu":{"version":"` + strings.Repeat("1", maxVersionRunes+1) + `"}}`,
		"control char":         `{"suwu":{"name":"a\u0007b"}}`,
	}
	for name, pkg := range bad {
		t.Run(name, func(t *testing.T) {
			writeExt(t, dir, "bad", pkg, `function handler(){}`)
			if _, err := Resolve(dir, "bad"); err == nil {
				t.Errorf("manifest %s must fail Resolve", pkg)
			}
		})
	}
}

// ReadManifest is the only reader of display fields outside this package, so it
// has to agree with Resolve for the same file.
func TestReadManifestMatchesResolve(t *testing.T) {
	dir := t.TempDir()
	writeExt(t, dir, "eye", `{"name":"Eye","suwu":{"name":"The Eye","description":"follows","version":"2.0.0"}}`, `function handler(){}`)

	ext, err := Resolve(dir, "eye")
	if err != nil {
		t.Fatal(err)
	}
	m, err := ReadManifest(filepath.Join(dir, "eye", PackageFile), "eye")
	if err != nil {
		t.Fatal(err)
	}
	if m.ID != ext.ID || m.Name != ext.Name || m.Description != ext.Description || m.Version != ext.Version {
		t.Errorf("ReadManifest = %+v, Resolve = %+v", m, ext)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "eye", PackageFile))
	if err != nil {
		t.Fatal(err)
	}
	fromBytes, err := ReadManifestBytes(raw, "eye")
	if err != nil {
		t.Fatal(err)
	}
	if fromBytes != m {
		t.Errorf("ReadManifestBytes = %+v, want %+v", fromBytes, m)
	}

	if _, err := ReadManifestBytes([]byte("{"), "eye"); err == nil {
		t.Error("malformed JSON must fail")
	}
}

func TestResolveNetOptIn(t *testing.T) {
	dir := t.TempDir()

	writeExt(t, dir, "offline", `{"name":"Offline","suwu":{"params":[]}}`, `function handler(){}`)
	ext, err := Resolve(dir, "offline")
	if err != nil {
		t.Fatal(err)
	}
	if ext.Net {
		t.Error("net must default to false")
	}

	writeExt(t, dir, "online", `{"name":"Online","suwu":{"net":true}}`, `function handler(){}`)
	ext, err = Resolve(dir, "online")
	if err != nil {
		t.Fatal(err)
	}
	if !ext.Net {
		t.Error("suwu.net was not parsed")
	}

	// Examples ship outside the binary: nothing is embedded or seeded.
	if _, err := os.Stat(filepath.Join(dir, "online", "meta.json")); !os.IsNotExist(err) {
		t.Error("meta.json must not exist")
	}
}

func TestResolveStaticDeclaration(t *testing.T) {
	dir := t.TempDir()

	writeExt(t, dir, "web", `{"name":"Web","suwu":{"static":"public"}}`, `function handler(){}`)
	mkdirExt(t, dir, "web", "public")
	ext, err := Resolve(dir, "web")
	if err != nil {
		t.Fatal(err)
	}
	if ext.Static != "public" {
		t.Errorf("static = %q, want public", ext.Static)
	}

	// The declared directory must exist: a built extension whose dist/ was
	// never built would otherwise resolve and then 404 every subresource.
	writeExt(t, dir, "gone", `{"name":"Gone","suwu":{"static":"dist"}}`, `function handler(){}`)
	if _, err := Resolve(dir, "gone"); err == nil {
		t.Error("a missing suwu.static directory must fail Resolve")
	}

	// Absent declaration: no static serving, StaticPath refuses.
	writeExt(t, dir, "plain", `{"name":"Plain"}`, `function handler(){}`)
	ext, err = Resolve(dir, "plain")
	if err != nil {
		t.Fatal(err)
	}
	if ext.Static != "" {
		t.Errorf("static = %q, want empty", ext.Static)
	}
	if _, err := ext.StaticPath("app.js"); err == nil {
		t.Error("StaticPath must fail without a declared directory")
	}

	// Rejected roots: only a dedicated, non-hidden subtree may be served.
	// strconv.Quote embeds the value JSON-compatibly (a raw backslash would
	// otherwise become a JSON escape like \b).
	badRoots := []string{".", "..", "/abs", "public/../x", ".hidden", "public/", "a\\b", "public//x"}
	for _, root := range badRoots {
		writeExt(t, dir, "bad",
			`{"name":"Bad","suwu":{"static":`+strconv.Quote(root)+`}}`, `function handler(){}`)
		if _, err := Resolve(dir, "bad"); err == nil {
			t.Errorf("static root %q accepted", root)
		}
	}
}

func TestResolveFileExtensions(t *testing.T) {
	dir := t.TempDir()

	// Claimed types are normalized to lowercase and sorted.
	writeExt(t, dir, "draw",
		`{"name":"Draw","suwu":{"fileExtensions":[".EXCALIDRAW", ".Calibredraw"]}}`,
		`function handler(){}`)
	ext, err := Resolve(dir, "draw")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{".calibredraw", ".excalidraw"}
	if len(ext.FileExtensions) != len(want) || ext.FileExtensions[0] != want[0] || ext.FileExtensions[1] != want[1] {
		t.Errorf("fileExtensions = %v, want %v", ext.FileExtensions, want)
	}

	// Duplicates collapse after normalization.
	writeExt(t, dir, "dup",
		`{"name":"Dup","suwu":{"fileExtensions":[".md",".MD",".MD"]}}`,
		`function handler(){}`)
	dup, err := Resolve(dir, "dup")
	if err != nil {
		t.Fatal(err)
	}
	if len(dup.FileExtensions) != 1 || dup.FileExtensions[0] != ".md" {
		t.Errorf("fileExtensions = %v, want [.md]", dup.FileExtensions)
	}

	// No declaration: the extension claims nothing.
	writeExt(t, dir, "plain", `{"name":"Plain"}`, `function handler(){}`)
	ext, err = Resolve(dir, "plain")
	if err != nil {
		t.Fatal(err)
	}
	if len(ext.FileExtensions) != 0 {
		t.Errorf("fileExtensions = %v, want none", ext.FileExtensions)
	}

	// Rejected entries: a typo must fail resolution, never silently claim a
	// type the extension cannot handle.
	bad := []string{"excalidraw", ".excalidraw!", ".excalidraw/", ".excalidraw ", " .excalidraw", "."}
	for _, entry := range bad {
		writeExt(t, dir, "bad",
			`{"name":"Bad","suwu":{"fileExtensions":[`+strconv.Quote(entry)+`]}}`,
			`function handler(){}`)
		if _, err := Resolve(dir, "bad"); err == nil {
			t.Errorf("file extension %q accepted", entry)
		}
	}

	// Too many claims.
	many := make([]string, 9)
	for i := range many {
		many[i] = `".f` + strconv.Itoa(i) + `"`
	}
	writeExt(t, dir, "many",
		`{"name":"Many","suwu":{"fileExtensions":[`+strings.Join(many, ",")+`]}}`,
		`function handler(){}`)
	if _, err := Resolve(dir, "many"); err == nil {
		t.Error("more than 8 file extensions must be rejected")
	}
}

func TestStaticPath(t *testing.T) {
	dir := t.TempDir()
	writeExt(t, dir, "web", `{"name":"Web","suwu":{"static":"public"}}`, `function handler(){}`)
	mkdirExt(t, dir, "web", "public")
	ext, err := Resolve(dir, "web")
	if err != nil {
		t.Fatal(err)
	}

	for _, rel := range []string{"app.js", "sub/icon.svg", "a_b-c.woff2"} {
		p, err := ext.StaticPath(rel)
		if err != nil {
			t.Errorf("StaticPath(%q) = %v", rel, err)
			continue
		}
		want := filepath.Join(ext.Dir, "public", rel)
		if p != want {
			t.Errorf("StaticPath(%q) = %q, want %q", rel, p, want)
		}
	}

	for _, rel := range []string{"", "/abs.js", "../x.js", "sub/../x.js", ".env", "assets/.secret", "a//b", "sub/./x", `a\b`} {
		if _, err := ext.StaticPath(rel); err == nil {
			t.Errorf("StaticPath(%q) accepted", rel)
		}
	}
}

func TestDir(t *testing.T) {
	if got, want := Dir("/srv/suwu"), filepath.Join("/srv/suwu", "extension"); got != want {
		t.Errorf("Dir = %q, want %q", got, want)
	}
	if got, want := LegacyDir("/srv/suwu"), filepath.Join("/srv/suwu", "extensions"); got != want {
		t.Errorf("LegacyDir = %q, want %q", got, want)
	}
}

// ── ResolveDir (the pre-rename fallback) ────────────────────────

func TestResolveDir(t *testing.T) {
	valid := `{"name":"Demo"}`
	entry := "function handler() { return { body: '' }; }"

	t.Run("current name wins", func(t *testing.T) {
		root := t.TempDir()
		writeExt(t, Dir(root), "a", valid, entry)
		writeExt(t, LegacyDir(root), "b", valid, entry)
		res := ResolveDir(root)
		if res.Dir != Dir(root) || res.Legacy {
			t.Errorf("Dir = %q legacy = %v, want the current name", res.Dir, res.Legacy)
		}
		if !res.LegacyPresent {
			t.Error("LegacyPresent = false, want true (the leftover must warn)")
		}
	})

	t.Run("falls back to legacy", func(t *testing.T) {
		root := t.TempDir()
		writeExt(t, LegacyDir(root), "b", valid, entry)
		res := ResolveDir(root)
		if !res.Legacy || res.Dir != LegacyDir(root) {
			t.Errorf("Dir = %q legacy = %v, want the legacy name", res.Dir, res.Legacy)
		}
		if !res.LegacyPresent {
			t.Error("LegacyPresent = false, want true")
		}
	})

	t.Run("empty current name does not hide legacy", func(t *testing.T) {
		root := t.TempDir()
		if err := os.MkdirAll(Dir(root), 0o755); err != nil {
			t.Fatal(err)
		}
		writeExt(t, LegacyDir(root), "b", valid, entry)
		if res := ResolveDir(root); !res.Legacy {
			t.Errorf("Legacy = false, want true (an empty dir is not a reason to ignore legacy)")
		}
	})

	t.Run("neither exists uses the current name", func(t *testing.T) {
		res := ResolveDir(t.TempDir())
		if res.Dir == LegacyDir(res.Dir) || filepath.Base(res.Dir) != DirName {
			t.Errorf("Dir = %q, want the current name", res.Dir)
		}
		if res.Legacy || res.LegacyPresent {
			t.Errorf("legacy = %v present = %v, want false/false", res.Legacy, res.LegacyPresent)
		}
	})
}

// ── API route registration ─────────────────────────────────────

func TestResolveAPIRoutes(t *testing.T) {
	dir := t.TempDir()
	writeExt(t, dir, "demo", `{
		"name": "Demo",
		"suwu": {
			"api": [
				{"route": "/hello", "handler": "api1.js"},
				{"route": "/hello/world", "handler": "api2.js"},
				{"route": "note/<id>", "handler": "note.js"},
				{"route": "/", "handler": "root.js"}
			]
		}
	}`, `function handler(){return "x"}`)

	ext, err := Resolve(dir, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if len(ext.API) != 4 {
		t.Fatalf("api = %+v, want 4 routes", ext.API)
	}
	if ext.API[0].Handler != "api1.js" || ext.API[3].Route != "/" {
		t.Errorf("api order/shape = %+v", ext.API)
	}

	p, err := ext.HandlerPath("api1.js")
	if err != nil {
		t.Fatal(err)
	}
	if p != filepath.Join(dir, "demo", "api1.js") {
		t.Errorf("handler path = %q", p)
	}
}

func TestResolveRejectsBadAPIRegistrations(t *testing.T) {
	cases := map[string]string{
		"empty route":      `{"suwu":{"api":[{"route":"","handler":"a.js"}]}}`,
		"empty segment":    `{"suwu":{"api":[{"route":"/a//b","handler":"a.js"}]}}`,
		"bad param":        `{"suwu":{"api":[{"route":"/n/<1id>","handler":"a.js"}]}}`,
		"unclosed param":   `{"suwu":{"api":[{"route":"/n/<id","handler":"a.js"}]}}`,
		"angle in literal": `{"suwu":{"api":[{"route":"/a>b","handler":"a.js"}]}}`,
		"empty handler":    `{"suwu":{"api":[{"route":"/a","handler":""}]}}`,
		"not js":           `{"suwu":{"api":[{"route":"/a","handler":"evil.txt"}]}}`,
		"dotdot handler":   `{"suwu":{"api":[{"route":"/a","handler":"../evil.js"}]}}`,
		"inner dotdot":     `{"suwu":{"api":[{"route":"/a","handler":"sub/../../evil.js"}]}}`,
		"absolute":         `{"suwu":{"api":[{"route":"/a","handler":"/etc/passwd.js"}]}}`,
	}
	dir := t.TempDir()
	for name, pkg := range cases {
		t.Run(name, func(t *testing.T) {
			writeExt(t, dir, "x", pkg, `function handler(){}`)
			if _, err := Resolve(dir, "x"); err == nil {
				t.Errorf("pkg %s: expected rejection", pkg)
			}
		})
	}
}

func TestMatchAPI(t *testing.T) {
	routes := []APIRoute{
		{Route: "/hello", Handler: "api1.js"},
		{Route: "/hello/world", Handler: "api2.js"},
		{Route: "/note/<id>", Handler: "note.js"},
		{Route: "/", Handler: "root.js"},
	}
	cases := []struct {
		path    string
		want    string
		params  map[string]string
		noMatch bool
	}{
		// First match wins: /hello shortcuts the more specific /hello/world.
		{path: "/hello/world", want: "api1.js", params: map[string]string{}},
		{path: "/hello/world/deeper", want: "api1.js", params: map[string]string{}},
		{path: "/hello", want: "api1.js", params: map[string]string{}},
		{path: "/hello/", want: "api1.js", params: map[string]string{}},
		// Segment boundary: /hello must not match /helloworld.
		{path: "/helloworld", want: "root.js", params: map[string]string{}},
		// Param binding, including prefix matches with deeper paths.
		{path: "/note/42", want: "note.js", params: map[string]string{"id": "42"}},
		{path: "/note/42/edit", want: "note.js", params: map[string]string{"id": "42"}},
		// The root catch-all is last, so it only sees what nothing else took.
		{path: "/anything/else", want: "root.js", params: map[string]string{}},
		{path: "/", want: "root.js", params: map[string]string{}},
		{path: "", want: "root.js", params: map[string]string{}},
	}
	for _, tc := range cases {
		rt, params, ok := MatchAPI(routes, tc.path)
		if tc.noMatch {
			if ok {
				t.Errorf("MatchAPI(%q) matched %s", tc.path, rt.Handler)
			}
			continue
		}
		if !ok {
			t.Errorf("MatchAPI(%q) no match, want %s", tc.path, tc.want)
			continue
		}
		if rt.Handler != tc.want {
			t.Errorf("MatchAPI(%q) handler = %s, want %s", tc.path, rt.Handler, tc.want)
		}
		for k, v := range tc.params {
			if params[k] != v {
				t.Errorf("MatchAPI(%q) params[%s] = %q, want %q", tc.path, k, params[k], v)
			}
		}
	}

	// No root route registered → unmatched paths fail closed.
	if _, _, ok := MatchAPI(routes[:3], "/other"); ok {
		t.Error("expected no match without a root route")
	}
}

func TestHandlerPathValidation(t *testing.T) {
	extDir := filepath.Join(t.TempDir(), "demo")
	if err := os.MkdirAll(extDir, 0o755); err != nil {
		t.Fatal(err)
	}
	valid := []string{"api.js", "sub/handler.js", "a_b-c.js"}
	for _, h := range valid {
		p, err := handlerPath(extDir, h)
		if err != nil {
			t.Errorf("handlerPath(%q) = %v", h, err)
			continue
		}
		if p != filepath.Join(extDir, h) {
			t.Errorf("path = %q", p)
		}
	}
	invalid := []string{"", "a.txt", "/abs.js", `sub\x.js`, "../x.js", "sub/../x.js", "./x.js"}
	for _, h := range invalid {
		if _, err := handlerPath(extDir, h); err == nil {
			t.Errorf("handlerPath(%q) accepted", h)
		}
	}
}
