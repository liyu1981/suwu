package server

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"

	"suwu/pkg/forward"
)

func (s *Server) handleForwardStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	if validateRequest(w, r, s.cfg) == "" {
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

	if validateRequest(w, r, s.cfg) == "" {
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

	if validateRequest(w, r, s.cfg) == "" {
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

	if validateRequest(w, r, s.cfg) == "" {
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

	if validateRequest(w, r, s.cfg) == "" {
		return
	}

	ports := readListeningPorts()
	writeJSON(w, http.StatusOK, map[string]any{"ports": ports})
}

// readListeningPorts reads /proc/net/tcp and /proc/net/tcp6 to find all
// listening TCP ports. State 0A = LISTEN.
func readListeningPorts() []int {
	seen := make(map[int]bool)
	var ports []int

	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(f)
		lineNo := 0
		for scanner.Scan() {
			lineNo++
			if lineNo == 1 {
				continue // skip header
			}
			line := scanner.Text()
			fields := strings.Fields(line)
			if len(fields) < 4 {
				continue
			}
			// State is field[3], "0A" = LISTEN
			if fields[3] != "0A" {
				continue
			}
			// Local address is field[1], format is IP:PORT in hex
			parts := strings.Split(fields[1], ":")
			if len(parts) < 2 {
				continue
			}
			portHex := parts[len(parts)-1]
			port, err := strconv.ParseInt(portHex, 16, 32)
			if err != nil || port < 1 {
				continue
			}
			p := int(port)
			if !seen[p] {
				seen[p] = true
				ports = append(ports, p)
			}
		}
		f.Close()
	}

	return ports
}
