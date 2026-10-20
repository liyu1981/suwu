package server

// SFTP endpoints for the SFTP tile. The SSH/SFTP connection is made from the
// Suwu host to the remote machine; the browser only sends paths. Credentials
// are held in memory by the sftp.Manager and are never persisted.
//
//   POST /api/sftp/connect    {host,port,user,auth,password,privateKey,passphrase}
//   GET  /api/sftp/sessions
//   POST /api/sftp/disconnect {session}
//   GET  /api/sftp/list?session=&path=
//   POST /api/sftp/mkdir      {session,path}
//   POST /api/sftp/rename     {session,path,newName}
//   POST /api/sftp/delete     {session,path}
//   GET  /api/sftp/download?session=&path=
//   POST /api/sftp/upload?session=&dir=&path=
//   POST /api/sftp/copy       {session,direction,source,destination,recursive,overwrite}

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"suwu/pkg/sftp"
)

const sftpRoutePrefix = "/api/sftp/"

// maxSftpUploadBytes caps a single browser upload (and download, via the same
// body cap).
const maxSftpUploadBytes = 2 << 30 // 2 GiB

// handleSftp routes /api/sftp/* requests.
func (s *Server) handleSftp(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}
	switch strings.TrimPrefix(r.URL.Path, sftpRoutePrefix) {
	case "connect":
		s.handleSftpConnect(w, r)
	case "sessions":
		s.handleSftpSessions(w, r)
	case "disconnect":
		s.handleSftpDisconnect(w, r)
	case "list":
		s.handleSftpList(w, r)
	case "mkdir":
		s.handleSftpMkdir(w, r)
	case "rename":
		s.handleSftpRename(w, r)
	case "delete":
		s.handleSftpDelete(w, r)
	case "download":
		s.handleSftpDownload(w, r)
	case "upload":
		s.handleSftpUpload(w, r)
	case "ping":
		s.handleSftpPing(w, r)
	case "copy":
		s.handleSftpCopy(w, r)
	case "transfer":
		s.handleSftpTransfer(w, r)
	default:
		writePlain(w, http.StatusNotFound, "Not Found")
	}
}

func (s *Server) handleSftpConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	var params sftp.ConnectionParams
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&params); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	session, err := s.sftpMgr.Connect(r.Context(), params)
	if err != nil {
		slog.Warn("sftp connect failed", "host", params.Host, "user", params.User, "error", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"sessionId": session.ID,
		"home":      session.Home(),
		"host":      session.Host,
		"user":      session.User,
		"hostKey":   session.HostKey,
	})
}

func (s *Server) handleSftpSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": s.sftpMgr.List()})
}

func (s *Server) handleSftpDisconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	var req struct {
		Session string `json:"session"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Session == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session is required"})
		return
	}
	s.sftpMgr.Disconnect(req.Session)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleSftpPing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	session, ok := s.sftpSession(w, r)
	if !ok {
		return
	}
	if err := session.KeepAlive(); err != nil {
		writeSftpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleSftpList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	session, ok := s.sftpSession(w, r)
	if !ok {
		return
	}
	dir := r.URL.Query().Get("path")
	if strings.TrimSpace(dir) == "" {
		dir = session.Home()
	}
	entries, err := session.List(dir)
	if err != nil {
		writeSftpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": dir, "entries": entries})
}

func (s *Server) handleSftpMkdir(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	var req struct {
		Session string `json:"session"`
		Path    string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Path) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}
	session, ok := s.sftpSessionByID(w, req.Session)
	if !ok {
		return
	}
	if err := session.Mkdir(req.Path); err != nil {
		writeSftpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": req.Path})
}

func (s *Server) handleSftpRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	var req struct {
		Session string `json:"session"`
		Path    string `json:"path"`
		NewName string `json:"newName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Path == "" || req.NewName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path and newName are required"})
		return
	}
	if strings.ContainsAny(req.NewName, "/\\") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "newName must not contain a path separator"})
		return
	}
	session, ok := s.sftpSessionByID(w, req.Session)
	if !ok {
		return
	}
	newPath := path.Join(path.Dir(req.Path), req.NewName)
	if err := session.Rename(req.Path, newPath); err != nil {
		writeSftpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": newPath})
}

func (s *Server) handleSftpDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	var req struct {
		Session string `json:"session"`
		Path    string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Path) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}
	session, ok := s.sftpSessionByID(w, req.Session)
	if !ok {
		return
	}
	if err := session.Remove(req.Path); err != nil {
		writeSftpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleSftpDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	session, ok := s.sftpSession(w, r)
	if !ok {
		return
	}
	remotePath := strings.TrimSpace(r.URL.Query().Get("path"))
	if remotePath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}
	reader, size, name, err := session.OpenReader(remotePath)
	if err != nil {
		writeSftpError(w, err)
		return
	}
	defer func() { _ = reader.Close() }()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeFilename(name)+`"`)
	if size >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	_, _ = io.Copy(w, reader)
}

