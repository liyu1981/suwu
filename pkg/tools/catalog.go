// Package tools installs the binaries in tools/catalog.json into a user-owned
// bin directory (~/.suwu/bin by default): download, verify the pinned sha256,
// extract only the declared files, then stamp the result.
//
// The catalog itself lives in the top-level `tools` package, which embeds the
// same tools/catalog.json the release builders and a running server read. This
// file is the schema and its validation; install.go is the writer.
//
// Two rules shape everything here:
//
//   - Nothing is written before it is verified. A download is hashed while it
//     streams, and a stamp (the record of a complete install) is written last,
//     so a stamp always describes a whole tool.
//   - The catalog is remote input. A name, a path or a mode that could escape
//     the bin directory is a hard error for the whole catalog, not a skipped
//     row: a typo in a pin must be loud, never silent.
package tools

import (
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	catalog "suwu/tools"
)

// SchemaVersion is the catalog schema this build understands.
const SchemaVersion = 1

// Archive kinds a platform entry may declare. "none" is a bare executable
// (GitHub's direct-binary releases), which is why it needs no strip.
const (
	ArchiveTarGz = "tar.gz"
	ArchiveTarXz = "tar.xz"
	ArchiveZip   = "zip"
	ArchiveNone  = "none"
)

// Bundle markers, used by the release builders to decide what goes into which
// artifact: `max` is the suwu-max payload, `hcbin` the archive embedded in the
// suwu binary for `suwu hc` and the Baikal tile.
const (
	BundledMax   = "max"
	BundledHCBin = "hcbin"
)

// Catalog is tools/catalog.json.
type Catalog struct {
	Schema    int    `json:"schema"`
	UpdatedAt string `json:"updatedAt"`
	Tools     []Tool `json:"tools"`
}

// Tool is one installable binary.
type Tool struct {
	Name     string `json:"name"`
	Label    string `json:"label"`
	Version  string `json:"version"`
	Summary  string `json:"summary"`
	Homepage string `json:"homepage"`
	License  string `json:"license"`
	// Requires is display-only: a prerequisite the user must provide (node, a
	// runtime), never something this installer fetches.
	Requires []string `json:"requires,omitempty"`
	Notes    string   `json:"notes,omitempty"`
	// Bundled marks a tool a release artifact carries: "max" (suwu-max) or
	// "hcbin" (inside the suwu binary). Empty means catalog-only.
	Bundled string `json:"bundled,omitempty"`
	// Keep lists non-executable files the max payload keeps beside the binary
	// (licenses, notices). It is a builder concern, not an install target.
	Keep      []string            `json:"keep,omitempty"`
	Platforms map[string]Platform `json:"platforms"`
}

// Platform is one platform's pinned download.
type Platform struct {
	// Archive is ArchiveTarGz, ArchiveZip or ArchiveNone.
	Archive string `json:"archive"`
	// URL must be https: a plain-http download would make the pin moot.
	URL string `json:"url"`
	// SHA256 is the archive's digest, lower-case hex.
	SHA256 string `json:"sha256"`
	// Strip is how many leading path components to drop from archive member
	// names before matching Entries (release tarballs usually wrap everything
	// in one directory).
	Strip int `json:"strip"`
	// Entries are the files this tool owns, relative to the bin directory.
	Entries []Entry `json:"entries"`
	// Docs are extra files fetched by name (man pages), for builders only.
	Docs map[string]string `json:"docs,omitempty"`
}

// Entry is one file a tool owns in the bin directory.
type Entry struct {
	File string `json:"file"`
	Mode string `json:"mode"`
}

var (
	nameRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	platformRe = regexp.MustCompile(`^(linux|darwin)-(amd64|arm64)$`)
	shaRe      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	modeRe     = regexp.MustCompile(`^0[0-7]{3}$`)
)

