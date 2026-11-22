package tools

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Limits for one tool. Tools are single binaries, but `pig` is already ~30 MiB
// compressed and a future tool could ship a runtime beside it, so these are
// generous while still bounding what a hostile or broken download can do.
const (
	// MaxArchiveBytes bounds a downloaded archive.
	MaxArchiveBytes = 128 << 20
	// MaxEntryBytes bounds one extracted file.
	MaxEntryBytes = 256 << 20
	// MaxTotalBytes bounds everything one tool extracts.
	MaxTotalBytes = 512 << 20
	// MaxMembers bounds how many archive members are examined at all, so a
	// crafted archive with millions of entries is refused before it is read.
	MaxMembers = 4096
)

// want is one declared file, resolved from the catalog.
type want struct {
	file string
	mode os.FileMode
}

// wants validates and resolves a spec's declared entries. A Spec can come from
// an embedded payload manifest rather than from the catalog, so the path and
// mode rules are re-checked here instead of being trusted.
func wants(spec Spec) ([]want, error) {
	if len(spec.Entries) == 0 {
		return nil, errors.New("install: the tool declares no files")
	}
	out := make([]want, 0, len(spec.Entries))
	seen := make(map[string]bool, len(spec.Entries))
	for _, e := range spec.Entries {
		if !safeRel(e.File) {
			return nil, fmt.Errorf("install: %q is not a safe relative path", e.File)
		}
		if !modeRe.MatchString(e.Mode) {
			return nil, fmt.Errorf("install: %q has mode %q, want something like 0755", e.File, e.Mode)
		}
		v, err := strconv.ParseUint(e.Mode, 8, 32)
		if err != nil {
			return nil, fmt.Errorf("install: %q mode %q: %w", e.File, e.Mode, err)
		}
		mode := os.FileMode(v)
		if mode&0o7000 != 0 || mode&0o002 != 0 {
			return nil, fmt.Errorf("install: %q must not be setuid/setgid/sticky or world-writable", e.File)
		}
		if seen[e.File] {
			return nil, fmt.Errorf("install: %q is declared twice", e.File)
		}
		seen[e.File] = true
		out = append(out, want{file: e.File, mode: mode})
	}
	return out, nil
}

// Extract unpacks only the declared entries of spec from src into dst.
//
// Members whose strip-normalised name is not declared are ignored rather than
// written: a release archive that also carries completions or a `.app` bundle
// installs exactly what the catalog says, and nothing else ever lands in the bin
// directory.
func Extract(spec Spec, src, dst string, declared []want) error {
	switch spec.Archive {
	case ArchiveNone:
		return extractBare(spec, src, dst, declared)
	case ArchiveTarGz:
		return extractTar(spec, src, dst, declared)
	case ArchiveZip:
		return extractZip(spec, src, dst, declared)
	default:
		return fmt.Errorf("install: unknown archive %q", spec.Archive)
	}
}

func extractBare(spec Spec, src, dst string, declared []want) error {
	if len(declared) != 1 {
		return errors.New("install: a bare binary declares exactly one file")
	}
	w := declared[0]
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("install: open %s: %w", filepath.Base(src), err)
	}
	defer func() { _ = in.Close() }()
	return writeEntry(dst, w, in)
}

func extractTar(spec Spec, src, dst string, declared []want) error {
	f, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("install: open %s: %w", filepath.Base(src), err)
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("install: unpack %s: %w", filepath.Base(src), err)
	}
	defer func() { _ = gz.Close() }()

	byName := index(declared)
	written := 0
	var total int64
	members := 0
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("install: read archive: %w", err)
		}
		if members++; members > MaxMembers {
			return fmt.Errorf("install: archive has more than %d members", MaxMembers)
		}
		switch hdr.Typeflag {
		case tar.TypeReg:
		case tar.TypeDir, tar.TypeXGlobalHeader, tar.TypeXHeader:
			continue
		default:
			// Symlinks, hard links, devices and FIFOs have no place in a tool
			// payload, and following one would be a way out of the bin dir.
			return fmt.Errorf("install: %s: unsupported archive entry type %q", hdr.Name, hdr.Typeflag)
		}
		rel, ok, err := memberName(hdr.Name, spec.Strip)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		w, declared := byName[rel]
		if !declared {
			continue
		}
		if hdr.Size > MaxEntryBytes {
			return fmt.Errorf("install: %s is larger than %d MiB", rel, MaxEntryBytes>>20)
		}
		if total+hdr.Size > MaxTotalBytes {
			return fmt.Errorf("install: payload exceeds %d MiB", MaxTotalBytes>>20)
		}
		if err := writeEntry(dst, w, tr); err != nil {
			return err
		}
		total += hdr.Size
		written++
		delete(byName, rel)
	}
	return checkAllWritten(spec, byName, written)
}

