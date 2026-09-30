// Package install puts a background or an extension into a Suwu data
// directory, from an archive or from the first-party GitHub catalog.
//
// Both sources fill a Stage (a scratch directory under <dataDir>/.install) and
// share one Commit, so a zip and a catalog download are validated and swapped
// into place by exactly the same code. Validation reuses the server's own
// resolvers — extension.Resolve and background.ResolveDisk — so an install can
// never leave a directory behind that the server would reject; the commit is a
// rename inside the data directory, which is atomic on one filesystem.
//
// Nothing is executed during an install: files are copied and validated as
// data. The first execution is the server spawning `suwu gq`, which is already
// sandboxed with a read-only root, a deadline and a concurrency cap
// (docs/EXTENSION_TILE_PLAN.md §4.4).
package install

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"suwu/pkg/background"
	"suwu/pkg/extension"
)

// Kind is what is being installed. The two kinds install into the two
// singularly named data-dir trees.
type Kind string

const (
	// KindExtension is a gqjs extension: <dataDir>/extension/<id>.
	KindExtension Kind = "extension"
	// KindBackground is a WebGPU background: <dataDir>/background/webgpu/<id>.
	KindBackground Kind = "background"
)

// StageDirName is the scratch directory under the data dir where an item is
// assembled and validated. It is removed on success and on every failure path.
const StageDirName = ".install"

// Limits bounding one install. They are deliberately looser than the server's
// per-request static caps (8 MiB) so a future large asset is not rejected,
// while the total still bounds the work an archive or a download can cause.
const (
	// MaxFiles is the maximum number of files in one item.
	MaxFiles = 4096
	// MaxFileBytes is the maximum size of one staged file.
	MaxFileBytes = 16 << 20 // 16 MiB
	// MaxTotalBytes is the maximum uncompressed size of one item.
	MaxTotalBytes = 64 << 20 // 64 MiB
)

// Kinds returns the installable kinds in display order.
func Kinds() []Kind { return []Kind{KindExtension, KindBackground} }

// KindFromString parses a user-supplied kind name.
func KindFromString(s string) (Kind, error) {
	switch Kind(strings.ToLower(strings.TrimSpace(s))) {
	case KindExtension:
		return KindExtension, nil
	case KindBackground:
		return KindBackground, nil
	case "":
		return "", errors.New("kind is required (extension or background)")
	default:
		return "", fmt.Errorf("unknown kind %q (want extension or background)", s)
	}
}

// Label is the human name of a kind, used in output.
func (k Kind) Label() string {
	if k == KindBackground {
		return "background"
	}
	return "extension"
}

// ValidID reports whether id is a legal directory name for this kind. Both
// kinds share the same id grammar; each package validates it with its own
// regexp so the two can never drift.
func (k Kind) ValidID(id string) bool {
	if k == KindBackground {
		return background.ValidID(id)
	}
	return extension.ValidID(id)
}

// Root returns the directory an item of this kind is installed into, given a
// data dir. It is the same string the server reads from, so an install is
// immediately visible.
func (k Kind) Root(dataDir string) string {
	if k == KindBackground {
		return background.Dir(dataDir)
	}
	return extension.Dir(dataDir)
}

// Options controls one install.
type Options struct {
	// DataDir is the Suwu data directory (default ~/.suwu).
	DataDir string
	// Force allows replacing an existing install of the same id.
	Force bool
	// DryRun validates and reports, then discards without touching the target.
	DryRun bool
}

// Item is the result of one install.
type Item struct {
	Kind Kind
	// ID is the directory name, i.e. what the tile or settings refer to.
	ID string
	// Name and Description come from the item's own manifest.
	Name        string
	Description string
	// Dir is the final path, empty on a dry run.
	Dir string
	// Files and Bytes describe what was written.
	Files int
	Bytes int64
	// Replaced reports that an existing install was swapped out.
	Replaced bool
	// Warnings are non-fatal notes worth printing (uncompiled shaders, …).
	Warnings []string
}

