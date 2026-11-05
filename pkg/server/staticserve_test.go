package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"suwu/pkg/auth"
	"suwu/pkg/forward"
)

func newStaticTestServer(t *testing.T) (*Server, *auth.Config, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<body>static</body>"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := &auth.Config{Token: "test-token", AllowedHosts: []string{"localhost", "127.0.0.1", "::1"}}
	s := New(cfg, nil, nil, nil, forward.NewManager(), "")
	t.Cleanup(s.CloseStatic)
	return s, cfg, dir
}

func staticRequest(t *testing.T, method, target, body string) *http.Request {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	r.RemoteAddr = "127.0.0.1:12345"
	return r
}

func TestStaticServeNoAuth(t *testing.T) {
	s, _, dir := newStaticTestServer(t)
	entry, _, err := s.StaticServe().Create(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	r := staticRequest(t, http.MethodGet, "http://localhost/staticserve/"+entry.ID+"/", "")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "static") {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestStaticServeHostAllowlist(t *testing.T) {
	s, _, dir := newStaticTestServer(t)
	entry, _, err := s.StaticServe().Create(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	r := staticRequest(t, http.MethodGet, "http://evil.test/staticserve/"+entry.ID+"/", "")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestStaticServeClientGate(t *testing.T) {
	s, _, dir := newStaticTestServer(t)
	entry, _, err := s.StaticServe().Create(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	r := staticRequest(t, http.MethodGet, "http://localhost/staticserve/"+entry.ID+"/", "")
	r.RemoteAddr = "203.0.113.5:12345"
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("unauthenticated remote status = %d, want 403", w.Code)
	}

	s.clients.Touch(r.RemoteAddr)
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("after touch status = %d, want 200", w.Code)
	}
}

func TestStaticServePauseResumeAPI(t *testing.T) {
	s, cfg, dir := newStaticTestServer(t)
	entry, _, err := s.StaticServe().Create(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	authHeader := "Bearer " + cfg.Token

	r := staticRequest(t, http.MethodPost, "http://localhost/api/staticserve/pause", `{"id":"`+entry.ID+`"}`)
	r.Header.Set("Authorization", authHeader)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("pause status = %d body=%s", w.Code, w.Body.String())
	}

	r = staticRequest(t, http.MethodGet, "http://localhost/staticserve/"+entry.ID+"/", "")
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("paused preview status = %d, want 503", w.Code)
	}

	r = staticRequest(t, http.MethodPost, "http://localhost/api/staticserve/resume", `{"id":"`+entry.ID+`"}`)
	r.Header.Set("Authorization", authHeader)
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("resume status = %d body=%s", w.Code, w.Body.String())
	}
}

func TestStaticPreviewRootPathGuard(t *testing.T) {
	s, _, dir := newStaticTestServer(t)
	entry, _, err := s.StaticServe().Create(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	for name, r := range map[string]*http.Request{
		"referer": func() *http.Request {
			r := staticRequest(t, http.MethodGet, "http://localhost/assets/nope.js", "")
			r.Header.Set("Referer", "http://localhost/staticserve/"+entry.ID+"/")
			return r
		}(),
		"null-origin": func() *http.Request {
			r := staticRequest(t, http.MethodGet, "http://localhost/static/app.js", "")
			r.Header.Set("Origin", "null")
			return r
		}(),
	} {
		t.Run(name, func(t *testing.T) {
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404", w.Code)
			}
		})
	}
}

func TestStaticServeRootRedirect(t *testing.T) {
	s, _, dir := newStaticTestServer(t)
	entry, _, err := s.StaticServe().Create(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	r := staticRequest(t, http.MethodGet, "http://localhost/staticserve/"+entry.ID, "")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusMovedPermanently || !strings.HasSuffix(w.Header().Get("Location"), "/") {
		t.Fatalf("status=%d location=%q", w.Code, w.Header().Get("Location"))
	}
}
