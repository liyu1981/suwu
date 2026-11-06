package server

// Tests for /gqjs/static/<id>/<path>: the deliberate no-credential policy,
// content types, the inert CSP on document-family types, CORS for opaque
// module fetches, and the fail-closed 404/405/413 gates.

import (
	"archive/zip"
	"compress/gzip"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"suwu/pkg/extension"
)

// staticDemoExt installs an extension declaring "static": "public" with assets
// covering every policy branch, and returns its directory.
func staticDemoExt(t *testing.T, dataDir string) string {
	t.Helper()
	writeAPIExt(t, dataDir, "demo", map[string]string{
		"package.json":     `{"name":"Static Demo","suwu":{"static":"public"}}`,
		"index.js":         `function handler() { return "page"; }`,
		"public/app.js":    `export const answer = 42;`,
		"public/style.css": `body { color: red; }`,
		"public/page.html": `<!doctype html><html><body><script>alert(1)</script></body></html>`,
		"public/icon.svg":  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1"/></svg>`,
		"public/notes.md":  `# not in the allow-list`,
		"public/.env":      `SECRET=hunter2`,
	})
	return filepath.Join(extension.Dir(dataDir), "demo")
}

// suwu.static may point at a zip archive instead of a directory: the same URLs
// are answered from the archive's entries, with the same content types, gzip
// negotiation and conditional handling.
func TestExtensionStaticFromZip(t *testing.T) {
	ts, _, dataDir := extTestServerDir(t, nil)
	id := "zipped"
	writeAPIExt(t, dataDir, id, map[string]string{
		"package.json": `{"name":"Zipped","suwu":{"static":"dist.zip"}}`,
		"index.js":     `function handler() { return "page"; }`,
	})
	body := strings.Repeat("export const x = 1;\n", 200)
	writeZipFile(t, filepath.Join(extension.Dir(dataDir), id, "dist.zip"), map[string]string{
		"assets/app-abc.js": body,
		"assets/app.css":    "body{color:red}",
		"fonts/Font.woff2":  "wOF2data",
		"page.html":         "<!doctype html><p>hi</p>",
		"notes.md":          "# not in the allow-list",
	})

	t.Run("js with gzip", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/gqjs/static/"+id+"/assets/app-abc.js", nil)
		req.Header.Set("Accept-Encoding", "gzip")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		if got := resp.Header.Get("Content-Encoding"); got != "gzip" {
			t.Fatalf("Content-Encoding = %q, want gzip", got)
		}
		if got := resp.Header.Get("Content-Type"); !strings.Contains(got, "javascript") {
			t.Errorf("Content-Type = %q", got)
		}
		zr, err := gzip.NewReader(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(zr)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != body {
			t.Error("entry body does not match the archive")
		}
	})

	t.Run("font is served verbatim", func(t *testing.T) {
		resp := staticReq(t, ts.URL, http.MethodGet, "/gqjs/static/"+id+"/fonts/Font.woff2", "")
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		if got := resp.Header.Get("Content-Type"); got != "font/woff2" {
			t.Errorf("Content-Type = %q", got)
		}
		if got := resp.Header.Get("Content-Encoding"); got != "" {
			t.Errorf("Content-Encoding = %q, want none for a compressed format", got)
		}
	})

	t.Run("document type gets the inert CSP", func(t *testing.T) {
		resp := staticReq(t, ts.URL, http.MethodGet, "/gqjs/static/"+id+"/page.html", "")
		defer resp.Body.Close()
		if got := resp.Header.Get("Content-Security-Policy"); got != extensionStaticInertCSP {
			t.Errorf("CSP = %q", got)
		}
	})

	t.Run("unknown type and missing entry 404", func(t *testing.T) {
		for _, p := range []string{"/gqjs/static/" + id + "/notes.md", "/gqjs/static/" + id + "/nope.js"} {
			resp := staticReq(t, ts.URL, http.MethodGet, p, "")
			resp.Body.Close()
			if resp.StatusCode != http.StatusNotFound {
				t.Errorf("%s: status = %d, want 404", p, resp.StatusCode)
			}
		}
	})

	t.Run("conditional request revalidates", func(t *testing.T) {
		first := staticReq(t, ts.URL, http.MethodGet, "/gqjs/static/"+id+"/assets/app.css", "")
		first.Body.Close()
		lastMod := first.Header.Get("Last-Modified")
		if lastMod == "" {
			t.Fatal("no Last-Modified on the zip path")
		}
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/gqjs/static/"+id+"/assets/app.css", nil)
		req.Header.Set("If-Modified-Since", lastMod)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNotModified {
			t.Errorf("status = %d, want 304", resp.StatusCode)
		}
	})

	t.Run("traversal is refused", func(t *testing.T) {
		for _, p := range []string{
			"/gqjs/static/" + id + "/../package.json",
			"/gqjs/static/" + id + "/assets/../../index.js",
		} {
			resp := staticReq(t, ts.URL, http.MethodGet, p, "")
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				t.Errorf("%s: traversal must not be served", p)
			}
		}
	})
}

