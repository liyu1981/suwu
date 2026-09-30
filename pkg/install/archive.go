package install

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"

	"suwu/pkg/background"
	"suwu/pkg/extension"
)

// idGrammar describes the id rule in error messages. Both kinds validate ids
// with their own regexp (extension.ValidID / background.ValidID); this is only
// the human-readable form of it.
const idGrammar = "lowercase letters, digits, '-' or '_', starting with a letter or digit"

// noisePrefixes are archive members produced by packaging tools rather than the
// author. They are skipped so a Finder or Windows round-trip still installs.
var noisePrefixes = []string{"__MACOSX/"}

const noiseFile = ".DS_Store"

// noisePath reports whether an archive member is packaging noise.
func noisePath(name string) bool {
	for _, p := range noisePrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return path.Base(name) == noiseFile
}

// Layout is the expected archive shape for a kind, and the prefixes accepted in
// place of the canonical one. Both come from the same constants the server
// reads from, so the archive contract cannot drift from the data dir.
func (k Kind) Layout() (canonical string, accepted []string) {
	switch k {
	case KindBackground:
		// background.DirName is "background/webgpu".
		accepted = []string{background.DirName, "webgpu"}
		return background.DirName, accepted
	default:
		// extension.DirName is "extension"; the legacy plural is still accepted
		// so an archive exported by an older build installs.
		return extension.DirName, []string{extension.DirName, extension.LegacyDirName}
	}
}

// archiveRoot identifies the single payload directory in an archive.
type archiveRoot struct {
	// id is the directory name, i.e. the installed id.
	id string
	// prefix is the accepted prefix that matched, empty for the bare form.
	prefix string
}

// findArchiveRoot works out the payload root from the archive's member names.
//
// The archive must contain exactly one payload directory: either
// <prefix>/<id>/... or a bare <id>/... . Anything else — two candidates, no
// candidate, a file at the top level — is an error, because guessing which
// directory to install would be worse than refusing.
func findArchiveRoot(kind Kind, names []string) (archiveRoot, error) {
	canonical, accepted := kind.Layout()

	// Collect candidate ids per accepted prefix, in the order the prefixes are
	// listed (canonical first), so a canonical layout always wins.
	found := map[string]string{} // id -> matched prefix
	for _, name := range names {
		if noisePath(name) {
			continue
		}
		clean := path.Clean(name)
		segs := strings.Split(clean, "/")
		if len(segs) < 2 {
			continue // a top-level file is not a payload root
		}
		for _, prefix := range accepted {
			psegs := strings.Split(prefix, "/")
			if len(segs) < len(psegs)+1 || !equalSegs(segs[:len(psegs)], psegs) {
				continue
			}
			id := segs[len(psegs)]
			if id == "" || id == "." || id == ".." {
				continue
			}
			// First prefix to claim an id keeps it, and the canonical prefix is
			// always consulted before the alternatives.
			if _, ok := found[id]; !ok {
				found[id] = prefix
			}
			break
		}
	}

	// The bare form: a single top-level directory that is not itself a prefix
	// segment, holding the kind's manifest at its root. The manifest
	// requirement is what keeps a stray top-level folder (a docs/ directory in
	// a source archive, say) from being mistaken for a payload.
	bare := map[string]bool{}
	for _, name := range names {
		if noisePath(name) {
			continue
		}
		segs := strings.Split(path.Clean(name), "/")
		if len(segs) != 2 {
			continue
		}
		top := segs[0]
		if top == canonical || isPrefixSegment(top, accepted) {
			continue
		}
		if segs[1] != manifestPath(kind) || !kind.ValidID(top) {
			continue
		}
		bare[top] = true
	}

	ids := make([]string, 0, len(found)+len(bare))
	for id := range found {
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		// No prefixed payload. A single bare top-level directory is accepted so
		// a hand-zipped extension directory still works.
		bareIDs := make([]string, 0, len(bare))
		for id := range bare {
			if kind.ValidID(id) {
				bareIDs = append(bareIDs, id)
			}
		}
		if len(bareIDs) == 1 {
			return archiveRoot{id: bareIDs[0]}, nil
		}
		if len(bareIDs) > 1 {
			sort.Strings(bareIDs)
			return archiveRoot{}, fmt.Errorf("archive has no %s/ prefix and %d top-level directories (%s); "+
				"zip exactly one item as %s/<id>/…", canonical, len(bareIDs), strings.Join(bareIDs, ", "), canonical)
		}
		return archiveRoot{}, fmt.Errorf("archive has no %s/<id>/ directory (found %d usable entries); "+
			"expected %s/<id>/…", canonical, len(names), canonical)
	}
	if len(ids) > 1 {
		sort.Strings(ids)
		return archiveRoot{}, fmt.Errorf("archive contains %d payload directories (%s); zip one item at a time",
			len(ids), strings.Join(ids, ", "))
	}
	id := ids[0]
	if !kind.ValidID(id) {
		return archiveRoot{}, fmt.Errorf("invalid %s id %q in the archive (want %s)", kind.Label(), id, idGrammar)
	}
	return archiveRoot{id: id, prefix: found[id]}, nil
}

