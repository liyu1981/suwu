package db

import (
	"context"
	"database/sql"
	"fmt"

	_ "github.com/go-sql-driver/mysql"
)

func init() {
	RegisterDriver(DriverMySQL, &MySQLDriver{})
}

// MySQLDriver implements the Driver interface for MySQL.
type MySQLDriver struct{}

func (d *MySQLDriver) Open(params ConnectionParams) (*sql.DB, error) {
	dsn, err := BuildDSN(params)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("mysql open: %w", err)
	}
	db.SetMaxOpenConns(10)
	return db, nil
}

func (d *MySQLDriver) ListTables(ctx context.Context, db *sql.DB) ([]TableInfo, error) {
	query := `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`
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

func (d *MySQLDriver) DescribeTable(ctx context.Context, db *sql.DB, tableName string) ([]ColumnInfo, error) {
	query := fmt.Sprintf(`
		SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
		FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '%s'
		ORDER BY ORDINAL_POSITION
	`, tableName)
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var columns []ColumnInfo
	for rows.Next() {
		var col ColumnInfo
		var nullable, key string
		var dfltValue sql.NullString
		if err := rows.Scan(&col.Name, &col.DataType, &nullable, &dfltValue, &key); err != nil {
			return nil, err
		}
		col.Nullable = nullable == "YES"
		col.IsPrimaryKey = key == "PRI"
		if dfltValue.Valid {
			col.DefaultValue = &dfltValue.String
		}
		columns = append(columns, col)
	}
	return columns, rows.Err()
}
