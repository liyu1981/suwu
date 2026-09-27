package server

// WebGPU backgrounds: the authenticated metadata list and the unauthenticated
// module/shader static route.
//
// Static serving is deliberately UNAUTHENTICATED, mirroring /gqjs/static/: an
// ES-module import carries neither cookies nor an Authorization header, and a
// background's relative shader imports cannot carry ?token=. The files are
// client-shipped, public source — never put secrets in a background dir. The
// data dir itself is user-owned, so a background runs as trusted local code.

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"suwu/backgrounds"
	"suwu/pkg/background"
)

// backgroundRoutePrefix serves background files: GET /backgrounds/webgpu/<id>/<path>
const backgroundRoutePrefix = "/backgrounds/webgpu/"

// backgroundStaticMaxBody caps one served background file.
const backgroundStaticMaxBody = 8 << 20 // 8 MiB

// backgroundStaticTypes is the allow-list of served file types — unknown
// extensions 404 (fail closed), so nothing outside the documented layout can
// be read through the route.
var backgroundStaticTypes = map[string]string{
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wgsl": "text/plain; charset=utf-8",
}

// handleBackgroundsList lists resolvable backgrounds:
// GET /api/backgrounds -> { "backgrounds": [ Manifest, … ] }
//
// Disk entries and the embedded builtin are merged by id — a data-dir copy
// overrides the builtin — so the frontend has exactly one registration path
// for both.
func (s *Server) handleBackgroundsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}

	merged := make(map[string]background.Manifest)
	if embedded, err := background.ListFS(backgrounds.Builtin, "webgpu"); err == nil {
		for _, m := range embedded {
			merged[m.ID] = m
		}
	}
	if disk, err := background.ListDisk(background.Dir(s.dataDir)); err == nil {
		for _, m := range disk {
			merged[m.ID] = m
		}
	}
	list := make([]background.Manifest, 0, len(merged))
	for _, m := range merged {
		list = append(list, m)
	}
	sortManifestsByID(list)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_ = json.NewEncoder(w).Encode(map[string]any{"backgrounds": list})
}

// handleBackgroundStatic serves one background file:
// GET/HEAD /backgrounds/webgpu/<id>/<path> — data dir first, embedded fallback.
func (s *Server) handleBackgroundStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, backgroundRoutePrefix)
	id, rel, ok := strings.Cut(rest, "/")
	if !ok || !background.ValidID(id) || rel == "" {
		http.NotFound(w, r)
		return
	}
	ext := strings.ToLower(filepath.Ext(rel))
	contentType, ok := backgroundStaticTypes[ext]
	if !ok {
		http.NotFound(w, r)
		return
	}

	// 1) data dir (a user copy overrides the builtin)
	if path, err := background.StaticFile(background.Dir(s.dataDir), id, rel); err == nil {
		if info, statErr := os.Stat(path); statErr == nil && info.Mode().IsRegular() {
			if info.Size() > backgroundStaticMaxBody {
				http.Error(w, "Background file too large", http.StatusRequestEntityTooLarge)
				return
			}
			f, openErr := os.Open(path)
			if openErr == nil {
				defer func() { _ = f.Close() }()
				w.Header().Set("Content-Type", contentType)
				w.Header().Set("X-Content-Type-Options", "nosniff")
				w.Header().Set("Cache-Control", "no-cache")
				// ServeContent honors HEAD, If-Modified-Since → 304 and Range.
				http.ServeContent(w, r, info.Name(), info.ModTime(), f)
				return
			}
		}
	}

	// 2) embedded builtin
	f, err := background.OpenFS(backgrounds.Builtin, "webgpu", id, rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if info.Size() > backgroundStaticMaxBody {
		http.Error(w, "Background file too large", http.StatusRequestEntityTooLarge)
		return
	}
	body, err := io.ReadAll(io.LimitReader(f, backgroundStaticMaxBody))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(body)
}

// sortManifestsByID keeps the JSON response stable between requests.
func sortManifestsByID(list []background.Manifest) {
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j].ID < list[j-1].ID; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
}
