// Package db provides database connection management and query execution
// for the DB Browser feature. It supports SQLite, MySQL, and PostgreSQL.
package db

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// DriverType enumerates supported database drivers.
type DriverType string

const (
	DriverSQLite   DriverType = "sqlite"
	DriverMySQL    DriverType = "mysql"
	DriverPostgres DriverType = "postgres"
)

// MaxRows limits result size to prevent browser OOM.
const MaxRows = 10000

// QueryTimeout caps individual query execution time.
const QueryTimeout = 30 * time.Second

// SessionIdleTimeout auto-closes idle sessions.
const SessionIdleTimeout = 30 * time.Minute

// ConnectionParams holds client-provided connection info.
// Credentials are NEVER persisted — held in memory only.
type ConnectionParams struct {
	Driver   DriverType `json:"driver"`
	Host     string     `json:"host,omitempty"`
	Port     int        `json:"port,omitempty"`
	Database string     `json:"database"`
	User     string     `json:"user,omitempty"`
	Password string     `json:"password,omitempty"`
	// SQLite-specific
	SQLitePath string `json:"sqlitePath,omitempty"`
	// SSL/TLS
	SSLMode string `json:"sslMode,omitempty"`
}

// ColumnMeta describes a result column.
type ColumnMeta struct {
	Name     string `json:"name"`
	DataType string `json:"dataType"`
}

// QueryResult holds the output of a SQL execution.
type QueryResult struct {
	Columns      []ColumnMeta    `json:"columns"`
	Rows         [][]interface{} `json:"rows"`
	RowsAffected int64           `json:"rowsAffected"`
	Milliseconds int64           `json:"milliseconds"`
	Error        string          `json:"error,omitempty"`
	Truncated    bool            `json:"truncated"`
}

// TableInfo for schema browsing.
type TableInfo struct {
	Name   string `json:"name"`
	Schema string `json:"schema,omitempty"`
	Type   string `json:"type"`
}

// ColumnInfo for table structure.
type ColumnInfo struct {
	Name         string  `json:"name"`
	DataType     string  `json:"dataType"`
	Nullable     bool    `json:"nullable"`
	DefaultValue *string `json:"defaultValue,omitempty"`
	IsPrimaryKey bool    `json:"isPrimaryKey"`
}

// Driver is the interface each database backend must implement.
type Driver interface {
	Open(params ConnectionParams) (*sql.DB, error)
	ListTables(ctx context.Context, db *sql.DB) ([]TableInfo, error)
	DescribeTable(ctx context.Context, db *sql.DB, tableName string) ([]ColumnInfo, error)
}

var drivers = map[DriverType]Driver{}

// RegisterDriver registers a database driver implementation.
func RegisterDriver(dt DriverType, d Driver) {
	drivers[dt] = d
}

// GetDriver returns the registered driver for the given type.
func GetDriver(dt DriverType) (Driver, error) {
	d, ok := drivers[dt]
	if !ok {
		return nil, fmt.Errorf("unsupported driver: %s", dt)
	}
	return d, nil
}

// BuildDSN creates a DSN string from connection parameters.
func BuildDSN(params ConnectionParams) (string, error) {
	switch params.Driver {
	case DriverSQLite:
		path := params.SQLitePath
		if path == "" {
			path = params.Database
		}
		if path == "" {
			return "", fmt.Errorf("sqlite requires a database file path")
		}
		return path, nil
	case DriverMySQL:
		host := params.Host
		if host == "" {
			host = "localhost"
		}
		port := params.Port
		if port == 0 {
			port = 3306
		}
		dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?parseTime=true&charset=utf8mb4",
			params.User, params.Password, host, port, params.Database)
		if params.SSLMode == "disable" || params.SSLMode == "" {
			dsn += "&tls=skip-verify"
		}
		return dsn, nil
	case DriverPostgres:
		host := params.Host
		if host == "" {
			host = "localhost"
		}
		port := params.Port
		if port == 0 {
			port = 5432
		}
		parts := []string{
			fmt.Sprintf("host=%s", host),
			fmt.Sprintf("port=%d", port),
			fmt.Sprintf("dbname=%s", params.Database),
		}
		if params.User != "" {
			parts = append(parts, fmt.Sprintf("user=%s", params.User))
		}
		if params.Password != "" {
			parts = append(parts, fmt.Sprintf("password=%s", params.Password))
		}
		sslmode := params.SSLMode
		if sslmode == "" {
			sslmode = "disable"
		}
		parts = append(parts, fmt.Sprintf("sslmode=%s", sslmode))
		return strings.Join(parts, " "), nil
	default:
		return "", fmt.Errorf("unsupported driver: %s", params.Driver)
	}
}

