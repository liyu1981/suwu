// Package maxbundle implements the payload side of suwu-max: a self-extracting
// launcher that installs the real suwu binary plus a small set of tools into a
// user-owned directory and then execs the real binary.
//
// The launcher embeds two files, produced by scripts/build-max.sh:
//
//	manifest.json    metadata for every extracted file (mode, sha256, version)
//	bundle.tar.gz     the compressed payload (suwu, tools, licenses)
//
// Extraction is version-stamped: a second run with the same manifest is a
// no-op. The stamp only requires presence (and the executable bit) so a tool's
// own self-update is not clobbered within a version; hashes are verified while
// extracting.
package maxbundle

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// SchemaVersion is the manifest/stamp schema this build understands.
const SchemaVersion = 1

// StampFile is the marker written into the install directory after a complete
// extraction. Its presence plus a version match is what makes a run a no-op.
const StampFile = ".suwu-max.json"

// MainBinary is the real binary the launcher execs.
const MainBinary = "suwu"

// Entry describes one extracted file.
type Entry struct {
	Name    string `json:"name"`
	File    string `json:"file"`
	Mode    string `json:"mode"` // octal string, e.g. "0755"
	SHA256  string `json:"sha256"`
	Version string `json:"version,omitempty"`
	License string `json:"license,omitempty"`
}

// Manifest describes one payload build.
type Manifest struct {
	Schema  int     `json:"schema"`
	Version string  `json:"version"`
	GOOS    string  `json:"goos"`
	GOARCH  string  `json:"goarch"`
	Entries []Entry `json:"entries"`
}

// Stamp records a completed extraction.
type Stamp struct {
	Schema      int      `json:"schema"`
	Version     string   `json:"version"`
	GOOS        string   `json:"goos"`
	GOARCH      string   `json:"goarch"`
	ExtractedAt string   `json:"extractedAt"`
	Files       []string `json:"files"`
}

// ParseManifest decodes and validates a manifest.
func ParseManifest(data []byte) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	if m.Schema != SchemaVersion {
		return nil, fmt.Errorf("manifest schema %d is not supported (want %d)", m.Schema, SchemaVersion)
	}
	if len(m.Entries) == 0 {
		return nil, errors.New("manifest has no entries")
	}
	for i := range m.Entries {
		e := &m.Entries[i]
		if e.File == "" {
			return nil, fmt.Errorf("manifest entry %d has no file", i)
		}
		clean := filepath.ToSlash(filepath.Clean(e.File))
		if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || filepath.IsAbs(e.File) {
			return nil, fmt.Errorf("manifest entry %q is not a safe relative path", e.File)
		}
		e.File = clean
		if e.Mode == "" {
			e.Mode = "0644"
		}
	}
	return &m, nil
}

// Result reports what Ensure did.
type Result struct {
	FirstRun bool
	Dir      string
	Skipped  bool
}

// Ensure extracts the embedded bundle into dir unless the stamp says this exact
// version is already installed.
//
// The bundle FS must contain "manifest.json" and "bundle.tar.gz". force
// re-extracts even when the stamp matches.
func Ensure(bundle fs.FS, dir string, force bool) (*Result, error) {
	manifestData, err := fs.ReadFile(bundle, "manifest.json")
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}
	manifest, err := ParseManifest(manifestData)
	if err != nil {
		return nil, err
	}
	if manifest.GOOS != "" && manifest.GOOS != runtime.GOOS {
		return nil, fmt.Errorf("bundle is for %s, but this is %s", manifest.GOOS, runtime.GOOS)
	}
	if manifest.GOARCH != "" && manifest.GOARCH != runtime.GOARCH {
		return nil, fmt.Errorf("bundle is for %s, but this is %s", manifest.GOARCH, runtime.GOARCH)
	}

	archive, err := bundle.Open("bundle.tar.gz")
	if err != nil {
		return nil, fmt.Errorf("open bundle: %w", err)
	}
	defer func() { _ = archive.Close() }()

	first, err := ensureArchive(manifest, archive, dir, force)
	if err != nil {
		return nil, err
	}
	return &Result{FirstRun: first, Dir: dir, Skipped: !first}, nil
}

func ensureArchive(manifest *Manifest, archive io.Reader, dir string, force bool) (bool, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, fmt.Errorf("create install dir: %w", err)
	}

	unlock, err := lockDir(dir)
	if err != nil {
		return false, err
	}
	defer unlock()

	if !force {
		if stamp, err := readStamp(dir); err == nil && stampMatches(stamp, manifest, dir) {
			return false, nil
		}
	}

	staging, err := os.MkdirTemp(dir, ".staging-")
	if err != nil {
		return false, fmt.Errorf("create staging dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(staging) }()

	if err := extractArchive(archive, staging); err != nil {
		return false, err
	}
	if err := verifyEntries(manifest, staging); err != nil {
		return false, err
	}
	if err := backupExisting(dir); err != nil {
		return false, err
	}
	if err := promoteEntries(manifest, staging, dir); err != nil {
		return false, err
	}
	if err := writeStamp(dir, manifest); err != nil {
		return false, err
	}
	return true, nil
}

// extractArchive unpacks the tar.gz into dst, refusing paths that escape it.
func extractArchive(archive io.Reader, dst string) error {
	gz, err := gzip.NewReader(archive)
	if err != nil {
		return fmt.Errorf("open gzip: %w", err)
	}
	defer func() { _ = gz.Close() }()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read tar: %w", err)
		}
		name := filepath.ToSlash(filepath.Clean(strings.TrimPrefix(hdr.Name, "./")))
		if name == "." || name == "" {
			continue
		}
		if strings.HasPrefix(name, "../") || filepath.IsAbs(name) {
			return fmt.Errorf("bundle entry %q escapes the install dir", hdr.Name)
		}
		target := filepath.Join(dst, filepath.FromSlash(name))
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, fs.FileMode(hdr.Mode).Perm())
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				_ = out.Close()
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
		default:
			// Symlinks/devices are not part of the documented payload.
			continue
		}
	}
}

