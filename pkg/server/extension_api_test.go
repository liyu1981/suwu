package server

// Tests for /gqjs/api/<id>/<path>: ordered route selection, the input
// contract handed to handlers, the relayed response (status/headers/body,
// denylist, no script injection) and the fail-closed gates.

import (
	"bytes"
	"encoding/base64"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"suwu/pkg/extension"
)

// writeAPIExt installs an extension directory with the given files.
func writeAPIExt(t *testing.T, dataDir, id string, files map[string]string) {
	t.Helper()
	extDir := filepath.Join(extension.Dir(dataDir), id)
	if err := os.MkdirAll(extDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		target := filepath.Join(extDir, name)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// demoAPIExt registers three routes, deliberately with the broad /hello in
// front of the more specific /hello/world.
func demoAPIExt(t *testing.T, dataDir string) {
	t.Helper()
	writeAPIExt(t, dataDir, "demo", map[string]string{
		"package.json": `{
			"name": "Demo",
			"description": "api demo",
			"suwu": {
				"api": [
					{"route": "/hello", "handler": "api1.js"},
					{"route": "/hello/world", "handler": "api2.js"},
					{"route": "/note/<id>", "handler": "note.js"}
				]
			}
		}`,
		"index.js": `function handler() { return "page"; }`,
		"api1.js":  `1`,
		"api2.js":  `2`,
		"note.js":  `3`,
	})
}

// extAPIReq performs an API request, optionally with the session cookie.
func extAPIReq(t *testing.T, base, token, method, path string, body []byte) *http.Response {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, base+path, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.AddCookie(&http.Cookie{Name: "suwu_token", Value: token})
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestExtensionAPIRouteOrder(t *testing.T) {
	runner := &stubExtensionRunner{result: []byte(`{"body":"ok"}`)}
	ts, cfg, dataDir := extTestServerDir(t, runner)
	demoAPIExt(t, dataDir)

	resp := extAPIReq(t, ts.URL, cfg.Token, http.MethodGet, "/gqjs/api/demo/hello/world", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	// /hello is registered first, so it shortcuts /hello/world.
	if !strings.HasSuffix(runner.gotEntry, "api1.js") {
		t.Errorf("entry = %q, want api1.js (first match wins)", runner.gotEntry)
	}
	want := map[string]string{
		"action": "api",
		"id":     "demo",
		"route":  "/hello",
		"path":   "/hello/world",
		"method": "GET",
	}
	for k, v := range want {
		if got := runner.gotInput[k]; got != v {
			t.Errorf("input[%s] = %v, want %v", k, got, v)
		}
	}
	if body := readAll(t, resp); body != "ok" {
		t.Errorf("body = %q", body)
	}
}

func TestExtensionAPIPathParams(t *testing.T) {
	runner := &stubExtensionRunner{result: []byte(`{"body":"note"}`)}
	ts, cfg, dataDir := extTestServerDir(t, runner)
	demoAPIExt(t, dataDir)

	resp := extAPIReq(t, ts.URL, cfg.Token, http.MethodGet, "/gqjs/api/demo/note/42", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !strings.HasSuffix(runner.gotEntry, "note.js") {
		t.Errorf("entry = %q, want note.js", runner.gotEntry)
	}
	if runner.gotInput["route"] != "/note/<id>" || runner.gotInput["path"] != "/note/42" {
		t.Errorf("route/path = %v / %v", runner.gotInput["route"], runner.gotInput["path"])
	}
	params, ok := runner.gotInput["pathParams"].(map[string]string)
	if !ok || params["id"] != "42" {
		t.Errorf("pathParams = %v", runner.gotInput["pathParams"])
	}
}

func TestExtensionAPIRootCatchAll(t *testing.T) {
	runner := &stubExtensionRunner{result: []byte(`{"body":"root"}`)}
	ts, cfg, dataDir := extTestServerDir(t, runner)
	writeAPIExt(t, dataDir, "fallback", map[string]string{
		"package.json": `{"name":"Fallback","suwu":{"api":[{"route":"/","handler":"all.js"}]}}`,
		"index.js":     `1`,
		"all.js":       `1`,
	})

	// The bare prefix and arbitrary subpaths both land on the root route.
	for _, p := range []string{"/gqjs/api/fallback", "/gqjs/api/fallback/anything/deep"} {
		resp := extAPIReq(t, ts.URL, cfg.Token, http.MethodGet, p, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", p, resp.StatusCode)
		}
	}
	if !strings.HasSuffix(runner.gotEntry, "all.js") {
		t.Errorf("entry = %q, want all.js", runner.gotEntry)
	}
	if runner.gotInput["path"] != "/" && runner.gotInput["path"] != "/anything/deep" {
		t.Errorf("path = %v", runner.gotInput["path"])
	}
}

func TestExtensionAPIFailClosedRoutes(t *testing.T) {
	ts, cfg, dataDir := extTestServerDir(t, &stubExtensionRunner{result: []byte(`"x"`)})
	demoAPIExt(t, dataDir)
	writeAPIExt(t, dataDir, "ghost", map[string]string{
		"package.json": `{"name":"Ghost","suwu":{"api":[{"route":"/gone","handler":"gone.js"}]}}`,
		"index.js":     `1`,
	})

	cases := []struct {
		name   string
		method string
		path   string
	}{
		{name: "extension without api registration (eye)", method: http.MethodGet, path: "/gqjs/api/eye/x"},
		{name: "unknown extension", method: http.MethodGet, path: "/gqjs/api/nope/x"},
		{name: "traversal id", method: http.MethodGet, path: "/gqjs/api/..%2Fx"},
		{name: "no matching route", method: http.MethodGet, path: "/gqjs/api/demo/other"},
		{name: "missing handler file", method: http.MethodGet, path: "/gqjs/api/ghost/gone"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := extAPIReq(t, ts.URL, cfg.Token, tc.method, tc.path, nil)
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusNotFound {
				t.Errorf("status = %d, want 404", resp.StatusCode)
			}
			if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
				t.Errorf("Content-Type = %q, want JSON errors", ct)
			}
		})
	}
}

func TestExtensionAPIAuthAndMethods(t *testing.T) {
	ts, cfg, dataDir := extTestServerDir(t, &stubExtensionRunner{result: []byte(`"x"`)})
	demoAPIExt(t, dataDir)

	// No credentials → 401 with a JSON error body.
	resp := extAPIReq(t, ts.URL, "", http.MethodGet, "/gqjs/api/demo/hello", nil)
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type = %q, want JSON", ct)
	}
	if !strings.Contains(body, `"error"`) {
		t.Errorf("body = %q, want a JSON error", body)
	}

	// Query token works and is stripped from the input query map.
	runner := &stubExtensionRunner{result: []byte(`"x"`)}
	ts2, cfg2, dataDir2 := extTestServerDir(t, runner)
	demoAPIExt(t, dataDir2)
	resp = extAPIReq(t, ts2.URL, "", http.MethodGet,
		"/gqjs/api/demo/hello?foo=bar&token="+cfg2.Token, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("query-token status = %d, want 200", resp.StatusCode)
	}
	query, _ := runner.gotInput["query"].(map[string]string)
	if query["foo"] != "bar" {
		t.Errorf("query = %v", query)
	}
	if _, leaked := query["token"]; leaked {
		t.Errorf("auth token leaked into handler input: %v", query)
	}

	// Disallowed method → 405 before any child process starts.
	resp = extAPIReq(t, ts.URL, cfg.Token, "TRACE", "/gqjs/api/demo/hello", nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("TRACE status = %d, want 405", resp.StatusCode)
	}
	if allow := resp.Header.Get("Allow"); !strings.Contains(allow, "GET") {
		t.Errorf("Allow = %q", allow)
	}
}

func TestExtensionAPIBodyLimit(t *testing.T) {
	runner := &stubExtensionRunner{result: []byte(`"x"`) }
	ts, cfg, dataDir := extTestServerDir(t, runner)
	demoAPIExt(t, dataDir)

	resp := extAPIReq(t, ts.URL, cfg.Token, http.MethodPost, "/gqjs/api/demo/hello",
		bytes.Repeat([]byte("a"), extensionAPIMaxBody+1))
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", resp.StatusCode)
	}
	if runner.gotEntry != "" {
		t.Errorf("handler ran despite oversized body: %q", runner.gotEntry)
	}
}

func TestExtensionAPIInputPayload(t *testing.T) {
	runner := &stubExtensionRunner{result: []byte(`{"body":"ok"}`)}
	ts, cfg, dataDir := extTestServerDir(t, runner)
	demoAPIExt(t, dataDir)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/gqjs/api/demo/hello?page=2",
		strings.NewReader(`{"a":1}`))
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "suwu_token", Value: cfg.Token})
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Custom", "v")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if runner.gotInput["body"] != `{"a":1}` {
		t.Errorf("input.body = %v", runner.gotInput["body"])
	}
	if _, binary := runner.gotInput["bodyB64"]; binary {
		t.Error("text body must not be base64")
	}
	if runner.gotInput["method"] != "POST" {
		t.Errorf("input.method = %v", runner.gotInput["method"])
	}
	headers, _ := runner.gotInput["headers"].(map[string]string)
	if headers["x-custom"] != "v" || headers["content-type"] != "application/json" {
		t.Errorf("input.headers = %v", headers)
	}
	query, _ := runner.gotInput["query"].(map[string]string)
	if query["page"] != "2" {
		t.Errorf("input.query = %v", query)
	}

	// Binary payloads cross as base64.
	runner.result = []byte(`"x"`)
	binaryBody := []byte{0xff, 0xfe, 0x00}
	resp = extAPIReq(t, ts.URL, cfg.Token, http.MethodPost, "/gqjs/api/demo/hello", binaryBody)
	resp.Body.Close()
	if got, _ := runner.gotInput["bodyB64"].(string); got != base64.StdEncoding.EncodeToString(binaryBody) {
		t.Errorf("input.bodyB64 = %v", runner.gotInput["bodyB64"])
	}
	if _, text := runner.gotInput["body"]; text {
		t.Error("binary body must not cross as text")
	}
}

