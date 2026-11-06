package server

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestAcceptsGzip(t *testing.T) {
	cases := []struct {
		header string
		want   bool
	}{
		{"", false},
		{"identity", false},
		{"gzip", true},
		{"GZIP", true},
		{"deflate, gzip", true},
		{"gzip;q=1.0", true},
		{"gzip;q=0", false},
		{"gzip;q=0.000", false},
		{"gzip ; q=0", false},
		{"deflate, gzip;q=0", false},
		{"br", false},
		{"*", true},
		{"*;q=0", false},
		{"gzip;q=0.5", true},
		{"gzip;q=0, *", true}, // the explicit gzip refusal only covers gzip
	}
	for _, tc := range cases {
		r := httptest.NewRequest(http.MethodGet, "/x.js", nil)
		if tc.header != "" {
			r.Header.Set("Accept-Encoding", tc.header)
		}
		if got := acceptsGzip(r); got != tc.want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", tc.header, got, tc.want)
		}
	}
}

func TestCompressible(t *testing.T) {
	yes := []string{"a.js", "a.mjs", "a.css", "a.html", "a.json", "a.svg", "a.txt", "a.map", "a.wasm", "A.JS"}
	no := []string{"a.woff2", "a.woff", "a.png", "a.webp", "a.ico", "a.gif", "a.zip", "a.gz", "noext"}
	for _, name := range yes {
		if !compressible(name) {
			t.Errorf("compressible(%q) = false, want true", name)
		}
	}
	for _, name := range no {
		if compressible(name) {
			t.Errorf("compressible(%q) = true, want false", name)
		}
	}
}

// gzipTestServer is a Server with just the pieces writeStaticBody needs.
func gzipTestServer() *Server { return &Server{gzipCache: newGzipCache()} }

// writeBody drives writeStaticBody once and returns the recorder.
func writeBody(
	t *testing.T,
	s *Server,
	method, name, key, acceptEncoding, rangeHeader string,
	body []byte,
) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "/"+name, nil)
	if acceptEncoding != "" {
		r.Header.Set("Accept-Encoding", acceptEncoding)
	}
	if rangeHeader != "" {
		r.Header.Set("Range", rangeHeader)
	}
	w := httptest.NewRecorder()
	w.Header().Set("Content-Type", "application/javascript")
	s.writeStaticBody(w, r, key, name, body)
	return w
}

func gunzip(t *testing.T, data []byte) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gunzip: %v", err)
	}
	return out
}

func TestWriteStaticBodyCompresses(t *testing.T) {
	s := gzipTestServer()
	// Highly compressible so the assertions stay readable.
	body := []byte(strings.Repeat("console.log('hello');\n", 400))
	if len(body) < gzipMinBytes {
		t.Fatalf("test body is too small to exercise compression (%d)", len(body))
	}

	w := writeBody(t, s, http.MethodGet, "app.js", "k1", "gzip", "", body)
	if got := w.Code; got != http.StatusOK {
		t.Fatalf("status = %d", got)
	}
	if got := w.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := w.Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Errorf("Vary = %q, want Accept-Encoding", got)
	}
	if got := w.Header().Get("Content-Length"); got != strconv.Itoa(w.Body.Len()) {
		t.Errorf("Content-Length = %q, want %d", got, w.Body.Len())
	}
	if w.Body.Len() >= len(body) {
		t.Errorf("compressed body (%d) is not smaller than the original (%d)", w.Body.Len(), len(body))
	}
	// Round trip: what the browser decodes must be byte-identical.
	if got := gunzip(t, w.Body.Bytes()); !bytes.Equal(got, body) {
		t.Error("decompressed body does not match the original")
	}
	// Cached for the next request under the same key.
	if _, ok := s.gzipCache.get("k1"); !ok {
		t.Error("compressed body was not cached")
	}
}

func TestWriteStaticBodyIdentity(t *testing.T) {
	s := gzipTestServer()
	body := []byte(strings.Repeat("x", gzipMinBytes+10))

	t.Run("no accept-encoding still varies", func(t *testing.T) {
		w := writeBody(t, s, http.MethodGet, "app.js", "k2", "", "", body)
		if got := w.Header().Get("Content-Encoding"); got != "" {
			t.Errorf("Content-Encoding = %q, want none", got)
		}
		if got := w.Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
			t.Errorf("Vary = %q: a shared cache could hand gzip to a client that never asked", got)
		}
		if !bytes.Equal(w.Body.Bytes(), body) {
			t.Error("identity body changed")
		}
	})

	t.Run("small file is not compressed", func(t *testing.T) {
		small := []byte("a{color:red}")
		w := writeBody(t, s, http.MethodGet, "a.css", "k3", "gzip", "", small)
		if got := w.Header().Get("Content-Encoding"); got != "" {
			t.Errorf("Content-Encoding = %q, want none under %d bytes", got, gzipMinBytes)
		}
		if _, ok := s.gzipCache.get("k3"); ok {
			t.Error("a sub-threshold body must not be cached")
		}
	})

	t.Run("range request is not compressed", func(t *testing.T) {
		w := writeBody(t, s, http.MethodGet, "app.js", "k4", "gzip", "bytes=0-99", body)
		if got := w.Header().Get("Content-Encoding"); got != "" {
			t.Errorf("Content-Encoding = %q: ranges must stay identity", got)
		}
	})

	t.Run("already-compressed type is skipped", func(t *testing.T) {
		w := writeBody(t, s, http.MethodGet, "font.woff2", "k5", "gzip", "", body)
		if got := w.Header().Get("Content-Encoding"); got != "" {
			t.Errorf("Content-Encoding = %q, want none for woff2", got)
		}
		if got := w.Header().Get("Vary"); got != "" {
			t.Errorf("Vary = %q, want none for a type we never compress", got)
		}
	})
}

func TestWriteStaticBodyHeadHasNoBody(t *testing.T) {
	s := gzipTestServer()
	body := []byte(strings.Repeat("y", gzipMinBytes+10))

	w := writeBody(t, s, http.MethodHead, "app.js", "k6", "gzip", "", body)
	if got := w.Header().Get("Content-Encoding"); got != "gzip" {
		t.Errorf("HEAD Content-Encoding = %q, want gzip", got)
	}
	if w.Body.Len() != 0 {
		t.Errorf("HEAD body = %d bytes, want 0", w.Body.Len())
	}
	if got := w.Header().Get("Content-Length"); got == "" || got == "0" {
		t.Errorf("HEAD Content-Length = %q, want the compressed size", got)
	}
}

// A large asset must not be able to evict the whole cache.
func TestGzipCacheEvicts(t *testing.T) {
	c := newGzipCache()
	chunk := make([]byte, 1<<20)
	for i := 0; i < 40; i++ {
		c.put("k"+strconv.Itoa(i), chunk)
	}
	if c.bytes > gzipCacheBytes {
		t.Errorf("cache holds %d bytes, over the %d cap", c.bytes, gzipCacheBytes)
	}
	if len(c.entries) == 0 {
		t.Error("cache evicted everything")
	}
	// The most recent keys survive.
	if _, ok := c.get("k39"); !ok {
		t.Error("the newest entry was evicted")
	}
	// Oversized entries are refused outright rather than evicting the cache.
	before := len(c.entries)
	c.put("huge", make([]byte, gzipChunkMax+1))
	if len(c.entries) != before {
		t.Error("an oversized entry was cached")
	}
}
