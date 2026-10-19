package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestSftpRoutes(t *testing.T) {
	ts, _, _ := extTestServerDir(t, nil)

	get := func(path string) (int, string) {
		t.Helper()
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}

	t.Run("requires auth", func(t *testing.T) {
		if status, _ := get("/api/sftp/sessions"); status == http.StatusOK {
			t.Fatal("expected a 401 without a token")
		}
	})

	t.Run("sessions starts empty", func(t *testing.T) {
		status, body := get("/api/sftp/sessions?token=testtoken")
		if status != http.StatusOK {
			t.Fatalf("status %d: %s", status, body)
		}
		var out struct {
			Sessions []any `json:"sessions"`
		}
		if err := json.Unmarshal([]byte(body), &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Sessions) != 0 {
			t.Fatalf("expected no sessions, got %s", body)
		}
	})

	t.Run("list requires a session", func(t *testing.T) {
		if status, _ := get("/api/sftp/list?token=testtoken"); status != http.StatusBadRequest {
			t.Fatalf("status %d, want 400", status)
		}
	})

	t.Run("list rejects an unknown session", func(t *testing.T) {
		if status, _ := get("/api/sftp/list?session=nope&token=testtoken"); status != http.StatusNotFound {
			t.Fatalf("status %d, want 404", status)
		}
	})
}

func TestCleanUploadRel(t *testing.T) {
	ok := map[string]string{
		"file.txt":         "file.txt",
		"a/b/c.txt":        "a/b/c.txt",
		"a/../b.txt":       "b.txt",
		"./x":              "x",
		"/abs/path.txt":    "abs/path.txt",
		"../../etc/passwd": "etc/passwd",
		"a\\b":             "a/b",
	}
	for in, want := range ok {
		got, err := cleanUploadRel(in)
		if err != nil {
			t.Errorf("cleanUploadRel(%q) error: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("cleanUploadRel(%q) = %q, want %q", in, got, want)
		}
	}
	for _, bad := range []string{"", "   ", ".", "/", ".."} {
		if got, err := cleanUploadRel(bad); err == nil {
			t.Errorf("expected %q to be rejected, got %q", bad, got)
		}
	}
	// A traversal never escapes the destination.
	if got, _ := cleanUploadRel("../../../../etc/passwd"); strings.HasPrefix(got, "..") {
		t.Fatalf("traversal escaped: %q", got)
	}
}
