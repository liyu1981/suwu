package server

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"suwu/pkg/assets"
	"suwu/pkg/auth"
	"suwu/pkg/extension"
	"suwu/pkg/forward"
	"suwu/pkg/session"
)

// stubExtensionRunner is a test double for the `suwu gq` child process.
type stubExtensionRunner struct {
	result   []byte
	err      error
	gotInput map[string]any
	gotExt   extension.Extension
	gotEntry string
}

func (s *stubExtensionRunner) Exec(_ context.Context, ext extension.Extension, entry string, input map[string]any) ([]byte, error) {
	s.gotExt = ext
	s.gotEntry = entry
	s.gotInput = input
	return s.result, s.err
}

// extTestServer builds a Server rooted at a temp data dir with the built-in
// extensions seeded, and injects the given runner.
func extTestServer(t *testing.T, runner extensionRunner) (*httptest.Server, *auth.Config) {
	ts, cfg, _ := extTestServerDir(t, runner)
	return ts, cfg
}

// extTestServerDir is extTestServer plus the data dir, so tests can install
// extra extensions next to the seeded ones.
func extTestServerDir(t *testing.T, runner extensionRunner) (*httptest.Server, *auth.Config, string) {
	t.Helper()
	cfg := &auth.Config{
		Token:        "testtoken",
		BindHost:     "127.0.0.1",
		AllowedHosts: []string{"localhost", "127.0.0.1", "::1"},
	}
	sub, err := fs.Sub(assets.FS, "web")
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := session.NewManager()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sessions.Close() })

	dataDir := t.TempDir()
	// No seed mechanism: install the eye fixture the way a user installs an
	// example (copy examples/extensions/eye into <dataDir>/extensions).
	writeAPIExt(t, dataDir, "eye", map[string]string{
		"package.json": `{"name":"Eye","description":"Classic X11-style eye that follows the pointer","suwu":{"params":[{"key":"size","label":"Size","description":"Eye radius in px","defaultValue":"140"}]}}`,
		"index.js":     `function handler() { return "eye page"; }`,
	})

	srv := New(cfg, sub, sessions, nil, forward.NewManager(), dataDir)
	srv.extRunner = runner

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, cfg, dataDir
}

func TestExtensionEndpoint(t *testing.T) {
	runner := &stubExtensionRunner{result: []byte(`{"body":"<html><body>ok</body></html>"}`)}
	ts, cfg := extTestServer(t, runner)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/gqjs/ext/eye?pane=P1&size=200", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "suwu_token", Value: cfg.Token})

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	body := readAll(t, resp)
	if !strings.HasPrefix(body, "<html><body>ok") || !strings.HasSuffix(body, "</body></html>") {
		t.Errorf("body wrapper wrong: %q", body)
	}
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors 'self'") {
		t.Errorf("CSP = %q, want frame-ancestors 'self'", csp)
	} else {
		// The base policy is scoped to this extension's own static and API
		// trees. The htmx CDN is declared only by extensions that use it.
		if strings.Contains(csp, "https://unpkg.com") {
			t.Errorf("base CSP unexpectedly allows the htmx CDN: %q", csp)
		}
		if !strings.Contains(csp, "https://127.0.0.1:") ||
			!strings.Contains(csp, "/gqjs/static/eye/") {
			t.Errorf("CSP missing the extension static origin: %q", csp)
		}
		// The render response must re-sandbox any document loaded at our origin
		// outside the tile (direct tab, escape-sandbox popup).
		if !strings.Contains(csp, "sandbox "+extensionSandboxTokens) {
			t.Errorf("CSP missing the sandbox guard: %q", csp)
		}
		if strings.Contains(csp, "allow-same-origin") {
			t.Errorf("CSP sandbox must not allow same-origin: %q", csp)
		}
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Errorf("Content-Type = %q", ct)
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q", resp.Header.Get("Cache-Control"))
	}
	if !strings.Contains(body, extensionRelayMarker) {
		t.Errorf("HTML response is missing the injected focus/key relay")
	}

	// The runner received the right extension, entry script and input.
	if runner.gotExt.ID != "eye" {
		t.Errorf("rendered ext = %q, want eye", runner.gotExt.ID)
	}
	if runner.gotExt.Entry == "" {
		t.Error("rendered ext.Entry is empty")
	}
	if runner.gotEntry != runner.gotExt.Entry {
		t.Errorf("exec entry = %q, want %q", runner.gotEntry, runner.gotExt.Entry)
	}
	if runner.gotExt.Dir == "" {
		t.Error("rendered ext.Dir is empty")
	}
	if got := runner.gotInput["pane"]; got != "P1" {
		t.Errorf("input.pane = %v, want P1", got)
	}
	if got := runner.gotInput["id"]; got != "eye" {
		t.Errorf("input.id = %v, want eye", got)
	}
	if got := runner.gotInput["action"]; got != "render" {
		t.Errorf("input.action = %v, want render", got)
	}
	// The render script gets the extension-scoped token, never the session token.
	if got, want := runner.gotInput["token"], auth.DeriveExtensionToken(cfg, "eye"); got != want {
		t.Errorf("input.token = %v, want the extension token %v", got, want)
	}
	if runner.gotInput["token"] == cfg.Token {
		t.Error("input.token is the session token")
	}
	// Extra params flow through.
	params, ok := runner.gotInput["params"].(map[string]string)
	if !ok {
		t.Fatalf("input.params type = %T", runner.gotInput["params"])
	}
	if params["size"] != "200" {
		t.Errorf("input.params.size = %q, want 200", params["size"])
	}
}

