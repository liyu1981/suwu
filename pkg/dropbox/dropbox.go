// Package dropbox manages a file dropbox: listing, uploading, deleting,
// and space-management for files stored in $SUWU_VAR/dropbox.
package dropbox

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Entry represents a single file in the dropbox.
type Entry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
}

// SpaceInfo reports total space used and file count.
type SpaceInfo struct {
	Used  int64 `json:"used"`
	Count int  `json:"count"`
}

// Dir resolves the dropbox directory under the given data root,
// creating it if it doesn't exist.
func Dir(dataRoot string) (string, error) {
	dir := filepath.Join(dataRoot, "dropbox")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create dropbox dir: %w", err)
	}
	return dir, nil
}

// List returns all files in the dropbox directory, sorted by modification
// time descending (newest first).
func List(dir string) ([]Entry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read dropbox: %w", err)
	}

	result := make([]Entry, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		fullPath := filepath.Join(dir, e.Name())
		result = append(result, Entry{
			Name:    e.Name(),
			Path:    fullPath,
			Size:    fi.Size(),
			ModTime: fi.ModTime().UTC().Format(time.RFC3339),
		})
	}

	// Sort newest first.
	sort.Slice(result, func(i, j int) bool {
		return result[i].ModTime > result[j].ModTime
	})

	return result, nil
}

// Upload writes a file to the dropbox directory. If a file with the same
// name exists, a numeric suffix is appended (e.g. file_2.txt).
// Returns the final file path.
func Upload(dir, filename string, r io.Reader) (string, error) {
	// Sanitize filename.
	filename = filepath.Base(filename)
	if filename == "." || filename == ".." {
		return "", fmt.Errorf("invalid filename")
	}

	// Deduplicate name.
	dest := filepath.Join(dir, filename)
	if _, err := os.Stat(dest); err == nil {
		ext := filepath.Ext(filename)
		base := strings.TrimSuffix(filename, ext)
		for i := 2; ; i++ {
			candidate := fmt.Sprintf("%s_%d%s", base, i, ext)
			candidatePath := filepath.Join(dir, candidate)
			if _, err := os.Stat(candidatePath); os.IsNotExist(err) {
				dest = candidatePath
				break
			}
		}
	}

	f, err := os.Create(dest)
	if err != nil {
		return "", fmt.Errorf("create file: %w", err)
	}
	defer f.Close()

	written, err := io.Copy(f, r)
	if err != nil {
		os.Remove(dest)
		return "", fmt.Errorf("write file: %w", err)
	}

	slog.Debug("dropbox upload", "path", dest, "size", written)
	return dest, nil
}

// Delete removes a single file from the dropbox directory.
func Delete(dir, filename string) error {
	// Sanitize: no path separators allowed.
	if strings.Contains(filename, "/") || strings.Contains(filename, "\\") {
		return fmt.Errorf("invalid filename")
	}
	path := filepath.Join(dir, filename)
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("delete: %w", err)
	}
	slog.Debug("dropbox delete", "path", path)
	return nil
}

// SpaceUsed calculates total bytes and file count in the dropbox directory.
func SpaceUsed(dir string) (SpaceInfo, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return SpaceInfo{}, fmt.Errorf("read dropbox: %w", err)
	}

	var total int64
	count := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		total += fi.Size()
		count++
	}

	return SpaceInfo{Used: total, Count: count}, nil
}

// Cleanup deletes the oldest files until total space is at or below
// targetBytes. Returns the number of files deleted.
func Cleanup(dir string, targetBytes int64) (int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, fmt.Errorf("read dropbox: %w", err)
	}

	type fileInfo struct {
		name    string
		modTime time.Time
		size    int64
	}

	var files []fileInfo
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, fileInfo{
			name:    e.Name(),
			modTime: fi.ModTime(),
			size:    fi.Size(),
		})
	}

	// Sort oldest first.
	sort.Slice(files, func(i, j int) bool {
		return files[i].modTime.Before(files[j].modTime)
	})

	// Calculate current total.
	var total int64
	for _, f := range files {
		total += f.size
	}

	// Delete oldest until under target.
	deleted := 0
	for _, f := range files {
		if total <= targetBytes {
			break
		}
		path := filepath.Join(dir, f.name)
		if err := os.Remove(path); err != nil {
			slog.Error("dropbox cleanup delete failed", "path", path, "error", err)
			continue
		}
		total -= f.size
		deleted++
		slog.Debug("dropbox cleanup deleted", "path", path, "size", f.size)
	}

	return deleted, nil
}