// Stage is a scratch directory holding one item's payload while it is written
// and validated. Callers must call Discard; Commit consumes it.
type Stage struct {
	kind     Kind
	id       string
	root     string // <dataDir>/.install
	dir      string // <root>/<id> — the payload directory
	files    int
	bytes    int64
	written  bool
	replaced bool
}

// NewStage creates a staging directory for one item. The id is validated
// against the kind's grammar before any path is built, so a hostile id can
// never escape the data directory.
//
// The payload directory is <dataDir>/.install/<kind>/<id> so that validation can
// call the kind's resolver with the same (parent, id) pair the server uses. The
// kind level also keeps two kinds that share an id from colliding.
func NewStage(dataDir string, kind Kind, id string) (*Stage, error) {
	if err := validateDataDir(dataDir); err != nil {
		return nil, err
	}
	if !kind.ValidID(id) {
		return nil, fmt.Errorf("invalid %s id %q (want %s)", kind.Label(), id, idGrammar)
	}
	root := filepath.Join(dataDir, StageDirName)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("create %s: %w", root, err)
	}
	dir := filepath.Join(root, kind.Label(), id)
	if err := os.RemoveAll(dir); err != nil {
		return nil, fmt.Errorf("clear staging dir: %w", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create staging dir: %w", err)
	}
	return &Stage{kind: kind, id: id, root: root, dir: dir}, nil
}

// validateDataDir rejects a data dir that is not an absolute, clean path. The
// install writes only inside it, so a relative or traversing data dir would
// widen that guarantee.
func validateDataDir(dataDir string) error {
	if dataDir == "" {
		return errors.New("data directory is required")
	}
	if !filepath.IsAbs(dataDir) {
		return fmt.Errorf("data directory %q must be an absolute path", dataDir)
	}
	if filepath.Clean(dataDir) != dataDir {
		return fmt.Errorf("data directory %q is not a clean path", dataDir)
	}
	return nil
}

// ID is the item id this stage was created for.
func (s *Stage) ID() string { return s.id }

// Kind is what this stage is assembling.
func (s *Stage) Kind() Kind { return s.kind }

// Dir is the payload directory inside the stage. Callers validate their own
// source paths before using it.
func (s *Stage) Dir() string { return s.dir }

// Stats reports the files and bytes written so far.
func (s *Stage) Stats() (files int, bytes int64) { return s.files, s.bytes }

// WriteFile writes one payload file, creating parent directories. rel is
// relative to the payload directory and is validated: no absolute path, no
// traversal, no backslash, no empty segment. Permissions are ours, not the
// source's.
func (s *Stage) WriteFile(rel string, r io.Reader) (int64, error) {
	target, err := s.resolve(rel)
	if err != nil {
		return 0, err
	}
	if s.files >= MaxFiles {
		return 0, fmt.Errorf("too many files (limit %d)", MaxFiles)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return 0, err
	}
	// O_EXCL: a duplicate entry in an archive is a packaging bug, and letting
	// it silently overwrite would make the result order-dependent.
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return 0, err
	}
	defer func() { _ = f.Close() }()

	// LimitReader per file plus a running total, so a source that understates
	// its sizes still cannot blow the budget.
	n, err := io.Copy(f, io.LimitReader(r, MaxFileBytes+1))
	if err != nil {
		_ = f.Close()
		_ = os.Remove(target)
		return 0, err
	}
	if err := checkSize(rel, n, s.bytes); err != nil {
		_ = f.Close()
		_ = os.Remove(target)
		return 0, err
	}
	s.files++
	s.bytes += n
	return n, nil
}

// checkSize enforces the per-file and per-item size budgets. It is separate so
// the accounting can be tested with synthetic numbers rather than by writing
// tens of megabytes.
func checkSize(rel string, n, alreadyWritten int64) error {
	if n > MaxFileBytes {
		return fmt.Errorf("%s: larger than the %d MiB per-file limit", rel, MaxFileBytes>>20)
	}
	if alreadyWritten+n > MaxTotalBytes {
		return fmt.Errorf("total size exceeds the %d MiB limit", MaxTotalBytes>>20)
	}
	return nil
}