func TestExtensionAPIRelay(t *testing.T) {
	runner := &stubExtensionRunner{result: []byte(
		`{"status":201,"contentType":"application/json","headers":{` +
			`"x-count":"3","Set-Cookie":"evil=1","Access-Control-Allow-Origin":"*",` +
			`"Content-Type":"text/plain"},"body":"{\"a\":1}"}`)}
	ts, cfg, dataDir := extTestServerDir(t, runner)
	demoAPIExt(t, dataDir)

	resp := extAPIReq(t, ts.URL, cfg.Token, http.MethodGet, "/gqjs/api/demo/hello", nil)
	defer resp.Body.Close()
	if resp.StatusCode != 201 {
		t.Errorf("status = %d, want 201", resp.StatusCode)
	}
	if resp.Header.Get("X-Count") != "3" {
		t.Errorf("x-count = %q", resp.Header.Get("X-Count"))
	}
	if v := resp.Header.Values("Set-Cookie"); len(v) > 0 {
		t.Errorf("Set-Cookie leaked: %v", v)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Error("CORS grant leaked")
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type = %q, want the contentType field to win", ct)
	}
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("nosniff = %q", resp.Header.Get("X-Content-Type-Options"))
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q", resp.Header.Get("Cache-Control"))
	}
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'none'") {
		t.Errorf("CSP = %q", csp)
	}
	if body := readAll(t, resp); body != `{"a":1}` {
		t.Errorf("body = %q", body)
	}
}