// Parse decodes and validates a catalog. The whole document is rejected on the
// first problem: a server that cannot trust one row cannot trust the list, and
// a partial catalog would show a tool whose pin was never checked.
func Parse(data []byte) (*Catalog, error) {
	var c Catalog
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse catalog: %w", err)
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

var (
	builtinOnce sync.Once
	builtinCat  *Catalog
	builtinErr  error
)

// Builtin parses the catalog embedded in this build. It is cached: the file is
// small, but every HTTP request of the tools page would otherwise re-validate
// it.
func Builtin() (*Catalog, error) {
	builtinOnce.Do(func() {
		builtinCat, builtinErr = Parse(catalog.Builtin)
	})
	return builtinCat, builtinErr
}

// Validate checks every rule the installer relies on.
func (c *Catalog) Validate() error {
	if c.Schema != SchemaVersion {
		return fmt.Errorf("catalog schema %d is not supported (want %d)", c.Schema, SchemaVersion)
	}
	if len(c.Tools) == 0 {
		return errors.New("catalog lists no tools")
	}
	seen := make(map[string]bool, len(c.Tools))
	// owner maps an owned file to the tool that claims it: two tools writing the
	// same path would make install order decide the winner.
	owner := make(map[string]string)
	for i := range c.Tools {
		t := &c.Tools[i]
		if err := t.validate(); err != nil {
			return err
		}
		if seen[t.Name] {
			return fmt.Errorf("tool %q is listed twice", t.Name)
		}
		seen[t.Name] = true
		for _, p := range t.Platforms {
			for _, e := range p.Entries {
				if prev, ok := owner[e.File]; ok && prev != t.Name {
					return fmt.Errorf("%s: also owned by %s", e.File, prev)
				}
				owner[e.File] = t.Name
			}
		}
	}
	return nil
}

func (t *Tool) validate() error {
	if !nameRe.MatchString(t.Name) {
		return fmt.Errorf("tool name %q must be lowercase letters, digits, '-' or '_'", t.Name)
	}
	if strings.TrimSpace(t.Version) == "" {
		return fmt.Errorf("tool %q has no version", t.Name)
	}
	if len(t.Platforms) == 0 {
		return fmt.Errorf("tool %q lists no platforms", t.Name)
	}
	if t.Bundled != "" && t.Bundled != BundledMax && t.Bundled != BundledHCBin {
		return fmt.Errorf("tool %q: unknown bundle marker %q", t.Name, t.Bundled)
	}
	for _, k := range t.Keep {
		if !safeName(k) {
			return fmt.Errorf("tool %q: keep entry %q is not a plain file name", t.Name, k)
		}
	}
	for key, p := range t.Platforms {
		if !platformRe.MatchString(key) {
			return fmt.Errorf("tool %q: platform %q must be <linux|darwin>-<amd64|arm64>", t.Name, key)
		}
		if err := p.validate(t.Name, key); err != nil {
			return err
		}
	}
	return nil
}

func (p *Platform) validate(tool, key string) error {
	if !strings.HasPrefix(p.URL, "https://") {
		return fmt.Errorf("tool %q (%s): url must be https", tool, key)
	}
	if !shaRe.MatchString(p.SHA256) {
		return fmt.Errorf("tool %q (%s): sha256 must be 64 lower-case hex characters", tool, key)
	}
	if p.Strip < 0 {
		return fmt.Errorf("tool %q (%s): strip cannot be negative", tool, key)
	}
	switch p.Archive {
	case ArchiveTarGz, ArchiveTarXz, ArchiveZip, ArchiveNone:
	case "":
		return fmt.Errorf("tool %q (%s): missing archive kind", tool, key)
	default:
		return fmt.Errorf("tool %q (%s): unknown archive %q", tool, key, p.Archive)
	}
	if len(p.Entries) == 0 {
		return fmt.Errorf("tool %q (%s): lists no entries", tool, key)
	}
	if p.Archive == ArchiveNone && (len(p.Entries) != 1 || p.Strip != 0) {
		return fmt.Errorf("tool %q (%s): a bare binary has exactly one entry and no strip", tool, key)
	}
	for _, e := range p.Entries {
		if err := validateEntry(tool, key, e); err != nil {
			return err
		}
	}
	for name, url := range p.Docs {
		if !safeName(name) {
			return fmt.Errorf("tool %q (%s): doc name %q is not a plain file name", tool, key, name)
		}
		if !strings.HasPrefix(url, "https://") {
			return fmt.Errorf("tool %q (%s): doc %q url must be https", tool, key, name)
		}
	}
	return nil
}

// validateEntry rejects a file name that could leave the bin directory or
// shadow the installer's own metadata (.tools/, .stage/).
func validateEntry(tool, key string, e Entry) error {
	if e.File == "" {
		return fmt.Errorf("tool %q (%s): entry with no file", tool, key)
	}
	if !safeRel(e.File) {
		return fmt.Errorf("tool %q (%s): entry %q is not a safe relative path", tool, key, e.File)
	}
	if !modeRe.MatchString(e.Mode) {
		return fmt.Errorf("tool %q (%s): entry %q mode %q must look like 0755", tool, key, e.File, e.Mode)
	}
	mode, err := strconv.ParseUint(e.Mode, 8, 32)
	if err != nil {
		return fmt.Errorf("tool %q (%s): entry %q mode %q: %w", tool, key, e.File, e.Mode, err)
	}
	if mode&0o7000 != 0 {
		return fmt.Errorf("tool %q (%s): entry %q must not be setuid/setgid/sticky", tool, key, e.File)
	}
	if mode&0o002 != 0 {
		return fmt.Errorf("tool %q (%s): entry %q must not be world-writable", tool, key, e.File)
	}
	return nil
}

// safeRel reports whether p is a clean, relative, forward-slash path that does
// not start with a dot (the metadata directories are off limits).
func safeRel(p string) bool {
	if p == "" || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00") {
		return false
	}
	if filepathVolume(p) != "" {
		return false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." || strings.HasPrefix(seg, ".") {
			return false
		}
	}
	return path.Clean(p) == p
}

