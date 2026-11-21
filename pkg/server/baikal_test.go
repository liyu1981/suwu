package server

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"suwu/pkg/assets"
	"suwu/pkg/auth"
	"suwu/pkg/forward"
	"suwu/pkg/herdr"
)

func baikalServer(t *testing.T) *httptest.Server {
	t.Helper()
	web, err := fs.Sub(assets.FS, "web")
	if err != nil {
		t.Fatal(err)
	}
	cfg := &auth.Config{
		Token:        "testtoken",
		BindHost:     "127.0.0.1",
		AllowedHosts: []string{"localhost", "127.0.0.1", "::1"},
	}
	srv := New(cfg, web, nil, nil, forward.NewManager(), "")
	t.Cleanup(func() { srv.baikal.closeAll() })
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// Baikal needs herdr-core; without it the tile must get an actionable error, not
// an empty page or a hang.
func TestBaikalSnapshotWithoutCore(t *testing.T) {
	t.Setenv("SUWU_HC_BIN", "/nonexistent/herdr-core")
	t.Setenv("PATH", t.TempDir()) // no herdr-core on PATH either
	herdr.ResetResolveCache()
	t.Cleanup(herdr.ResetResolveCache)

	ts := baikalServer(t)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/baikal/snapshot?token=testtoken", nil)
	req.Host = "127.0.0.1"
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	var body struct {
		Error string `json:"error"`
		Hint  string `json:"hint"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Error == "" || !strings.Contains(body.Hint, "herdr") {
		t.Fatalf("body = %+v, want an error and a hint", body)
	}
}

func TestBaikalRequiresAuth(t *testing.T) {
	ts := baikalServer(t)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/baikal/snapshot", nil)
	req.Host = "127.0.0.1"
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 401/403", resp.StatusCode)
	}
}

func TestBaikalAttachRejectsBadTerminal(t *testing.T) {
	ts := baikalServer(t)
	for _, bad := range []string{"../../etc/passwd", "t1;rm -rf /", "a/b", ""} {
		req, _ := http.NewRequest(http.MethodGet,
			ts.URL+"/ws/baikal/attach?token=testtoken&terminal="+bad, nil)
		req.Host = "127.0.0.1"
		req.Header.Set("Origin", "http://127.0.0.1")
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("terminal %q: status = %d, want 400", bad, resp.StatusCode)
		}
	}
}
