// Package background discovers WebGPU backgrounds: directories of
// background.json + scene.js + shaders that the shell downloads from the data
// dir (external) or the copy embedded in the binary (builtin).
//
// An external background is a directory under <dataDir>/background/webgpu/<id>
// with a required background.json manifest and scene.js entry, mirroring the
// layout of pkg/extension. The builtin copy lives in the top-level
// backgrounds/ package (an embed.FS) and is resolved through the same
// functions — disk first, embedded fallback — so a data-dir copy overrides the
// builtin. Nothing is seeded automatically: examples/background/webgpu holds
// installable copies the user drops into the data dir.
package background

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	// DirName is the background tree below the data dir: <dataDir>/background/webgpu.
	DirName = "background/webgpu"
	// ManifestFile is the required JSON manifest in every background dir.
	ManifestFile = "background.json"
	// EntryFile is the required scene.js module in every background dir.
	EntryFile = "scene.js"
)

// OverrideDir, when set (from $SUWU_BACKGROUNDS_DIR), replaces the data-dir
// location so development can serve the repo tree directly.
const overrideEnv = "SUWU_BACKGROUNDS_DIR"

// idRe validates a background id (also the directory name): it forbids path
// separators and dot segments, the primary traversal defense.
var idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// Credit is attribution for a background ported from an external work.
type Credit struct {
	Author  string `json:"author"`
	URL     string `json:"url,omitempty"`
	License string `json:"license,omitempty"`
}

// Option is one choice of a select parameter.
type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// Param is one user-adjustable setting. JSON only — unlike the in-bundle
// BackgroundParam schema there are no functions, so a numeric slider formats
// its value with Decimals + Suffix instead of a `format` callback.
type Param struct {
	Kind  string `json:"kind"`
	Key   string `json:"key"`
	Label string `json:"label"`
	Hint  string `json:"hint,omitempty"`

	// number
	Default any      `json:"default"`
	Min     *float64 `json:"min,omitempty"`
	Max     *float64 `json:"max,omitempty"`
	Step    *float64 `json:"step,omitempty"`
	// JSON-friendly `format` stand-in: toFixed(Decimals) + Suffix.
	Decimals *int   `json:"decimals,omitempty"`
	Suffix   string `json:"suffix,omitempty"`

	// select
	Options []Option `json:"options,omitempty"`

	// text
	Placeholder string `json:"placeholder,omitempty"`
	MaxLength   *int   `json:"maxLength,omitempty"`
}

// Manifest is a validated background.json.
type Manifest struct {
	ID     string  `json:"id"`
	Label  string  `json:"label"`
	Engine string  `json:"engine"`
	Credit *Credit `json:"credit,omitempty"`
	Params []Param `json:"params,omitempty"`
}

// Dir returns the background directory for a Suwu data directory. The
// SUWU_BACKGROUNDS_DIR override serves a repo/other tree directly (dev).
func Dir(dataDir string) string {
	if override := strings.TrimSpace(os.Getenv(overrideEnv)); override != "" {
		return override
	}
	return filepath.Join(dataDir, DirName)
}

// ValidID reports whether id is a legal background id.
func ValidID(id string) bool { return idRe.MatchString(id) }

// ParseManifest validates manifest bytes for a directory named id.
func ParseManifest(data []byte, id string) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return Manifest{}, fmt.Errorf("background %q: %w", id, err)
	}
	if m.ID == "" || m.ID != id {
		return Manifest{}, fmt.Errorf("background %q: manifest id %q must equal the directory name", id, m.ID)
	}
	if m.Label == "" {
		m.Label = m.ID
	}
	if m.Engine == "" {
		return Manifest{}, fmt.Errorf("background %q: missing engine", id)
	}
	if err := validateParams(m.ID, m.Params); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