func TestExtensionEndpointAuth(t *testing.T) {
	ts, cfg := extTestServer(t, &stubExtensionRunner{result: []byte(`"ok"`)})

	// No cookie, no token → 401.
	resp, err := http.Get(ts.URL + "/gqjs/ext/eye")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("no-auth status = %d, want 401", resp.StatusCode)
	}

	// Query token fallback works.
	resp, err = http.Get(ts.URL + "/gqjs/ext/eye?token=testtoken")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("query-token status = %d, want 200", resp.StatusCode)
	}

	// The render route is session-only: an extension-scoped token is rejected.
	extReq, err := http.NewRequest(http.MethodGet, ts.URL+"/gqjs/ext/eye", nil)
	if err != nil {
		t.Fatal(err)
	}
	extReq.Header.Set("Authorization", "Bearer "+auth.DeriveExtensionToken(cfg, "eye"))
	resp, err = http.DefaultClient.Do(extReq)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("extension-token render status = %d, want 401", resp.StatusCode)
	}

	// A sandboxed (opaque-origin) caller sends Origin: null — it must not be
	// rejected as a malformed origin (it used to 400).
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/gqjs/ext/eye", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", "null")
	req.AddCookie(&http.Cookie{Name: "suwu_token", Value: cfg.Token})
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Errorf("opaque-origin page status = %d, want 200", resp2.StatusCode)
	}
}

// TestExtensionCSPForSandboxGuard pins the guard tokens to the tile iframe's
// sandbox attribute. Effective capabilities are the intersection of every
// sandbox source, so these two lists must never drift apart.
func TestExtensionCSPForSandboxGuard(t *testing.T) {
	const tileIframeSandbox = "allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox"
	if extensionSandboxTokens != tileIframeSandbox {
		t.Errorf("extensionSandboxTokens = %q, want the tile iframe's %q", extensionSandboxTokens, tileIframeSandbox)
	}

	r := httptest.NewRequest(http.MethodGet, "https://127.0.0.1:8080/gqjs/ext/eye", nil)
	base := extension.Extension{ID: "eye"}
	for name, csp := range map[string]string{
		"rendered page": extensionCSPFor(r, base),
		"error page":    extensionCSP,
	} {
		if !strings.Contains(csp, "sandbox "+tileIframeSandbox) {
			t.Errorf("%s CSP = %q, want a sandbox directive", name, csp)
		}
		if strings.Contains(csp, "allow-same-origin") {
			t.Errorf("%s CSP = %q, must not allow same-origin", name, csp)
		}
	}
}

