package db

import (
	"context"
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

func init() {
	RegisterDriver(DriverSQLite, &SQLiteDriver{})
}

// SQLiteDriver implements the Driver interface for SQLite.
type SQLiteDriver struct{}

func (d *SQLiteDriver) Open(params ConnectionParams) (*sql.DB, error) {
	dsn, err := BuildDSN(params)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("sqlite open: %w", err)
	}
	// SQLite optimizations
	db.SetMaxOpenConns(1) // SQLite doesn't support concurrent writes
	return db, nil
}

func (d *SQLiteDriver) ListTables(ctx context.Context, db *sql.DB) ([]TableInfo, error) {
	query := `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`
	return d.listFromQuery(ctx, db, query)
}

func (d *SQLiteDriver) listFromQuery(ctx context.Context, db *sql.DB, query string) ([]TableInfo, error) {
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tables []TableInfo
	for rows.Next() {
		var t TableInfo
		if err := rows.Scan(&t.Name, &t.Type); err != nil {
			return nil, err
		}
		tables = append(tables, t)
	}
	return tables, rows.Err()
}

func (d *SQLiteDriver) DescribeTable(ctx context.Context, db *sql.DB, tableName string) ([]ColumnInfo, error) {
	query := fmt.Sprintf(`PRAGMA table_info(%s)`, tableName)
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var columns []ColumnInfo
	for rows.Next() {
		var cid int
		var name, dataType string
		var notNull int
		var dfltValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &dataType, &notNull, &dfltValue, &pk); err != nil {
			return nil, err
		}
		col := ColumnInfo{
			Name:         name,
			DataType:     dataType,
			Nullable:     notNull == 0,
			IsPrimaryKey: pk > 0,
		}
		if dfltValue.Valid {
			col.DefaultValue = &dfltValue.String
		}
		columns = append(columns, col)
	}
	return columns, rows.Err()
}
