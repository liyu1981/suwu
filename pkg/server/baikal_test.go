package server

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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

// The tile stops polling every three seconds because this stream tells it when
// to re-read: headers must make it stream un-buffered, and the first bytes must
// confirm it is live (the client drops its opening poll on `ready`).
func TestBaikalEventsStreams(t *testing.T) {
	ts := baikalServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
		ts.URL+"/api/baikal/events?token=testtoken", nil)
	req.Host = "127.0.0.1"
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q", ct)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("cache-control = %q", cc)
	}
	if xab := resp.Header.Get("X-Accel-Buffering"); xab != "no" {
		t.Fatalf("x-accel-buffering = %q, want no (a proxy would buffer the stream)", xab)
	}

	// The opening write is a retry hint plus a confirmation; the stream then
	// stays open (that is the point), so read until both have arrived rather
	// than to EOF.
	var seen strings.Builder
	buf := make([]byte, 256)
	for !strings.Contains(seen.String(), "event: ready") {
		n, err := resp.Body.Read(buf)
		seen.Write(buf[:n])
		if err != nil {
			t.Fatalf("read: %v (after %q)", err, seen.String())
		}
	}
	head := seen.String()
	if !strings.HasPrefix(head, "retry: ") {
		t.Fatalf("first bytes = %q, want a retry hint", head)
	}
	if !strings.Contains(head, "data: ok") {
		t.Fatalf("stream did not confirm itself: %q", head)
	}
}

func TestBaikalEventsRequiresAuth(t *testing.T) {
	ts := baikalServer(t)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/baikal/events", nil)
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