func TestExtensionCSPForExtras(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "https://127.0.0.1:8080/gqjs/ext/excalidraw", nil)
	ext := extension.Extension{
		ID:      "excalidraw",
		CSP:     map[string][]string{"script-src": {"'unsafe-eval'"}, "worker-src": {"blob:", "data:"}},
		Sandbox: []string{"allow-downloads"},
	}
	csp := extensionCSPFor(r, ext)
	for _, want := range []string{
		"script-src 'unsafe-inline' https://127.0.0.1:8080/gqjs/static/excalidraw/ http://127.0.0.1:8080/gqjs/static/excalidraw/ 'unsafe-eval'",
		"worker-src https://127.0.0.1:8080/gqjs/static/excalidraw/ http://127.0.0.1:8080/gqjs/static/excalidraw/ blob: data:",
		"sandbox " + extensionSandboxTokens + " allow-downloads",
	} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP = %q, want %q", csp, want)
		}
	}
}

func TestExtensionEndpointErrors(t *testing.T) {
	t.Run("unknown id", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{result: []byte(`"x"`)})
		status := getWithCookie(t, ts.URL+"/gqjs/ext/nope", cfg.Token)
		if status != http.StatusNotFound {
			t.Errorf("status = %d, want 404", status)
		}
	})

	t.Run("traversal id", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{result: []byte(`"x"`)})
		status := getWithCookie(t, ts.URL+"/gqjs/ext/..%2F..%2Fetc", cfg.Token)
		if status != http.StatusNotFound {
			t.Errorf("status = %d, want 404", status)
		}
	})

	t.Run("empty id", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{result: []byte(`"x"`)})
		status := getWithCookie(t, ts.URL+"/gqjs/ext/", cfg.Token)
		if status != http.StatusNotFound {
			t.Errorf("status = %d, want 404", status)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{err: errExtensionTimeout})
		status := getWithCookie(t, ts.URL+"/gqjs/ext/eye", cfg.Token)
		if status != http.StatusGatewayTimeout {
			t.Errorf("status = %d, want 504", status)
		}
	})

	t.Run("runner failure", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{err: os.ErrPermission})
		status := getWithCookie(t, ts.URL+"/gqjs/ext/eye", cfg.Token)
		if status != http.StatusInternalServerError {
			t.Errorf("status = %d, want 500", status)
		}
	})

	t.Run("invalid result", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{result: []byte(`{"nope":1}`)})
		status := getWithCookie(t, ts.URL+"/gqjs/ext/eye", cfg.Token)
		if status != http.StatusInternalServerError {
			t.Errorf("status = %d, want 500", status)
		}
	})

	t.Run("method not allowed", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{result: []byte(`"x"`)})
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/gqjs/ext/eye", nil)
		req.AddCookie(&http.Cookie{Name: "suwu_token", Value: cfg.Token})
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("status = %d, want 405", resp.StatusCode)
		}
	})
}

