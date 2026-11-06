package server

// gzip for the static text assets Suwu serves.
//
// A Vite build makes the JS/CSS payload large (the app's own bundle is 5.7 MB,
// 1.5 MB gzipped), and nothing in the tree compressed before this file. Three
// handlers serve text — `serveAsset` (embedded app assets), `handleExtensionStatic`
// and `handleBackgroundStatic` — and they all go through the helpers here so the
// rules cannot drift.
//
// Design: compress once per file and cache the result. Every file these paths
// serve is immutable for a given (path, size, mtime): embedded assets never
// change while the process lives, and an installed extension's assets only
// change when the user reinstalls. So the cost is paid once per file per boot,
// after which responses carry an exact Content-Length instead of being chunked.
//
// Deliberately NOT compressed: the extension render page. It carries the
// extension-scoped token *and* echoes caller-controlled input (`?file=`) into
// the same response — compressing attacker-influenced text next to a secret is
// exactly the BREACH oracle. Static assets carry no secrets.
//
// See docs/EXTENSION_BUILD_PLAN.md §5.1.

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
)

// gzipMinBytes is the size below which compressing is not worth a header: a
// 300-byte file gains maybe 100 bytes and costs a Vary on every response.
const gzipMinBytes = 1024

// gzipChunkMax is the largest file we cache compressed. Everything above it is
// streamed through a pooled writer instead, so one huge asset cannot evict the
// whole cache; the handlers already cap their bodies (8 MiB).
const gzipChunkMax = 8 << 20

// gzipCacheBytes caps the memory the compressed copies may hold. It bounds what
// a directory full of large assets can pin.
const gzipCacheBytes = 32 << 20

// gzipLevel is DefaultCompression: measured on the 5.7 MB app bundle, going to
// 9 buys 0.1% for +54% CPU, while BestSpeed is 3x faster but 21% larger. The
// cost is paid once per file per boot, so the better ratio wins.
const gzipLevel = gzip.DefaultCompression

// compressibleExts are the served types worth compressing. Everything else the
// handlers serve is already compressed on disk (woff2, png, webp, ico) and
// would only grow. .wasm is included: it compresses ~50%, and the browser
// decodes Content-Encoding before the application/wasm MIME check, so
// WebAssembly.instantiateStreaming is unaffected.
var compressibleExts = map[string]bool{
	".js": true, ".mjs": true, ".css": true, ".html": true, ".htm": true,
	".xhtml": true, ".json": true, ".map": true, ".svg": true, ".txt": true,
	".wasm": true,
}

// compressible reports whether a path may be gzipped.
func compressible(name string) bool {
	return compressibleExts[strings.ToLower(path.Ext(name))]
}

// acceptsGzip parses Accept-Encoding. It is deliberately not a full q-value
// negotiation: gzip (or * ) with a non-zero q is enough, and an explicit
// `gzip;q=0` must disable it.
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		enc, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		enc = strings.ToLower(strings.TrimSpace(enc))
		if enc != "gzip" && enc != "*" {
			continue
		}
		if q, ok := qValue(params); ok && q == 0 {
			continue
		}
		return true
	}
	return false
}

// qValue reads the q parameter of one Accept-Encoding element. It reports
// whether a q was present at all; malformed values are treated as absent (the
// encoding stays enabled), matching browsers' tolerant behaviour.
func qValue(params string) (float64, bool) {
	for _, p := range strings.Split(params, ";") {
		k, v, ok := strings.Cut(strings.TrimSpace(p), "=")
		if !ok || strings.ToLower(strings.TrimSpace(k)) != "q" {
			continue
		}
		v = strings.TrimSpace(v)
		switch v {
		case "0", "0.0", "0.00", "0.000":
			return 0, true
		case "1", "1.0", "1.00", "1.000":
			return 1, true
		}
		return 0.5, true // any other non-zero q: enabled
	}
	return 0, false
}

// gzipEntry is one cached compressed body.
type gzipEntry struct {
	body []byte
}

// gzipCache is the process-wide cache of compressed assets, keyed by caller
// (handler family) + name + size + mtime. Bounded by gzipCacheBytes; entries
// are never invalidated individually — a changed file gets a new key, and the
// old key becomes unreachable, which the size cap then reclaims.
type gzipCache struct {
	mu      sync.RWMutex
	entries map[string]gzipEntry
	order   []string // insertion order, for eviction
	bytes   int
}

func newGzipCache() *gzipCache {
	return &gzipCache{entries: make(map[string]gzipEntry)}
}

// get returns the cached body for key.
func (c *gzipCache) get(key string) ([]byte, bool) {
	c.mu.RLock()
	e, ok := c.entries[key]
	c.mu.RUnlock()
	return e.body, ok
}

// put stores body under key, evicting oldest entries until it fits.
func (c *gzipCache) put(key string, body []byte) {
	if len(body) == 0 || len(body) > gzipChunkMax || int64(len(body)) > gzipCacheBytes {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.entries[key]; ok {
		return
	}
	for c.bytes+len(body) > gzipCacheBytes && len(c.order) > 0 {
		oldest := c.order[0]
		c.order = c.order[1:]
		if e, ok := c.entries[oldest]; ok {
			c.bytes -= len(e.body)
			delete(c.entries, oldest)
		}
	}
	c.entries[key] = gzipEntry{body: body}
	c.order = append(c.order, key)
	c.bytes += len(body)
}

// gzipBytes compresses src at gzipLevel.
func gzipBytes(src []byte) ([]byte, error) {
	var buf bytes.Buffer
	buf.Grow(len(src) / 4)
	zw, err := gzip.NewWriterLevel(&buf, gzipLevel)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(src); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// writeStaticBody serves one static body, compressed when the request allows it
// and the type is worth it. key identifies the cached entry (handler family +
// name + size + mtime); name decides the type; data is the raw body.
//
// The caller has already set Content-Type and any security headers. This
// function owns Content-Encoding, Vary, Content-Length and the body.
func (s *Server) writeStaticBody(w http.ResponseWriter, r *http.Request, key, name string, data []byte) {
	if !compressible(name) {
		_, _ = w.Write(data)
		return
	}
	// Always advertise the negotiation, even when answering identity: without
	// it a shared proxy can hand gzip bytes to a client that never asked.
	w.Header().Add("Vary", "Accept-Encoding")

	// Byte ranges own the body shape; a gzip stream would break them. The
	// handlers that support ranges (ServeContent) take this path via identity.
	if r.Header.Get("Range") != "" || len(data) < gzipMinBytes {
		_, _ = w.Write(data)
		return
	}
	if !acceptsGzip(r) {
		_, _ = w.Write(data)
		return
	}

	body, ok := s.gzipCache.get(key)
	if !ok {
		var err error
		body, err = gzipBytes(data)
		if err != nil {
			// Compression is an optimization: fall back to identity rather than
			// failing a request that would otherwise succeed.
			_, _ = w.Write(data)
			return
		}
		s.gzipCache.put(key, body)
	}
	w.Header().Set("Content-Encoding", "gzip")
	// An accurate length is the point of caching: no chunked encoding.
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}