// validateParams enforces the JSON-safe parameter schema: a small set of kinds,
// unique keys, and defaults that fit their own bounds.
func validateParams(id string, params []Param) error {
	seen := make(map[string]bool, len(params))
	for _, p := range params {
		if p.Key == "" {
			return fmt.Errorf("background %q: parameter without a key", id)
		}
		if seen[p.Key] {
			return fmt.Errorf("background %q: duplicate parameter key %q", id, p.Key)
		}
		seen[p.Key] = true
		if p.Label == "" {
			return fmt.Errorf("background %q: parameter %q has no label", id, p.Key)
		}
		switch p.Kind {
		case "number":
			if p.Min == nil || p.Max == nil || *p.Min > *p.Max {
				return fmt.Errorf("background %q: number parameter %q needs min <= max", id, p.Key)
			}
			if p.Decimals != nil && *p.Decimals < 0 {
				return fmt.Errorf("background %q: number parameter %q has negative decimals", id, p.Key)
			}
			if p.Step != nil && *p.Step <= 0 {
				return fmt.Errorf("background %q: number parameter %q needs step > 0", id, p.Key)
			}
			v, ok := p.Default.(float64)
			if !ok {
				return fmt.Errorf("background %q: number parameter %q needs a numeric default", id, p.Key)
			}
			if v < *p.Min || v > *p.Max {
				return fmt.Errorf("background %q: number parameter %q default %v outside [%v, %v]", id, p.Key, v, *p.Min, *p.Max)
			}
		case "boolean":
			if _, ok := p.Default.(bool); !ok {
				return fmt.Errorf("background %q: boolean parameter %q needs a boolean default", id, p.Key)
			}
		case "select":
			if len(p.Options) == 0 {
				return fmt.Errorf("background %q: select parameter %q has no options", id, p.Key)
			}
			if _, ok := p.Default.(string); !ok {
				return fmt.Errorf("background %q: select parameter %q needs a string default", id, p.Key)
			}
			found := false
			values := make(map[string]bool, len(p.Options))
			for _, opt := range p.Options {
				if opt.Value == "" || values[opt.Value] {
					return fmt.Errorf("background %q: select parameter %q has an empty or duplicate option", id, p.Key)
				}
				values[opt.Value] = true
				if opt.Value == p.Default {
					found = true
				}
			}
			if !found {
				return fmt.Errorf("background %q: select parameter %q default %q is not an option", id, p.Key, p.Default)
			}
		case "text":
			if _, ok := p.Default.(string); !ok {
				return fmt.Errorf("background %q: text parameter %q needs a string default", id, p.Key)
			}
			if p.MaxLength != nil && *p.MaxLength <= 0 {
				return fmt.Errorf("background %q: text parameter %q needs maxLength > 0", id, p.Key)
			}
		case "color":
			v, ok := p.Default.(string)
			if !ok || !hexRe.MatchString(v) {
				return fmt.Errorf("background %q: color parameter %q needs an #rrggbb default", id, p.Key)
			}
		default:
			return fmt.Errorf("background %q: parameter %q has unsupported kind %q", id, p.Key, p.Kind)
		}
	}
	return nil
}

var hexRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// ListDisk returns every valid background under dir, sorted by id. A missing
// dir yields no entries; invalid dirs are skipped.
func ListDisk(dir string) ([]Manifest, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read backgrounds dir: %w", err)
	}
	var out []Manifest
	for _, e := range entries {
		if !e.IsDir() || !ValidID(e.Name()) {
			continue
		}
		m, err := ResolveDisk(dir, e.Name())
		if err != nil {
			continue // skip invalid/incomplete backgrounds
		}
		out = append(out, m)
	}
	sortManifests(out)
	return out, nil
}

// ListFS returns every valid background under root in fsys, sorted by id. Paths
// look like webgpu/<id>/background.json (the embedded tree's layout).
func ListFS(fsys fs.FS, root string) ([]Manifest, error) {
	entries, err := fs.ReadDir(fsys, root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read embedded backgrounds: %w", err)
	}
	var out []Manifest
	for _, e := range entries {
		if !e.IsDir() || !ValidID(e.Name()) {
			continue
		}
		m, err := ResolveFS(fsys, root, e.Name())
		if err != nil {
			continue
		}
		out = append(out, m)
	}
	sortManifests(out)
	return out, nil
}