// ExecuteQuery runs a SQL statement and returns structured results.
func ExecuteQuery(db *sql.DB, query string) *QueryResult {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), QueryTimeout)
	defer cancel()

	// Detect if this is a SELECT-like query (returns rows) vs mutation.
	trimmed := strings.TrimSpace(strings.ToUpper(query))
	isSelect := strings.HasPrefix(trimmed, "SELECT") ||
		strings.HasPrefix(trimmed, "SHOW") ||
		strings.HasPrefix(trimmed, "DESCRIBE") ||
		strings.HasPrefix(trimmed, "EXPLAIN") ||
		strings.HasPrefix(trimmed, "WITH")

	if isSelect {
		return executeSelect(ctx, db, query, start)
	}
	return executeMutation(ctx, db, query, start)
}

func executeSelect(ctx context.Context, db *sql.DB, query string, start time.Time) *QueryResult {
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return &QueryResult{
			Error:        err.Error(),
			Milliseconds: time.Since(start).Milliseconds(),
		}
	}
	defer rows.Close()

	columns, err := rows.ColumnTypes()
	if err != nil {
		return &QueryResult{
			Error:        err.Error(),
			Milliseconds: time.Since(start).Milliseconds(),
		}
	}

	colMeta := make([]ColumnMeta, len(columns))
	for i, col := range columns {
		// Use ScanType to get the Go type name as a fallback
		scanType := col.ScanType()
		dataType := scanType.String()
		// Try to get a more database-specific type if available
		if dataType == "interface {}" {
			dataType = "unknown"
		}
		colMeta[i] = ColumnMeta{
			Name:     col.Name(),
			DataType: dataType,
		}
	}

	var resultRows [][]interface{}
	truncated := false
	for rows.Next() {
		if len(resultRows) >= MaxRows {
			truncated = true
			break
		}
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range values {
			valuePtrs[i] = &values[i]
		}
		if err := rows.Scan(valuePtrs...); err != nil {
			return &QueryResult{
				Error:        fmt.Sprintf("scan error: %v", err),
				Milliseconds: time.Since(start).Milliseconds(),
			}
		}
		// Convert []byte to string for JSON serialization
		for i, v := range values {
			if b, ok := v.([]byte); ok {
				values[i] = string(b)
			}
			if t, ok := v.(time.Time); ok {
				values[i] = t.Format(time.RFC3339)
			}
		}
		resultRows = append(resultRows, values)
	}
	if err := rows.Err(); err != nil {
		return &QueryResult{
			Error:        err.Error(),
			Milliseconds: time.Since(start).Milliseconds(),
		}
	}

	return &QueryResult{
		Columns:      colMeta,
		Rows:         resultRows,
		Milliseconds: time.Since(start).Milliseconds(),
		Truncated:    truncated,
	}
}

func executeMutation(ctx context.Context, db *sql.DB, query string, start time.Time) *QueryResult {
	result, err := db.ExecContext(ctx, query)
	if err != nil {
		return &QueryResult{
			Error:        err.Error(),
			Milliseconds: time.Since(start).Milliseconds(),
		}
	}
	affected, _ := result.RowsAffected()
	return &QueryResult{
		RowsAffected: affected,
		Milliseconds: time.Since(start).Milliseconds(),
	}
}

// StartCleanupLoop periodically closes idle sessions.
func (m *Manager) StartCleanupLoop(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.cleanup()
			}
		}
	}()
}

func (m *Manager) cleanup() {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	for id, s := range m.sessions {
		if now.Sub(s.lastActivity) > SessionIdleTimeout {
			slog.Info("closing idle db session", "id", id, "idle", now.Sub(s.lastActivity))
			s.db.Close()
			delete(m.sessions, id)
		}
	}
}
