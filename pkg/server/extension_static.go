package server

// Extension static assets: GET/HEAD /gqjs/static/<id>/<path> streams files
// from the extension's declared suwu.static directory (package.json).
//
// Deliberately UNAUTHENTICATED: the render page runs in a sandboxed iframe
// with an opaque origin, and ES-module fetches carry neither cookies nor
// tokens — a module's relative imports cannot carry ?token= either. Static
// files are therefore public, client-shipped source: NEVER put secrets
// (tokens, passwords, API keys) in them. Secrets travel through the
// authenticated render HTML instead (a data-* attribute or an inline classic
// script) and are read by the static code at runtime; see the canonical
// data-api pattern in examples/extension/hn-top-stories and
// docs/EXTENSION_API_PLAN.md §2.8.

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"log/slog"

	"suwu/pkg/extension"
)

// extensionStaticRoutePrefix is the path prefix for extension static assets.
const extensionStaticRoutePrefix = "/gqjs/static/"

// extensionStaticMaxBody caps one static file on disk.
//
// A built extension ships whole bundles rather than hand-written scripts, and
// with inlined dynamic imports one entry chunk can be several megabytes
// (examples/extension/excalidraw is 7.8 MB). The cap matches MaxFileBytes in
// pkg/install so anything installable is also servable, with headroom for the
// next dependency.
const extensionStaticMaxBody = 16 << 20 // 16 MiB

// extensionStaticInertCSP scopes document-family static types (.html/.svg/…).
// Opened as a direct tab they would be unsandboxed documents on our origin,
// so scripts are cut and the page renders inert; as <img>/<link>/<script>
// subresources the response CSP is irrelevant and rendering is unaffected.
const extensionStaticInertCSP = "default-src 'none'; style-src 'unsafe-inline'"

// extensionStaticTypes is the allow-list of served file types — unknown
// extensions 404 (fail closed), so package.json and friends have no entry.
// .js/.mjs use the explicit JavaScript type modules expect.
var extensionStaticTypes = map[string]string{
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".html":  "text/html; charset=utf-8",
	".htm":   "text/html; charset=utf-8",
	".xhtml": "application/xhtml+xml",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".gif":   "image/gif",
	".webp":  "image/webp",
	".ico":   "image/x-icon",
	".woff2": "font/woff2",
	".woff":  "font/woff",
	".ttf":   "font/ttf",
	".txt":   "text/plain; charset=utf-8",
	".map":   "application/json; charset=utf-8",
	// .wasm is required by built extensions: Excalidraw's font-subsetting
	// module fetches woff2.wasm and compiles it with
	// WebAssembly.instantiateStreaming, which refuses any other MIME type.
	".wasm": "application/wasm",
}

// isDocumentStaticType reports whether a served type can become a browsing
// context when opened directly (needs the inert CSP).
func isDocumentStaticType(ext string) bool {
	switch ext {
	case ".html", ".htm", ".xhtml", ".svg":
		return true
	}
	return false
}

