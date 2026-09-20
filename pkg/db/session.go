package db

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Session represents an active database connection.
type Session struct {
	ID           string
	Params       ConnectionParams
	db           *sql.DB
	createdAt    time.Time
	lastActivity time.Time
}

// DB returns the underlying sql.DB for query execution.
func (s *Session) DB() *sql.DB {
	return s.db
}

// Manager holds active sessions keyed by session ID.
// One ConnectionParams can have multiple sessions.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	nextID   int64
}

// NewManager creates a new session manager.
func NewManager() *Manager {
	return &Manager{
		sessions: make(map[string]*Session),
	}
}

// Connect creates a new session with the given connection parameters.
func (m *Manager) Connect(params ConnectionParams) (*Session, error) {
	d, err := GetDriver(params.Driver)
	if err != nil {
		return nil, err
	}

	// DSNs contain credentials; log only the driver, not connection strings.
	slog.Info("db connect", "driver", params.Driver)

	db, err := d.Open(params)
	if err != nil {
		return nil, fmt.Errorf("connection failed: %w", err)
	}

	// Test the connection
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping failed: %w", err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	m.nextID++
	id := fmt.Sprintf("db_%d_%d", time.Now().UnixMilli(), m.nextID)
	now := time.Now()
	session := &Session{
		ID:           id,
		Params:       params,
		db:           db,
		createdAt:    now,
		lastActivity: now,
	}
	m.sessions[id] = session
	slog.Info("db session created", "id", id, "driver", params.Driver)
	return session, nil
}

// Get returns a session by ID, updating lastActivity.
func (m *Manager) Get(id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return nil, fmt.Errorf("session not found: %s", id)
	}
	s.lastActivity = time.Now()
	return s, nil
}

// Disconnect closes and removes a session.
func (m *Manager) Disconnect(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return fmt.Errorf("session not found: %s", id)
	}
	s.db.Close()
	delete(m.sessions, id)
	slog.Info("db session closed", "id", id)
	return nil
}

// SessionInfo returns basic info about a session (no credentials).
type SessionInfo struct {
	ID           string     `json:"id"`
	Driver       DriverType `json:"driver"`
	Database     string     `json:"database"`
	ConnectedAt  time.Time  `json:"connectedAt"`
	LastActivity time.Time  `json:"lastActivity"`
}

// ListSessions returns info about all active sessions.
func (m *Manager) ListSessions() []SessionInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]SessionInfo, 0, len(m.sessions))
	for _, s := range m.sessions {
		result = append(result, SessionInfo{
			ID:           s.ID,
			Driver:       s.Params.Driver,
			Database:     s.Params.Database,
			ConnectedAt:  s.createdAt,
			LastActivity: s.lastActivity,
		})
	}
	return result
}

// CloseAll closes all sessions. Called on server shutdown.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, s := range m.sessions {
		s.db.Close()
		slog.Info("db session closed (shutdown)", "id", id)
	}
	m.sessions = make(map[string]*Session)
}

// ListTables returns the tables in the database for a given session.
func (m *Manager) ListTables(ctx context.Context, sessionID string) ([]TableInfo, error) {
	session, err := m.Get(sessionID)
	if err != nil {
		return nil, err
	}

	d, err := GetDriver(session.Params.Driver)
	if err != nil {
		return nil, err
	}

	return d.ListTables(ctx, session.DB())
}
