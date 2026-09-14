package server

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"suwu/pkg/db"
)

// handleDBBrowser routes /api/db/* requests to the appropriate handler.
func (s *Server) handleDBBrowser(w http.ResponseWriter, r *http.Request) {
	if s.validateRequest(w, r) == "" {
		return
	}

	switch {
	case r.URL.Path == "/api/db/connect":
		s.handleDBConnect(w, r)
	case r.URL.Path == "/api/db/disconnect":
		s.handleDBDisconnect(w, r)
	case r.URL.Path == "/api/db/sessions":
		s.handleDBSessions(w, r)
	case r.URL.Path == "/api/db/execute":
		s.handleDBExecute(w, r)
	case r.URL.Path == "/api/db/tables":
		s.handleDBTables(w, r)
	case r.URL.Path == "/api/db/describe":
		s.handleDBDescribe(w, r)
	default:
		writePlain(w, http.StatusNotFound, "Not Found")
	}
}

// dbConnectRequest is the request body for /api/db/connect.
type dbConnectRequest struct {
	Driver     string `json:"driver"`
	Host       string `json:"host,omitempty"`
	Port       int    `json:"port,omitempty"`
	Database   string `json:"database"`
	User       string `json:"user,omitempty"`
	Password   string `json:"password,omitempty"`
	SQLitePath string `json:"sqlitePath,omitempty"`
	SSLMode    string `json:"sslMode,omitempty"`
}

// dbConnectResponse is the response for /api/db/connect.
type dbConnectResponse struct {
	SessionID string       `json:"sessionId"`
	Tables    []db.TableInfo `json:"tables,omitempty"`
	Error     string       `json:"error,omitempty"`
}

// handleDBConnect validates a connection and creates a session.
func (s *Server) handleDBConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	var req dbConnectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, dbConnectResponse{Error: "invalid request body"})
		return
	}

	params := db.ConnectionParams{
		Driver:     db.DriverType(req.Driver),
		Host:       req.Host,
		Port:       req.Port,
		Database:   req.Database,
		User:       req.User,
		Password:   req.Password,
		SQLitePath: req.SQLitePath,
		SSLMode:    req.SSLMode,
	}

	// Validate required fields
	switch params.Driver {
	case db.DriverSQLite:
		if params.SQLitePath == "" && params.Database == "" {
			writeJSON(w, http.StatusBadRequest, dbConnectResponse{Error: "database file path required for SQLite"})
			return
		}
	case db.DriverMySQL, db.DriverPostgres:
		if params.Database == "" {
			writeJSON(w, http.StatusBadRequest, dbConnectResponse{Error: "database name required"})
			return
		}
	default:
		writeJSON(w, http.StatusBadRequest, dbConnectResponse{Error: "unsupported driver: " + req.Driver})
		return
	}

	session, err := s.dbSessions.Connect(params)
	if err != nil {
		slog.Error("db connect failed", "error", err, "driver", params.Driver)
		writeJSON(w, http.StatusBadRequest, dbConnectResponse{Error: err.Error()})
		return
	}

	// Try to list tables (best effort)
	tables, _ := s.dbSessions.ListTables(session.ID)

	writeJSON(w, http.StatusOK, dbConnectResponse{
		SessionID: session.ID,
		Tables:    tables,
	})
}

// dbDisconnectRequest is the request body for /api/db/disconnect.
type dbDisconnectRequest struct {
	SessionID string `json:"sessionId"`
}

// handleDBDisconnect closes a database session.
func (s *Server) handleDBDisconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	var req dbDisconnectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if err := s.dbSessions.Disconnect(req.SessionID); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "disconnected"})
}

// handleDBSessions lists all active database sessions.
func (s *Server) handleDBSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	sessions := s.dbSessions.ListSessions()
	writeJSON(w, http.StatusOK, sessions)
}

// dbExecuteRequest is the request body for /api/db/execute.
type dbExecuteRequest struct {
	SessionID string `json:"sessionId"`
	SQL       string `json:"sql"`
}

// handleDBExecute runs a SQL query and returns results.
func (s *Server) handleDBExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	var req dbExecuteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.SQL == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sql is required"})
		return
	}

	session, err := s.dbSessions.Get(req.SessionID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	result := db.ExecuteQuery(session.DB(), req.SQL)
	writeJSON(w, http.StatusOK, result)
}

// handleDBTables lists tables in the connected database.
func (s *Server) handleDBTables(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	sessionID := r.URL.Query().Get("session")
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session parameter required"})
		return
	}

	session, err := s.dbSessions.Get(sessionID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	tables, err := s.dbSessions.ListTables(sessionID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// If the session's driver can list tables, use that
	if tables == nil {
		// Fallback: try a generic query
		d, _ := db.GetDriver(session.Params.Driver)
		if d != nil {
			tables, err = d.ListTables(r.Context(), session.DB())
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
		}
	}

	if tables == nil {
		tables = []db.TableInfo{}
	}

	writeJSON(w, http.StatusOK, tables)
}

// handleDBDescribe describes the columns of a table.
func (s *Server) handleDBDescribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writePlain(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	sessionID := r.URL.Query().Get("session")
	tableName := r.URL.Query().Get("table")
	if sessionID == "" || tableName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session and table parameters required"})
		return
	}

	session, err := s.dbSessions.Get(sessionID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	d, _ := db.GetDriver(session.Params.Driver)
	if d == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "driver not available"})
		return
	}

	columns, err := d.DescribeTable(r.Context(), session.DB(), tableName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, columns)
}
