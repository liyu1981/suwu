// Package server implements the HTTP routes, static asset serving, and the
// WebSocket PTY bridge for the ghostty-web demo server.
package server

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"suwu/pkg/auth"
	"suwu/pkg/forward"
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
	cfg       *auth.Config
	assets    fs.FS
	sessions  *session.Manager
	notify    *notify.Listener
	forwards  *forward.Manager
	startedAt time.Time
}

// New creates a Server serving static assets from assetsFS (the web tree)
// and managing keyed PTY sessions through mgr.
func New(cfg *auth.Config, assetsFS fs.FS, sessions *session.Manager, nl *notify.Listener, fwds *forward.Manager) *Server {
	return &Server{cfg: cfg, assets: assetsFS, sessions: sessions, notify: nl, forwards: fwds, startedAt: time.Now()}
}

// StartedAt returns the server's start timestamp.
func (s *Server) StartedAt() time.Time {
	return s.startedAt
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(s.route)
}

func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	slog.Debug("request", "method", r.Method, "path", r.URL.Path, "remote", r.RemoteAddr)

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

	if r.URL.Path == "/api/file" {
		s.handleFile(w, r)
		return
	}

	if r.URL.Path == "/api/files" {
		s.handleFiles(w, r)
		return
	}

	if r.URL.Path == "/api/home" {
		s.handleHome(w, r)
		return
	}

	if r.URL.Path == "/api/file/rename" {
		s.handleFileRename(w, r)
		return
	}

	if r.URL.Path == "/api/file/delete" {
		s.handleFileDelete(w, r)
		return
	}

	if r.URL.Path == "/api/file/chmod" {
		s.handleFileChmod(w, r)
		return
	}

	if r.URL.Path == "/api/file/chown" {
		s.handleFileChown(w, r)
		return
	}

	if r.URL.Path == "/api/file/upload" {
		s.handleFileUpload(w, r)
		return
	}

	if r.URL.Path == "/api/session-state" {
		s.handleSessionState(w, r)
		return
	}

	if r.URL.Path == "/api/forward/start" {
		s.handleForwardStart(w, r)
		return
	}

	if r.URL.Path == "/api/forward/stop" {
		s.handleForwardStop(w, r)
		return
	}

	if r.URL.Path == "/api/forward/remove" {
		s.handleForwardRemove(w, r)
		return
	}

	if r.URL.Path == "/api/forward/status" || strings.HasPrefix(r.URL.Path, "/api/forward/status/") {
		s.handleForwardStatus(w, r)
		return
	}

	if r.URL.Path == "/api/forward/server-ports" {
		s.handleForwardServerPorts(w, r)
		return
	}

	if r.URL.Path == "/api/server-info" {
		s.handleServerInfo(w, r)
		return
	}

	if r.URL.Path == "/api/update/check" {
		s.handleUpdateCheck(w, r)
		return
	}

	if r.URL.Path == "/api/update/upgrade" {
		s.handleUpdateUpgrade(w, r)
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

// validateRequest is a helper that validates an API request and writes an
// error response if unauthorized. Returns the validated token or "" if failed.
func validateRequest(w http.ResponseWriter, r *http.Request, cfg *auth.Config) string {
	token := r.URL.Query().Get("token")
	slog.Debug("validateRequest", "host", r.Host, "origin", r.Header.Get("Origin"),
		"hasQueryToken", token != "", "hasAuthHeader", r.Header.Get("Authorization") != "",
		"allowedHosts", cfg.AllowedHosts)
	d, validated := auth.ValidateAPIRequest(cfg, r.Host, r.Header.Get("Origin"), r.Header.Get("Authorization"), token)
	if !d.OK {
		slog.Debug("validateRequest FAILED", "status", d.Status, "reason", d.Reason,
			"host", r.Host, "origin", r.Header.Get("Origin"))
		writePlain(w, d.Status, d.Reason)
		return ""
	}
	return validated
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

	if validateRequest(w, r, s.cfg) == "" {
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

// handleHome returns the current user's home directory.
// GET /api/home
func (s *Server) handleHome(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if validateRequest(w, r, s.cfg) == "" {
		return
	}

	home, err := os.UserHomeDir()
	if err != nil {
		home = "/"
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": home})
}

// handleFile serves the contents of a single file.
// GET /api/file?path=/path/to/file&token=<session-token>
func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if validateRequest(w, r, s.cfg) == "" {
		return
	}

	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path parameter required"})
		return
	}

	filePath = filepath.Clean(filePath)

	info, err := os.Stat(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "file not found"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot access file"})
		}
		return
	}
	if info.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is a directory"})
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, filePath)
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

// handleFileRename renames a file or directory.
// POST /api/file/rename { "path": "/path/to/file", "newName": "new-name" }
func (s *Server) handleFileRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if validateRequest(w, r, s.cfg) == "" {
		return
	}

	var req struct {
		Path    string `json:"path"`
		NewName string `json:"newName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Path == "" || req.NewName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path and newName are required"})
		return
	}

	// Sanitize: prevent path traversal in newName
	if strings.Contains(req.NewName, "/") || strings.Contains(req.NewName, "\\") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid name"})
		return
	}

	oldPath := filepath.Clean(req.Path)
	newPath := filepath.Join(filepath.Dir(oldPath), req.NewName)

	if err := os.Rename(oldPath, newPath); err != nil {
		slog.Error("rename failed", "path", oldPath, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("rename failed: %v", err)})
		return
	}

	slog.Debug("file renamed", "from", oldPath, "to", newPath)
	writeJSON(w, http.StatusOK, map[string]string{"path": newPath})
}

// handleFileDelete deletes a file or directory.
// POST /api/file/delete { "path": "/path/to/file" }
func (s *Server) handleFileDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if validateRequest(w, r, s.cfg) == "" {
		return
	}

	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}

	filePath := filepath.Clean(req.Path)

	// Prevent deleting root or home
	if filePath == "/" || filePath == filepath.Dir(filePath) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "cannot delete root directory"})
		return
	}

	if err := os.RemoveAll(filePath); err != nil {
		slog.Error("delete failed", "path", filePath, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("delete failed: %v", err)})
		return
	}

	slog.Debug("file deleted", "path", filePath)
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// handleFileChmod changes file permissions.
// POST /api/file/chmod { "path": "/path/to/file", "mode": "755" }
func (s *Server) handleFileChmod(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if validateRequest(w, r, s.cfg) == "" {
		return
	}

	var req struct {
		Path string `json:"path"`
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Path == "" || req.Mode == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path and mode are required"})
		return
	}

	// Parse octal mode
	mode, err := strconv.ParseUint(req.Mode, 8, 32)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid mode format (use octal, e.g., 755)"})
		return
	}

	filePath := filepath.Clean(req.Path)
	if err := os.Chmod(filePath, fs.FileMode(mode)); err != nil {
		slog.Error("chmod failed", "path", filePath, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("chmod failed: %v", err)})
		return
	}

	slog.Debug("file mode changed", "path", filePath, "mode", req.Mode)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleFileChown changes file ownership.
// POST /api/file/chown { "path": "/path/to/file", "uid": 1000, "gid": 1000 }
func (s *Server) handleFileChown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if validateRequest(w, r, s.cfg) == "" {
		return
	}

	var req struct {
		Path string `json:"path"`
		UID  int    `json:"uid"`
		GID  int    `json:"gid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}

	filePath := filepath.Clean(req.Path)

	// Use chown command since os.Chown requires root
	cmd := exec.Command("chown", fmt.Sprintf("%d:%d", req.UID, req.GID), filePath)
	if output, err := cmd.CombinedOutput(); err != nil {
		slog.Error("chown failed", "path", filePath, "error", err, "output", string(output))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("chown failed: %v", err)})
		return
	}

	slog.Debug("file ownership changed", "path", filePath, "uid", req.UID, "gid", req.GID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleFileUpload uploads files to a directory.
// POST /api/file/upload (multipart/form-data)
// Fields: path (directory), file (uploaded file)
func (s *Server) handleFileUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if validateRequest(w, r, s.cfg) == "" {
		return
	}

	// Parse multipart form (max 100MB)
	if err := r.ParseMultipartForm(100 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to parse upload form"})
		return
	}

	dirPath := r.FormValue("path")
	if dirPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}

	dirPath = filepath.Clean(dirPath)
	info, err := os.Stat(dirPath)
	if err != nil || !info.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is not a directory"})
		return
	}

	file, handler, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no file provided"})
		return
	}
	defer file.Close()

	// Sanitize filename
	filename := filepath.Base(handler.Filename)
	if filename == "." || filename == ".." {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid filename"})
		return
	}

	dstPath := filepath.Join(dirPath, filename)

	// Create destination file
	dst, err := os.Create(dstPath)
	if err != nil {
		slog.Error("upload create failed", "path", dstPath, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to create file: %v", err)})
		return
	}
	defer dst.Close()

	// Copy file contents
	written, err := io.Copy(dst, file)
	if err != nil {
		slog.Error("upload write failed", "path", dstPath, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to write file: %v", err)})
		return
	}

	slog.Debug("file uploaded", "path", dstPath, "size", written)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"path": dstPath,
		"size": written,
	})
}

// handleSessionState returns the current CWD and foreground command for a
// terminal session. Polled by the frontend for session persistence.
// GET /api/session-state?session=<key>&token=<token>
func (s *Server) handleSessionState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if validateRequest(w, r, s.cfg) == "" {
		return
	}

	key := r.URL.Query().Get("session")
	if key == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session parameter required"})
		return
	}

	cwd, foreground := s.sessions.GetState(key)
	slog.Debug("session-state", "key", key, "cwd", cwd, "foreground", foreground)
	writeJSON(w, http.StatusOK, map[string]string{
		"cwd":        cwd,
		"foreground": foreground,
	})
}

// handleServerInfo returns the server's start timestamp.
// GET /api/server-info
func (s *Server) handleServerInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if validateRequest(w, r, s.cfg) == "" {
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"startedAt": s.startedAt.UTC().Format(time.RFC3339),
	})
}
