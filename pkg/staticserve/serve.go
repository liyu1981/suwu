package staticserve

import (
	"bytes"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
)

// maxHTMLInjectBytes bounds the HTML we read to add the address-bar bridge.
// Larger documents are streamed unchanged; the bridge is optional.
const maxHTMLInjectBytes = 8 << 20 // 8 MiB

// documentCSP sandboxes every previewed document. There is deliberately no
// allow-same-origin: the page gets an opaque origin, so it cannot reach the
// parent Suwu app, its APIs, or top-level navigation.
const documentCSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads"

// bridgeScript reports in-iframe navigation to the Static Browser tile and
// lets the tile ask for a reload. It runs inside the opaque-origin sandbox.
const bridgeScript = `<script>(function(){function p(t,x){try{var d={type:"staticserve-"+t};if(x)for(var k in x)d[k]=x[k];parent.postMessage(d,"*")}catch(e){}}function l(){p("location",{href:location.href})}addEventListener("load",l);addEventListener("hashchange",l);addEventListener("popstate",l);["pushState","replaceState"].forEach(function(n){var o=history[n];if(!o)return;history[n]=function(){var r=o.apply(this,arguments);l();return r}});addEventListener("message",function(e){if(e.data&&e.data.type==="staticserve-reload")location.reload()});p("ready");l()})();</script>`

var mimeTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".htm":         "text/html; charset=utf-8",
	".xhtml":       "application/xhtml+xml; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".cjs":         "text/javascript; charset=utf-8",
	".json":        "application/json; charset=utf-8",
	".map":         "application/json; charset=utf-8",
	".wasm":        "application/wasm",
	".xml":         "application/xml; charset=utf-8",
	".txt":         "text/plain; charset=utf-8",
	".md":          "text/markdown; charset=utf-8",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".jpg":         "image/jpeg",
	".jpeg":        "image/jpeg",
	".gif":         "image/gif",
	".webp":        "image/webp",
	".avif":        "image/avif",
	".bmp":         "image/bmp",
	".ico":         "image/x-icon",
	".woff":        "font/woff",
	".woff2":       "font/woff2",
	".ttf":         "font/ttf",
	".otf":         "font/otf",
	".eot":         "application/vnd.ms-fontobject",
	".mp4":         "video/mp4",
	".webm":        "video/webm",
	".ogg":         "audio/ogg",
	".mp3":         "audio/mpeg",
	".wav":         "audio/wav",
	".flac":        "audio/flac",
	".pdf":         "application/pdf",
	".webmanifest": "application/manifest+json",
}

// ServeHTTP serves rel (a path relative to the entry root, without a leading
// slash) from the registered folder. The caller has already validated the
// host, client IP, and paused state.
func (e *Entry) ServeHTTP(w http.ResponseWriter, r *http.Request, rel string) {
	setCommonHeaders(w, r)

	switch r.Method {
	case http.MethodOptions:
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(http.StatusNoContent)
		return
	case http.MethodGet, http.MethodHead:
	default:
		w.Header().Set("Allow", "GET, HEAD, OPTIONS")
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	root := e.Root()
	if root == nil {
		http.NotFound(w, r)
		return
	}

	rel = strings.TrimPrefix(rel, "/")
	if strings.ContainsRune(rel, 0) {
		http.NotFound(w, r)
		return
	}
	clean := strings.TrimPrefix(path.Clean("/"+rel), "/")
	if clean == "" {
		clean = "."
	}

	f, err := root.Open(clean)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()

	info, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}

	if info.IsDir() {
		if !strings.HasSuffix(r.URL.Path, "/") {
			redirectToSlash(w, r)
			return
		}
		indexRel := path.Join(clean, "index.html")
		if index, indexInfo, ok := openRegular(root, indexRel); ok {
			defer func() { _ = index.Close() }()
			e.serveHTML(w, r, index, indexInfo)
			return
		}
		e.serveDirListing(w, r, root, clean)
		return
	}

	if !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}

	ext := strings.ToLower(path.Ext(clean))
	if ext == ".html" || ext == ".htm" {
		e.serveHTML(w, r, f, info)
		return
	}
	if isDocumentExt(ext) {
		w.Header().Set("Content-Security-Policy", documentCSP)
	}
	e.serveContent(w, r, clean, f, info)
}

