// Package maxbundle implements the payload side of suwu-max: a one-shot
// installer that puts the real `suwu` binary in ~/.local/bin and the bundled
// tools in ~/.suwu/bin, then runs the app.
//
// It is a bootstrap, not a launcher. After the first run what executes is the
// normal binary, `suwu upgrade` replaces it, and suwu-max is needed again only
// to re-seed the tools on a new machine (docs/TOOLS_PLAN.md §7).
//
// The launcher embeds two files, produced by scripts/build-max.sh:
//
//	manifest.json    schema 2: the app, and each tool with its version and files
//	bundle.tar.gz    the compressed payload (suwu plus the tools)
//
// The app is written once and never downgraded by an older bundle; tools are
// installed through pkg/tools, so a bundled tool is an "offline install from a
// frozen catalog" — same staging, same hostile-archive guards, same stamps.
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

	"suwu/pkg/bindir"
	"suwu/pkg/tools"
)

// SchemaVersion is the manifest schema this build understands. Schema 1 was the
// launcher's flat file list; the bootstrap partitions the payload by owner, so
// the format changed with the model.
const SchemaVersion = 2

// MainBinary is the app the launcher installs and then execs.
const MainBinary = "suwu"

// RecordFile records what this launcher did, beside the app's data:
// <dataDir>/maxbundle.json. The per-tool truth lives in the tools' own stamps.
const RecordFile = "maxbundle.json"

// File describes one payload file.
type File struct {
	File   string `json:"file"`
	Mode   string `json:"mode"`
	SHA256 string `json:"sha256"`
}

// Tool is one bundled tool: everything pkg/tools needs to install and stamp it.
type Tool struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	License string `json:"license,omitempty"`
	Files   []File `json:"files"`
}

// Manifest describes one payload build.
type Manifest struct {
	Schema  int    `json:"schema"`
	Version string `json:"version"`
	GOOS    string `json:"goos"`
	GOARCH  string `json:"goarch"`
	App     File   `json:"app"`
	Tools   []Tool `json:"tools"`
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
	if err := validFile(&m.App); err != nil {
		return nil, fmt.Errorf("app: %w", err)
	}
	if m.App.File != MainBinary {
		return nil, fmt.Errorf("manifest app must be %q, got %q", MainBinary, m.App.File)
	}
	if len(m.Tools) == 0 {
		return nil, errors.New("manifest lists no tools")
	}
	seen := make(map[string]bool, len(m.Tools))
	for i := range m.Tools {
		t := &m.Tools[i]
		if strings.TrimSpace(t.Name) == "" || strings.ContainsAny(t.Name, "/\\.") {
			return nil, fmt.Errorf("manifest tool %d has an invalid name %q", i, t.Name)
		}
		if seen[t.Name] {
			return nil, fmt.Errorf("manifest lists %q twice", t.Name)
		}
		seen[t.Name] = true
		for j := range t.Files {
			if err := validFile(&t.Files[j]); err != nil {
				return nil, fmt.Errorf("tool %s: %w", t.Name, err)
			}
		}
	}
	return &m, nil
}

func validFile(f *File) error {
	clean := filepath.ToSlash(filepath.Clean(f.File))
	if f.File == "" || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || filepath.IsAbs(f.File) {
		return fmt.Errorf("entry %q is not a safe relative path", f.File)
	}
	f.File = clean
	if f.Mode == "" {
		f.Mode = "0644"
	}
	if _, err := parseMode(f.Mode); err != nil {
		return fmt.Errorf("entry %q: bad mode %q", f.File, f.Mode)
	}
	if !isHex64(f.SHA256) {
		return fmt.Errorf("entry %q: bad sha256", f.File)
	}
	return nil
}

func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// Options controls one bootstrap.
type Options struct {
	// DataDir is the Suwu data directory (default ~/.suwu). Tools land in its
	// bin/ subdirectory and the record beside it.
	DataDir string
	// BinDir overrides the tool directory (default <DataDir>/bin).
	BinDir string
	// AppDir is where the app goes (default ~/.local/bin).
	AppDir string
	// Force re-installs the app and every tool even when they are already there.
	Force bool
	// NoPath skips the PATH block.
	NoPath bool
}

// ToolResult is what happened to one bundled tool.
type ToolResult struct {
	Name      string
	Version   string
	Installed bool
	// Skipped is set when a newer install of the same tool is already there
	// (origin "tools"): an explicit install beats the bundle.
	Skipped bool
}

// Result reports what the bootstrap did.
type Result struct {
	DataDir      string
	BinDir       string
	AppPath      string
	AppInstalled bool
	AppSkipped   bool
	Tools        []ToolResult
	PathChanged  []string
	PathRemoved  []string
	// Warnings are non-fatal notes worth printing (a missing external
	// dependency of a bundled tool).
	Warnings []string
}

