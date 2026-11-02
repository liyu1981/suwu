package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"suwu/pkg/forward"
)

func (s *Server) handleForwardStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if s.validateRequest(w, r) == "" {
		return
	}

	var cfg forward.ForwardConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		writePlain(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	f, err := s.forwards.Start(cfg)
	if err != nil {
		writePlain(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, s.forwards.ToStatus(f))
}

func (s *Server) handleForwardStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if s.validateRequest(w, r) == "" {
		return
	}

	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writePlain(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	f, err := s.forwards.Stop(body.ID)
	if err != nil {
		writePlain(w, http.StatusNotFound, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, s.forwards.ToStatus(f))
}

func (s *Server) handleForwardRemove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "POST, DELETE")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if s.validateRequest(w, r) == "" {
		return
	}

	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writePlain(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	if err := s.forwards.Remove(body.ID); err != nil {
		writePlain(w, http.StatusNotFound, err.Error())
		return
	}

	writePlain(w, http.StatusOK, "ok")
}

func (s *Server) handleForwardStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if s.validateRequest(w, r) == "" {
		return
	}

	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/forward/status/"), "/")
	if len(parts) > 0 && parts[0] != "" {
		id := parts[0]
		status, err := s.forwards.Status(id)
		if err != nil {
			writePlain(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, status)
		return
	}

	writeJSON(w, http.StatusOK, s.forwards.StatusAll())
}

// handleForwardServerPorts returns all TCP ports currently listening on the server
// by reading /proc/net/tcp and /proc/net/tcp6.
func (s *Server) handleForwardServerPorts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if s.validateRequest(w, r) == "" {
		return
	}

	ports := readListeningPorts()
	writeJSON(w, http.StatusOK, map[string]any{"ports": ports})
}
