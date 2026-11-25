package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testCatalogJSON(t *testing.T, version string) []byte {
	t.Helper()
	c := map[string]any{
		"schema": 1,
		"tools": []any{map[string]any{
			"name": "rg", "version": version,
			"platforms": map[string]any{"linux-amd64": map[string]any{
				"archive": "none", "url": "https://example.test/rg",
				"sha256": strings.Repeat("a", 64), "strip": 0,
				"entries": []any{map[string]any{"file": "rg", "mode": "0755"}},
			}},
		}},
	}
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func newTestSource(t *testing.T, handler http.HandlerFunc) (*Source, *int32) {
	t.Helper()
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if r.Header.Get("User-Agent") == "" {
			t.Error("no user agent")
		}
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	s := NewSource(t.TempDir())
	s.RawBase = srv.URL
	s.Ref = "v1.2.3"
	return s, &hits
}

func TestSourceFetchesThenCaches(t *testing.T) {
	body := testCatalogJSON(t, "1.0")
	s, hits := newTestSource(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/liyu1981/suwu/v1.2.3/tools/catalog.json" {
			t.Errorf("path %q", got)
		}
		w.Header().Set("ETag", `"abc"`)
		_, _ = w.Write(body)
	})
	cat, origin, err := s.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cat.Tools[0].Version != "1.0" || origin.Stale || origin.Cached {
		t.Fatalf("catalog %+v origin %+v", cat.Tools[0], origin)
	}
	if *hits != 1 {
		t.Fatalf("hits %d", *hits)
	}
	// Within the TTL the cache answers without a request.
	cat, origin, err = s.Load(context.Background())
	if err != nil || cat.Tools[0].Version != "1.0" || !origin.Cached {
		t.Fatalf("cache miss: %+v %+v %v", cat, origin, err)
	}
	if *hits != 1 {
		t.Fatalf("cache did not save a request: %d", *hits)
	}
}

func TestSourceRevalidatesWithETag(t *testing.T) {
	body := testCatalogJSON(t, "1.0")
	s, hits := newTestSource(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") == `"abc"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"abc"`)
		_, _ = w.Write(body)
	})
	if _, _, err := s.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Age the cache past the TTL.
	s.Now = func() time.Time { return time.Now().Add(7 * time.Hour) }
	cat, origin, err := s.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cat.Tools[0].Version != "1.0" || !origin.Cached {
		t.Fatalf("304 should reuse the cached catalog: %+v %+v", cat, origin)
	}
	if *hits != 2 {
		t.Fatalf("hits %d", *hits)
	}
}

func TestSourceServesStaleCatalogOffline(t *testing.T) {
	body := testCatalogJSON(t, "1.0")
	s, _ := newTestSource(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	})
	if _, _, err := s.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Same source, but the network is gone and the cache is old.
	s.Now = func() time.Time { return time.Now().Add(48 * time.Hour) }
	s.RawBase = "http://127.0.0.1:1"
	cat, origin, err := s.Load(context.Background())
	if err != nil {
		t.Fatalf("a stale catalog should be served: %v", err)
	}
	if !origin.Stale || cat.Tools[0].Version != "1.0" {
		t.Fatalf("origin %+v", origin)
	}
}

func TestSourceErrorsWithoutCache(t *testing.T) {
	s, _ := newTestSource(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusForbidden)
	})
	if _, _, err := s.Load(context.Background()); err == nil {
		t.Fatal("want an error")
	}
}

func TestSourceRejectsBadCatalog(t *testing.T) {
	s, _ := newTestSource(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"schema":1,"tools":[]}`))
	})
	if _, _, err := s.Load(context.Background()); err == nil {
		t.Fatal("an invalid catalog must not be cached or served")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(s.CachePath), cacheName)); !os.IsNotExist(err) {
		t.Fatal("a rejected catalog was written to the cache")
	}
}

func TestOfflineIsTheEmbeddedCatalog(t *testing.T) {
	cat, err := Offline()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := cat.Find("rg"); !ok {
		t.Fatal("embedded catalog has no rg")
	}
}

// The catalog is always read from master, regardless of the build's version:
// a release tag cut before tools/catalog.json existed would 404 forever.
func TestDefaultRefIsMasterUnlessOverridden(t *testing.T) {
	t.Setenv(RefEnv, "")
	if got := defaultRef(); got != masterRef {
		t.Errorf("default ref %q, want %q", got, masterRef)
	}
	t.Setenv(RefEnv, "v9.9.9")
	if got := defaultRef(); got != "v9.9.9" {
		t.Errorf("SUWU_TOOLS_REF ignored: %q", got)
	}
}

// A refresh that fails must say why: a page that says "GitHub could not be
// reached" for an invalid catalog sends the reader to the wrong place.
func TestSourceReportsWhyItIsStale(t *testing.T) {
	body := testCatalogJSON(t, "1.0")
	s, _ := newTestSource(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	})
	if _, _, err := s.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	// An invalid catalog on the wire is an error with its own reason.
	s.Now = func() time.Time { return time.Now().Add(48 * time.Hour) }
	s.RawBase = "http://127.0.0.1:1"
	_, origin, err := s.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !origin.Stale || origin.Error == "" {
		t.Fatalf("stale origin has no reason: %+v", origin)
	}
	if !strings.Contains(origin.Error, "fetch catalog") {
		t.Fatalf("reason is not the fetch error: %q", origin.Error)
	}
}

// A tag cut before tools/catalog.json existed must not leave every install
// stale forever: the tag is tried, and master answers with the reason recorded.
func TestSourceFallsBackToMasterWhenTheTagHasNoCatalog(t *testing.T) {
	body := testCatalogJSON(t, "2.0")
	var asked []string
	s, _ := newTestSource(t, func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.Path)
		if strings.Contains(r.URL.Path, "/v1.2.3/") {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(body)
	})
	cat, origin, err := s.Load(context.Background())
	if err != nil {
		t.Fatalf("expected the master fallback, got %v", err)
	}
	if cat.Tools[0].Version != "2.0" {
		t.Fatalf("catalog %+v", cat.Tools[0])
	}
	if origin.Ref != "master" || origin.FallbackFrom != "v1.2.3" || origin.Stale {
		t.Fatalf("origin %+v", origin)
	}
	if len(asked) != 2 || !strings.Contains(asked[0], "v1.2.3") || !strings.Contains(asked[1], "/master/") {
		t.Fatalf("requests %v", asked)
	}
	// A network failure does not fall back: it is read as a network failure.
	s.RawBase = "http://127.0.0.1:1"
	s.Now = func() time.Time { return time.Now().Add(48 * time.Hour) }
	_, origin, err = s.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !origin.Stale || origin.Error == "" {
		t.Fatalf("origin %+v", origin)
	}
	// The cached copy came from master, and the answer says so.
	if origin.Ref != "master" {
		t.Fatalf("stale copy reports ref %q", origin.Ref)
	}
}
