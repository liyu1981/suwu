package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// getManifest fetches /api/sync/manifest with test auth and decodes it.
func getManifest(t *testing.T, ts *httptest.Server, dir string) (*http.Response, *syncManifestResponse) {
	t.Helper()
	u := ts.URL + "/api/sync/manifest"
	if dir != "" {
		u += "?path=" + url.QueryEscape(dir)
	}
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer testtoken")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var decoded *syncManifestResponse
	if resp.StatusCode == http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		decoded = &syncManifestResponse{}
		if err := json.Unmarshal(raw, decoded); err != nil {
			t.Fatalf("decode manifest: %v", err)
		}
	}
	return resp, decoded
}

func TestSyncManifestListsTree(t *testing.T) {
	ts, _ := testServer(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src", "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "nested", "deep.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("# hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Pin one mtime so the ms conversion is asserted exactly.
	want := time.Date(2024, 5, 1, 12, 30, 45, 123_000_000, time.UTC)
	if err := os.Chtimes(filepath.Join(root, "README.md"), want, want); err != nil {
		t.Fatal(err)
	}

	resp, manifest := getManifest(t, ts, root)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if manifest.Path != filepath.Clean(root) {
		t.Fatalf("path = %q, want %q", manifest.Path, root)
	}
	if manifest.Truncated {
		t.Fatal("small tree must not be truncated")
	}
	if manifest.EntryCount != len(manifest.Entries) {
		t.Fatalf("entryCount = %d, len(entries) = %d", manifest.EntryCount, len(manifest.Entries))
	}

	byRel := map[string]syncManifestEntry{}
	for _, e := range manifest.Entries {
		byRel[e.Rel] = e
	}
	for _, rel := range []string{"src", "src/nested", "src/main.go", "src/nested/deep.txt", "README.md"} {
		if _, ok := byRel[rel]; !ok {
			t.Errorf("missing entry %q (got %v)", rel, relsOf(manifest.Entries))
		}
	}
	if e := byRel["src"]; !e.IsDir {
		t.Error("src must be a directory")
	}
	if e := byRel["src/main.go"]; e.IsDir || e.Size != int64(len("package main")) {
		t.Errorf("src/main.go = %+v", e)
	}
	if e := byRel["README.md"]; e.MtimeMs != want.UnixMilli() {
		t.Errorf("README.md mtimeMs = %d, want %d", e.MtimeMs, want.UnixMilli())
	}
}

func relsOf(entries []syncManifestEntry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Rel
	}
	return out
}

func TestSyncManifestSkipsSymlinks(t *testing.T) {
	ts, _ := testServer(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "real.txt"), []byte("inside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "file-link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "dir-link")); err != nil {
		t.Fatal(err)
	}

	resp, manifest := getManifest(t, ts, root)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	for _, e := range manifest.Entries {
		if strings.HasPrefix(e.Rel, "file-link") || strings.HasPrefix(e.Rel, "dir-link") {
			t.Fatalf("symlink leaked into manifest: %q", e.Rel)
		}
	}
	if manifest.EntryCount != 1 || manifest.Entries[0].Rel != "real.txt" {
		t.Fatalf("entries = %v, want only real.txt", relsOf(manifest.Entries))
	}
}

func TestSyncManifestTruncatesOnDepth(t *testing.T) {
	ts, _ := testServer(t)
	root := t.TempDir()
	// Build a chain deeper than maxSyncDepth: root/lvl/lvl/... with the file
	// sitting maxSyncDepth+3 levels down.
	deep := root
	for i := 0; i < maxSyncDepth+3; i++ {
		deep = filepath.Join(deep, "lvl")
	}
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deep, "too-deep.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "top.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	resp, manifest := getManifest(t, ts, root)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !manifest.Truncated {
		t.Fatal("depth overflow must set truncated")
	}
	for _, e := range manifest.Entries {
		if e.Rel == "too-deep.txt" {
			t.Fatal("entry beyond depth cap must be excluded")
		}
	}
	foundTop := false
	for _, e := range manifest.Entries {
		if e.Rel == "top.txt" {
			foundTop = true
		}
	}
	if !foundTop {
		t.Fatal("entries within the cap must still be listed")
	}
}

func TestSyncManifestTruncatesOnEntryCount(t *testing.T) {
	ts, _ := testServer(t)
	root := t.TempDir()
	for i := 0; i <= maxSyncEntries; i++ {
		if err := os.WriteFile(filepath.Join(root, "f"+itoa(i)), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	resp, manifest := getManifest(t, ts, root)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !manifest.Truncated {
		t.Fatal("entry overflow must set truncated")
	}
	if manifest.EntryCount > maxSyncEntries {
		t.Fatalf("entryCount = %d exceeds cap %d", manifest.EntryCount, maxSyncEntries)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [8]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(b[pos:])
}

func TestSyncManifestNotFound(t *testing.T) {
	ts, _ := testServer(t)
	resp, _ := getManifest(t, ts, filepath.Join(t.TempDir(), "missing"))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

func TestSyncManifestRejectsFile(t *testing.T) {
	ts, _ := testServer(t)
	file := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	resp, _ := getManifest(t, ts, file)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestSyncManifestRequiresPath(t *testing.T) {
	ts, _ := testServer(t)
	resp, _ := getManifest(t, ts, "")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestSyncManifestMethodNotAllowed(t *testing.T) {
	ts, _ := testServer(t)
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/sync/manifest?path=/", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer testtoken")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", resp.StatusCode)
	}
}

func TestSyncManifestRequiresAuth(t *testing.T) {
	ts, _ := testServer(t)
	resp, err := http.Get(ts.URL + "/api/sync/manifest?path=/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("unauthenticated manifest must fail, got 200")
	}
}