func openRegular(root *os.Root, name string) (*os.File, os.FileInfo, bool) {
	f, err := root.Open(name)
	if err != nil {
		return nil, nil, false
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = f.Close()
		return nil, nil, false
	}
	return f, info, true
}

func (e *Entry) serveContent(w http.ResponseWriter, r *http.Request, rel string, f *os.File, info os.FileInfo) {
	if ctype := contentTypeFor(rel); ctype != "" {
		w.Header().Set("Content-Type", ctype)
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

func (e *Entry) serveHTML(w http.ResponseWriter, r *http.Request, f *os.File, info os.FileInfo) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", documentCSP)
	w.Header().Set("Referrer-Policy", "unsafe-url")

	data, err := io.ReadAll(io.LimitReader(f, maxHTMLInjectBytes+1))
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	if int64(len(data)) > maxHTMLInjectBytes {
		// Too large to rewrite; stream the original bytes instead.
		if _, seekErr := f.Seek(0, io.SeekStart); seekErr == nil {
			http.ServeContent(w, r, info.Name(), info.ModTime(), f)
			return
		}
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	injected := injectBridge(data)
	http.ServeContent(w, r, info.Name(), info.ModTime(), bytes.NewReader(injected))
}

func (e *Entry) serveDirListing(w http.ResponseWriter, r *http.Request, root *os.Root, rel string) {
	// FileServerFS handles index-less directory listings, redirects, and HEAD.
	// We already checked for index.html above, so this produces a listing.
	handler := http.FileServerFS(root.FS())
	r2 := r.Clone(r.Context())
	u := *r.URL
	u.Path = "/" + strings.TrimPrefix(rel, "./")
	if u.Path == "/." {
		u.Path = "/"
	}
	if !strings.HasSuffix(u.Path, "/") {
		u.Path += "/"
	}
	r2.URL = &u
	handler.ServeHTTP(w, r2)
}

func setCommonHeaders(w http.ResponseWriter, r *http.Request) {
	// The sandboxed preview has an opaque origin and sends Origin: null for
	// CORS-mode loads (module scripts, fonts, fetch). Grant only that origin,
	// not "*", so an arbitrary website in the same browser cannot read the
	// preview's files even though the request comes from loopback.
	previewReferer := strings.HasPrefix(RefererPath(r.Referer(), r.Host), RoutePrefix)
	if r.Header.Get("Origin") == "null" && (previewReferer || r.Method == http.MethodOptions) {
		w.Header().Set("Access-Control-Allow-Origin", "null")
		w.Header().Add("Vary", "Origin")
	}
	w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Referrer-Policy", "unsafe-url")
}

func redirectToSlash(w http.ResponseWriter, r *http.Request) {
	u := *r.URL
	u.Path += "/"
	http.Redirect(w, r, u.String(), http.StatusMovedPermanently)
}

func contentTypeFor(rel string) string {
	ext := strings.ToLower(path.Ext(rel))
	if ctype, ok := mimeTypes[ext]; ok {
		return ctype
	}
	if ctype := mime.TypeByExtension(ext); ctype != "" {
		return ctype
	}
	return ""
}

func isDocumentExt(ext string) bool {
	switch ext {
	case ".html", ".htm", ".xhtml", ".svg":
		return true
	}
	return false
}

func injectBridge(html []byte) []byte {
	lower := bytes.ToLower(html)
	idx := bytes.LastIndex(lower, []byte("</body>"))
	if idx < 0 {
		idx = bytes.LastIndex(lower, []byte("</html>"))
	}
	if idx < 0 {
		out := make([]byte, 0, len(html)+len(bridgeScript))
		out = append(out, html...)
		out = append(out, bridgeScript...)
		return out
	}
	out := make([]byte, 0, len(html)+len(bridgeScript))
	out = append(out, html[:idx]...)
	out = append(out, bridgeScript...)
	out = append(out, html[idx:]...)
	return out
}

// RefererPath returns the path of a same-origin referrer, or "" when the
// referrer is absent or belongs to another origin. Used by the server-side
// preview guard.
func RefererPath(referer, hostHeader string) string {
	if referer == "" {
		return ""
	}
	u, err := url.Parse(referer)
	if err != nil {
		return ""
	}
	if u.Host != "" && !strings.EqualFold(u.Host, hostHeader) {
		return ""
	}
	return u.Path
}
