// Package extension discovers and resolves gqjs-backed extensions that the
// `extension` tile plugin renders. An extension is a directory under the Suwu
// data dir's `extensions/` folder containing a required `meta.json` (metadata)
// and a hard-coded `index.js` entry point.
package extension

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// go:embed seeds embeds the built-in extension examples shipped with Suwu.
//
//go:embed seeds
var seedsFS embed.FS

// EntryFile is the hard-coded entry point filename inside an extension dir.
const EntryFile = "index.js"

// MetaFile is the required metadata filename inside an extension dir.
const MetaFile = "meta.json"

// idRe validates an extension id (also the directory name). It forbids path
// separators and dot segments, which is the primary traversal defense.
var idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// Param documents one launch parameter an extension accepts. It mirrors the
// frontend PluginParamDoc shape so the config editor can render labels/hints.
type Param struct {
	Key          string `json:"key"`
	Label        string `json:"label,omitempty"`
	Description  string `json:"description,omitempty"`
	DefaultValue string `json:"defaultValue,omitempty"`
}

// Meta is the parsed contents of an extension's meta.json.
type Meta struct {
	Name        string  `json:"name,omitempty"`
	Description string  `json:"description,omitempty"`
	Params      []Param `json:"params,omitempty"`
}

// Extension is one resolved, runnable extension.
type Extension struct {
	// ID is the extension directory name.
	ID string `json:"id"`
	// Name is the display name (defaults to ID).
	Name string `json:"name"`
	// Description is a short human description.
	Description string `json:"description,omitempty"`
	// Params documents accepted launch parameters.
	Params []Param `json:"params,omitempty"`
	// Dir is the absolute extension directory.
	Dir string `json:"-"`
	// Entry is the absolute path to index.js.
	Entry string `json:"-"`
}

// Dir returns the extensions directory for a Suwu data directory.
func Dir(dataDir string) string {
	return filepath.Join(dataDir, "extensions")
}

// ValidID reports whether id is a legal extension id.
func ValidID(id string) bool { return idRe.MatchString(id) }

// List returns every resolvable extension under dir, sorted by ID. Missing or
// unreadable directories yield an empty result; individual invalid or
// incomplete extension directories are skipped.
func List(dir string) ([]Extension, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read extensions dir: %w", err)
	}
	out := make([]Extension, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		ext, err := Resolve(dir, e.Name())
		if err != nil {
			continue // skip invalid/incomplete extension dirs
		}
		out = append(out, ext)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// Resolve validates an id and returns its Extension, reading meta.json.
func Resolve(dir, id string) (Extension, error) {
	if !ValidID(id) {
		return Extension{}, fmt.Errorf("invalid extension id %q", id)
	}
	base, err := filepath.Abs(dir)
	if err != nil {
		return Extension{}, fmt.Errorf("resolve extensions dir: %w", err)
	}
	extDir := filepath.Join(base, id)
	if err := ensureWithin(base, extDir); err != nil {
		return Extension{}, fmt.Errorf("extension %q: %w", id, err)
	}

	entry := filepath.Join(extDir, EntryFile)
	if !isRegularFile(entry) {
		return Extension{}, fmt.Errorf("extension %q: missing %s", id, EntryFile)
	}
	if err := ensureWithin(extDir, entry); err != nil {
		return Extension{}, fmt.Errorf("extension %q: %w", id, err)
	}

	meta, err := readMeta(filepath.Join(extDir, MetaFile))
	if err != nil {
		return Extension{}, fmt.Errorf("extension %q: %w", id, err)
	}
	name := meta.Name
	if name == "" {
		name = id
	}
	return Extension{
		ID:          id,
		Name:        name,
		Description: meta.Description,
		Params:      meta.Params,
		Dir:         extDir,
		Entry:       entry,
	}, nil
}

// Seed writes embedded built-in extensions into dir, never overwriting an
// existing extension directory.
func Seed(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create extensions dir: %w", err)
	}
	entries, err := fs.ReadDir(seedsFS, "seeds")
	if err != nil {
		return fmt.Errorf("read seeds: %w", err)
	}
	for _, e := range entries {
		if !e.IsDir() || !ValidID(e.Name()) {
			continue
		}
		target := filepath.Join(dir, e.Name())
		if _, err := os.Stat(target); err == nil {
			continue // already present; never overwrite a user's copy
		}
		if err := copyTree("seeds/"+e.Name(), target); err != nil {
			return fmt.Errorf("seed %s: %w", e.Name(), err)
		}
	}
	return nil
}

func readMeta(path string) (Meta, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Meta{}, fmt.Errorf("missing %s", MetaFile)
		}
		return Meta{}, fmt.Errorf("read %s: %w", MetaFile, err)
	}
	var m Meta
	if err := json.Unmarshal(data, &m); err != nil {
		return Meta{}, fmt.Errorf("parse %s: %w", MetaFile, err)
	}
	return m, nil
}

// copyTree recursively copies an embedded directory into dst with 0644 files.
func copyTree(src, dst string) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	return fs.WalkDir(seedsFS, src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(path, src)
		rel = strings.TrimPrefix(rel, "/")
		if rel == "" {
			return nil
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := seedsFS.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}

// isRegularFile reports whether p exists and is a regular file.
func isRegularFile(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

// ensureWithin rejects target when, after resolving symlinks, it is not
// contained in base. This is the defense against a symlinked extension dir
// escaping the extensions root.
func ensureWithin(base, target string) error {
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		// base may not exist yet (e.g. Seed); fall back to lexical check.
		resolvedBase = base
	}
	resolvedTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		resolvedTarget = target
	}
	absBase, err := filepath.Abs(resolvedBase)
	if err != nil {
		return err
	}
	absTarget, err := filepath.Abs(resolvedTarget)
	if err != nil {
		return err
	}
	if absTarget != absBase && !strings.HasPrefix(absTarget, absBase+string(filepath.Separator)) {
		return fmt.Errorf("path escapes the extensions directory")
	}
	return nil
}