func TestExtensionAPINoScriptInjection(t *testing.T) {
	// Even a text/html result is relayed byte-for-byte: API routes never get
	// the focus/key relay script that page renders inject.
	runner := &stubExtensionRunner{
		result: []byte(`{"contentType":"text/html","body":"<html><body>hi</body></html>"}`),
	}
	ts, cfg, dataDir := extTestServerDir(t, runner)
	demoAPIExt(t, dataDir)

	resp := extAPIReq(t, ts.URL, cfg.Token, http.MethodGet, "/gqjs/api/demo/hello", nil)
	defer resp.Body.Close()
	body := readAll(t, resp)
	if strings.Contains(body, extensionRelayMarker) {
		t.Errorf("API response contains the injected relay script: %q", body)
	}
	if body != "<html><body>hi</body></html>" {
		t.Errorf("body = %q, want it untouched", body)
	}
}

func TestExtensionAPIBinaryAndDefaults(t *testing.T) {
	// bodyB64 relays raw bytes; an omitted contentType defaults to JSON.
	runner := &stubExtensionRunner{result: []byte(`{"status":200,"bodyB64":"//4A"}`)}
	ts, cfg, dataDir := extTestServerDir(t, runner)
	demoAPIExt(t, dataDir)

	resp := extAPIReq(t, ts.URL, cfg.Token, http.MethodGet, "/gqjs/api/demo/hello", nil)
	defer resp.Body.Close()
	body := readAll(t, resp)
	if body != string([]byte{0xff, 0xfe, 0x00}) {
		t.Errorf("body bytes = %v", []byte(body))
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type = %q, want JSON default", ct)
	}
}

func TestExtensionAPIEmptyResultIsNoContent(t *testing.T) {
	for _, raw := range []string{"", "null"} {
		runner := &stubExtensionRunner{result: []byte(raw)}
		ts, cfg, dataDir := extTestServerDir(t, runner)
		demoAPIExt(t, dataDir)
		resp := extAPIReq(t, ts.URL, cfg.Token, http.MethodGet, "/gqjs/api/demo/hello", nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			t.Errorf("result %q: status = %d, want 204", raw, resp.StatusCode)
		}
	}
}

