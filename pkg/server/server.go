// Package server implements the HTTP routes, static asset serving, and the
// WebSocket PTY bridge for the ghostty-web demo server.
package server

import (
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"suwu/pkg/auth"
	"suwu/pkg/notify"
	"suwu/pkg/session"
)

var mimeTypes = map[string]string{
	".html": "text/html",
	".js":   "application/javascript",
	".mjs":  "application/javascript",
	".css":  "text/css",
	".json": "application/json",
	".wasm": "application/wasm",
	".png":  "image/png",
	".svg":  "image/svg+xml",
	".ico":  "image/x-icon",
}

// Server is the demo HTTP + WebSocket server.
type Server struct {
	cfg      *auth.Config
	assets   fs.FS
	sessions *session.Manager
	notify   *notify.Listener
}

// New creates a Server serving static assets from assetsFS (the web tree)
// and managing keyed PTY sessions through mgr.
func New(cfg *auth.Config, assetsFS fs.FS, sessions *session.Manager, nl *notify.Listener) *Server {
	return &Server{cfg: cfg, assets: assetsFS, sessions: sessions, notify: nl}
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(s.route)
}

func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/ws" {
		s.handleWS(w, r)
		return
	}

	if r.URL.Path == "/ws/notify" {
		s.handleNotifyWS(w, r)
		return
	}

	if r.URL.Path == "/api/token" {
		s.handleToken(w, r)
		return
	}

	if r.URL.Path == "/api/files" {
		s.handleFiles(w, r)
		return
	}

	if r.URL.Path == "/" || r.URL.Path == "/index.html" {
		s.serveAsset(w, r, "index.html")
		return
	}

	// Static assets produced by the Vite build live under /assets/.
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name != "" && fileExists(s.assets, name) {
		s.serveAsset(w, r, name)
		return
	}

	if path.Ext(r.URL.Path) == "" {
		// Client-side route handled by the TanStack Router app.
		s.serveAsset(w, r, "index.html")
		return
	}

	http.NotFound(w, r)
}

func fileExists(fsys fs.FS, name string) bool {
	f, err := fsys.Open(name)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	return err == nil && !info.IsDir()
}

func (s *Server) serveAsset(w http.ResponseWriter, r *http.Request, name string) {
	name = path.Clean("/" + name)
	file, err := s.assets.Open(strings.TrimPrefix(name, "/"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()

	if info, err := file.Stat(); err == nil && info.IsDir() {
		http.NotFound(w, r)
		return
	}

	data, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	if ctype, ok := mimeTypes[path.Ext(name)]; ok {
		w.Header().Set("Content-Type", ctype)
	}
	_, _ = w.Write(data)
}

func (s *Server) handleToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	d := auth.ValidateTokenRequest(s.cfg, r.Host, r.Header.Get("Origin"), r.Header.Get("Authorization"))
	if !d.OK {
		writePlain(w, d.Status, d.Reason)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write([]byte(`{"token":` + strconv.Quote(s.cfg.Token) + `}`))
}

const maxFileEntries = 1000

type fileEntry struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
}

type fileListResponse struct {
	Path    string      `json:"path"`
	Entries []fileEntry `json:"entries"`
}

// handleFiles returns the directory listing for a given path.
// GET /api/files?path=/home/user
func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	d := auth.ValidateTokenRequest(s.cfg, r.Host, r.Header.Get("Origin"), r.Header.Get("Authorization"))
	if !d.OK {
		writePlain(w, d.Status, d.Reason)
		return
	}

	dirPath := r.URL.Query().Get("path")
	if dirPath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			home = "/"
		}
		dirPath = home
	}

	dirPath = filepath.Clean(dirPath)

	info, err := os.Stat(dirPath)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "path not found"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot access path"})
		}
		return
	}
	if !info.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is not a directory"})
		return
	}

	entries, err := os.ReadDir(dirPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot read directory"})
		return
	}

	result := make([]fileEntry, 0, len(entries))
	for _, e := range entries {
		if len(result) >= maxFileEntries {
			break
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		result = append(result, fileEntry{
			Name:    e.Name(),
			IsDir:   e.IsDir(),
			Size:    fi.Size(),
			ModTime: fi.ModTime().UTC().Format(time.RFC3339),
		})
	}

	resp := fileListResponse{Path: dirPath, Entries: result}
	writeJSON(w, http.StatusOK, resp)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writePlain(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(msg))
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 {
		return def
	}
	return n
}
