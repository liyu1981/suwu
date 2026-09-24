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
// data-api pattern in examples/extensions/hn-top-stories and
// docs/EXTENSION_API_PLAN.md §2.8.

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"log/slog"

	"suwu/pkg/extension"
)

// extensionStaticRoutePrefix is the path prefix for extension static assets.
const extensionStaticRoutePrefix = "/gqjs/static/"

// extensionStaticMaxBody caps one static file on disk.
const extensionStaticMaxBody = 8 << 20 // 8 MiB

// extensionStaticInertCSP scopes document-family static types (.html/.svg/…).
// Opened as a direct tab they would be unsandboxed documents on our origin,
// so scripts are cut and the page renders inert; as <img>/<link>/<script>
// subresources the response CSP is irrelevant and rendering is unaffected.
const extensionStaticInertCSP = "default-src 'none'; style-src 'unsafe-inline'"

// extensionStaticTypes is the allow-list of served file types — unknown
// extensions 404 (fail closed), so package.json and friends have no entry.
// .js/.mjs use the explicit JavaScript type modules expect.
var extensionStaticTypes = map[string]string{
	".js":     "text/javascript; charset=utf-8",
	".mjs":    "text/javascript; charset=utf-8",
	".css":    "text/css; charset=utf-8",
	".json":   "application/json; charset=utf-8",
	".html":   "text/html; charset=utf-8",
	".htm":    "text/html; charset=utf-8",
	".xhtml":  "application/xhtml+xml",
	".svg":    "image/svg+xml",
	".png":    "image/png",
	".gif":    "image/gif",
	".webp":   "image/webp",
	".ico":    "image/x-icon",
	".woff2":  "font/woff2",
	".woff":   "font/woff",
	".ttf":    "font/ttf",
	".txt":    "text/plain; charset=utf-8",
	".map":    "application/json; charset=utf-8",
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

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Revalidate on every use: cheap on a LAN, and Last-Modified (below)
	// turns the revalidation into a 304 with no body.
	w.Header().Set("Cache-Control", "no-cache")
	if isDocumentStaticType(extn) {
		w.Header().Set("Content-Security-Policy", extensionStaticInertCSP)
	}
	// ServeContent streams without a full read and honors HEAD,
	// If-Modified-Since → 304, and Range requests.
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}
