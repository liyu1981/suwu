package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func postWrite(t *testing.T, ts *httptest.Server, payload map[string]any) (*http.Response, map[string]any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/file/write", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var decoded map[string]any
	raw, _ := io.ReadAll(resp.Body)
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &decoded)
	}
	return resp, decoded
}

func TestFileGetExposesMtimeMs(t *testing.T) {
	ts, _ := testServer(t)
	path := filepath.Join(t.TempDir(), "mtime.txt")
	if err := os.WriteFile(path, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/file?path="+url.QueryEscape(path), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer testtoken")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	want := strconv.FormatInt(info.ModTime().UnixMilli(), 10)
	if got := resp.Header.Get("X-Suwu-Mtime-Ms"); got != want {
		t.Fatalf("X-Suwu-Mtime-Ms = %q, want %q", got, want)
	}
}

func TestFileWriteCreate(t *testing.T) {
	ts, _ := testServer(t)
	path := filepath.Join(t.TempDir(), "new.txt")

	resp, body := postWrite(t, ts, map[string]any{"path": path, "content": "hello\n"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%v)", resp.StatusCode, body)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello\n" {
		t.Fatalf("content = %q, want %q", got, "hello\n")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("mode = %o, want 644", info.Mode().Perm())
	}
}

func TestFileWriteUpdatePreservesMode(t *testing.T) {
	ts, _ := testServer(t)
	path := filepath.Join(t.TempDir(), "script.sh")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)

	resp, body := postWrite(t, ts, map[string]any{
		"path":    path,
		"content": "new",
		"mtimeMs": float64(info.ModTime().UnixMilli()),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%v)", resp.StatusCode, body)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "new" {
		t.Fatalf("content = %q, want %q", got, "new")
	}
	info, _ = os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o, want 600 (preserved)", info.Mode().Perm())
	}
}

func TestFileWriteConflictOnStaleMtime(t *testing.T) {
	ts, _ := testServer(t)
	path := filepath.Join(t.TempDir(), "conflict.txt")
	if err := os.WriteFile(path, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)

	resp, body := postWrite(t, ts, map[string]any{
		"path":    path,
		"content": "v2",
		"mtimeMs": float64(info.ModTime().UnixMilli() - 1000),
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%v)", resp.StatusCode, body)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "v1" {
		t.Fatalf("conflict must not modify the file, got %q", got)
	}
}

func TestFileWriteCreateExistingConflict(t *testing.T) {
	ts, _ := testServer(t)
	path := filepath.Join(t.TempDir(), "exists.txt")
	if err := os.WriteFile(path, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}

	resp, body := postWrite(t, ts, map[string]any{"path": path, "content": "clobber"})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%v)", resp.StatusCode, body)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "keep" {
		t.Fatalf("content = %q, want unchanged", got)
	}
}

func TestFileWriteUpdateMissingConflict(t *testing.T) {
	ts, _ := testServer(t)
	path := filepath.Join(t.TempDir(), "gone.txt")

	resp, body := postWrite(t, ts, map[string]any{
		"path": path, "content": "x", "mtimeMs": float64(1000),
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%v)", resp.StatusCode, body)
	}
}

func TestFileWriteRejectsDirectory(t *testing.T) {
	ts, _ := testServer(t)
	dir := t.TempDir()
	info, _ := os.Stat(dir)

	resp, body := postWrite(t, ts, map[string]any{
		"path": dir, "content": "x", "mtimeMs": float64(info.ModTime().UnixMilli()),
	})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%v)", resp.StatusCode, body)
	}
}

func TestFileWriteRejectsMissingParent(t *testing.T) {
	ts, _ := testServer(t)
	path := filepath.Join(t.TempDir(), "nope", "file.txt")

	resp, body := postWrite(t, ts, map[string]any{"path": path, "content": "x"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%v)", resp.StatusCode, body)
	}
}

func TestFileWriteMethodNotAllowed(t *testing.T) {
	ts, _ := testServer(t)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/file/write", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", resp.StatusCode)
	}
}

func TestFileWriteRequiresAuth(t *testing.T) {
	ts, _ := testServer(t)
	path := filepath.Join(t.TempDir(), "auth.txt")
	body, _ := json.Marshal(map[string]any{"path": path, "content": "x"})
	resp, err := http.Post(ts.URL+"/api/file/write", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("unauthenticated write must fail, got 200")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file must not be created without auth")
	}
}

func TestFileWriteFollowsSymlink(t *testing.T) {
	ts, _ := testServer(t)
	dir := t.TempDir()
	target := filepath.Join(dir, "target.txt")
	link := filepath.Join(dir, "link.txt")
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	info, _ := os.Stat(link)

	resp, body := postWrite(t, ts, map[string]any{
		"path": link, "content": "new", "mtimeMs": float64(info.ModTime().UnixMilli()),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%v)", resp.StatusCode, body)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "new" {
		t.Fatalf("symlink target content = %q, want new", got)
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("symlink was replaced by a regular file")
	}
}
