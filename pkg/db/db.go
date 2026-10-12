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

	if statementReturnsRows(query) {
		return normalizeResult(executeSelect(ctx, db, query, start))
	}
	return normalizeResult(executeMutation(ctx, db, query, start))
}

// rowReturningStatements are the leading SQL keywords whose statements produce
// a result set. Everything else runs through ExecContext, which is what exposes
// RowsAffected and what drivers expect for mutations and session commands
// (SET, BEGIN/COMMIT, most DDL).
var rowReturningStatements = map[string]bool{
	"SELECT":   true,
	"SHOW":     true,
	"DESCRIBE": true,
	"DESC":     true,
	"EXPLAIN":  true,
	"WITH":     true, // CTEs, including data-modifying WITH ... RETURNING
	"PRAGMA":   true, // SQLite pragmas return a result set
	"VALUES":   true,
	"TABLE":    true, // PostgreSQL shorthand for SELECT * FROM
}

// statementReturnsRows reports whether a statement should run with QueryContext
// (result set) rather than ExecContext (rows affected).
func statementReturnsRows(query string) bool {
	stmt := stripLeadingComments(query)
	if rowReturningStatements[firstKeyword(stmt)] {
		return true
	}
	// INSERT/UPDATE/DELETE ... RETURNING produces rows on PostgreSQL and
	// SQLite; running it through Exec would silently discard them.
	return containsKeyword(stmt, "RETURNING")
}

// stripLeadingComments removes leading whitespace, `-- line` comments and
// `/* block */` comments so the first keyword is not hidden behind one.
func stripLeadingComments(query string) string {
	s := query
	for {
		s = strings.TrimLeft(s, " \t\r\n")
		switch {
		case strings.HasPrefix(s, "--"):
			i := strings.IndexByte(s, '\n')
			if i < 0 {
				return ""
			}
			s = s[i+1:]
		case strings.HasPrefix(s, "/*"):
			i := strings.Index(s, "*/")
			if i < 0 {
				return ""
			}
			s = s[i+2:]
		default:
			return s
		}
	}
}

// firstKeyword returns the first whitespace-delimited token, uppercased and cut
// at the first separator. Empty when the statement has none.
func firstKeyword(stmt string) string {
	stmt = strings.TrimLeft(stmt, " \t\r\n")
	end := strings.IndexFunc(stmt, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\r' || r == '\n' || r == ';' || r == '('
	})
	if end < 0 {
		end = len(stmt)
	}
	return strings.ToUpper(strings.TrimSpace(stmt[:end]))
}

// containsKeyword reports whether word appears in stmt as a standalone
// identifier, so a column named "returning_rate" does not match RETURNING.
func containsKeyword(stmt, word string) bool {
	upper := strings.ToUpper(stmt)
	for i := 0; i+len(word) <= len(upper); {
		rel := strings.Index(upper[i:], word)
		if rel < 0 {
			return false
		}
		start := i + rel
		end := start + len(word)
		beforeOK := start == 0 || !isIdentByte(upper[start-1])
		afterOK := end == len(upper) || !isIdentByte(upper[end])
		if beforeOK && afterOK {
			return true
		}
		i = start + 1
	}
	return false
}

func isIdentByte(b byte) bool {
	return b == '_' || (b >= '0' && b <= '9') || (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')
}

// normalizeResult enforces the JSON contract that columns and rows are always
// arrays, never null. A mutation has no result set, and Go marshals a nil slice
// as null, which broke every client that assumed `.rows.length`.
func normalizeResult(r *QueryResult) *QueryResult {
	if r.Columns == nil {
		r.Columns = []ColumnMeta{}
	}
	if r.Rows == nil {
		r.Rows = [][]interface{}{}
	}
	return r
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
		dataType := "unknown"
		if scanType != nil {
			dataType = scanType.String()
		}
		// Try to get a more database-specific type if available
		if dataType == "interface {}" {
			dataType = "unknown"
		}
		colMeta[i] = ColumnMeta{
			Name:     col.Name(),
			DataType: dataType,
		}
	}

	resultRows := make([][]interface{}, 0)
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
	// Columns and Rows stay nil here; normalizeResult fills them with empty
	// arrays so the JSON payload never carries null for a mutation.
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
