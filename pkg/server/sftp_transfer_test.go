package server

// Tests for the generic endpoint-to-endpoint transfer used by the SFTP tile.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"suwu/pkg/auth"
)

func TestSftpTransferSuwuToSuwu(t *testing.T) {
	s := New(&auth.Config{Token: "test-token", AllowedHosts: []string{"localhost"}}, nil, nil, nil, nil, "")
	dir := t.TempDir()
	srcDir := filepath.Join(dir, "src")
	dstDir := filepath.Join(dir, "dst")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(srcDir, "hello.txt")
	if err := os.WriteFile(src, []byte("hi there"), 0o644); err != nil {
		t.Fatal(err)
	}

	post := func(body any) *httptest.ResponseRecorder {
		payload, _ := json.Marshal(body)
		r := httptest.NewRequest(http.MethodPost, "http://localhost/api/sftp/transfer", strings.NewReader(string(payload)))
		r.Header.Set("Authorization", "Bearer test-token")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}

	// Copy the file into dstDir.
	w := post(map[string]any{
		"sourceKind":      "suwu",
		"sourcePath":      src,
		"destinationKind": "suwu",
		"destinationPath": dstDir,
		"overwrite":       false,
	})
	if w.Code != 200 {
		t.Fatalf("HTTP %d: %s", w.Code, w.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(dstDir, "hello.txt"))
	if err != nil || string(got) != "hi there" {
		t.Fatalf("copied content = %q err=%v", got, err)
	}

	// Without overwrite, a second copy fails.
	w = post(map[string]any{
		"sourceKind":      "suwu",
		"sourcePath":      src,
		"destinationKind": "suwu",
		"destinationPath": dstDir,
	})
	if w.Code == 200 {
		t.Fatal("expected an overwrite refusal")
	}

	// Recursive directory copy.
	sub := filepath.Join(srcDir, "nested")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	w = post(map[string]any{
		"sourceKind":      "suwu",
		"sourcePath":      srcDir,
		"destinationKind": "suwu",
		"destinationPath": dstDir,
		"recursive":       true,
		"overwrite":       true,
	})
	if w.Code != 200 {
		t.Fatalf("recursive HTTP %d: %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(dstDir, "src", "nested", "a.txt")); err != nil {
		t.Fatalf("recursive copy missing: %v", err)
	}
}

func TestSftpTransferValidation(t *testing.T) {
	s := New(&auth.Config{Token: "test-token", AllowedHosts: []string{"localhost"}}, nil, nil, nil, nil, "")
	post := func(body any) *httptest.ResponseRecorder {
		payload, _ := json.Marshal(body)
		r := httptest.NewRequest(http.MethodPost, "http://localhost/api/sftp/transfer", strings.NewReader(string(payload)))
		r.Header.Set("Authorization", "Bearer test-token")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}

	// Missing paths.
	if w := post(map[string]any{"sourceKind": "suwu", "destinationKind": "suwu"}); w.Code != http.StatusBadRequest {
		t.Fatalf("missing paths: HTTP %d", w.Code)
	}
	// Unknown endpoint kind.
	if w := post(map[string]any{
		"sourceKind": "wat", "sourcePath": "/a", "destinationKind": "suwu", "destinationPath": "/b",
	}); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown kind: HTTP %d", w.Code)
	}
	// Remote endpoint without a session.
	if w := post(map[string]any{
		"sourceKind": "remote", "sourcePath": "/a", "destinationKind": "suwu", "destinationPath": "/b",
	}); w.Code != http.StatusBadRequest {
		t.Fatalf("missing session: HTTP %d", w.Code)
	}
}
