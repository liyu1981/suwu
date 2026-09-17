package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
)

// maxFileWriteBytes caps a single save so a stray huge buffer cannot exhaust
// memory or disk.
const maxFileWriteBytes = 10 << 20 // 10 MiB

// handleFileWrite saves editor contents back to disk.
//
// POST /api/file/write { "path": "...", "content": "...", "mtimeMs": 123 }
//
// The presence of mtimeMs selects the mode:
//   - present → update: the file must exist and its modification time must
//     match (optimistic concurrency, so we never clobber an external edit);
//     the existing file mode is preserved.
//   - absent  → create: the file must not exist yet; the parent directory must.
//
// Writes are atomic (temp file + rename in the target directory).
func (s *Server) handleFileWrite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if s.validateRequest(w, r) == "" {
		return
	}

	var req struct {
		Path    string   `json:"path"`
		Content string   `json:"content"`
		MtimeMs *float64 `json:"mtimeMs"`
	}
	// Allow some JSON escaping overhead on top of the raw content cap.
	body := http.MaxBytesReader(w, r.Body, maxFileWriteBytes*2)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}
	if len(req.Content) > maxFileWriteBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "file too large"})
		return
	}

	target := resolveWriteTarget(req.Path)

	info, statErr := os.Stat(target)
	exists := statErr == nil

	if req.MtimeMs == nil {
		// Create mode.
		if exists {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "file already exists"})
			return
		}
		if !errors.Is(statErr, os.ErrNotExist) {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot access file"})
			return
		}
	} else {
		// Update mode.
		if !exists {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "file no longer exists"})
			return
		}
		if info.IsDir() {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is a directory"})
			return
		}
		if info.ModTime().UnixMilli() != int64(*req.MtimeMs) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "file changed on disk"})
			return
		}
	}

	parent := filepath.Dir(target)
	if pinfo, err := os.Stat(parent); err != nil || !pinfo.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "parent directory does not exist"})
		return
	}

	mode := os.FileMode(0o644)
	if exists {
		mode = info.Mode().Perm()
	}

	if err := writeFileAtomic(target, []byte(req.Content), mode); err != nil {
		slog.Error("file write failed", "path", target, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("write failed: %v", err)})
		return
	}

	resp := map[string]any{"path": target, "size": len(req.Content)}
	if newInfo, err := os.Stat(target); err == nil {
		resp["size"] = newInfo.Size()
		resp["mtimeMs"] = float64(newInfo.ModTime().UnixMilli())
	}
	slog.Debug("file written", "path", target, "size", resp["size"])
	writeJSON(w, http.StatusOK, resp)
}

// resolveWriteTarget cleans the path and resolves symlinks so an atomic rename
// replaces the link target instead of the symlink itself. For a not-yet-existing
// file it resolves the parent directory.
func resolveWriteTarget(path string) string {
	target := filepath.Clean(path)
	if resolved, err := filepath.EvalSymlinks(target); err == nil {
		return resolved
	}
	if resolvedParent, err := filepath.EvalSymlinks(filepath.Dir(target)); err == nil {
		return filepath.Join(resolvedParent, filepath.Base(target))
	}
	return target
}

// writeFileAtomic writes data to a temp file in the target directory, fsyncs
// it, applies mode and renames it over path.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		if tmpName != "" {
			_ = os.Remove(tmpName)
		}
	}()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	tmpName = "" // successfully renamed; nothing to clean up
	return nil
}
