package main

import (
	"os"
	"strings"
	"testing"

	"suwu/pkg/backup"
)

// TestReportBackupCapturesOutput drives reportBackup against a temp data dir
// holding a populated slot and checks the one-line summary it prints. A missing
// or unreadable backup must stay silent (reportBackup must never fail an
// upgrade).
func TestReportBackupCapturesOutput(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SUWU_VAR", dir)

	// No backup at all: reportBackup is quiet.
	if out := captureStdout(t, reportBackup); out != "" {
		t.Fatalf("reportBackup with no backups printed %q, want nothing", out)
	}

	// Populate one slot directly through the store.
	store, err := backup.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	slot := "abcdefghijklmnopqrstuvwxyz"
	if _, err := store.Put(slot, nil, strings.NewReader(testContainer())); err != nil {
		t.Fatal(err)
	}

	out := captureStdout(t, reportBackup)
	if !strings.Contains(out, "Backup:") {
		t.Fatalf("reportBackup printed %q, want a Backup: line", out)
	}
	if !strings.Contains(out, slot[:4]) && !strings.Contains(out, "1 slot") {
		t.Errorf("reportBackup output %q should mention one slot", out)
	}
}

// testContainer builds a minimally valid backup container prologue for the
// store to accept.
func testContainer() string {
	header := `{"v":1,"gen":1}`
	return "SUWUBK1" + string([]byte{0, 0, 0, byte(len(header))}) + header + "ciphertext"
}

// captureStdout redirects os.Stdout around fn and returns what it printed.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	orig := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	fn()
	_ = w.Close()
	os.Stdout = orig
	buf := make([]byte, 0, 256)
	tmp := make([]byte, 256)
	for {
		n, err := r.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil {
			break
		}
	}
	return string(buf)
}