// Install extracts the payload, writes the app and installs the tools.
func Install(bundle fs.FS, opt Options) (*Result, error) {
	if bundle == nil {
		return nil, errors.New("this executable was built without a payload; build it with 'go build -tags max'")
	}
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
	res, opt, err := prepare(opt)
	if err != nil {
		return nil, err
	}

	archive, err := bundle.Open("bundle.tar.gz")
	if err != nil {
		return nil, fmt.Errorf("open bundle: %w", err)
	}
	defer func() { _ = archive.Close() }()

	// One lock for everything: the app's rename and every tool's commit are the
	// same critical section as `suwu upgrade` and a page install.
	unlock, err := bindir.Lock(opt.DataDir)
	if err != nil {
		return nil, err
	}
	defer unlock()

	stage, err := os.MkdirTemp(filepath.Join(opt.DataDir, "tmp"), "max-")
	if err != nil {
		return nil, fmt.Errorf("create staging dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(stage) }()

	if err := extractArchive(archive, stage); err != nil {
		return nil, err
	}
	if err := verifyHashes(manifest, stage); err != nil {
		return nil, err
	}

	appInstalled, err := installApp(manifest, stage, opt)
	if err != nil {
		return nil, err
	}
	res.AppInstalled = appInstalled
	res.AppSkipped = !appInstalled

	for _, tool := range manifest.Tools {
		tr, err := installTool(tool, stage, manifest, opt)
		if err != nil {
			return res, err
		}
		res.Tools = append(res.Tools, tr)
	}

	res.Warnings = dependencyWarnings(manifest)
	if err := writeRecord(res, manifest); err != nil {
		return res, err
	}
	// The tool directory is not optional: a shell opened outside Suwu should
	// find the tools the bundle just installed. `--no-path` only concerns the
	// app's own directory, which is a separate block.
	if _, err := bindir.EnsurePath(opt.BinDir, bindir.ToolsBlock); err != nil {
		fmt.Fprintf(os.Stderr, "suwu-max: could not update PATH for the tool directory: %v\n", err)
	}
	if !opt.NoPath {
		changed, removed, err := syncPath(opt.AppDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "suwu-max: could not update PATH: %v\n", err)
		}
		res.PathChanged, res.PathRemoved = changed, removed
	}
	return res, nil
}

// prepare applies the defaults and creates the directories the install writes
// into. Both are absolute: everything below is a path operation we promise.
func prepare(opt Options) (*Result, Options, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, opt, fmt.Errorf("cannot find home directory: %w", err)
	}
	if opt.DataDir == "" {
		opt.DataDir = filepath.Join(home, ".suwu")
	}
	abs, err := filepath.Abs(opt.DataDir)
	if err != nil {
		return nil, opt, err
	}
	opt.DataDir = abs
	if opt.BinDir == "" {
		opt.BinDir = bindir.Dir(opt.DataDir)
	}
	if opt.AppDir == "" {
		opt.AppDir = filepath.Join(home, ".local", "bin")
	}
	for _, dir := range []string{opt.DataDir, filepath.Join(opt.DataDir, "tmp"), opt.BinDir, opt.AppDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, opt, fmt.Errorf("create %s: %w", dir, err)
		}
	}
	return &Result{
		DataDir: opt.DataDir,
		BinDir:  opt.BinDir,
		AppPath: filepath.Join(opt.AppDir, MainBinary),
	}, opt, nil
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
		if strings.HasPrefix(name, "../") || filepath.IsAbs(name) || strings.ContainsRune(name, '\\') {
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
			if _, err := io.Copy(out, io.LimitReader(tr, 512<<20)); err != nil {
				_ = out.Close()
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
		default:
			// Symlinks, hard links and devices are not part of the payload; a
			// payload that carries one is not ours to follow.
			return fmt.Errorf("bundle entry %q has unsupported type %q", hdr.Name, hdr.Typeflag)
		}
	}
}

// verifyHashes checks every manifest file's sha256 before anything is installed.
func verifyHashes(manifest *Manifest, staging string) error {
	check := func(f File) error {
		got, err := fileSHA256(filepath.Join(staging, filepath.FromSlash(f.File)))
		if err != nil {
			return fmt.Errorf("%s: %w", f.File, err)
		}
		if !strings.EqualFold(got, f.SHA256) {
			return fmt.Errorf("%s: checksum mismatch (manifest %s, payload %s)", f.File, f.SHA256, got)
		}
		return nil
	}
	if err := check(manifest.App); err != nil {
		return err
	}
	for _, t := range manifest.Tools {
		for _, f := range t.Files {
			if err := check(f); err != nil {
				return err
			}
		}
	}
	return nil
}

