package staticserve

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func newTestEntry(t *testing.T, files map[string]string) *Entry {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	m := NewManager()
	t.Cleanup(m.CloseAll)
	e, _, err := m.Create(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func request(t *testing.T, e *Entry, target, rel string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, target, nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, r, rel)
	return w
}

func TestServeHTMLInjectsBridgeAndSandbox(t *testing.T) {
	e := newTestEntry(t, map[string]string{
		"index.html": "<html><body><h1>hello</h1></body></html>",
	})
	w := request(t, e, "http://localhost/staticserve/site/", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "staticserve-reload") || !strings.Contains(body, "hello") {
		t.Fatalf("bridge not injected: %s", body)
	}
	if got := w.Header().Get("Content-Security-Policy"); !strings.Contains(got, "sandbox") || strings.Contains(got, "allow-same-origin") {
		t.Fatalf("csp = %q", got)
	}
	if got := w.Header().Get("Referrer-Policy"); got != "unsafe-url" {
		t.Fatalf("referrer policy = %q", got)
	}
}

func TestServeOpaqueOriginCORS(t *testing.T) {
	e := newTestEntry(t, map[string]string{"app.js": "export const x = 1;"})
	r := httptest.NewRequest(http.MethodGet, "http://localhost/staticserve/site/app.js", nil)
	r.Header.Set("Origin", "null")
	r.Header.Set("Referer", "http://localhost/staticserve/site/")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, r, "app.js")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "null" {
		t.Fatalf("opaque CORS = %q, want null", got)
	}

	// An unrelated opaque-origin page must not be able to read preview files.
	evil := httptest.NewRequest(http.MethodGet, "http://localhost/staticserve/site/app.js", nil)
	evil.Header.Set("Origin", "null")
	evil.Header.Set("Referer", "http://evil.test/")
	ew := httptest.NewRecorder()
	e.ServeHTTP(ew, evil, "app.js")
	if got := ew.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unrelated opaque CORS = %q, want empty", got)
	}
}

func TestServeCSSAndMIME(t *testing.T) {
	e := newTestEntry(t, map[string]string{"style.css": "body{}"})
	w := request(t, e, "http://localhost/staticserve/site/style.css", "style.css")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if got := w.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/css") {
		t.Fatalf("content type = %q", got)
	}
}

func TestServeDirectoryIndexAndListing(t *testing.T) {
	e := newTestEntry(t, map[string]string{
		"sub/index.html": "<body>sub</body>",
		"list/a.txt":     "a",
	})
	w := request(t, e, "http://localhost/staticserve/site/sub/", "sub")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "sub") {
		t.Fatalf("index status=%d body=%s", w.Code, w.Body.String())
	}
	w = request(t, e, "http://localhost/staticserve/site/list/", "list")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "a.txt") {
		t.Fatalf("listing status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestServeRejectsTraversalAndSymlinkEscape(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on Windows")
	}
	e := newTestEntry(t, map[string]string{"ok.txt": "ok"})
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(e.Dir, "leak.txt")); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"../secret.txt", "leak.txt"} {
		w := request(t, e, "http://localhost/staticserve/site/"+rel, rel)
		if w.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", rel, w.Code)
		}
	}
}

func TestRefererPath(t *testing.T) {
	if got := RefererPath("http://localhost:8181/staticserve/myweb/", "localhost:8181"); got != "/staticserve/myweb/" {
		t.Fatalf("got %q", got)
	}
	if got := RefererPath("http://evil.test/staticserve/myweb/", "localhost:8181"); got != "" {
		t.Fatalf("foreign host got %q", got)
	}
}