// ResolveDisk validates id and reads its manifest from dir, including the
// scene.js entry the frontend imports.
func ResolveDisk(dir, id string) (Manifest, error) {
	if !ValidID(id) {
		return Manifest{}, fmt.Errorf("invalid background id %q", id)
	}
	base, err := filepath.Abs(dir)
	if err != nil {
		return Manifest{}, err
	}
	bgDir := filepath.Join(base, id)
	if err := ensureWithin(base, bgDir); err != nil {
		return Manifest{}, fmt.Errorf("background %q: %w", id, err)
	}
	data, err := os.ReadFile(filepath.Join(bgDir, ManifestFile))
	if err != nil {
		return Manifest{}, fmt.Errorf("background %q: %w", id, err)
	}
	m, err := ParseManifest(data, id)
	if err != nil {
		return Manifest{}, err
	}
	if err := requireRegularFile(filepath.Join(bgDir, EntryFile)); err != nil {
		return Manifest{}, fmt.Errorf("background %q: %w", id, err)
	}
	return m, nil
}

// ResolveFS validates id and reads its manifest from fsys under root.
func ResolveFS(fsys fs.FS, root, id string) (Manifest, error) {
	if !ValidID(id) {
		return Manifest{}, fmt.Errorf("invalid background id %q", id)
	}
	bgDir := path.Join(root, id)
	data, err := fs.ReadFile(fsys, path.Join(bgDir, ManifestFile))
	if err != nil {
		return Manifest{}, fmt.Errorf("background %q: %w", id, err)
	}
	m, err := ParseManifest(data, id)
	if err != nil {
		return Manifest{}, err
	}
	if !regularFileFS(fsys, path.Join(bgDir, EntryFile)) {
		return Manifest{}, fmt.Errorf("background %q: missing %s", id, EntryFile)
	}
	return m, nil
}

// StaticFile resolves rel (a path inside a background dir, "scene.js",
// "shaders/x.shader.js", …) to an absolute host path, refusing anything that
// escapes the background dir — including through symlinks.
func StaticFile(dir, id, rel string) (string, error) {
	if !ValidID(id) {
		return "", fmt.Errorf("invalid background id %q", id)
	}
	rel = filepath.ToSlash(rel)
	if rel == "" || rel == "." || strings.HasPrefix(rel, "/") || strings.Contains(rel, "\\") {
		return "", fmt.Errorf("invalid path %q", rel)
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == ".." || seg == "." || seg == "" {
			return "", fmt.Errorf("invalid path %q", rel)
		}
	}
	base, err := filepath.Abs(filepath.Join(dir, id))
	if err != nil {
		return "", err
	}
	target := filepath.Join(base, filepath.FromSlash(rel))
	if err := ensureWithin(base, target); err != nil {
		return "", err
	}
	return target, nil
}

// OpenFS resolves rel inside the embedded background root/id and opens it.
func OpenFS(fsys fs.FS, root, id, rel string) (fs.File, error) {
	if !ValidID(id) {
		return nil, fmt.Errorf("invalid background id %q", id)
	}
	rel = strings.TrimPrefix(filepath.ToSlash(rel), "/")
	if rel == "" || !fs.ValidPath(rel) || strings.HasPrefix(rel, "..") {
		return nil, fmt.Errorf("invalid path %q", rel)
	}
	return fsys.Open(path.Join(root, id, rel))
}

// ensureWithin refuses base/target pairs where target escapes base, resolving
// symlinks first (copied from pkg/extension: a symlinked background dir must
// not serve files outside the data dir).
func ensureWithin(base, target string) error {
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
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
		return fmt.Errorf("path escapes the background directory")
	}
	return nil
}

func requireRegularFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("missing %s", filepath.Base(path))
	}
	return nil
}

func regularFileFS(fsys fs.FS, path string) bool {
	info, err := fs.Stat(fsys, path)
	return err == nil && info.Mode().IsRegular()
}

func sortManifests(list []Manifest) {
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
}
