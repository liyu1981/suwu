package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"

	"suwu/pkg/bindir"
	"suwu/pkg/tools"
)

// The tools endpoints. The browser cannot write ~/.suwu/bin, so every action the
// System tools page offers is a server-side install: the server downloads
// (pkg/tools), verifies the pinned sha256 and stamps the result. docs/TOOLS_PLAN.md
// §9.
const (
	toolsListRoute      = "/api/tools"
	toolsInstallRoute   = "/api/tools/install"
	toolsUninstallRoute = "/api/tools/uninstall"
	toolsPathRoute      = "/api/tools/path"
	toolsRefreshRoute   = "/api/tools/refresh"
)

// toolsBusy is the single-flight guard for installs. One tool at a time keeps
// the download budget, the staging directory and the bin-dir lock simple; the
// second click gets a 409 instead of a request parked behind a 30 MiB download.
type toolsBusy struct {
	mu    sync.Mutex
	taken bool
}

func (b *toolsBusy) acquire() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.taken {
		return false
	}
	b.taken = true
	return true
}

func (b *toolsBusy) release() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.taken = false
}

// handleTools dispatches /api/tools and its sub-paths.
func (s *Server) handleTools(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case toolsListRoute:
		s.handleToolsList(w, r)
	case toolsInstallRoute:
		s.handleToolsInstall(w, r)
	case toolsUninstallRoute:
		s.handleToolsUninstall(w, r)
	case toolsPathRoute:
		s.handleToolsPath(w, r)
	case toolsRefreshRoute:
		s.handleToolsRefresh(w, r)
	default:
		writePlain(w, http.StatusNotFound, "Not Found")
	}
}

// toolsSource is the catalog source for this server. It reads the ref of the
// running build, with the same override the CLI honours.
func (s *Server) toolsSource() *tools.Source { return tools.NewSource(s.dataDir) }

// loadToolsCatalog prefers the network, falls back to the cached copy, then to
// the catalog embedded in this binary. A page that cannot reach GitHub still
// shows what is installed.
func (s *Server) loadToolsCatalog(ctx context.Context, refresh bool) (*tools.Catalog, tools.Origin, error) {
	src := s.toolsSource()
	var (
		cat    *tools.Catalog
		origin tools.Origin
		err    error
	)
	if refresh {
		cat, origin, err = src.Refresh(ctx)
	} else {
		cat, origin, err = src.Load(ctx)
	}
	if err == nil {
		return cat, origin, nil
	}
	offline, offErr := tools.Offline()
	if offErr != nil {
		return nil, origin, err
	}
	origin.Stale = true
	return offline, origin, nil
}

// toolsPathState reports whether the opt-in rc block is installed.
func (s *Server) toolsPathState() (enabled bool, files []string) {
	files, err := bindir.PathFiles(bindir.ToolsBlock)
	if err != nil {
		return false, nil
	}
	return len(files) > 0, files
}

// GET /api/tools -> the catalog resolved against this machine.
func (s *Server) handleToolsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	refresh := r.URL.Query().Get("refresh") == "1"
	cat, origin, err := s.loadToolsCatalog(r.Context(), refresh)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	list, err := tools.Statuses(cat, runtime.GOOS, runtime.GOARCH, s.dataDir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	enabled, files := s.toolsPathState()
	writeJSON(w, http.StatusOK, map[string]any{
		"os":     runtime.GOOS,
		"arch":   runtime.GOARCH,
		"binDir": bindir.Dir(s.dataDir),
		"source": origin,
		"path": map[string]any{
			"enabled": enabled,
			"files":   files,
		},
		"tools": list,
	})
}

// POST /api/tools/install {name}
func (s *Server) handleToolsInstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	var req struct {
		Name  string `json:"name"`
		Force bool   `json:"force"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}

	cat, _, err := s.loadToolsCatalog(r.Context(), false)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	tool, ok := cat.Find(name)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": fmt.Sprintf("%s is not in the catalog", name)})
		return
	}
	platform, ok := tool.For(runtime.GOOS, runtime.GOARCH)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("%s has no build for %s", name, tools.PlatformKey(runtime.GOOS, runtime.GOARCH)),
		})
		return
	}

	if !s.toolsBusy.acquire() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "an install is already running"})
		return
	}
	defer s.toolsBusy.release()

	res, err := tools.InstallFromURL(r.Context(), tools.SpecFrom(tool, platform, runtime.GOOS, runtime.GOARCH), tools.Options{
		DataDir: s.dataDir,
		Force:   req.Force,
	})
	if err != nil {
		writeToolsError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":     res.Name,
		"version":  res.Version,
		"files":    res.Files,
		"skipped":  res.Skipped,
		"replaced": res.Replaced,
	})
}

// POST /api/tools/uninstall {name}
func (s *Server) handleToolsUninstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if !s.toolsBusy.acquire() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "an install is already running"})
		return
	}
	defer s.toolsBusy.release()

	res, err := tools.Uninstall(tools.Options{DataDir: s.dataDir}, strings.TrimSpace(req.Name))
	if err != nil {
		writeToolsError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": res.Name, "removed": res.Files})
}

// POST /api/tools/path {enabled}
func (s *Server) handleToolsPath(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	dir := bindir.Dir(s.dataDir)
	if req.Enabled {
		if _, err := os.Stat(dir); err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "nothing is installed yet; install a tool first"})
			return
		}
		changed, err := bindir.EnsurePath(dir, bindir.ToolsBlock)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		enabled, files := s.toolsPathState()
		writeJSON(w, http.StatusOK, map[string]any{"enabled": enabled, "files": files, "changed": changed})
		return
	}
	changed, err := bindir.RemovePath(bindir.ToolsBlock)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	enabled, files := s.toolsPathState()
	writeJSON(w, http.StatusOK, map[string]any{"enabled": enabled, "files": files, "changed": changed})
}

// POST /api/tools/refresh -> the catalog origin after a forced revalidation.
func (s *Server) handleToolsRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	_, origin, err := s.loadToolsCatalog(r.Context(), true)
	if err != nil && origin.FetchedAt == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"source": origin})
}

// writeToolsError maps an installer error onto a status code: permission and
// ownership problems are conflicts, upstream problems are the gateway's fault.
func writeToolsError(w http.ResponseWriter, err error) {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "already exists"),
		strings.Contains(msg, "is a symlink"),
		strings.Contains(msg, "not installed by suwu tools"),
		strings.Contains(msg, "not installed"):
		writeJSON(w, http.StatusConflict, map[string]string{"error": msg})
	case strings.Contains(msg, "checksum mismatch"),
		strings.Contains(msg, "download"),
		strings.Contains(msg, "fetch catalog"):
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": msg})
	case strings.Contains(msg, "no build for"), strings.Contains(msg, "not in the catalog"):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": msg})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": msg})
	}
}
