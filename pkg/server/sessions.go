package server

// Login-session management and persistence (docs/AUTH_SESSIONS_PLAN.md).
//
// The registry itself lives in pkg/auth; this file owns the HTTP surface the
// page and `suwu auth` use, and the file the registry is restored from and saved
// to, so a restart does not sign every device out.

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"suwu/pkg/auth"
)

// restoreSessions fills a Server's registry from the data directory. A failure
// is logged and ignored: sessions are a convenience layer over the password, and
// a corrupt file must never stop the server from starting.
func restoreSessions(cfg *auth.Config, dataDir string) {
	if dataDir == "" || cfg == nil || cfg.Sessions == nil {
		return
	}
	sessions, err := auth.LoadSessions(dataDir, cfg.PasswordHash, time.Now())
	if err != nil {
		slog.Warn("could not load login sessions", "error", err)
		return
	}
	cfg.Sessions.Restore(sessions)
	cfg.Sessions.OnChange(func() {
		if err := auth.SaveSessions(dataDir, cfg.PasswordHash, cfg.Sessions.Snapshot()); err != nil {
			slog.Warn("could not save login sessions", "error", err)
		}
	})
}

// loadSessions is kept for callers that hold a Server.
func (s *Server) loadSessions() {
	if s.dataDir == "" || s.cfg == nil || s.cfg.Sessions == nil {
		return
	}
	sessions, err := auth.LoadSessions(s.dataDir, s.cfg.PasswordHash, time.Now())
	if err != nil {
		slog.Warn("could not load login sessions", "error", err)
		return
	}
	s.cfg.Sessions.Restore(sessions)
	if len(sessions) > 0 {
		slog.Debug("login sessions restored", "count", len(sessions))
	}
	s.cfg.Sessions.OnChange(s.saveSessions)
}

// saveSessions persists the registry. It is called after a mutation (create,
// rotate, revoke) rather than on every request: the sliding expiry of a session
// in use is a few minutes of drift, and rewriting a file on every API call would
// not be worth it.
func (s *Server) saveSessions() {
	if s.dataDir == "" || s.cfg == nil || s.cfg.Sessions == nil {
		return
	}
	if err := auth.SaveSessions(s.dataDir, s.cfg.PasswordHash, s.cfg.Sessions.Snapshot()); err != nil {
		slog.Warn("could not save login sessions", "error", err)
	}
}

// Sessions returns the live sessions, for the CLI's `suwu auth ls`.
func (s *Server) Sessions() []*auth.Session {
	if s.cfg == nil || s.cfg.Sessions == nil {
		return nil
	}
	return s.cfg.Sessions.List()
}

// RevokeSession drops one session and reports its label.
func (s *Server) RevokeSession(id string) (string, bool) {
	if s.cfg == nil || s.cfg.Sessions == nil {
		return "", false
	}
	session, ok := s.cfg.Sessions.Get(id)
	if !ok {
		return "", false
	}
	label := session.Label
	if !s.cfg.Sessions.Revoke(id) {
		return "", false
	}
	return label, true
}

// RevokeAllSessions signs every device out, including the caller of the HTTP
// API; `suwu auth rm --all` is the local escape hatch and does not spare itself.
func (s *Server) RevokeAllSessions() int {
	if s.cfg == nil || s.cfg.Sessions == nil {
		return 0
	}
	return s.cfg.Sessions.RevokeAllExcept("")
}

// handleSessions serves /api/sessions and /api/sessions/<id>.
func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request, current string) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/sessions")
	rest = strings.TrimPrefix(rest, "/")
	if rest == "" || rest == "revoke-all" {
		s.handleSessionsRoot(w, r, current, rest == "revoke-all")
		return
	}
	id, err := pathUnescape(rest)
	if err != nil || id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session id"})
		return
	}
	if r.Method != http.MethodDelete {
		w.Header().Set("Allow", "DELETE")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	s.revokeSession(w, r, current, id)
}

// handleSessionsRoot lists sessions, and serves the revoke-all action.
func (s *Server) handleSessionsRoot(w http.ResponseWriter, r *http.Request, current string, revokeAll bool) {
	if revokeAll {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
			return
		}
		var req struct {
			KeepCurrent *bool `json:"keepCurrent"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req)
		keep := current
		if req.KeepCurrent != nil && !*req.KeepCurrent {
			keep = ""
		}
		revoked := s.cfg.Sessions.RevokeAllExcept(keep)
		body := map[string]any{"revoked": revoked}
		if keep == "" {
			// Signing out everywhere includes the caller: hand it a fresh session
			// so it stays usable, which is what the button promises.
			session, token, err := auth.NewSession(sessionLabel(r), time.Now())
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			s.cfg.Sessions.Add(session)
			body["token"], body["session"] = token, session
		}
		writeJSON(w, http.StatusOK, body)
		return
	}

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	sessions := s.cfg.Sessions.List()
	list := make([]map[string]any, 0, len(sessions))
	for _, session := range sessions {
		list = append(list, map[string]any{
			"id":       session.ID,
			"label":    session.Label,
			"created":  session.Created.UTC().Format(time.RFC3339),
			"lastSeen": session.LastSeen.UTC().Format(time.RFC3339),
			"expires":  session.Expires.UTC().Format(time.RFC3339),
			"legacy":   session.Legacy,
			"current":  session.ID == current,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": list})
}

// revokeSession removes one session. Revoking the one you are using is allowed
// and re-mints for the caller, so "sign out this device" is not a trap.
func (s *Server) revokeSession(w http.ResponseWriter, r *http.Request, current, id string) {
	ok := s.cfg.Sessions.Revoke(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such session"})
		return
	}
	body := map[string]any{"ok": true, "id": id}
	if id == current {
		session, token, err := auth.NewSession(sessionLabel(r), time.Now())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		s.cfg.Sessions.Add(session)
		body["token"], body["session"] = token, session
	}
	writeJSON(w, http.StatusOK, body)
}

// handleTokenRotate gives the caller's session a new secret, invalidating the
// token without dropping the login.
func (s *Server) handleTokenRotate(w http.ResponseWriter, r *http.Request, current string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if current == "" || current == auth.BasicKey || current == "hmac" || current == "legacy" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "this session cannot be rotated; sign in again"})
		return
	}
	token, err := s.cfg.Sessions.Rotate(current)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such session"})
		return
	}
	session, _ := s.cfg.Sessions.Get(current)
	body := map[string]any{"token": token}
	if session != nil {
		body["session"] = session
	}
	writeJSON(w, http.StatusOK, body)
}

// pathUnescape decodes one path segment.
func pathUnescape(seg string) (string, error) {
	if strings.ContainsAny(seg, "/?# ") {
		return "", errBadSegment
	}
	return seg, nil
}

var errBadSegment = errorString("invalid path segment")

type errorString string

func (e errorString) Error() string { return string(e) }