// handleExtensionStatic serves an extension's public assets:
// GET/HEAD /gqjs/static/<id>/<path>
func (s *Server) handleExtensionStatic(w http.ResponseWriter, r *http.Request) {
	// Module scripts and fonts are CORS-mode fetches from the opaque page.
	grantOpaqueOriginCORS(w, r)

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeExtensionAPIError(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, extensionStaticRoutePrefix)
	id, rel, _ := strings.Cut(rest, "/")
	if !extension.ValidID(id) || rel == "" {
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}
	ext, err := extension.Resolve(s.extensionDir(), id)
	if err != nil {
		slog.Debug("extension resolve failed", "id", id, "error", err)
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}
	if ext.Static == "" {
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}
	extn := strings.ToLower(filepath.Ext(rel))
	contentType, ok := extensionStaticTypes[extn]
	if !ok {
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}
	// suwu.static is either a directory or a zip archive; both answer the same
	// URLs, so only how the bytes are obtained differs.
	if ext.StaticKind() == extension.StaticZip {
		s.serveZipStatic(w, r, ext, id, rel, extn, contentType)
		return
	}

	p, err := ext.StaticPath(rel)
	if err != nil {
		slog.Debug("extension static path", "id", id, "path", rel, "error", err)
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}
	st, err := os.Stat(p)
	if err != nil || !st.Mode().IsRegular() {
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}
	if st.Size() > extensionStaticMaxBody {
		writeExtensionAPIError(w, http.StatusRequestEntityTooLarge, "Static file too large")
		return
	}
	f, err := os.Open(p)
	if err != nil {
		slog.Debug("extension static open", "id", id, "path", rel, "error", err)
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}
	defer func() { _ = f.Close() }()

	setStaticHeaders(w, extn, contentType)
	// The validator is set on both paths so a client can always revalidate; the
	// conditional request itself takes the streaming path below (ServeContent
	// answers 304 with it).
	w.Header().Set("Last-Modified", st.ModTime().UTC().Format(http.TimeFormat))

	// Range and conditional requests keep the streaming path: ServeContent owns
	// both, and a gzip stream would break byte ranges. A plain GET/HEAD for a
	// compressible type is read once, gzipped once, and cached (compress.go).
	if isGzipCandidate(r, st.Size(), extn) {
		body, readErr := io.ReadAll(io.LimitReader(f, extensionStaticMaxBody+1))
		if readErr == nil && int64(len(body)) == st.Size() {
			s.writeStaticBody(w, r, extensionStaticCacheKey(id, rel, st.Size(), st.ModTime()), rel, body)
			return
		}
		// Read failed or raced with a rewrite: fall back to streaming, which
		// re-stats and re-opens nothing (the body is still positioned).
		if _, seekErr := f.Seek(0, io.SeekStart); seekErr == nil {
			http.ServeContent(w, r, st.Name(), st.ModTime(), f)
			return
		}
		writeExtensionAPIError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	// ServeContent streams without a full read and honors HEAD,
	// If-Modified-Since → 304, and Range requests.
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

// isGzipCandidate reports whether this request should take the
// read-gzip-cache path instead of http.ServeContent: a plain GET/HEAD (no
// Range, no conditional revalidation) for a compressible type above the
// minimum size.
func isGzipCandidate(r *http.Request, size int64, extn string) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if r.Header.Get("Range") != "" {
		return false
	}
	// Conditional requests are ServeContent's job: it answers 304 with the
	// right validators, which a cached gzip body would bypass.
	if r.Header.Get("If-Modified-Since") != "" || r.Header.Get("If-None-Match") != "" {
		return false
	}
	if size < gzipMinBytes || !compressibleExts[extn] {
		return false
	}
	return acceptsGzip(r)
}

// extensionStaticCacheKey identifies one immutable (file, version) pair.
func extensionStaticCacheKey(id, rel string, size int64, mtime time.Time) string {
	return "ext:" + id + "/" + rel + ":" + strconv.FormatInt(size, 10) + ":" + strconv.FormatInt(mtime.UnixNano(), 10)
}

// setStaticHeaders applies the headers both static sources share.
func setStaticHeaders(w http.ResponseWriter, extn, contentType string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Revalidate on every use: cheap on a LAN, and Last-Modified turns the
	// revalidation into a 304 with no body.
	w.Header().Set("Cache-Control", "no-cache")
	if isDocumentStaticType(extn) {
		w.Header().Set("Content-Security-Policy", extensionStaticInertCSP)
	}
}

// serveZipStatic answers one request from a suwu.static zip archive.
//
// The entry is read whole (static files are capped, and the gzip path needs the
// bytes anyway), then served through http.ServeContent so HEAD, conditional
// requests and Range keep working exactly like the directory source. The
// archive entry's mtime is the validator, so rebuilding dist.zip invalidates
// every cached copy.
func (s *Server) serveZipStatic(
	w http.ResponseWriter,
	r *http.Request,
	ext extension.Extension,
	id, rel, extn, contentType string,
) {
	asset, err := ext.StaticAsset(rel, extensionStaticMaxBody)
	if err != nil {
		if errors.Is(err, extension.ErrStaticTooLarge) {
			writeExtensionAPIError(w, http.StatusRequestEntityTooLarge, "Static file too large")
			return
		}
		slog.Debug("extension static zip entry", "id", id, "path", rel, "error", err)
		writeExtensionAPIError(w, http.StatusNotFound, "Not found")
		return
	}
	setStaticHeaders(w, extn, contentType)
	w.Header().Set("Last-Modified", asset.ModTime.UTC().Format(http.TimeFormat))

	if isGzipCandidate(r, int64(len(asset.Data)), extn) {
		s.writeStaticBody(w, r,
			extensionStaticCacheKey("zip:"+id, rel, int64(len(asset.Data)), asset.ModTime),
			rel, asset.Data)
		return
	}
	http.ServeContent(w, r, asset.Name, asset.ModTime, bytes.NewReader(asset.Data))
}
