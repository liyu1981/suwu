// Package extdata is the server-side half of the extension storage bridge: one
// JSON record per (extension, key), under <dataDir>/extension-data/<id>/<key>.json.
//
// An extension's frame has an opaque origin, so its storage is the page's
// IndexedDB; that makes a note (or any client-side extension) live in one
// browser. A record kept here is the same value on every device, which is what
// an extension opts into when it asks for the server scope
// (docs/EXTENSION_TILE_PLAN.md §4.8).
//
// The key and size limits are the browser bridge's, on purpose: a value must be
// storable on either side without changing meaning.
package extdata

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"suwu/pkg/extension"
)

const (
	// DirName is the tree below the data dir: <dataDir>/extension-data/<id>/.
	DirName = "extension-data"
	// MaxValueBytes caps one record. It matches EXT_VALUE_MAX in
	// frontend/src/lib/extStore.ts (512 KB of JSON).
	MaxValueBytes = 512_000
)

// keyRe is the suffix an extension may choose. It mirrors EXT_KEY_RE in
// frontend/src/lib/extStore.ts and deliberately forbids path separators, so a
// key can never name a directory.
var keyRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// ErrNotFound means the extension has no record under that key.
var ErrNotFound = errors.New("no such record")

// ErrTooLarge means the value exceeds MaxValueBytes.
var ErrTooLarge = fmt.Errorf("record is larger than %d bytes", MaxValueBytes)

// Store reads and writes extension records for one data directory.
type Store struct {
	root string
}

// New returns a store rooted at <dataDir>/extension-data. The directory is
// created on the first write, not here: a server that never sees a server-scoped
// extension should not leave an empty tree behind.
func New(dataDir string) (*Store, error) {
	if dataDir == "" || !filepath.IsAbs(dataDir) {
		return nil, fmt.Errorf("extension data: data directory %q must be an absolute path", dataDir)
	}
	return &Store{root: filepath.Join(dataDir, DirName)}, nil
}

// Root is the directory records live under.
func (s *Store) Root() string { return s.root }

// ValidKey reports whether key is a legal suffix.
func ValidKey(key string) bool { return keyRe.MatchString(key) }

// ValidID reports whether id is a legal extension id.
func ValidID(id string) bool { return extension.ValidID(id) }

// path validates both names and returns the record's path. Validation is what
// keeps a hostile id or key from naming a file outside the tree, so every entry
// point goes through it.
func (s *Store) path(id, key string) (string, error) {
	if !ValidID(id) {
		return "", fmt.Errorf("extension data: %q is not an extension id", id)
	}
	if !ValidKey(key) {
		return "", fmt.Errorf("extension data: %q is not a key", key)
	}
	return filepath.Join(s.root, id, key+".json"), nil
}

// Get returns one record's bytes.
func (s *Store) Get(id, key string) ([]byte, error) {
	path, err := s.path(id, key)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return data, nil
}

// Set writes one record atomically. The value must be JSON: the browser stores
// parsed values, and a record that does not parse would fail there on the way
// back, which is worse than refusing it now.
func (s *Store) Set(id, key string, value []byte) error {
	path, err := s.path(id, key)
	if err != nil {
		return err
	}
	if len(value) > MaxValueBytes {
		return ErrTooLarge
	}
	if len(value) == 0 || !json.Valid(value) {
		return errors.New("extension data: value is not JSON")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+"-")
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := tmp.Write(value); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := os.Chmod(name, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return os.Rename(name, path)
}

// Delete removes one record. Deleting a record that is not there is not an
// error: the caller asked for the end state, not for a transition.
func (s *Store) Delete(id, key string) error {
	path, err := s.path(id, key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// List returns the keys an extension has records under, sorted.
func (s *Store) List(id string) ([]string, error) {
	if !ValidID(id) {
		return nil, fmt.Errorf("extension data: %q is not an extension id", id)
	}
	entries, err := os.ReadDir(filepath.Join(s.root, id))
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		key := strings.TrimSuffix(name, ".json")
		if !ValidKey(key) {
			continue
		}
		out = append(out, key)
	}
	sort.Strings(out)
	return out, nil
}
