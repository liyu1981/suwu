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
	ext, err := Resolve(dir, "web")
	if err != nil {
		t.Fatal(err)
	}
	if ext.Static != "public" {
		t.Errorf("static = %q, want public", ext.Static)
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

func TestStaticPath(t *testing.T) {
	dir := t.TempDir()
	writeExt(t, dir, "web", `{"name":"Web","suwu":{"static":"public"}}`, `function handler(){}`)
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
	if got, want := Dir("/srv/suwu"), filepath.Join("/srv/suwu", "extensions"); got != want {
		t.Errorf("Dir = %q, want %q", got, want)
	}
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
		"empty route":     `{"suwu":{"api":[{"route":"","handler":"a.js"}]}}`,
		"empty segment":   `{"suwu":{"api":[{"route":"/a//b","handler":"a.js"}]}}`,
		"bad param":       `{"suwu":{"api":[{"route":"/n/<1id>","handler":"a.js"}]}}`,
		"unclosed param":  `{"suwu":{"api":[{"route":"/n/<id","handler":"a.js"}]}}`,
		"angle in literal": `{"suwu":{"api":[{"route":"/a>b","handler":"a.js"}]}}`,
		"empty handler":   `{"suwu":{"api":[{"route":"/a","handler":""}]}}`,
		"not js":          `{"suwu":{"api":[{"route":"/a","handler":"evil.txt"}]}}`,
		"dotdot handler":  `{"suwu":{"api":[{"route":"/a","handler":"../evil.js"}]}}`,
		"inner dotdot":    `{"suwu":{"api":[{"route":"/a","handler":"sub/../../evil.js"}]}}`,
		"absolute":        `{"suwu":{"api":[{"route":"/a","handler":"/etc/passwd.js"}]}}`,
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