func TestExtensionAPICORS(t *testing.T) {
	runner := &stubExtensionRunner{result: []byte(`{"body":"ok"}`)}
	ts, cfg, dataDir := extTestServerDir(t, runner)
	demoAPIExt(t, dataDir)

	withOrigin := func(method, path, origin, token string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, ts.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if token != "" {
			req.AddCookie(&http.Cookie{Name: "suwu_token", Value: token})
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	// Sandboxed extension pages (opaque origin) may read the response.
	resp := withOrigin(http.MethodGet, "/gqjs/api/demo/hello", "null", cfg.Token)
	resp.Body.Close()
	// Regression: auth used to parse "null" as a malformed origin and 400.
	if resp.StatusCode != http.StatusOK {
		t.Errorf("opaque-origin GET status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "null" {
		t.Errorf("ACAO = %q, want null", got)
	}
	if !strings.Contains(resp.Header.Get("Vary"), "Origin") {
		t.Errorf("Vary = %q, want Origin", resp.Header.Get("Vary"))
	}
	if resp.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Error("credentials must not be allowed; auth rides on the query token")
	}

	// Foreign origins get no grant.
	resp = withOrigin(http.MethodGet, "/gqjs/api/demo/hello", "https://evil.example", cfg.Token)
	resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("ACAO for a foreign origin = %q, want empty", got)
	}

	// Preflight is answered before auth and never reaches the handler.
	runner.gotEntry = ""
	preflight, err := http.NewRequest(http.MethodOptions, ts.URL+"/gqjs/api/demo/hello", nil)
	if err != nil {
		t.Fatal(err)
	}
	preflight.Header.Set("Origin", "null")
	preflight.Header.Set("Access-Control-Request-Method", "GET")
	// htmx sends its HX-* headers; the preflight must reflect them back or
	// the browser rejects the poll before the real request.
	preflight.Header.Set("Access-Control-Request-Headers", "content-type, hx-trigger")
	preflight.Header.Set("Access-Control-Request-Private-Network", "true")
	presp, err := http.DefaultClient.Do(preflight)
	if err != nil {
		t.Fatal(err)
	}
	presp.Body.Close()
	if presp.StatusCode != http.StatusNoContent {
		t.Errorf("preflight status = %d, want 204", presp.StatusCode)
	}
	if got := presp.Header.Get("Access-Control-Allow-Methods"); !strings.Contains(got, "GET") {
		t.Errorf("ACAM = %q", got)
	}
	if got, want := presp.Header.Get("Access-Control-Allow-Headers"), "content-type, hx-trigger"; got != want {
		t.Errorf("ACAH = %q, want the reflected %q", got, want)
	}
	if presp.Header.Get("Access-Control-Allow-Private-Network") != "true" {
		t.Error("private-network preflight not acknowledged")
	}
	if presp.Header.Get("Access-Control-Allow-Origin") != "null" {
		t.Errorf("preflight ACAO = %q, want null", presp.Header.Get("Access-Control-Allow-Origin"))
	}
	if runner.gotEntry != "" {
		t.Errorf("preflight must not reach the handler, ran %q", runner.gotEntry)
	}

	// Errors are readable too: the 401 carries the grant.
	resp = withOrigin(http.MethodGet, "/gqjs/api/demo/hello", "null", "")
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("Access-Control-Allow-Origin") != "null" {
		t.Errorf("401 = %d ACAO %q", resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
	}
	if !strings.Contains(body, `"error"`) {
		t.Errorf("body = %q", body)
	}
}

func TestExtensionAPIErrors(t *testing.T) {
	cases := []struct {
		name   string
		runner *stubExtensionRunner
		want   int
	}{
		{name: "timeout", runner: &stubExtensionRunner{err: errExtensionTimeout}, want: http.StatusGatewayTimeout},
		{name: "runner failure", runner: &stubExtensionRunner{err: os.ErrPermission}, want: http.StatusInternalServerError},
		{name: "invalid result", runner: &stubExtensionRunner{result: []byte("plain")}, want: http.StatusInternalServerError},
		{name: "invalid base64", runner: &stubExtensionRunner{result: []byte(`{"bodyB64":"!!"}`)}, want: http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts, cfg, dataDir := extTestServerDir(t, tc.runner)
			demoAPIExt(t, dataDir)
			resp := extAPIReq(t, ts.URL, cfg.Token, http.MethodGet, "/gqjs/api/demo/hello", nil)
			body := readAll(t, resp)
			resp.Body.Close()
			if resp.StatusCode != tc.want {
				t.Errorf("status = %d, want %d", resp.StatusCode, tc.want)
			}
			if !strings.Contains(body, `"error"`) {
				t.Errorf("body = %q, want a JSON error", body)
			}
		})
	}
}
