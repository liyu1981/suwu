package db

import (
	"context"
	"database/sql"
	"fmt"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func init() {
	RegisterDriver(DriverPostgres, &PostgresDriver{})
}

// PostgresDriver implements the Driver interface for PostgreSQL.
type PostgresDriver struct{}

func (d *PostgresDriver) Open(params ConnectionParams) (*sql.DB, error) {
	dsn, err := BuildDSN(params)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("postgres open: %w", err)
	}
	db.SetMaxOpenConns(10)
	return db, nil
}

func (d *PostgresDriver) ListTables(ctx context.Context, db *sql.DB) ([]TableInfo, error) {
	query := `
		SELECT table_name, table_type
		FROM information_schema.tables
		WHERE table_schema = 'public'
		ORDER BY table_name
	`
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

func (d *PostgresDriver) DescribeTable(ctx context.Context, db *sql.DB, tableName string) ([]ColumnInfo, error) {
	query := fmt.Sprintf(`
		SELECT 
			c.column_name,
			c.data_type,
			c.is_nullable,
			c.column_default,
			CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END as is_primary_key
		FROM information_schema.columns c
		LEFT JOIN information_schema.key_column_usage kcu
			ON c.table_name = kcu.table_name 
			AND c.column_name = kcu.column_name
			AND c.table_schema = kcu.table_schema
		LEFT JOIN information_schema.table_constraints tc
			ON kcu.constraint_name = tc.constraint_name
			AND tc.constraint_type = 'PRIMARY KEY'
		WHERE c.table_schema = 'public' AND c.table_name = '%s'
		ORDER BY c.ordinal_position
	`, tableName)
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var columns []ColumnInfo
	for rows.Next() {
		var col ColumnInfo
		var nullable string
		var dfltValue sql.NullString
		if err := rows.Scan(&col.Name, &col.DataType, &nullable, &dfltValue, &col.IsPrimaryKey); err != nil {
			return nil, err
		}
		col.Nullable = nullable == "YES"
		if dfltValue.Valid {
			col.DefaultValue = &dfltValue.String
		}
		columns = append(columns, col)
	}
	return columns, rows.Err()
}