// WriteBytes is WriteFile from an in-memory payload.
func (s *Stage) WriteBytes(rel string, data []byte) (int64, error) {
	return s.WriteFile(rel, strings.NewReader(string(data)))
}

// MkdirAll creates one empty payload directory (archives may carry empty dirs).
func (s *Stage) MkdirAll(rel string) error {
	target, err := s.resolve(rel)
	if err != nil {
		return err
	}
	return os.MkdirAll(target, 0o755)
}

// resolve maps a payload-relative path to an absolute path inside the stage,
// rejecting anything that could leave it.
func (s *Stage) resolve(rel string) (string, error) {
	clean, err := cleanRel(rel)
	if err != nil {
		return "", err
	}
	target := filepath.Join(s.dir, filepath.FromSlash(clean))
	// Belt and braces: the lexical check above already guarantees this, but the
	// containment assertion is the invariant worth stating.
	if err := ensureWithin(s.dir, target); err != nil {
		return "", fmt.Errorf("%s: %w", rel, err)
	}
	return target, nil
}

// cleanRel validates a slash-separated relative path. It rejects absolute
// paths, backslashes, volume names, empty segments and dot segments, and
// returns a cleaned path.
func cleanRel(rel string) (string, error) {
	if rel == "" {
		return "", errors.New("empty path")
	}
	if strings.ContainsRune(rel, '\x00') {
		return "", fmt.Errorf("%q: contains a NUL byte", rel)
	}
	if strings.ContainsRune(rel, '\\') {
		return "", fmt.Errorf("%q: backslash separators are not allowed", rel)
	}
	if strings.HasPrefix(rel, "/") {
		return "", fmt.Errorf("%q: absolute path", rel)
	}
	if filepath.VolumeName(rel) != "" {
		return "", fmt.Errorf("%q: volume-qualified path", rel)
	}
	for _, seg := range strings.Split(rel, "/") {
		switch seg {
		case "":
			return "", fmt.Errorf("%q: empty path segment", rel)
		case ".", "..":
			return "", fmt.Errorf("%q: dot path segment", rel)
		}
	}
	return filepath.ToSlash(filepath.Clean(rel)), nil
}

// ensureWithin rejects target when it is not contained in base after symlink
// resolution. Mirrors pkg/extension's unexported helper: a symlinked staging
// directory must not be able to redirect a write outside the data dir.
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
		return errors.New("path escapes the staging directory")
	}
	return nil
}

// verify walks the staged tree and re-checks containment for every entry. It
// defends against anything the per-file checks could have missed, and is
// cheap: an item is tens of files.
func (s *Stage) verify() error {
	return filepath.WalkDir(s.dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ensureWithin(s.dir, p); err != nil {
			return fmt.Errorf("%s: %w", p, err)
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("%s: symlink in the staged tree", p)
		}
		return nil
	})
}

// Discard removes the stage and prunes the empty scratch directories above it.
// It is safe to call after Commit and on every failure path, so a rejected
// install leaves the data directory exactly as it found it.
func (s *Stage) Discard() error {
	if s == nil || s.written {
		return nil
	}
	err := os.RemoveAll(s.dir)
	s.prune()
	return err
}

// prune removes the now-empty scratch directories above the payload:
// <root>/<kind> and then <root>. Both removals fail harmlessly when something
// else is still staged there, so a concurrent install is never disturbed.
func (s *Stage) prune() {
	_ = os.Remove(filepath.Dir(s.dir))
	_ = os.Remove(s.root)
}

// Commit validates the staged payload with the server's own resolver, then
// moves it into place.
//
// The order matters: nothing about the target is touched until the payload is
// known to be a valid item, so a bad archive leaves the data directory exactly
// as it was. A dry run stops after validation.
func (s *Stage) Commit(opt Options) (Item, error) {
	item := Item{Kind: s.kind, ID: s.id}
	// Every early return below must leave the data dir as it was found, and
	// written is only set once the payload is in its final place.
	defer func() { _ = s.Discard() }()

	if err := s.verify(); err != nil {
		return item, fmt.Errorf("validate staged tree: %w", err)
	}
	name, desc, err := s.validate()
	if err != nil {
		return item, err
	}
	item.Name, item.Description = name, desc
	if s.kind == KindBackground {
		item.Warnings = s.backgroundWarnings()
	}
	item.Files, item.Bytes = s.files, s.bytes

	target := filepath.Join(s.kind.Root(opt.DataDir), s.id)
	item.Dir = target

	if opt.DryRun {
		return item, nil
	}

	if err := s.commit(target, opt.Force); err != nil {
		return item, err
	}
	s.written = true
	item.Replaced = s.replaced
	s.prune()
	return item, nil
}