// installApp writes ~/.local/bin/suwu unless it is already there.
//
// A bundle only ever seeds the app: a newer version installed by `suwu upgrade`
// is never replaced by an older wrapper, and replacing it on purpose is what
// --force is for (docs/TOOLS_PLAN.md §7, D11).
func installApp(manifest *Manifest, stage string, opt Options) (bool, error) {
	dest := filepath.Join(opt.AppDir, MainBinary)
	if _, err := os.Lstat(dest); err == nil && !opt.Force {
		return false, nil
	}
	src := filepath.Join(stage, filepath.FromSlash(manifest.App.File))
	mode, err := parseMode(manifest.App.Mode)
	if err != nil {
		return false, err
	}
	return true, writeAtomic(src, dest, mode)
}

// writeAtomic copies src to dest through a temp file in the same directory, so a
// half-written binary is never executable.
func writeAtomic(src, dest string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	tmp, err := os.CreateTemp(filepath.Dir(dest), "."+filepath.Base(dest)+"-")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := io.Copy(tmp, in); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(name, mode.Perm()); err != nil {
		return err
	}
	return os.Rename(name, dest)
}

// installTool hands one tool to pkg/tools, unless an explicit install already
// owns it.
func installTool(t Tool, stage string, manifest *Manifest, opt Options) (ToolResult, error) {
	tr := ToolResult{Name: t.Name, Version: t.Version}
	stamp, err := tools.ReadStamp(opt.DataDir, t.Name)
	if err == nil && stamp.Origin == tools.OriginTools && !opt.Force {
		tr.Skipped = true
		return tr, nil
	}
	spec := tools.Spec{
		Name:    t.Name,
		Version: t.Version,
		GOOS:    manifest.GOOS,
		GOARCH:  manifest.GOARCH,
		Archive: tools.ArchiveNone, // unused: the files are already staged
		Entries: make([]tools.Entry, 0, len(t.Files)),
		URL:     "embedded:suwu-max/" + t.Name,
	}
	for _, f := range t.Files {
		spec.Entries = append(spec.Entries, tools.Entry{File: f.File, Mode: f.Mode})
	}
	if _, err := tools.InstallFromFiles(spec, tools.Options{
		DataDir:  opt.DataDir,
		Force:    opt.Force,
		Origin:   tools.OriginMax,
		LockHeld: true, // Install holds it for the whole bootstrap
	}, stage); err != nil {
		return tr, err
	}
	tr.Installed = true
	return tr, nil
}

// Record is what the bootstrap leaves behind for `--version` and for support
// questions; the tools' own stamps remain the authority on what is installed.
type Record struct {
	Schema        int    `json:"schema"`
	BundleVersion string `json:"bundleVersion"`
	GOOS          string `json:"goos"`
	GOARCH        string `json:"goarch"`
	AppPath       string `json:"appPath"`
	BinDir        string `json:"binDir"`
	InstalledAt   string `json:"installedAt"`
}

func writeRecord(res *Result, manifest *Manifest) error {
	rec := Record{
		Schema:        SchemaVersion,
		BundleVersion: manifest.Version,
		GOOS:          manifest.GOOS,
		GOARCH:        manifest.GOARCH,
		AppPath:       res.AppPath,
		BinDir:        res.BinDir,
		InstalledAt:   time.Now().UTC().Format(time.RFC3339),
	}
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(res.DataDir, RecordFile+".tmp")
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", RecordFile, err)
	}
	return os.Rename(tmp, filepath.Join(res.DataDir, RecordFile))
}

// syncPath puts the app's directory on PATH, and drops a block that a previous
// suwu-max left pointing at the tool directory.
//
// The old launcher added ~/.suwu/bin. Under the bootstrap model this block
// only needs ~/.local/bin (where `suwu` lives); the tool directory has its own
// block, written unconditionally by Install. Rewriting the same block is what
// makes the migration automatic, and removing it entirely is right when the
// app directory is already on PATH some other way.
func syncPath(appDir string) (changed, removed []string, err error) {
	if bindir.OnPath(appDir) {
		removed, err = bindir.RemovePath(bindir.MaxBlock)
		return nil, removed, err
	}
	changed, err = bindir.EnsurePath(appDir, bindir.MaxBlock)
	return changed, nil, err
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

// BundlePath returns the tool directory below home, used by the CLI.
func BundlePath(home string) string { return bindir.Dir(filepath.Join(home, ".suwu")) }

// CleanRelative normalises a bundle-relative path (exported for the builder
// script's tests).
func CleanRelative(p string) string { return path.Clean(filepath.ToSlash(p)) }
