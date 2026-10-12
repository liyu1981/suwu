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

// A mutation has no result set, but the API must still return empty arrays for
// columns and rows so clients can read .length without a null check. This is
// the UPDATE/INSERT/DELETE/SET path that previously crashed the DB Browser with
// "Cannot read properties of null (reading 'length')".
func TestExecuteQueryMutationContract(t *testing.T) {
	d, err := (&SQLiteDriver{}).Open(ConnectionParams{Driver: DriverSQLite, Database: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })

	if _, err := d.Exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO users (email, role) VALUES ('liyu1981au@gmail.com', 'admin'), ('other@example.com', 'admin')`); err != nil {
		t.Fatal(err)
	}

	result := ExecuteQuery(d, "UPDATE users SET role = 'user' WHERE lower(email) = 'liyu1981au@gmail.com'")
	if result.Error != "" {
		t.Fatal(result.Error)
	}
	if result.Columns == nil || result.Rows == nil {
		t.Fatalf("mutation must return non-nil columns and rows: %+v", result)
	}
	if len(result.Columns) != 0 || len(result.Rows) != 0 {
		t.Fatalf("mutation must return empty columns and rows: %+v", result)
	}
	if result.RowsAffected != 1 {
		t.Fatalf("rowsAffected = %d, want 1", result.RowsAffected)
	}

	// INSERT ... RETURNING routes through QueryContext and comes back as rows.
	result = ExecuteQuery(d, "INSERT INTO users (email, role) VALUES ('third@example.com', 'user') RETURNING id")
	if result.Error != "" {
		t.Fatal(result.Error)
	}
	if len(result.Columns) != 1 || len(result.Rows) != 1 {
		t.Fatalf("INSERT ... RETURNING must return a result set: %+v", result)
	}

	// PRAGMA is a SQLite session statement that returns rows.
	result = ExecuteQuery(d, "PRAGMA table_info(users)")
	if result.Error != "" {
		t.Fatal(result.Error)
	}
	if len(result.Columns) == 0 || len(result.Rows) == 0 {
		t.Fatalf("PRAGMA must return rows: %+v", result)
	}
}

func TestStatementReturnsRows(t *testing.T) {
	cases := []struct {
		sql  string
		want bool
	}{
		{"SELECT 1", true},
		{"  select 1", true},
		{"-- comment\nSELECT 1", true},
		{"/* block */ PRAGMA table_info(x)", true},
		{"SHOW TABLES", true},
		{"DESC users", true},
		{"EXPLAIN SELECT 1", true},
		{"WITH x AS (SELECT 1) SELECT * FROM x", true},
		{"VALUES (1), (2)", true},
		{"UPDATE users SET role = 'user'", false},
		{"INSERT INTO t VALUES (1)", false},
		{"DELETE FROM t", false},
		{"SET search_path TO public", false},
		{"BEGIN", false},
		{"INSERT INTO t VALUES (1) RETURNING id", true},
		{"UPDATE t SET returning_rate = 1", false},
	}
	for _, tc := range cases {
		if got := statementReturnsRows(tc.sql); got != tc.want {
			t.Errorf("statementReturnsRows(%q) = %v, want %v", tc.sql, got, tc.want)
		}
	}
}