// safeName is safeRel plus "no separators": a single file name.
func safeName(p string) bool { return safeRel(p) && !strings.Contains(p, "/") }

// filepathVolume mirrors filepath.VolumeName for the slash-separated catalog
// paths, without dragging the OS separator into the check.
func filepathVolume(p string) string {
	if len(p) >= 2 && p[1] == ':' {
		return p[:2]
	}
	return ""
}

// PlatformKey is the catalog key for a target, e.g. "linux-amd64".
func PlatformKey(goos, goarch string) string { return goos + "-" + goarch }

// Find returns the tool with this name.
func (c *Catalog) Find(name string) (*Tool, bool) {
	for i := range c.Tools {
		if c.Tools[i].Name == name {
			return &c.Tools[i], true
		}
	}
	return nil, false
}

// Names lists the catalog in file order.
func (c *Catalog) Names() []string {
	out := make([]string, 0, len(c.Tools))
	for _, t := range c.Tools {
		out = append(out, t.Name)
	}
	return out
}

// Bundled lists the tools a release artifact carries, in catalog order.
func (c *Catalog) Bundled(marker string) []*Tool {
	out := make([]*Tool, 0, len(c.Tools))
	for i := range c.Tools {
		if c.Tools[i].Bundled == marker {
			out = append(out, &c.Tools[i])
		}
	}
	return out
}

// For returns this platform's pinned download and whether the tool is
// available here at all. A tool that only ships for Linux answers false on
// macOS; that is a fact to show, not an error to hide.
func (t *Tool) For(goos, goarch string) (Platform, bool) {
	p, ok := t.Platforms[PlatformKey(goos, goarch)]
	return p, ok
}

// Platforms lists the catalog keys in a stable order, for messages.
func (t *Tool) PlatformsList() []string {
	out := make([]string, 0, len(t.Platforms))
	for k := range t.Platforms {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