// verifyEntries checks every manifest entry's sha256 in the staging tree.
func verifyEntries(manifest *Manifest, staging string) error {
	for _, e := range manifest.Entries {
		if e.SHA256 == "" {
			return fmt.Errorf("manifest entry %q has no sha256", e.File)
		}
		got, err := fileSHA256(filepath.Join(staging, filepath.FromSlash(e.File)))
		if err != nil {
			return fmt.Errorf("%s: %w", e.File, err)
		}
		if !strings.EqualFold(got, e.SHA256) {
			return fmt.Errorf("%s: checksum mismatch (manifest %s, payload %s)", e.File, e.SHA256, got)
		}
	}
	return nil
}

// backupExisting keeps the current suwu as suwu.prev before it is replaced
// ("keep it first, then copy").
func backupExisting(dir string) error {
	src := filepath.Join(dir, MainBinary)
	info, err := os.Stat(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("read existing suwu: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, MainBinary+".prev"), data, info.Mode().Perm()); err != nil {
		return fmt.Errorf("back up existing suwu: %w", err)
	}
	return nil
}

// promoteEntries moves each staged file into place, replacing the target. The
// main binary is moved first so a crash leaves a usable suwu when possible.
func promoteEntries(manifest *Manifest, staging, dir string) error {
	entries := append([]Entry(nil), manifest.Entries...)
	sortMainFirst(entries)
	for _, e := range entries {
		src := filepath.Join(staging, filepath.FromSlash(e.File))
		dst := filepath.Join(dir, filepath.FromSlash(e.File))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		// Ensure the executable bit is what the manifest says even on a
		// permissive umask or an archive that lost the mode.
		if mode, err := parseMode(e.Mode); err == nil && mode&0o111 != 0 {
			_ = os.Chmod(src, mode)
		}
		if err := os.Rename(src, dst); err != nil {
			return fmt.Errorf("install %s: %w", e.File, err)
		}
	}
	return nil
}

func sortMainFirst(entries []Entry) {
	for i, e := range entries {
		if e.File == MainBinary && i != 0 {
			copy(entries[1:i+1], entries[:i])
			entries[0] = e
			return
		}
	}
}

func readStamp(dir string) (*Stamp, error) {
	data, err := os.ReadFile(filepath.Join(dir, StampFile))
	if err != nil {
		return nil, err
	}
	var s Stamp
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// stampMatches is the idempotency check: same schema/version/platform and every
// file present with its executable bit. File contents are deliberately not
// hashed here so a bundled tool that self-updates is not overwritten until the
// next suwu-max version.
func stampMatches(stamp *Stamp, manifest *Manifest, dir string) bool {
	if stamp.Schema != manifest.Schema ||
		stamp.Version != manifest.Version ||
		stamp.GOOS != manifest.GOOS ||
		stamp.GOARCH != manifest.GOARCH {
		return false
	}
	for _, e := range manifest.Entries {
		info, err := os.Stat(filepath.Join(dir, filepath.FromSlash(e.File)))
		if err != nil || !info.Mode().IsRegular() {
			return false
		}
		mode, err := parseMode(e.Mode)
		if err == nil && mode&0o111 != 0 && info.Mode()&0o111 == 0 {
			return false
		}
	}
	return true
}

func writeStamp(dir string, manifest *Manifest) error {
	stamp := Stamp{
		Schema:      manifest.Schema,
		Version:     manifest.Version,
		GOOS:        manifest.GOOS,
		GOARCH:      manifest.GOARCH,
		ExtractedAt: time.Now().UTC().Format(time.RFC3339),
		Files:       make([]string, 0, len(manifest.Entries)),
	}
	for _, e := range manifest.Entries {
		stamp.Files = append(stamp.Files, e.File)
	}
	data, err := json.MarshalIndent(stamp, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, StampFile+".tmp")
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("write stamp: %w", err)
	}
	return os.Rename(tmp, filepath.Join(dir, StampFile))
}

func fileSHA256(file string) (string, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func parseMode(s string) (fs.FileMode, error) {
	var v uint64
	if _, err := fmt.Sscanf(s, "%o", &v); err != nil {
		return 0, err
	}
	return fs.FileMode(v), nil
}

// BundlePath returns the extraction target below home, used by the CLI.
func BundlePath(home string) string {
	return filepath.Join(home, ".suwu", "bin")
}

// CleanRelative normalises a bundle-relative path (exported for the builder
// script's tests).
func CleanRelative(p string) string {
	return path.Clean(filepath.ToSlash(p))
}
