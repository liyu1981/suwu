package db

import "testing"

func TestExecuteQueryNullAndEmptyResults(t *testing.T) {
	d, err := (&SQLiteDriver{}).Open(ConnectionParams{Driver: DriverSQLite, Database: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })

	result := ExecuteQuery(d, "SELECT NULL AS value")
	if result.Error != "" {
		t.Fatal(result.Error)
	}
	if len(result.Columns) != 1 || result.Columns[0].DataType != "unknown" {
		t.Fatalf("columns = %+v", result.Columns)
	}
	if len(result.Rows) != 1 || result.Rows[0][0] != nil {
		t.Fatalf("rows = %+v", result.Rows)
	}

	result = ExecuteQuery(d, "SELECT 1 AS value WHERE 0")
	if result.Error != "" {
		t.Fatal(result.Error)
	}
	if result.Rows == nil || len(result.Rows) != 0 {
		t.Fatalf("empty rows must be a non-nil array: %+v", result.Rows)
	}
}