// writeZipFile writes a zip fixture (name → content) at path.
func writeZipFile(t *testing.T, path string, entries map[string]string) {
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
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
}

// A built extension ships big JS. Proxied through the real handler, a gzip
// client gets a compressed body that round-trips to the on-disk bytes, and a
// plain client still gets identity — with Vary either way.
func TestExtensionStaticGzip(t *testing.T) {
	ts, _, dataDir := extTestServerDir(t, nil)
	extDir := staticDemoExt(t, dataDir)

	body := strings.Repeat("export const x = 1;\n", 200)
	if err := os.MkdirAll(filepath.Join(extDir, "public"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(extDir, "public", "big.js"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	get := func(t *testing.T, accept string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, ts.URL+"/gqjs/static/demo/big.js", nil)
		if err != nil {
			t.Fatal(err)
		}
		if accept != "" {
			req.Header.Set("Accept-Encoding", accept)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	t.Run("gzip client", func(t *testing.T) {
		resp := get(t, "gzip")
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		if got := resp.Header.Get("Content-Encoding"); got != "gzip" {
			t.Fatalf("Content-Encoding = %q, want gzip", got)
		}
		if got := resp.Header.Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
			t.Errorf("Vary = %q", got)
		}
		// The transport already decoded it (Go sends Accept-Encoding for us only
		// when we set it explicitly; here we did, so Uncompressed is false and a
		// transparent decode does not happen — read through gzip ourselves).
		zr, err := gzip.NewReader(resp.Body)
		if err != nil {
			t.Fatalf("gzip reader: %v", err)
		}
		got, err := io.ReadAll(zr)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if string(got) != body {
			t.Error("decompressed body does not match the file")
		}
		if resp.ContentLength <= 0 || resp.ContentLength >= int64(len(body)) {
			t.Errorf("Content-Length = %d, want the compressed size", resp.ContentLength)
		}
	})

	t.Run("plain client", func(t *testing.T) {
		resp := get(t, "")
		defer resp.Body.Close()
		if got := resp.Header.Get("Content-Encoding"); got != "" {
			t.Errorf("Content-Encoding = %q, want none", got)
		}
		if got := resp.Header.Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
			t.Errorf("Vary = %q, want Accept-Encoding advertised anyway", got)
		}
		got, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != body {
			t.Error("identity body does not match the file")
		}
	})

	t.Run("conditional request still revalidates", func(t *testing.T) {
		first := get(t, "gzip")
		first.Body.Close()
		lastMod := first.Header.Get("Last-Modified")
		if lastMod == "" {
			t.Fatal("no Last-Modified")
		}
		req, err := http.NewRequest(http.MethodGet, ts.URL+"/gqjs/static/demo/big.js", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Accept-Encoding", "gzip")
		req.Header.Set("If-Modified-Since", lastMod)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNotModified {
			t.Errorf("status = %d, want 304", resp.StatusCode)
		}
	})
}

// .wasm must be served: built extensions fetch it at runtime, and
// WebAssembly.instantiateStreaming rejects any other MIME type.
func TestExtensionStaticWasm(t *testing.T) {
	ts, _, dataDir := extTestServerDir(t, nil)
	extDir := staticDemoExt(t, dataDir)
	if err := os.WriteFile(filepath.Join(extDir, "public", "woff2.wasm"), []byte("\x00asm"), 0o644); err != nil {
		t.Fatal(err)
	}

	resp := staticReq(t, ts.URL, http.MethodGet, "/gqjs/static/demo/woff2.wasm", "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "application/wasm" {
		t.Errorf("Content-Type = %q, want application/wasm", got)
	}
}

// staticReq performs a static request with an optional Origin header and no
// other credentials, returning the response.
func staticReq(t *testing.T, base, method, path, origin string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, base+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestExtensionStaticServing(t *testing.T) {
	ts, _, dataDir := extTestServerDir(t, nil)
	extDir := staticDemoExt(t, dataDir)

	t.Run("public without credentials", func(t *testing.T) {
		// Deliberate: no cookie, no token — ES-module imports cannot carry
		// either, so static assets are public by design.
		resp := staticReq(t, ts.URL, http.MethodGet, "/gqjs/static/demo/app.js", "")
		body := readAll(t, resp)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); ct != "text/javascript; charset=utf-8" {
			t.Errorf("Content-Type = %q", ct)
		}
		if body != `export const answer = 42;` {
			t.Errorf("body = %q", body)
		}
		if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("nosniff = %q", resp.Header.Get("X-Content-Type-Options"))
		}
		if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
			t.Errorf("Cache-Control = %q, want no-cache", cc)
		}
	})

	t.Run("content types", func(t *testing.T) {
		cases := map[string]string{
			"/gqjs/static/demo/style.css": "text/css; charset=utf-8",
			"/gqjs/static/demo/icon.svg":  "image/svg+xml",
			"/gqjs/static/demo/page.html": "text/html; charset=utf-8",
		}
		for path, want := range cases {
			resp := staticReq(t, ts.URL, http.MethodGet, path, "")
			resp.Body.Close()
			if got := resp.Header.Get("Content-Type"); got != want {
				t.Errorf("%s: Content-Type = %q, want %q", path, got, want)
			}
		}
	})

	t.Run("inert CSP only on document-family types", func(t *testing.T) {
		for _, path := range []string{"/gqjs/static/demo/page.html", "/gqjs/static/demo/icon.svg"} {
			resp := staticReq(t, ts.URL, http.MethodGet, path, "")
			resp.Body.Close()
			csp := resp.Header.Get("Content-Security-Policy")
			if !strings.Contains(csp, "default-src 'none'") {
				t.Errorf("%s: CSP = %q, want inert policy", path, csp)
			}
		}
		resp := staticReq(t, ts.URL, http.MethodGet, "/gqjs/static/demo/app.js", "")
		resp.Body.Close()
		if csp := resp.Header.Get("Content-Security-Policy"); csp != "" {
			t.Errorf("scripts must not get the document CSP, got %q", csp)
		}
	})

	t.Run("cors for opaque module fetches", func(t *testing.T) {
		resp := staticReq(t, ts.URL, http.MethodGet, "/gqjs/static/demo/app.js", "null")
		resp.Body.Close()
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "null" {
			t.Errorf("ACAO = %q, want null", got)
		}
		resp = staticReq(t, ts.URL, http.MethodGet, "/gqjs/static/demo/app.js", "https://evil.example")
		resp.Body.Close()
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("ACAO for a foreign origin = %q, want empty", got)
		}
	})

	t.Run("method not allowed", func(t *testing.T) {
		resp := staticReq(t, ts.URL, http.MethodPost, "/gqjs/static/demo/app.js", "")
		resp.Body.Close()
		if resp.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("status = %d, want 405", resp.StatusCode)
		}
		if allow := resp.Header.Get("Allow"); allow != "GET, HEAD" {
			t.Errorf("Allow = %q", allow)
		}
	})

	t.Run("fail-closed 404s", func(t *testing.T) {
		cases := []string{
			"/gqjs/static/nope/app.js",              // unknown extension
			"/gqjs/static/eye/app.js",               // extension declares no static
			"/gqjs/static/demo",                     // empty path
			"/gqjs/static/demo/",                    // empty path (trailing slash)
			"/gqjs/static/demo/.env",                // dotfile
			"/gqjs/static/demo/%2e%2e/package.json", // traversal (decoded to ..)
			"/gqjs/static/%2e%2e/app.js",            // invalid id
			"/gqjs/static/demo/notes.md",            // type outside the allow-list
			"/gqjs/static/demo/nope.js",             // missing file
		}
		for _, path := range cases {
			resp := staticReq(t, ts.URL, http.MethodGet, path, "")
			body := readAll(t, resp)
			resp.Body.Close()
			if resp.StatusCode != http.StatusNotFound {
				t.Errorf("%s: status = %d, want 404", path, resp.StatusCode)
			}
			if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
				t.Errorf("%s: Content-Type = %q, want JSON errors", path, ct)
			}
			if !strings.Contains(body, `"error"`) {
				t.Errorf("%s: body = %q", path, body)
			}
		}
	})

	t.Run("symlink escape denied", func(t *testing.T) {
		link := filepath.Join(extDir, "public", "link.js")
		if err := os.Symlink("/etc/passwd", link); err != nil {
			t.Skipf("symlink unavailable: %v", err)
		}
		resp := staticReq(t, ts.URL, http.MethodGet, "/gqjs/static/demo/link.js", "")
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("status = %d, want 404 for a symlink leaving the static root", resp.StatusCode)
		}
	})

	t.Run("conditional request yields 304", func(t *testing.T) {
		appPath := filepath.Join(extDir, "public", "app.js")
		fixed := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
		if err := os.Chtimes(appPath, fixed, fixed); err != nil {
			t.Fatal(err)
		}
		resp := staticReq(t, ts.URL, http.MethodGet, "/gqjs/static/demo/app.js", "")
		lastMod := resp.Header.Get("Last-Modified")
		resp.Body.Close()
		if lastMod == "" {
			t.Fatal("Last-Modified missing")
		}
		req, err := http.NewRequest(http.MethodGet, ts.URL+"/gqjs/static/demo/app.js", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("If-Modified-Since", lastMod)
		resp2, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp2.Body.Close()
		if resp2.StatusCode != http.StatusNotModified {
			t.Errorf("status = %d, want 304", resp2.StatusCode)
		}
	})

	t.Run("oversized file rejected", func(t *testing.T) {
		big := filepath.Join(extDir, "public", "big.js")
		if err := os.WriteFile(big, make([]byte, extensionStaticMaxBody+1), 0o644); err != nil {
			t.Fatal(err)
		}
		resp := staticReq(t, ts.URL, http.MethodGet, "/gqjs/static/demo/big.js", "")
		resp.Body.Close()
		if resp.StatusCode != http.StatusRequestEntityTooLarge {
			t.Errorf("status = %d, want 413", resp.StatusCode)
		}
	})
}
