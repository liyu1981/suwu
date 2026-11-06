package extension

// Static asset sources: suwu.static may point at a directory (the classic
// layout, shipped file by file) or at a zip archive holding that tree.
//
// A built extension is hundreds of small files — a Vite bundle plus its fonts —
// and shipping them as one archive keeps the repository, the install payload
// and the GitHub catalog to a single blob per extension. Serving is unchanged
// from the client's point of view: the same /gqjs/static/<id>/<path> URLs are
// answered from the archive's entries.

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// StaticKind is what a declared suwu.static points at.
type StaticKind int

const (
	// StaticNone means the extension serves no static assets.
	StaticNone StaticKind = iota
	// StaticDir is a directory tree inside the extension directory.
	StaticDir
	// StaticZip is a zip archive (any name ending in .zip) inside it.
	StaticZip
)

// String is used in error messages and logs.
func (k StaticKind) String() string {
	switch k {
	case StaticDir:
		return "directory"
	case StaticZip:
		return "zip archive"
	}
	return "none"
}

// StaticArchiveExt is the suffix that makes a declared static path an archive.
const StaticArchiveExt = ".zip"

// StaticKind reports what suwu.static points at.
func (e Extension) StaticKind() StaticKind {
	switch {
	case e.Static == "":
		return StaticNone
	case isArchivePath(e.Static):
		return StaticZip
	}
	return StaticDir
}

// isArchivePath reports whether a declared static path names a zip archive.
func isArchivePath(p string) bool {
	return strings.HasSuffix(strings.ToLower(p), StaticArchiveExt)
}

// StaticAsset is one resolved static file: its bytes plus the metadata the
// static handler needs to answer conditional requests.
type StaticAsset struct {
	// Name is the requested relative path, for the Content-Type and logs.
	Name string
	// Data is the file's contents. Static files are small by construction (the
	// server caps them), so they are read whole; that also lets the handler
	// count lines and compress once.
	Data []byte
	// ModTime is the archive's timestamp for a zip source, the file's own for a
	// directory. It backs Last-Modified, so a rebuilt archive invalidates.
	ModTime time.Time
}

// StaticAsset resolves one static file: from the directory with the usual
// symlink-escape checks, or from the archive's entries.
//
// rel is untrusted (it comes off the request), so every segment is validated
// before anything is joined or looked up — a zip entry name is no more
// trustworthy than a path segment, and the same rules apply to both.
func (e Extension) StaticAsset(rel string, maxBytes int64) (StaticAsset, error) {
	if e.Static == "" {
		return StaticAsset{}, fmt.Errorf("extension has no static source")
	}
	if err := validateRelSegments(rel); err != nil {
		return StaticAsset{}, err
	}
	if e.StaticKind() == StaticZip {
		return e.staticFromZip(rel, maxBytes)
	}
	return e.staticFromDir(rel, maxBytes)
}

// staticFromDir reads one file out of the declared directory.
func (e Extension) staticFromDir(rel string, maxBytes int64) (StaticAsset, error) {
	p, err := e.StaticPath(rel)
	if err != nil {
		return StaticAsset{}, err
	}
	st, err := os.Stat(p)
	if err != nil || !st.Mode().IsRegular() {
		return StaticAsset{}, fmt.Errorf("not found")
	}
	if maxBytes > 0 && st.Size() > maxBytes {
		return StaticAsset{}, ErrStaticTooLarge
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return StaticAsset{}, err
	}
	return StaticAsset{Name: rel, Data: data, ModTime: st.ModTime()}, nil
}

// ErrStaticTooLarge is returned when one static file exceeds the caller's cap.
var ErrStaticTooLarge = fmt.Errorf("static file too large")

// staticFromZip reads one entry out of the declared archive.
//
// The archive is opened per request: the central directory of a bundle-sized
// zip parses in microseconds, and re-opening means a rebuild on disk is picked
// up without a cache to invalidate.
func (e Extension) staticFromZip(rel string, maxBytes int64) (StaticAsset, error) {
	path := filepath.Join(e.Dir, e.Static)
	if err := ensureWithin(e.Dir, path); err != nil {
		return StaticAsset{}, fmt.Errorf("static archive: %w", err)
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		return StaticAsset{}, fmt.Errorf("open static archive: %w", err)
	}
	defer func() { _ = zr.Close() }()

	entry, err := findZipEntry(zr.File, rel)
	if err != nil {
		return StaticAsset{}, err
	}
	if maxBytes > 0 && int64(entry.UncompressedSize64) > maxBytes {
		return StaticAsset{}, ErrStaticTooLarge
	}
	rc, err := entry.Open()
	if err != nil {
		return StaticAsset{}, err
	}
	defer func() { _ = rc.Close() }()

	// Read one byte past the cap so a lying header cannot get past it.
	limit := int64(-1)
	if maxBytes > 0 {
		limit = maxBytes + 1
	}
	var data []byte
	if limit > 0 {
		data, err = io.ReadAll(io.LimitReader(rc, limit))
	} else {
		data, err = io.ReadAll(rc)
	}
	if err != nil {
		return StaticAsset{}, err
	}
	if maxBytes > 0 && int64(len(data)) > maxBytes {
		return StaticAsset{}, ErrStaticTooLarge
	}
	return StaticAsset{Name: rel, Data: data, ModTime: entry.Modified}, nil
}

// findZipEntry finds the entry whose cleaned name equals rel.
//
// Entry names are matched after cleaning, and an entry carrying a ".." or an
// absolute name simply never matches what validateRelSegments let through — so
// a hostile archive cannot be used to read outside itself.
func findZipEntry(files []*zip.File, rel string) (*zip.File, error) {
	want := strings.TrimPrefix(filepath.ToSlash(filepath.Clean("/"+rel)), "/")
	for _, f := range files {
		if f.FileInfo().IsDir() {
			continue
		}
		name := strings.TrimPrefix(filepath.ToSlash(f.Name), "./")
		if name == want {
			return f, nil
		}
	}
	return nil, fmt.Errorf("not found")
}

// StaticArchivePath is the absolute path of a zip-based static source, so callers
// (install, the render stub) can report or validate it without re-deriving it.
func (e Extension) StaticArchivePath() (string, error) {
	if e.StaticKind() != StaticZip {
		return "", fmt.Errorf("extension has no static archive")
	}
	path := filepath.Join(e.Dir, e.Static)
	if err := ensureWithin(e.Dir, path); err != nil {
		return "", fmt.Errorf("static archive: %w", err)
	}
	return path, nil
}
