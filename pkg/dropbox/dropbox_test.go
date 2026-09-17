package dropbox

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestUploadDeduplicatesNames(t *testing.T) {
	dir := t.TempDir()
	for i, name := range []string{"file.txt", "file_2.txt", "file_3.txt"} {
		content := fmt.Sprintf("upload %d", i)
		path, err := Upload(dir, "file.txt", strings.NewReader(content))
		if err != nil {
			t.Fatal(err)
		}
		if filepath.Base(path) != name {
			t.Fatalf("name = %q, want %q", filepath.Base(path), name)
		}
		assertContent(t, path, content)
	}
}

func TestConcurrentUploadsPreserveContents(t *testing.T) {
	dir := t.TempDir()
	const count = 32
	var wg sync.WaitGroup
	start := make(chan struct{})
	paths := make([]string, count)
	for i := range count {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			content := fmt.Sprintf("upload %d", i)
			path, err := Upload(dir, "file.txt", strings.NewReader(content))
			if err != nil {
				t.Error(err)
				return
			}
			paths[i] = path
		}()
	}
	close(start)
	wg.Wait()

	seen := make(map[string]bool)
	for i, path := range paths {
		if path == "" {
			continue
		}
		if seen[path] {
			t.Errorf("uploads share path %q", path)
		}
		seen[path] = true
		assertContent(t, path, fmt.Sprintf("upload %d", i))
	}
}

func TestUploadRemovesPartialFile(t *testing.T) {
	dir := t.TempDir()
	wantErr := errors.New("read failed")
	r := io.MultiReader(strings.NewReader("partial"), failingReader{wantErr})
	if _, err := Upload(dir, "file.txt", r); !errors.Is(err, wantErr) {
		t.Fatalf("error = %v, want %v", err, wantErr)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("partial upload left %d files", len(entries))
	}
}

func TestUploadMissingDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "missing")
	if _, err := Upload(dir, "file.txt", strings.NewReader("data")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("error = %v, want missing directory", err)
	}
}

type failingReader struct{ err error }

func (r failingReader) Read([]byte) (int, error) { return 0, r.err }

func assertContent(t *testing.T, path, want string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != want {
		t.Errorf("%s content = %q, want %q", path, data, want)
	}
}
