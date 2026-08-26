package server

import (
	"context"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"ghostty-web-demo/pkg/assets"
	"ghostty-web-demo/pkg/auth"

	"github.com/coder/websocket"
)

func testServer(t *testing.T) (*httptest.Server, *auth.Config) {
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
	srv := New(cfg, sub)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, cfg
}

func TestTokenEndpoint(t *testing.T) {
	ts, cfg := testServer(t)

	resp, err := http.Get(ts.URL + "/api/token")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body := make([]byte, 256)
	n, _ := resp.Body.Read(body)
	got := string(body[:n])
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(got, cfg.Token) {
		t.Fatalf("response %q does not contain token", got)
	}
}

func TestTokenBadOrigin(t *testing.T) {
	ts, _ := testServer(t)

	req, _ := http.NewRequest("GET", ts.URL+"/api/token", nil)
	req.Header.Set("Origin", "http://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}

func dialWS(t *testing.T, ts *httptest.Server, origin string, query url.Values) *websocket.Conn {
	t.Helper()
	u := ts.URL + "/ws?" + query.Encode()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h := http.Header{}
	h.Set("Origin", origin)
	c, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return c
}

func TestWebSocketBadToken(t *testing.T) {
	ts, _ := testServer(t)
	u := ts.URL + "/ws?token=wrong&cols=80&rows=24"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	origin := "http://" + hostOf(ts)
	h := http.Header{}
	h.Set("Origin", origin)
	_, resp, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: h})
	if err == nil {
		t.Fatal("expected dial error for bad token")
	}
	if resp == nil || resp.StatusCode != 401 {
		t.Fatalf("status = %+v, want 401", resp)
	}
}

func TestWebSocketSession(t *testing.T) {
	ts, cfg := testServer(t)
	origin := "http://" + hostOf(ts)

	q := url.Values{}
	q.Set("cols", "80")
	q.Set("rows", "24")
	q.Set("token", cfg.Token)

	conn := dialWS(t, ts, origin, q)
	defer conn.CloseNow()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// First message should be the welcome banner.
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read welcome: %v", err)
	}
	if !strings.Contains(string(data), "Welcome to ghostty-web") {
		t.Fatalf("welcome banner missing, got: %q", data)
	}

	// Send a command; expect its output back on the PTY.
	if err := conn.Write(ctx, websocket.MessageText, []byte("echo hello-ghostty\r")); err != nil {
		t.Fatalf("write: %v", err)
	}

	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read output: %v", err)
		}
		if strings.Contains(string(data), "hello-ghostty") {
			return
		}
	}
	t.Fatal("did not receive command output in time")
}

func TestWebSocketMultipleSessions(t *testing.T) {
	ts, cfg := testServer(t)
	origin := "http://" + hostOf(ts)

	mk := func(tag string) *websocket.Conn {
		q := url.Values{}
		q.Set("cols", "80")
		q.Set("rows", "24")
		q.Set("token", cfg.Token)
		return dialWS(t, ts, origin, q)
	}

	a := mk("a")
	defer a.CloseNow()
	b := mk("b")
	defer b.CloseNow()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Both sessions welcome banners arrive.
	for _, c := range []*websocket.Conn{a, b} {
		if _, data, err := c.Read(ctx); err != nil || !strings.Contains(string(data), "Welcome to ghostty-web") {
			t.Fatalf("session banner missing (err=%v): %q", err, data)
		}
	}

	// Interleave commands between the two sessions; each must see its own output.
	if err := a.Write(ctx, websocket.MessageText, []byte("echo AAA-123\r")); err != nil {
		t.Fatal(err)
	}
	if err := b.Write(ctx, websocket.MessageText, []byte("echo BBB-456\r")); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(8 * time.Second)
	got := map[string]bool{}
	for time.Now().Before(deadline) && (!got["AAA-123"] || !got["BBB-456"]) {
		for _, c := range []*websocket.Conn{a, b} {
			if data, err := readWithTimeout(t, c, ctx); err == nil {
				s := string(data)
				if strings.Contains(s, "AAA-123") {
					got["AAA-123"] = true
				}
				if strings.Contains(s, "BBB-456") {
					got["BBB-456"] = true
				}
			}
		}
	}
	if !got["AAA-123"] || !got["BBB-456"] {
		t.Fatalf("did not receive both sessions' output: %v", got)
	}
}

func readWithTimeout(t *testing.T, c *websocket.Conn, ctx context.Context) ([]byte, error) {
	t.Helper()
	done := make(chan struct {
		data []byte
		err  error
	}, 1)
	go func() {
		_, data, err := c.Read(ctx)
		done <- struct {
			data []byte
			err  error
		}{data, err}
	}()
	select {
	case res := <-done:
		return res.data, res.err
	case <-time.After(2 * time.Second):
		return nil, context.DeadlineExceeded
	}
}

func hostOf(ts *httptest.Server) string {
	u, _ := url.Parse(ts.URL)
	return u.Host
}

func getBody(t *testing.T, url string) (int, []byte) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body := make([]byte, 4096)
	n, _ := resp.Body.Read(body)
	return resp.StatusCode, body[:n]
}

func TestIndexServed(t *testing.T) {
	ts, _ := testServer(t)
	status, body := getBody(t, ts.URL+"/")
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	if !strings.Contains(string(body), `<div id="root">`) {
		t.Fatalf("index.html does not contain the app root: %q", body)
	}
}

func TestAssetServed(t *testing.T) {
	ts, _ := testServer(t)

	// Find a hashed Vite asset to request.
	var asset string
	sub, err := fs.Sub(assets.FS, "web")
	if err != nil {
		t.Fatal(err)
	}
	err = fs.WalkDir(sub, "assets", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && asset == "" {
			asset = "/" + p
		}
		return nil
	})
	if err != nil || asset == "" {
		t.Fatalf("no assets found in embed (err=%v)", err)
	}

	status, _ := getBody(t, ts.URL+asset)
	if status != 200 {
		t.Fatalf("GET %s = %d, want 200", asset, status)
	}
}

func TestSpaFallback(t *testing.T) {
	ts, _ := testServer(t)
	status, body := getBody(t, ts.URL+"/colors")
	if status != 200 {
		t.Fatalf("status = %d, want 200 (SPA fallback)", status)
	}
	if !strings.Contains(string(body), `<div id="root">`) {
		t.Fatalf("SPA fallback did not serve index.html: %q", body)
	}
}

func TestMissingFile404(t *testing.T) {
	ts, _ := testServer(t)
	status, _ := getBody(t, ts.URL+"/missing.js")
	if status != 404 {
		t.Fatalf("status = %d, want 404", status)
	}
}