// equalSegs compares path segments exactly (no case folding: ids are lowercase).
func equalSegs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// isPrefixSegment reports whether seg is the first segment of an accepted prefix.
func isPrefixSegment(seg string, accepted []string) bool {
	for _, prefix := range accepted {
		if strings.Split(prefix, "/")[0] == seg {
			return true
		}
	}
	return false
}

// FromArchive installs one item from a zip archive.
//
// The archive's file list, names, declared sizes and mode bits are all
// attacker-controlled, so every one is checked (see the guards below). Files
// are staged, validated by the kind's resolver, then renamed into place; a
// rejected archive leaves the data directory untouched.
func FromArchive(kind Kind, r io.ReaderAt, size int64, opt Options) (Item, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return Item{}, fmt.Errorf("read archive: %w", err)
	}
	if len(zr.File) == 0 {
		return Item{}, errors.New("archive is empty")
	}

	names := make([]string, 0, len(zr.File))
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	root, err := findArchiveRoot(kind, names)
	if err != nil {
		return Item{Kind: kind, ID: root.id}, err
	}

	stage, err := NewStage(opt.DataDir, kind, root.id)
	if err != nil {
		return Item{Kind: kind, ID: root.id}, err
	}
	defer func() { _ = stage.Discard() }()

	// The prefix every payload member must start with, so an archive cannot
	// smuggle a second top-level directory past findArchiveRoot.
	prefix := ""
	if root.prefix != "" {
		prefix = root.prefix + "/" + root.id + "/"
	} else {
		prefix = root.id + "/"
	}

	for _, f := range zr.File {
		if noisePath(f.Name) {
			continue
		}
		info := f.FileInfo()
		if info.IsDir() {
			continue // parents are created on demand
		}
		rel, err := payloadRel(prefix, f.Name)
		if err != nil {
			return Item{Kind: kind, ID: root.id}, err
		}
		if !isRegularZipEntry(f) {
			return Item{Kind: kind, ID: root.id}, fmt.Errorf("%s: not a regular file (mode %v)", f.Name, info.Mode())
		}
		// The declared size is a cheap early reject; the actual copy is
		// bounded again by Stage.WriteFile.
		if f.UncompressedSize64 > MaxFileBytes {
			return Item{Kind: kind, ID: root.id}, fmt.Errorf("%s: declared %d bytes, over the %d MiB per-file limit",
				f.Name, f.UncompressedSize64, MaxFileBytes>>20)
		}
		rc, err := f.Open()
		if err != nil {
			return Item{Kind: kind, ID: root.id}, fmt.Errorf("%s: %w", f.Name, err)
		}
		_, writeErr := stage.WriteFile(rel, rc)
		closeErr := rc.Close()
		if writeErr != nil {
			return Item{Kind: kind, ID: root.id}, fmt.Errorf("%s: %w", f.Name, writeErr)
		}
		if closeErr != nil {
			return Item{Kind: kind, ID: root.id}, fmt.Errorf("%s: %w", f.Name, closeErr)
		}
	}
	return stage.Commit(opt)
}

// payloadRel maps an archive member name to a payload-relative path, rejecting
// anything outside the payload directory and any non-regular member.
func payloadRel(prefix, name string) (string, error) {
	if !strings.HasPrefix(name, prefix) {
		return "", fmt.Errorf("archive entry %q is outside %q", name, prefix)
	}
	rel := strings.TrimPrefix(name, prefix)
	if rel == "" {
		return "", fmt.Errorf("archive entry %q has no payload", name)
	}
	clean, err := cleanRel(rel)
	if err != nil {
		return "", fmt.Errorf("archive entry: %w", err)
	}
	return clean, nil
}

// isRegularZipEntry rejects symlinks, devices, FIFOs and sockets. A staged
// tree of only regular files and directories is the one shape the server and
// the browser can be trusted with.
func isRegularZipEntry(f *zip.File) bool {
	mode := f.Mode()
	if mode&os.ModeSymlink != 0 {
		return false
	}
	if mode&(os.ModeDevice|os.ModeCharDevice|os.ModeNamedPipe|os.ModeSocket) != 0 {
		return false
	}
	if mode&os.ModeIrregular != 0 {
		return false
	}
	// A regular file either has no type bits at all or explicitly says regular.
	// ModeType is zero for both, so this is the default-true branch; the checks
	// above are what matter.
	return true
}

// FromArchiveFile is FromArchive from a path on disk.
func FromArchiveFile(kind Kind, file string, opt Options) (Item, error) {
	info, err := os.Stat(file)
	if err != nil {
		return Item{Kind: kind}, err
	}
	if info.IsDir() {
		return Item{Kind: kind}, fmt.Errorf("%s is a directory", file)
	}
	f, err := os.Open(file)
	if err != nil {
		return Item{Kind: kind}, err
	}
	defer func() { _ = f.Close() }()
	return FromArchive(kind, f, info.Size(), opt)
}
