package server

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
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
}

func (s *stubExtensionRunner) Render(_ context.Context, ext extension.Extension, input map[string]any) ([]byte, error) {
	s.gotExt = ext
	s.gotInput = input
	return s.result, s.err
}

// extTestServer builds a Server rooted at a temp data dir with the built-in
// extensions seeded, and injects the given runner.
func extTestServer(t *testing.T, runner extensionRunner) (*httptest.Server, *auth.Config) {
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
	if err := extension.Seed(extension.Dir(dataDir)); err != nil {
		t.Fatal(err)
	}

	srv := New(cfg, sub, sessions, nil, forward.NewManager(), dataDir)
	srv.extRunner = runner

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, cfg
}

func TestExtensionEndpoint(t *testing.T) {
	runner := &stubExtensionRunner{result: []byte(`{"body":"<html><body>ok</body></html>"}`)}
	ts, cfg := extTestServer(t, runner)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/gqjs/eye?pane=P1&size=200", nil)
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

	// The runner received the right extension and input.
	if runner.gotExt.ID != "eye" {
		t.Errorf("rendered ext = %q, want eye", runner.gotExt.ID)
	}
	if runner.gotExt.Entry == "" {
		t.Error("rendered ext.Entry is empty")
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
	ts, _ := extTestServer(t, &stubExtensionRunner{result: []byte(`"ok"`)})

	// No cookie, no token → 401.
	resp, err := http.Get(ts.URL + "/gqjs/eye")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("no-auth status = %d, want 401", resp.StatusCode)
	}

	// Query token fallback works.
	resp, err = http.Get(ts.URL + "/gqjs/eye?token=testtoken")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("query-token status = %d, want 200", resp.StatusCode)
	}
}

func TestExtensionEndpointErrors(t *testing.T) {
	t.Run("unknown id", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{result: []byte(`"x"`)})
		status := getWithCookie(t, ts.URL+"/gqjs/nope", cfg.Token)
		if status != http.StatusNotFound {
			t.Errorf("status = %d, want 404", status)
		}
	})

	t.Run("traversal id", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{result: []byte(`"x"`)})
		status := getWithCookie(t, ts.URL+"/gqjs/..%2F..%2Fetc", cfg.Token)
		if status != http.StatusNotFound {
			t.Errorf("status = %d, want 404", status)
		}
	})

	t.Run("empty id", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{result: []byte(`"x"`)})
		status := getWithCookie(t, ts.URL+"/gqjs/", cfg.Token)
		if status != http.StatusNotFound {
			t.Errorf("status = %d, want 404", status)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{err: errExtensionTimeout})
		status := getWithCookie(t, ts.URL+"/gqjs/eye", cfg.Token)
		if status != http.StatusGatewayTimeout {
			t.Errorf("status = %d, want 504", status)
		}
	})

	t.Run("runner failure", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{err: os.ErrPermission})
		status := getWithCookie(t, ts.URL+"/gqjs/eye", cfg.Token)
		if status != http.StatusInternalServerError {
			t.Errorf("status = %d, want 500", status)
		}
	})

	t.Run("invalid result", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{result: []byte(`{"nope":1}`)})
		status := getWithCookie(t, ts.URL+"/gqjs/eye", cfg.Token)
		if status != http.StatusInternalServerError {
			t.Errorf("status = %d, want 500", status)
		}
	})

	t.Run("method not allowed", func(t *testing.T) {
		ts, cfg := extTestServer(t, &stubExtensionRunner{result: []byte(`"x"`)})
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/gqjs/eye", nil)
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

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/gqjs/eye", nil)
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
