package server

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Manifest caps keep one pre-flight request bounded: a runaway directory must
// answer with `truncated: true` instead of streaming an unbounded body, and
// the client refuses to mirror a partial view.
const (
	maxSyncEntries = 20000
	maxSyncDepth   = 32
)

type syncManifestEntry struct {
	Rel     string `json:"rel"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	MtimeMs int64  `json:"mtimeMs"`
}

type syncManifestResponse struct {
	Path       string              `json:"path"`
	Entries    []syncManifestEntry `json:"entries"`
	EntryCount int                 `json:"entryCount"`
	Truncated  bool                `json:"truncated"`
}

// handleSyncManifest returns the recursive manifest of a folder with
// millisecond mtimes — the remote half of one Folder Sync pre-flight.
//
// GET /api/sync/manifest?path=/abs/dir
//
// The existing /api/files endpoint is single-level with second-precision
// RFC3339 mtimes, so a 5 s sync loop would need one request per directory and
// still could not detect same-timestamp divergence reliably. This handler is
// read-only (no destructive rate limit) and never follows symlinks: a link
// could point outside the synced folder, and the mirror must not escape it.
func (s *Server) handleSyncManifest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if s.validateRequest(w, r) == "" {
		return
	}

	dirPath := r.URL.Query().Get("path")
	if dirPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path parameter required"})
		return
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

	resp := syncManifestResponse{
		Path:    dirPath,
		Entries: make([]syncManifestEntry, 0, 64),
	}

	// rootLen strips the root prefix (plus its separator) so entries carry a
	// POSIX-style rel path relative to dirPath.
	rootLen := len(dirPath)
	if dirPath != string(filepath.Separator) {
		rootLen++
	}

	walkErr := filepath.WalkDir(dirPath, func(p string, d fs.DirEntry, err error) error {
		if p == dirPath {
			if err != nil {
				return err
			}
			return nil
		}
		if err != nil {
			// An unreadable entry below the root is skipped, not fatal: the
			// rest of the folder still mirrors. Root failures returned above.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		// Never follow or list symlinks — the mirror stays inside the folder.
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}

		rel := filepath.ToSlash(p[rootLen:])
		depth := strings.Count(rel, "/") + 1
		if depth > maxSyncDepth {
			resp.Truncated = true
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if len(resp.Entries) >= maxSyncEntries {
			resp.Truncated = true
			return fs.SkipAll
		}

		fi, err := d.Info()
		if err != nil {
			return nil
		}
		resp.Entries = append(resp.Entries, syncManifestEntry{
			Rel:     rel,
			IsDir:   d.IsDir(),
			Size:    fi.Size(),
			MtimeMs: fi.ModTime().UnixMilli(),
		})
		return nil
	})
	if walkErr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot read directory"})
		return
	}

	resp.EntryCount = len(resp.Entries)
	writeJSON(w, http.StatusOK, resp)
}
