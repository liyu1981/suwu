package db

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestConnectDoesNotLogDSN(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	m := NewManager()
	t.Cleanup(m.CloseAll)
	// SQLite ignores the password, but logging must not depend on its length
	// or include the connection string for any driver.
	s, err := m.Connect(ConnectionParams{
		Driver: DriverSQLite, Database: ":memory:",
		Password: "a-password-longer-than-the-dsn",
	})
	if err != nil {
		t.Fatal(err)
	}
	if s.DB() == nil {
		t.Fatal("missing database connection")
	}
	output := logs.String()
	for _, forbidden := range []string{"dsn=", ":memory:", "a-password-longer-than-the-dsn"} {
		if strings.Contains(output, forbidden) {
			t.Errorf("connection log contains %q", forbidden)
		}
	}
	if !strings.Contains(output, "driver=sqlite") {
		t.Error("connection log is missing driver metadata")
	}
}

func TestConnectRejectsInvalidParams(t *testing.T) {
	m := NewManager()
	t.Cleanup(m.CloseAll)
	for _, params := range []ConnectionParams{
		{Driver: DriverSQLite},
		{Driver: "unknown"},
	} {
		if _, err := m.Connect(params); err == nil {
			t.Errorf("Connect(%+v) succeeded", params)
		}
	}
	if len(m.ListSessions()) != 0 {
		t.Fatal("invalid connections created sessions")
	}
}
