package server

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"suwu/pkg/backup"
)

// Backup endpoints. The client encrypts before anything reaches this file, so
// the server is a slot-indexed blob store: it validates the container
// prologue, records sizes and ciphertext digests, and hands bytes back
// unchanged. There is no code path here that can read a setting value.
//
//	POST   /api/backup         body = container bytes, X-Suwu-Slot, ?base=<gen>
//	GET    /api/backup/meta    ?slot= -> index + quota
//	GET    /api/backup/blob    ?slot=&gen= -> container bytes
//	DELETE /api/backup         ?slot=&confirm=<slot>
const (
	backupSlotHeader = "X-Suwu-Slot"
	backupMaxBaseLen = 20
)

// backupWriteLimit is the per-minute budget for uploads. It is separate from
// the destructive-op limiter: the periodic autosave is the one caller that
// legitimately writes often, and it must not spend the budget that file and
// dropbox operations rely on.
const backupWriteRateLimitMax = 12

func (s *Server) handleBackup(w http.ResponseWriter, r *http.Request) {
	if s.backups == nil {
		writePlain(w, http.StatusInternalServerError, "Backup store unavailable")
		return
	}

	switch r.Method {
	case http.MethodPost:
		if !s.backupRateLimit(w, r) {
			return
		}
		s.handleBackupPut(w, r)
	case http.MethodDelete:
		// Forgetting a backup is destructive, so it shares the upload budget
		// rather than getting an unlimited path.
		if !s.backupRateLimit(w, r) {
			return
		}
		s.handleBackupDelete(w, r)
	default:
		w.Header().Set("Allow", "POST, DELETE")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

// handleBackupPut stores one encrypted generation.
//
// ?base=<gen> is the generation the client believed was current. If the slot has
// moved on, the write is refused with 409 rather than overwriting a newer
// backup from another browser — that check is the whole multi-device story.
func (s *Server) handleBackupPut(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}

	slot := strings.TrimSpace(r.Header.Get(backupSlotHeader))
	if slot == "" {
		slot = r.URL.Query().Get("slot")
	}
	if !backup.ValidSlot(slot) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid slot"})
		return
	}

	var base *int64
	if raw := r.URL.Query().Get("base"); raw != "" {
		if len(raw) > backupMaxBaseLen {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid base"})
			return
		}
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid base"})
			return
		}
		base = &parsed
	}

	// Cap the body twice: MaxBytesReader makes the excess a read error before
	// it is buffered, and the store caps again so a direct caller is bounded
	// too.
	r.Body = http.MaxBytesReader(w, r.Body, backup.MaxUploadBytes)
	meta, err := s.backups.Put(slot, base, r.Body)
	if err != nil {
		// MaxBytesReader reports its own error type; map it before the generic
		// branch so an oversized upload is a 413 and not a 500.
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "backup too large"})
			return
		}
		switch {
		case errors.Is(err, backup.ErrConflict):
			latest, _ := s.backups.Meta(slot)
			current := int64(0)
			var currentAt string
			if g, ok := latest.Latest(); ok {
				current, currentAt = g.Gen, g.MTime
			}
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":        "conflict",
				"reason":       "a newer backup exists on the server",
				"currentGen":   current,
				"currentMTime": currentAt,
			})
		case errors.Is(err, backup.ErrTooLarge):
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "backup too large"})
		case errors.Is(err, backup.ErrNotContainer):
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a backup container"})
		default:
			slog.Error("backup put failed", "error", err)
			writePlain(w, http.StatusInternalServerError, "Internal Server Error")
		}
		return
	}

	latest, _ := meta.Latest()
	slog.Info("backup stored", "slot", slot, "gen", latest.Gen, "bytes", latest.Size,
		"generations", len(meta.Generations))
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"gen":         latest.Gen,
		"mtime":       latest.MTime,
		"size":        latest.Size,
		"generations": len(meta.Generations),
		"bytes":       meta.Bytes,
	})
}

func (s *Server) handleBackupMeta(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	if s.backups == nil {
		writePlain(w, http.StatusInternalServerError, "Backup store unavailable")
		return
	}

	slot := r.URL.Query().Get("slot")
	if !backup.ValidSlot(slot) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid slot"})
		return
	}

	meta, err := s.backups.Meta(slot)
	if errors.Is(err, backup.ErrNotFound) {
		// Not an error: "this slot has no backup yet" is the normal state of a
		// browser that has just been set up.
		writeJSON(w, http.StatusOK, map[string]any{
			"slot":        slot,
			"generations": []backup.Generation{},
			"bytes":       0,
		})
		return
	}
	if err != nil {
		slog.Error("backup meta failed", "error", err)
		writePlain(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) handleBackupBlob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if s.validateRequest(w, r) == "" {
		return
	}
	if s.backups == nil {
		writePlain(w, http.StatusInternalServerError, "Backup store unavailable")
		return
	}

	slot := r.URL.Query().Get("slot")
	if !backup.ValidSlot(slot) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid slot"})
		return
	}
	gen, err := strconv.ParseInt(r.URL.Query().Get("gen"), 10, 64)
	if err != nil || gen < 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid generation"})
		return
	}

	data, err := s.backups.Read(slot, gen)
	if errors.Is(err, backup.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "backup not found"})
		return
	}
	if err != nil {
		slog.Error("backup read failed", "error", err)
		writePlain(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	// Opaque bytes: never sniffed as anything, never cached by a proxy or a
	// service worker, and always a download so a stray navigation cannot land
	// binary in a tab.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"suwu-backup-g%d.bin\"", gen))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(data)
}

// handleBackupDelete forgets a whole slot. It requires `confirm` to echo the
// slot id: a backup is the only copy of somebody's settings, and a mistyped or
// stale id in a URL should not be able to wipe it.
func (s *Server) handleBackupDelete(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}
	if s.backups == nil {
		writePlain(w, http.StatusInternalServerError, "Backup store unavailable")
		return
	}

	slot := r.URL.Query().Get("slot")
	if !backup.ValidSlot(slot) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid slot"})
		return
	}
	if r.URL.Query().Get("confirm") != slot {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "confirm must echo the slot id"})
		return
	}

	if err := s.backups.Delete(slot); err != nil {
		slog.Error("backup delete failed", "error", err)
		writePlain(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	slog.Info("backup slot deleted", "slot", slot)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "slot": slot})
}

// backupRateLimit applies the upload budget to writes only.
func (s *Server) backupRateLimit(w http.ResponseWriter, r *http.Request) bool {
	if s.backupLimit.Allow(s.cfg.Token) {
		return true
	}
	slog.Warn("backup rate limit exceeded", "remote", r.RemoteAddr)
	writePlain(w, http.StatusTooManyRequests, "Rate limit exceeded")
	return false
}