func extractZip(spec Spec, src, dst string, declared []want) error {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return fmt.Errorf("install: open %s: %w", filepath.Base(src), err)
	}
	defer func() { _ = zr.Close() }()
	if len(zr.File) > MaxMembers {
		return fmt.Errorf("install: archive has more than %d members", MaxMembers)
	}
	byName := index(declared)
	written := 0
	var total int64
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if !f.Mode().IsRegular() {
			return fmt.Errorf("install: %s: unsupported archive entry type %s", f.Name, f.Mode().Type())
		}
		rel, ok, err := memberName(f.Name, spec.Strip)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		w, declared := byName[rel]
		if !declared {
			continue
		}
		if f.UncompressedSize64 > MaxEntryBytes {
			return fmt.Errorf("install: %s is larger than %d MiB", rel, MaxEntryBytes>>20)
		}
		if total+int64(f.UncompressedSize64) > MaxTotalBytes {
			return fmt.Errorf("install: payload exceeds %d MiB", MaxTotalBytes>>20)
		}
		rc, err := f.Open()
		if err != nil {
			return fmt.Errorf("install: %s: %w", rel, err)
		}
		err = writeEntry(dst, w, rc)
		_ = rc.Close()
		if err != nil {
			return err
		}
		total += int64(f.UncompressedSize64)
		written++
		delete(byName, rel)
	}
	return checkAllWritten(spec, byName, written)
}

func index(declared []want) map[string]want {
	m := make(map[string]want, len(declared))
	for _, w := range declared {
		m[w.file] = w
	}
	return m
}

func checkAllWritten(spec Spec, missing map[string]want, written int) error {
	if len(missing) == 0 {
		return nil
	}
	names := make([]string, 0, len(missing))
	for name := range missing {
		names = append(names, name)
	}
	// Deterministic messages: the first missing name is what a user reads.
	first := names[0]
	for _, name := range names {
		if name < first {
			first = name
		}
	}
	return fmt.Errorf("install: %s: %q is not in %s", spec.Name, first, spec.URL)
}

// memberName applies the strip prefix. A name that could escape the staging
// directory — absolute, a traversal segment, a backslash separator or a volume
// name — is an error for the whole archive rather than a skipped member: the
// archive was built wrong or built to attack, and either way it is not ours to
// guess at.
func memberName(name string, strip int) (string, bool, error) {
	if name == "" {
		return "", false, nil
	}
	if strings.ContainsRune(name, 0) || strings.ContainsRune(name, '\\') {
		return "", false, fmt.Errorf("install: %q: bad path separator", name)
	}
	if strings.HasPrefix(name, "/") || (len(name) >= 2 && name[1] == ':') {
		return "", false, fmt.Errorf("install: %q: absolute path in archive", name)
	}
	segs := make([]string, 0, 8)
	for _, seg := range strings.Split(name, "/") {
		switch seg {
		case "", ".":
			continue
		case "..":
			return "", false, fmt.Errorf("install: %q: traversal in archive", name)
		}
		segs = append(segs, seg)
	}
	if len(segs) <= strip {
		return "", false, nil
	}
	rel := strings.Join(segs[strip:], "/")
	if rel == "" {
		return "", false, nil
	}
	return rel, true, nil
}

// writeEntry writes one declared file with its declared mode, refusing to
// overwrite (a duplicate entry in an archive is a packaging bug) and refusing to
// write through a symlink.
func writeEntry(dst string, w want, r io.Reader) error {
	target := filepath.Join(dst, filepath.FromSlash(w.file))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fmt.Errorf("install: %s: %w", w.file, err)
	}
	if info, err := os.Lstat(target); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("install: %s is a symlink in the staging dir", w.file)
	}
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, w.mode.Perm())
	if err != nil {
		return fmt.Errorf("install: %s: %w", w.file, err)
	}
	n, copyErr := io.Copy(out, io.LimitReader(r, MaxEntryBytes+1))
	closeErr := out.Close()
	if copyErr != nil {
		return fmt.Errorf("install: %s: %w", w.file, copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("install: %s: %w", w.file, closeErr)
	}
	if n > MaxEntryBytes {
		return fmt.Errorf("install: %s is larger than %d MiB", w.file, MaxEntryBytes>>20)
	}
	// Apply the declared mode explicitly: the umask can only take bits away, but
	// an archive entry's own mode must never win over the catalog's.
	if err := os.Chmod(target, w.mode.Perm()); err != nil {
		return fmt.Errorf("install: %s: %w", w.file, err)
	}
	return nil
}
