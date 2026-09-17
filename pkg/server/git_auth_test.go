package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"suwu/pkg/auth"
)

// Exercise handler guards without a repository or a running server. Invalid
// bodies must never be decoded until authentication has succeeded.
func TestGitHandlersRequireAuthentication(t *testing.T) {
	cfg := &auth.Config{Token: "test-token", AllowedHosts: []string{"localhost"}}
	s := New(cfg, nil, nil, nil, nil, "")
	for _, endpoint := range []struct {
		path   string
		method string
	}{
		{"/api/git/commits", http.MethodGet},
		{"/api/git/commit", http.MethodGet},
		{"/api/git/branches", http.MethodGet},
		{"/api/git/worktrees", http.MethodGet},
		{"/api/git/diff", http.MethodGet},
		{"/api/git/compare", http.MethodGet},
		{"/api/git/compare/file", http.MethodGet},
		{"/api/git/action", http.MethodPost},
	} {
		t.Run(endpoint.path, func(t *testing.T) {
			for _, token := range []string{"", "invalid"} {
				r := httptest.NewRequest(endpoint.method, "http://localhost"+endpoint.path, strings.NewReader("invalid json"))
				if token != "" {
					r.Header.Set("Authorization", "Bearer "+token)
				}
				w := httptest.NewRecorder()
				s.Handler().ServeHTTP(w, r)
				if w.Code != http.StatusUnauthorized {
					t.Fatalf("status = %d, want 401", w.Code)
				}
			}

			// A valid credential reaches method validation, without invoking Git.
			r := httptest.NewRequest(http.MethodPut, "http://localhost"+endpoint.path, nil)
			r.Header.Set("Authorization", "Bearer "+cfg.Token)
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != http.StatusMethodNotAllowed {
				t.Fatalf("authenticated status = %d, want 405", w.Code)
			}
		})
	}
}