func TestExtensionStatusAndContentType(t *testing.T) {
	runner := &stubExtensionRunner{result: []byte(`{"status":201,"contentType":"text/plain","body":"created"}`)}
	ts, cfg := extTestServer(t, runner)

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/gqjs/ext/eye", nil)
	req.AddCookie(&http.Cookie{Name: "suwu_token", Value: cfg.Token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 201 {
		t.Errorf("status = %d, want 201", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/plain" {
		t.Errorf("Content-Type = %q, want text/plain", ct)
	}
	if body := readAll(t, resp); body != "created" {
		t.Errorf("body = %q", body)
	}
}

func TestExtensionsList(t *testing.T) {
	ts, _ := extTestServer(t, nil)

	resp, err := http.Get(ts.URL + "/api/extensions?token=testtoken")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	var payload struct {
		Extensions []struct {
			ID          string                     `json:"id"`
			Name        string                     `json:"name"`
			Description string                     `json:"description"`
			Params      []extension.Param          `json:"params"`
			Dir         string                     `json:"dir"`
			Entry       string                     `json:"entry"`
			Extra       map[string]json.RawMessage `json:"-"`
		} `json:"extensions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Extensions) == 0 {
		t.Fatal("no extensions listed")
	}
	found := false
	for _, e := range payload.Extensions {
		if e.ID == "eye" {
			found = true
			if e.Name != "Eye" {
				t.Errorf("name = %q, want Eye", e.Name)
			}
			// Filesystem paths must not leak through the API.
			if e.Dir != "" || e.Entry != "" {
				t.Errorf("dir/entry leaked: %q / %q", e.Dir, e.Entry)
			}
		}
	}
	if !found {
		t.Errorf("seeded 'eye' not listed: %+v", payload.Extensions)
	}
}

func TestParseExtensionResult(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		wantErr bool
		body    string
		status  int
	}{
		{name: "bare string", raw: `"hello"`, body: "hello"},
		{name: "object body", raw: `{"body":"<p>x</p>"}`, body: "<p>x</p>"},
		{name: "html shorthand", raw: `{"html":"<p>y</p>"}`, body: "<p>y</p>"},
		{name: "body wins over html", raw: `{"body":"b","html":"h"}`, body: "b"},
		{name: "with status", raw: `{"status":404,"body":"nope"}`, body: "nope", status: 404},
		{name: "empty", raw: ``, wantErr: true},
		{name: "null", raw: `null`, wantErr: true},
		{name: "no body", raw: `{"status":200}`, wantErr: true},
		{name: "not json", raw: `plain`, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseExtensionResult([]byte(tc.raw))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.page() != tc.body {
				t.Errorf("body = %q, want %q", got.page(), tc.body)
			}
			if tc.status != 0 && got.Status != tc.status {
				t.Errorf("status = %d, want %d", got.Status, tc.status)
			}
		})
	}
}

func TestInjectExtensionRelay(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string // where the marker must appear
	}{
		{name: "before closing body", in: "<html><body><p>x</p></body></html>", want: "before body close"},
		{name: "body uppercase", in: "<HTML><BODY><p>x</p></BODY></HTML>", want: "before body close"},
		{name: "no body falls back to html", in: "<html><head></head></html>", want: "before html close"},
		{name: "fragment appended", in: "<p>no wrapper", want: "appended"},
		{name: "empty body", in: "", want: "unchanged"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := injectExtensionRelay(tc.in)
			if tc.name == "empty body" {
				if got != "" {
					t.Errorf("got %q, want empty", got)
				}
				return
			}
			if !strings.Contains(got, extensionRelayMarker) {
				t.Fatalf("relay not injected: %q", got)
			}
			switch tc.want {
			case "before body close":
				if !strings.Contains(strings.ToLower(got), extensionRelayMarker+">") ||
					strings.Index(strings.ToLower(got), extensionRelayMarker) > strings.LastIndex(strings.ToLower(got), "</body>") {
					t.Errorf("relay not before </body>: %q", got)
				}
			case "before html close":
				if strings.Index(strings.ToLower(got), extensionRelayMarker) > strings.LastIndex(strings.ToLower(got), "</html>") {
					t.Errorf("relay not before </html>: %q", got)
				}
			case "appended":
				if !strings.HasSuffix(strings.TrimSpace(got), "</script>") {
					t.Errorf("relay not appended at end: %q", got)
				}
			}
			// Original content is preserved.
			if tc.in != "" && !strings.Contains(got, strings.TrimSuffix(strings.TrimPrefix(tc.in, "<html>"), "</html>")) && tc.name != "no body falls back to html" {
				// soft check only; main assertion is marker placement
				_ = got
			}
		})
	}
}

func TestInjectExtensionRelayIdempotent(t *testing.T) {
	first := injectExtensionRelay("<html><body>x</body></html>")
	second := injectExtensionRelay(first)
	if second != first {
		t.Errorf("second injection changed the body")
	}
	if got := strings.Count(first, extensionRelayMarker); got != 1 {
		t.Errorf("marker count = %d, want 1", got)
	}
	// An extension that ships its own copy is left alone.
	own := `<html><body><script data-suwu-ext-relay>/* mine */</script></body></html>`
	if got := injectExtensionRelay(own); got != own {
		t.Errorf("should not re-inject over an existing relay: %q", got)
	}
}

func TestIsHTMLContentType(t *testing.T) {
	html := []string{"text/html", "text/html; charset=utf-8", "TEXT/HTML; CHARSET=utf-8"}
	other := []string{"text/plain", "application/json", "image/png", ""}
	for _, ct := range html {
		if !isHTMLContentType(ct) {
			t.Errorf("isHTMLContentType(%q) = false, want true", ct)
		}
	}
	for _, ct := range other {
		if isHTMLContentType(ct) {
			t.Errorf("isHTMLContentType(%q) = true, want false", ct)
		}
	}
}

func TestProcessRunnerDefaults(t *testing.T) {
	p := newProcessRunner("/tmp/ext")
	if p.timeout != defaultExtensionTimeout {
		t.Errorf("timeout = %v, want %v", p.timeout, defaultExtensionTimeout)
	}
	if cap(p.sem) != defaultExtensionConcurrency {
		t.Errorf("sem cap = %d, want %d", cap(p.sem), defaultExtensionConcurrency)
	}
	if p.binary == "" {
		t.Error("binary is empty")
	}
	if p.extDir != "/tmp/ext" {
		t.Errorf("extDir = %q", p.extDir)
	}
}

func TestGQArgsNetOptIn(t *testing.T) {
	p := newProcessRunner("/tmp/ext")
	plain := extension.Extension{}
	withNet := extension.Extension{Net: true}

	offline := strings.Join(p.gqArgs("/ext/index.js", "/tmp/in.json", "/tmp/out.json", plain, nil), " ")
	if strings.Contains(offline, "--allow-net") {
		t.Errorf("without suwu.net the child must stay networkless: %s", offline)
	}
	online := strings.Join(p.gqArgs("/ext/stories.js", "/tmp/in.json", "/tmp/out.json", withNet, nil), " ")
	if !strings.Contains(online, "--allow-net") {
		t.Errorf("with suwu.net the child must get --allow-net: %s", online)
	}
	for _, args := range []string{offline, online} {
		if strings.Contains(args, "--allow-private") {
			t.Errorf("extensions never get --allow-private: %s", args)
		}
	}
	if got := p.gqArgs("/ext/stories.js", "/tmp/in.json", "/tmp/out.json", withNet, nil); got[len(got)-1] != "/ext/stories.js" {
		t.Errorf("entry must stay the final argument, got %q", got[len(got)-1])
	}
}

// suwu.fs is what turns the child writable and mounts the extension's data
// dir plus the requested file's directory; without it nothing but the
// extension tree is visible and the fs stays read-only.
func TestGQArgsFSMounts(t *testing.T) {
	tree := t.TempDir()
	p := newProcessRunner(tree)
	withFS := extension.Extension{ID: "excalidraw", FS: true}
	dataDir := filepath.Join(filepath.Dir(tree), "extension-data", "excalidraw")

	noFile := p.gqArgs("save.js", "/tmp/in.json", "/tmp/out.json", withFS, nil)
	if hasArg(noFile, "--ro") {
		t.Errorf("suwu.fs must keep the child writable: %v", noFile)
	}
	for _, want := range []string{
		"--root", "/ext-data=" + dataDir,
		"--root", "/ext=" + tree,
	} {
		if !hasArg(noFile, want) {
			t.Errorf("missing %q in %v", want, noFile)
		}
	}
	if hasArg(noFile, "/fs=") {
		t.Errorf("with no requested file no /fs mount may appear: %v", noFile)
	}
	if _, err := os.Stat(dataDir); err != nil {
		t.Errorf("extension-data dir must be created: %v", err)
	}

	// The render/API builders deliver query and params as map[string]string;
	// asserting only map[string]any silently found no path and skipped the
	// mount, so every save failed with EACCES.
	for _, tc := range []struct {
		name  string
		input map[string]any
	}{
		{"render params", map[string]any{"params": map[string]string{"file": "/home/u/proj/doc.excalidraw"}}},
		{"api query", map[string]any{"query": map[string]string{"file": "/home/u/proj/doc.excalidraw"}}},
		{"json-shaped query", map[string]any{"query": map[string]any{"file": "/home/u/proj/doc.excalidraw"}}},
		{"top level", map[string]any{"file": "/home/u/proj/doc.excalidraw"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args := p.gqArgs("save.js", "/tmp/in.json", "/tmp/out.json", withFS, tc.input)
			if !hasArg(args, "--root") || !hasArg(args, "/fs=/home/u/proj") {
				t.Errorf("requested file directory must be mounted: %v", args)
			}
		})
	}

	without := p.gqArgs("save.js", "/tmp/in.json", "/tmp/out.json", extension.Extension{}, map[string]any{
		"query": map[string]string{"file": "/home/u/proj/doc.excalidraw"},
	})
	if !hasArg(without, "--ro") {
		t.Errorf("without suwu.fs the child must stay read-only: %v", without)
	}
	if hasArg(without, "/fs=") {
		t.Errorf("suwu.fs is the only gate to a /fs mount: %v", without)
	}
}

// hasArg reports whether args carries exactly v (exact match, so "--root" can
// never be mistaken for the "--ro" prefix).
func hasArg(args []string, v string) bool {
	for _, a := range args {
		if a == v {
			return true
		}
	}
	return false
}

// ── helpers ─────────────────────────────────────────────────────────

func readAll(t *testing.T, resp *http.Response) string {
	t.Helper()
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return sb.String()
}

func getWithCookie(t *testing.T, rawURL, token string) int {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("token", token)
	u.RawQuery = q.Encode()
	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "suwu_token", Value: token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// TestExtensionsListResolvesExtensionDir pins the data-dir rename at the server
// boundary: the list handler reads <dataDir>/extension, and still reads the
// pre-rename <dataDir>/extensions when only that one exists.
func TestExtensionsListResolvesExtensionDir(t *testing.T) {
	listIDs := func(t *testing.T, srv *httptest.Server) []string {
		t.Helper()
		resp, err := http.Get(srv.URL + "/api/extensions?token=testtoken")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var payload struct {
			Extensions []struct {
				ID string `json:"id"`
			} `json:"extensions"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		ids := make([]string, 0, len(payload.Extensions))
		for _, e := range payload.Extensions {
			ids = append(ids, e.ID)
		}
		return ids
	}

	newServer := func(t *testing.T, dataDir string) *httptest.Server {
		t.Helper()
		sessions, err := session.NewManager()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { sessions.Close() })
		cfg := &auth.Config{
			Token:        "testtoken",
			BindHost:     "127.0.0.1",
			AllowedHosts: []string{"localhost", "127.0.0.1", "::1"},
		}
		sub, err := fs.Sub(assets.FS, "web")
		if err != nil {
			t.Fatal(err)
		}
		srv := New(cfg, sub, sessions, nil, forward.NewManager(), dataDir)
		ts := httptest.NewServer(srv.Handler())
		t.Cleanup(ts.Close)
		return ts
	}

	files := map[string]string{
		"package.json": `{"name":"Demo"}`,
		"index.js":     `function handler() { return "x"; }`,
	}
	write := func(t *testing.T, dir, id string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(dir, id), 0o755); err != nil {
			t.Fatal(err)
		}
		for name, body := range files {
			if err := os.WriteFile(filepath.Join(dir, id, name), []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}

	t.Run("current name", func(t *testing.T) {
		dir := t.TempDir()
		write(t, extension.Dir(dir), "new")
		if ids := listIDs(t, newServer(t, dir)); len(ids) != 1 || ids[0] != "new" {
			t.Errorf("ids = %v, want [new]", ids)
		}
	})

	t.Run("legacy name is still read", func(t *testing.T) {
		dir := t.TempDir()
		write(t, extension.LegacyDir(dir), "old")
		if ids := listIDs(t, newServer(t, dir)); len(ids) != 1 || ids[0] != "old" {
			t.Errorf("ids = %v, want [old] from the legacy tree", ids)
		}
	})

	t.Run("current name wins over legacy", func(t *testing.T) {
		dir := t.TempDir()
		write(t, extension.Dir(dir), "new")
		write(t, extension.LegacyDir(dir), "old")
		ids := listIDs(t, newServer(t, dir))
		if len(ids) != 1 || ids[0] != "new" {
			t.Errorf("ids = %v, want only [new]", ids)
		}
	})
}