func (s *Server) handleSftpUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	session, ok := s.sftpSession(w, r)
	if !ok {
		return
	}
	dir := strings.TrimSpace(r.URL.Query().Get("dir"))
	if dir == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "dir is required"})
		return
	}
	rel, err := cleanUploadRel(r.URL.Query().Get("path"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	remotePath := path.Join(dir, rel)

	writer, err := session.CreateWriter(remotePath)
	if err != nil {
		writeSftpError(w, err)
		return
	}
	written, copyErr := io.Copy(writer, http.MaxBytesReader(w, r.Body, maxSftpUploadBytes))
	closeErr := writer.Close()
	if copyErr != nil {
		writeSftpError(w, copyErr)
		return
	}
	if closeErr != nil {
		writeSftpError(w, closeErr)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": remotePath, "size": written})
}

func (s *Server) handleSftpCopy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	session, ok := s.sftpSession(w, r)
	if !ok {
		return
	}
	var req struct {
		Direction   string `json:"direction"`
		Source      string `json:"source"`
		Destination string `json:"destination"`
		Recursive   bool   `json:"recursive"`
		Overwrite   bool   `json:"overwrite"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Source == "" || req.Destination == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source and destination are required"})
		return
	}

	switch req.Direction {
	case "local-to-remote":
		if err := session.CopyLocalToRemote(req.Source, req.Destination, req.Recursive, req.Overwrite); err != nil {
			writeSftpError(w, err)
			return
		}
	case "remote-to-local":
		if err := session.CopyRemoteToLocal(req.Source, req.Destination, req.Recursive, req.Overwrite); err != nil {
			writeSftpError(w, err)
			return
		}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "direction must be local-to-remote or remote-to-local"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// sftpSession resolves the ?session= parameter (GET/ping routes).
func (s *Server) sftpSession(w http.ResponseWriter, r *http.Request) (*sftp.Session, bool) {
	return s.sftpSessionByID(w, r.URL.Query().Get("session"))
}

// sftpSessionByID resolves a body-supplied session id (POST routes).
func (s *Server) sftpSessionByID(w http.ResponseWriter, id string) (*sftp.Session, bool) {
	id = strings.TrimSpace(id)
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session is required"})
		return nil, false
	}
	session, err := s.sftpMgr.Get(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return nil, false
	}
	return session, true
}

// writeSftpError maps a remote error to a 502 with its message.
func writeSftpError(w http.ResponseWriter, err error) {
	slog.Debug("sftp operation failed", "error", err)
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
}

// cleanUploadRel normalises a client-supplied relative upload path so it can
// never escape the destination directory.
func cleanUploadRel(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", errors.New("path is required")
	}
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimPrefix(path.Clean("/"+p), "/")
	if p == "" {
		return "", errors.New("invalid path")
	}
	return p, nil
}

// ── Endpoint-to-endpoint copy ─────────────────────────────────────────
//
// The SFTP tile has two independent panes; each is one of:
//   suwu   — the Suwu host's own filesystem
//   remote — an SFTP session
// so a copy can be any of suwu↔suwu, suwu↔remote or remote↔remote. The server
// streams the bytes, so remote↔remote never round-trips through the browser.

// copyEndpoint identifies one side of a transfer.
const (
	endpointSuwu   = "suwu"
	endpointRemote = "remote"
)

func (s *Server) handleSftpTransfer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	var req struct {
		SourceKind      string `json:"sourceKind"`
		SourceSession   string `json:"sourceSession"`
		SourcePath      string `json:"sourcePath"`
		DestinationKind string `json:"destinationKind"`
		DestSession     string `json:"destSession"`
		DestinationPath string `json:"destinationPath"`
		Recursive       bool   `json:"recursive"`
		Overwrite       bool   `json:"overwrite"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.SourcePath == "" || req.DestinationPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sourcePath and destinationPath are required"})
		return
	}

	srcRemote, err := s.sftpEndpointSession(req.SourceKind, req.SourceSession)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	dstRemote, err := s.sftpEndpointSession(req.DestinationKind, req.DestSession)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	switch {
	case srcRemote == nil && dstRemote == nil:
		err = copySuwuToSuwu(req.SourcePath, req.DestinationPath, req.Recursive, req.Overwrite)
	case srcRemote == nil && dstRemote != nil:
		err = dstRemote.CopyLocalToRemote(req.SourcePath, req.DestinationPath, req.Recursive, req.Overwrite)
	case srcRemote != nil && dstRemote == nil:
		err = srcRemote.CopyRemoteToLocal(req.SourcePath, req.DestinationPath, req.Recursive, req.Overwrite)
	default:
		err = dstRemote.CopyFromSession(srcRemote, req.SourcePath, req.DestinationPath, req.Recursive, req.Overwrite)
	}
	if err != nil {
		writeSftpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// sftpEndpointSession resolves an endpoint kind to its SFTP session, or nil for
// the Suwu host.
func (s *Server) sftpEndpointSession(kind, sessionID string) (*sftp.Session, error) {
	switch kind {
	case endpointSuwu, "":
		return nil, nil
	case endpointRemote:
		if strings.TrimSpace(sessionID) == "" {
			return nil, errors.New("a session is required for a remote endpoint")
		}
		return s.sftpMgr.Get(sessionID)
	default:
		return nil, fmt.Errorf("unknown endpoint kind %q", kind)
	}
}

// copySuwuToSuwu copies within the Suwu host's filesystem.
func copySuwuToSuwu(src, destDir string, recursive, overwrite bool) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	dest := filepath.Join(destDir, filepath.Base(src))
	if info.IsDir() {
		if !recursive {
			return errors.New("source is a directory; enable recursive copy")
		}
		return copySuwuDir(src, dest, overwrite)
	}
	return copySuwuFile(src, dest, overwrite)
}

func copySuwuDir(src, destDir string, overwrite bool) error {
	return filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(destDir, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copySuwuFile(p, target, overwrite)
	})
}

func copySuwuFile(src, dest string, overwrite bool) error {
	if !overwrite {
		if _, err := os.Stat(dest); err == nil {
			return fmt.Errorf("%s already exists", dest)
		}
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
