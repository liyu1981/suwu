package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"suwu/pkg/auth"
	"suwu/pkg/forward"
)

func TestForwardStatusRoutes(t *testing.T) {
	cfg := &auth.Config{Token: "test-token", AllowedHosts: []string{"localhost"}}
	s := New(cfg, nil, nil, nil, forward.NewManager(), "")
	for _, tc := range []struct {
		path string
		code int
	}{
		{"/api/forward/status", http.StatusOK},
		{"/api/forward/status/", http.StatusOK},
		{"/api/forward/status/missing", http.StatusNotFound},
	} {
		t.Run(tc.path, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "http://localhost"+tc.path, nil)
			r.Header.Set("Authorization", "Bearer "+cfg.Token)
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != tc.code {
				t.Fatalf("status = %d, want %d", w.Code, tc.code)
			}
			if tc.code == http.StatusOK && strings.TrimSpace(w.Body.String()) != "[]" {
				t.Fatalf("empty list = %q, want []", w.Body.String())
			}
		})
	}
}
