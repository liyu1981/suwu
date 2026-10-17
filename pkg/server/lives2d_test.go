package server

// Tests for the /api/lives2d/* routes: auth, provider listing, search
// forwarding and media streaming through a stub provider.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"suwu/pkg/lives2d"
)

// stubLives is a provider that serves its media from a local test server, so
// the handler can be exercised without touching the network.
type stubLives struct{ mediaBase string }

func (stubLives) ID() string             { return "stub" }
func (stubLives) Label() string          { return "Stub" }
func (stubLives) Credit() lives2d.Credit { return lives2d.Credit{Author: "Stub"} }
func (stubLives) ImageOrigins() []string { return []string{"https://thumbs.example.com"} }
func (stubLives) Search(_ context.Context, q string, page int) (lives2d.SearchPage, error) {
	return lives2d.SearchPage{
		Items:   []lives2d.Item{{ID: "item-1", Title: "Result for " + q}},
		Page:    page,
		HasMore: true,
	}, nil
}

func (s stubLives) Resolve(_ context.Context, id string) (lives2d.Media, error) {
	return lives2d.Media{
		URL:         s.mediaBase + "/wallpaper.mp4",
		Filename:    "fallback.mp4",
		ContentType: "video/mp4",
	}, nil
}

func TestLives2DImageOriginsInCSP(t *testing.T) {
	lives2d.Register(stubLives{})
	if !strings.Contains(cspPolicy(), "https://thumbs.example.com") {
		t.Fatalf("provider image origin missing from CSP: %s", cspPolicy())
	}
}

func TestLives2DRoutes(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Disposition", `attachment; filename="from-origin.mp4"`)
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = io.WriteString(w, "MP4DATA")
	}))
	defer origin.Close()

	lives2d.Register(stubLives{mediaBase: origin.URL})
	ts, _, _ := extTestServerDir(t, nil)

	get := func(path string) (int, http.Header, string) {
		t.Helper()
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, resp.Header, string(body)
	}

	t.Run("requires auth", func(t *testing.T) {
		if status, _, _ := get("/api/lives2d/providers"); status == http.StatusOK {
			t.Fatal("expected a 401 without a token")
		}
	})

	t.Run("lists providers", func(t *testing.T) {
		status, _, body := get("/api/lives2d/providers?token=testtoken")
		if status != http.StatusOK {
			t.Fatalf("status %d", status)
		}
		var out struct {
			Providers []struct {
				ID    string `json:"id"`
				Label string `json:"label"`
			} `json:"providers"`
		}
		if err := json.Unmarshal([]byte(body), &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		found := false
		for _, p := range out.Providers {
			if p.ID == "stub" && p.Label == "Stub" {
				found = true
			}
		}
		if !found {
			t.Fatalf("stub provider missing from %s", body)
		}
	})

	t.Run("search forwards the query", func(t *testing.T) {
		status, _, body := get("/api/lives2d/search?provider=stub&q=hello&token=testtoken")
		if status != http.StatusOK {
			t.Fatalf("status %d: %s", status, body)
		}
		if !strings.Contains(body, "Result for hello") || !strings.Contains(body, `"hasMore":true`) {
			t.Fatalf("unexpected body: %s", body)
		}
	})

	t.Run("search rejects an unknown provider", func(t *testing.T) {
		if status, _, _ := get("/api/lives2d/search?provider=nope&q=x&token=testtoken"); status != http.StatusNotFound {
			t.Fatalf("status %d, want 404", status)
		}
	})

	t.Run("search requires a query", func(t *testing.T) {
		if status, _, _ := get("/api/lives2d/search?provider=stub&token=testtoken"); status != http.StatusBadRequest {
			t.Fatalf("status %d, want 400", status)
		}
	})

	t.Run("media streams the origin bytes", func(t *testing.T) {
		status, header, body := get("/api/lives2d/media?provider=stub&id=item-1&token=testtoken")
		if status != http.StatusOK {
			t.Fatalf("status %d", status)
		}
		if body != "MP4DATA" {
			t.Fatalf("body = %q", body)
		}
		if cd := header.Get("Content-Disposition"); !strings.Contains(cd, "from-origin.mp4") {
			t.Fatalf("content-disposition = %q", cd)
		}
	})
}