// validate runs the kind's resolver against the stage's parent, which is the
// same call the server makes per request. It returns the manifest name and
// description so the CLI can report them.
func (s *Stage) validate() (name, desc string, err error) {
	parent := filepath.Dir(s.dir)
	switch s.kind {
	case KindBackground:
		m, err := background.ResolveDisk(parent, s.id)
		if err != nil {
			return "", "", fmt.Errorf("not a valid background: %w", err)
		}
		return m.Label, "", nil
	case KindExtension:
		e, err := extension.Resolve(parent, s.id)
		if err != nil {
			return "", "", fmt.Errorf("not a valid extension: %w", err)
		}
		return e.Name, e.Description, nil
	default:
		return "", "", fmt.Errorf("unknown kind %q", s.kind)
	}
}

// backgroundWarnings reports the freshness invariant the repo enforces with
// check-background-shaders.mjs: an authored entry WGSL with no compiled
// sibling artifact will fail to import in the browser. It is a warning, not an
// error — the install is valid, only the preview would break.
func (s *Stage) backgroundWarnings() []string {
	var out []string
	_ = filepath.WalkDir(s.dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(p) != ".wgsl" {
			return nil //nolint:nilerr // a walk error is reported by verify()
		}
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			return nil
		}
		// Only entry shaders (@fragment / @compute) are compiled; helpers are
		// inlined into them.
		if !bytes.Contains(data, []byte("@fragment")) && !bytes.Contains(data, []byte("@compute")) {
			return nil
		}
		artifact := strings.TrimSuffix(p, ".wgsl") + ".shader.js"
		if _, statErr := os.Stat(artifact); statErr != nil {
			out = append(out, fmt.Sprintf("%s has no compiled %s (run: suwu background build %s)",
				filepath.Base(p), filepath.Base(artifact), strings.TrimPrefix(p, s.dir+string(filepath.Separator))))
		}
		return nil
	})
	return out
}

// commit moves the staged payload onto target, atomically. It reports whether
// a previous install was replaced.
func (s *Stage) commit(target string, force bool) error {
	root := filepath.Dir(target)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", root, err)
	}

	// Refuse to write through a symlink at the target.
	if info, err := os.Lstat(target); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%s is a symlink; refusing to replace it", target)
		}
		if !force {
			return fmt.Errorf("%s already exists; pass --force to replace it", target)
		}
	}

	// Same filesystem (both under the data dir), so the rename is atomic. The
	// backup keeps a working install intact until the new one is in place.
	var backup string
	if _, err := os.Lstat(target); err == nil {
		s.replaced = true
		backup = fmt.Sprintf("%s.bak-%s", target, strconv.FormatInt(time.Now().UnixNano(), 10))
		if err := os.Rename(target, backup); err != nil {
			return fmt.Errorf("set aside existing install: %w", err)
		}
	}
	if err := os.Rename(s.dir, target); err != nil {
		if backup != "" {
			// Put the previous install back before reporting.
			if restoreErr := os.Rename(backup, target); restoreErr != nil {
				return fmt.Errorf("install failed: %w (and restoring %s failed: %v)", err, target, restoreErr)
			}
		}
		return fmt.Errorf("install: %w", err)
	}
	if backup != "" {
		_ = os.RemoveAll(backup)
	}
	return nil
}

// Installed reports whether an item of this kind is already installed under
// dataDir.
func (k Kind) Installed(dataDir, id string) bool {
	_, err := os.Stat(filepath.Join(k.Root(dataDir), id))
	return err == nil
}
