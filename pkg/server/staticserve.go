package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"suwu/pkg/auth"
	"suwu/pkg/staticserve"
)

const staticServeAPIPrefix = "/api/staticserve/"

// isStaticPreviewPath reports whether p is the static-preview route itself.
func isStaticPreviewPath(p string) bool {
	return p == "/staticserve" || strings.HasPrefix(p, staticserve.RoutePrefix)
}

// isStaticPreviewRequest detects a request made by a sandboxed preview page so
// root-absolute URLs ("/static/app.js") return 404 instead of accidentally
// loading Suwu's own assets. The sandbox attributes cannot restrict URLs; this
// is the server-side half of the isolation.
func isStaticPreviewRequest(r *http.Request) bool {
	if r.Header.Get("Origin") == "null" && !isOpaqueOriginExemptPath(r.URL.Path) {
		return true
	}
	ref := r.Referer()
	if ref == "" {
		return false
	}
	return strings.HasPrefix(staticserve.RefererPath(ref, r.Host), staticserve.RoutePrefix)
}

// Extension and background pages legitimately run with an opaque origin and
// fetch their own same-origin assets with Origin: null. They are not static
// previews, so the root-path guard must leave those routes alone.
func isOpaqueOriginExemptPath(p string) bool {
	return strings.HasPrefix(p, "/gqjs/") || strings.HasPrefix(p, "/backgrounds/")
}

// handleStaticServe serves an unauthenticated preview:
// GET/HEAD/OPTIONS /staticserve/<id>/<path>
//
// The Host allow-list and the recent-authenticated-client IP gate replace the
// token: static assets must load without ?token= for relative URLs to work.
func (s *Server) handleStaticServe(w http.ResponseWriter, r *http.Request) {
	if d := auth.ValidateHostRequest(s.cfg, r.Host); !d.OK {
		writePlain(w, d.Status, d.Reason)
		return
	}
	if !s.clients.Allow(r.RemoteAddr) {
		writePlain(w, http.StatusForbidden, "Forbidden: open Suwu in this browser first")
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, staticserve.RoutePrefix)
	id, rel, _ := strings.Cut(rest, "/")
	if id == "" {
		http.NotFound(w, r)
		return
	}
	entry, err := s.statics.Get(id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if entry.Paused() {
		w.Header().Set("Retry-After", "60")
		writePlain(w, http.StatusServiceUnavailable, "Static serve is paused")
		return
	}

	// /staticserve/<id> -> /staticserve/<id>/ so relative paths resolve.
	if rel == "" && !strings.HasSuffix(r.URL.Path, "/") {
		http.Redirect(w, r, r.URL.Path+"/", http.StatusMovedPermanently)
		return
	}

	s.clients.Touch(r.RemoteAddr)
	entry.ServeHTTP(w, r, rel)
}

// handleStaticServeAPI manages the in-memory registry. Every operation is
// authenticated like the rest of /api/*.
func (s *Server) handleStaticServeAPI(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}

	switch r.URL.Path {
	case staticServeAPIPrefix + "start":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
			return
		}
		var body struct {
			Dir string `json:"dir"`
			New bool   `json:"new"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writePlain(w, http.StatusBadRequest, "Invalid JSON")
			return
		}
		entry, created, err := s.statics.Create(body.Dir, body.New)
		if err != nil {
			writePlain(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"serve": entry.Status(), "created": created})

	case staticServeAPIPrefix + "list":
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"serves": s.statics.List()})

	case staticServeAPIPrefix + "pause", staticServeAPIPrefix + "resume":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
			return
		}
		var body struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writePlain(w, http.StatusBadRequest, "Invalid JSON")
			return
		}
		var (
			entry *staticserve.Entry
			err   error
		)
		if strings.HasSuffix(r.URL.Path, "/pause") {
			entry, err = s.statics.Pause(body.ID)
		} else {
			entry, err = s.statics.Resume(body.ID)
		}
		if err != nil {
			writePlain(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, entry.Status())

	case staticServeAPIPrefix + "remove":
		if r.Method != http.MethodPost && r.Method != http.MethodDelete {
			w.Header().Set("Allow", "POST, DELETE")
			writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
			return
		}
		var body struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writePlain(w, http.StatusBadRequest, "Invalid JSON")
			return
		}
		if err := s.statics.Remove(body.ID); err != nil {
			writePlain(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})

	default:
		http.NotFound(w, r)
	}
}
