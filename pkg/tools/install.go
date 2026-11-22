package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"suwu/pkg/bindir"
)

// StampSchema is the stamp format this build writes and reads.
const StampSchema = 1

// Where an installed tool came from. The distinction is what decides precedence
// when the suwu-max payload and an explicit install both want the same file
// (docs/TOOLS_PLAN.md §7.1).
const (
	// OriginTools is an install from the catalog, by CLI or by the settings page.
	OriginTools = "tools"
	// OriginMax is a file the suwu-max payload put there.
	OriginMax = "suwu-max"
)

// ErrNoStamp means the tool is not installed by Suwu (it may still be a file in
// the bin dir that somebody else put there).
var ErrNoStamp = errors.New("no stamp: not installed by suwu tools")

// Spec is everything an install needs, independent of where the bytes come
// from: the catalog (a download), the suwu-max payload (an embedded archive), or
// a directory the caller already unpacked.
type Spec struct {
	Name    string
	Version string
	GOOS    string
	GOARCH  string
	Archive string
	Strip   int
	Entries []Entry
	// SHA256 is the archive's digest. It may be empty only when the caller has
	// already verified the bytes (the bundle checker).
	SHA256 string
	// URL is reported in errors and recorded in the stamp.
	URL string
}

// SpecFrom builds the install spec for one catalog tool on one platform.
func SpecFrom(t *Tool, p Platform, goos, goarch string) Spec {
	return Spec{
		Name:    t.Name,
		Version: t.Version,
		GOOS:    goos,
		GOARCH:  goarch,
		Archive: p.Archive,
		Strip:   p.Strip,
		Entries: p.Entries,
		SHA256:  p.SHA256,
		URL:     p.URL,
	}
}

// Options controls one install.
type Options struct {
	// DataDir is the Suwu data directory; the bin dir is <dataDir>/bin.
	DataDir string
	// Force replaces an existing install even when it is the same version.
	Force bool
	// DryRun downloads and verifies, then discards without touching the bin dir.
	DryRun bool
	// Origin defaults to OriginTools. The bundle passes OriginMax.
	Origin string
	// Client is the HTTP transport; nil means a client with a 5-minute budget.
	Client *http.Client
	// Progress, when set, receives the download counters.
	Progress func(name string, done, total int64)
	// LockHeld says the caller already holds bindir.Lock for this data dir, as
	// the suwu-max bootstrap does for its whole run. Taking the lock twice from
	// one process would deadlock, so the caller must be right about this.
	LockHeld bool
}

func (o Options) origin() string {
	if o.Origin == "" {
		return OriginTools
	}
	return o.Origin
}

// Result reports what an install did.
type Result struct {
	Name     string
	Version  string
	Origin   string
	BinDir   string
	Files    []string
	Bytes    int64
	Replaced bool
	// Skipped means the same version was already installed and Force was off.
	Skipped bool
	// Warnings are non-fatal notes (a file that was already gone, …).
	Warnings []string
}

// Stamp records one complete install. It is written last, so its presence always
// means every file it lists is in place.
type Stamp struct {
	Schema      int         `json:"schema"`
	Name        string      `json:"name"`
	Version     string      `json:"version"`
	GOOS        string      `json:"goos"`
	GOARCH      string      `json:"goarch"`
	Origin      string      `json:"origin"`
	InstalledAt string      `json:"installedAt"`
	Source      string      `json:"source,omitempty"`
	Files       []StampFile `json:"files"`
}

// StampFile is one file a tool owns.
type StampFile struct {
	File   string `json:"file"`
	Mode   string `json:"mode"`
	SHA256 string `json:"sha256,omitempty"`
}

// Path is where a tool's binary lives.
func Path(dataDir, name string) string { return filepath.Join(bindir.Dir(dataDir), name) }

// ReadStamp returns one tool's stamp.
func ReadStamp(dataDir, name string) (Stamp, error) {
	binDir := bindir.Dir(dataDir)
	data, err := os.ReadFile(bindir.StampPath(binDir, name))
	if err != nil {
		if os.IsNotExist(err) {
			return Stamp{}, ErrNoStamp
		}
		return Stamp{}, err
	}
	var s Stamp
	if err := json.Unmarshal(data, &s); err != nil {
		return Stamp{}, fmt.Errorf("read stamp for %s: %w", name, err)
	}
	return s, nil
}

// Stamps returns every stamp in the bin dir, keyed by tool name. A malformed
// stamp is reported in the map's error instead of hiding the rest.
func Stamps(dataDir string) (map[string]Stamp, error) {
	dir := bindir.StampDir(bindir.Dir(dataDir))
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]Stamp{}, nil
		}
		return nil, err
	}
	out := make(map[string]Stamp, len(entries))
	var firstErr error
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".json")
		s, err := ReadStamp(dataDir, name)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		out[name] = s
	}
	return out, firstErr
}

// InstallFromURL downloads, verifies and installs one tool from the catalog.
func InstallFromURL(ctx context.Context, spec Spec, opt Options) (Result, error) {
	if spec.URL == "" {
		return Result{}, fmt.Errorf("install %s: no download url", spec.Name)
	}
	return install(spec, opt, func(stage string) error {
		archive, err := download(ctx, spec, opt)
		if err != nil {
			return err
		}
		defer func() { _ = os.Remove(archive) }()
		declared, err := wants(spec)
		if err != nil {
			return err
		}
		return Extract(spec, archive, stage, declared)
	})
}

// InstallFromArchive installs one tool from bytes the caller already holds — the
// suwu-max payload. The digest in spec is still verified, so a corrupted build
// is caught before anything is written.
func InstallFromArchive(spec Spec, opt Options, r io.Reader, size int64) (Result, error) {
	return install(spec, opt, func(stage string) error {
		archive, actual, err := spool(r, spec.Name, opt.DataDir)
		if err != nil {
			return err
		}
		defer func() { _ = os.Remove(archive) }()
		if spec.SHA256 != "" {
			if err := verifyDigest(spec, actual); err != nil {
				return err
			}
		}
		declared, err := wants(spec)
		if err != nil {
			return err
		}
		return Extract(spec, archive, stage, declared)
	})
}

// InstallFromFiles installs a tool whose files the caller already extracted and
// verified (the suwu-max payload does exactly that with its manifest hashes).
func InstallFromFiles(spec Spec, opt Options, sourceDir string) (Result, error) {
	return install(spec, opt, func(stage string) error {
		declared, err := wants(spec)
		if err != nil {
			return err
		}
		for _, w := range declared {
			src := filepath.Join(sourceDir, filepath.FromSlash(w.file))
			in, err := os.Open(src)
			if err != nil {
				return fmt.Errorf("install %s: %s: %w", spec.Name, w.file, err)
			}
			err = writeEntry(stage, w, in)
			_ = in.Close()
			if err != nil {
				return err
			}
		}
		return nil
	})
}

// install is the one path every source shares: lock, skip, stage, verify, commit,
// stamp.
func install(spec Spec, opt Options, produce func(stage string) error) (Result, error) {
	res := Result{Name: spec.Name, Version: spec.Version, Origin: opt.origin()}
	if err := validateSpec(spec); err != nil {
		return res, err
	}
	if err := validateDataDir(opt.DataDir); err != nil {
		return res, err
	}
	binDir, err := bindir.Ensure(opt.DataDir)
	if err != nil {
		return res, err
	}
	res.BinDir = binDir

	if !opt.LockHeld {
		unlock, err := bindir.Lock(opt.DataDir)
		if err != nil {
			return res, err
		}
		defer unlock()
	}

	// A stamp is proof we put these files there, so both an upgrade of our own
	// install and taking over a bundled one replace them without --force. That
	// "both" is the whole point of the stamp: update means replace. Only a file
	// no stamp claims (somebody's hand-installed copy) needs --force.
	allowReplace := opt.Force
	var previous []string
	if existing, err := ReadStamp(opt.DataDir, spec.Name); err == nil {
		allowReplace = true
		previous = stampFiles(existing)
		if existing.Origin == res.Origin && existing.Version == spec.Version && !opt.Force {
			res.Skipped = true
			res.Files = previous
			return res, nil
		}
	}

	stageRoot := filepath.Join(binDir, bindir.StageDirName)
	if err := os.MkdirAll(stageRoot, 0o755); err != nil {
		return res, fmt.Errorf("create staging dir: %w", err)
	}
	stage, err := os.MkdirTemp(stageRoot, spec.Name+"-")
	if err != nil {
		return res, fmt.Errorf("create staging dir: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(stage)
		// The stage root only exists while something is being installed.
		_ = os.Remove(stageRoot)
	}()

	if err := produce(stage); err != nil {
		return res, err
	}
	staged, bytes, err := verifyStage(binDir, stage, spec)
	if err != nil {
		return res, err
	}
	res.Bytes = bytes
	for _, f := range staged {
		res.Files = append(res.Files, f.File)
	}
	if opt.DryRun {
		return res, nil
	}

	replaced, err := commit(binDir, stage, staged, allowReplace)
	res.Replaced = replaced
	if err != nil {
		return res, err
	}
	stamp := Stamp{
		Schema:      StampSchema,
		Name:        spec.Name,
		Version:     spec.Version,
		GOOS:        spec.GOOS,
		GOARCH:      spec.GOARCH,
		Origin:      res.Origin,
		InstalledAt: time.Now().UTC().Format(time.RFC3339),
		Source:      spec.URL,
		Files:       staged,
	}
	if err := writeStamp(binDir, stamp); err != nil {
		return res, err
	}
	// Only now, with the stamp in place, are the replaced files dropped, and any
	// file the previous version owned but this one does not (a tool whose payload
	// changed shape) is removed — an upgrade must not leave orphans behind.
	dropBackups(binDir, staged)
	res.Warnings = append(res.Warnings, prunePrevious(binDir, previous, staged)...)
	return res, nil
}

// prunePrevious removes files the previous install owned that this one does not.
// It is deliberately timid: a path is only removed when it is inside the bin dir,
// not a symlink, and no longer claimed by the new stamp.
func prunePrevious(binDir string, previous []string, current []StampFile) []string {
	if len(previous) == 0 {
		return nil
	}
	keeping := make(map[string]bool, len(current))
	for _, f := range current {
		keeping[f.File] = true
	}
	var warnings []string
	for _, file := range previous {
		if keeping[file] {
			continue
		}
		target := filepath.Join(binDir, filepath.FromSlash(file))
		if err := bindir.Within(binDir, target); err != nil {
			continue
		}
		info, err := os.Lstat(target)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			continue
		}
		if err := os.Remove(target); err != nil {
			warnings = append(warnings, fmt.Sprintf("could not remove the old %s: %v", file, err))
			continue
		}
		pruneEmptyDirs(binDir, filepath.Dir(target))
	}
	return warnings
}

// verifyStage walks the staged tree, refuses symlinks, and returns the files with
// their digests for the stamp.
func verifyStage(binDir, stage string, spec Spec) ([]StampFile, int64, error) {
	declared, err := wants(spec)
	if err != nil {
		return nil, 0, err
	}
	var files []StampFile
	var total int64
	for i, w := range declared {
		p := filepath.Join(stage, filepath.FromSlash(w.file))
		if err := bindir.Within(stage, p); err != nil {
			return nil, 0, fmt.Errorf("%s: %w", w.file, err)
		}
		info, err := os.Lstat(p)
		if err != nil {
			return nil, 0, fmt.Errorf("install %s: %s missing from the payload", spec.Name, w.file)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return nil, 0, fmt.Errorf("install %s: %s is not a regular file", spec.Name, w.file)
		}
		sum, err := fileSHA256(p)
		if err != nil {
			return nil, 0, err
		}
		files = append(files, StampFile{File: w.file, Mode: spec.Entries[i].Mode, SHA256: sum})
		total += info.Size()
	}
	// The destination must not be a symlink: writing through one is how a tool
	// could land outside the bin dir.
	for _, f := range files {
		target := filepath.Join(binDir, filepath.FromSlash(f.File))
		if info, err := os.Lstat(target); err == nil && info.Mode()&os.ModeSymlink != 0 {
			return nil, 0, fmt.Errorf("install %s: %s is a symlink; refusing to replace it", spec.Name, f.File)
		}
	}
	return files, total, nil
}

// commit moves each staged file into the bin dir, keeping the previous file as a
// backup until the stamp is written.
func commit(binDir, stage string, files []StampFile, force bool) (bool, error) {
	replaced := false
	dir := bindir.StampDir(binDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, fmt.Errorf("create %s: %w", dir, err)
	}
	for _, f := range files {
		target := filepath.Join(binDir, filepath.FromSlash(f.File))
		if err := bindir.Within(binDir, target); err != nil {
			return replaced, fmt.Errorf("%s: %w", f.File, err)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return replaced, fmt.Errorf("prepare %s: %w", f.File, err)
		}
		if _, err := os.Lstat(target); err == nil {
			if !force {
				return replaced, fmt.Errorf("%s already exists in %s; pass --force to replace it", f.File, binDir)
			}
			replaced = true
			if err := os.Rename(target, backupPath(target)); err != nil {
				return replaced, fmt.Errorf("set aside %s: %w", f.File, err)
			}
		}
		if err := os.Rename(filepath.Join(stage, filepath.FromSlash(f.File)), target); err != nil {
			return replaced, fmt.Errorf("install %s: %w", f.File, err)
		}
	}
	return replaced, nil
}

func backupPath(target string) string {
	return fmt.Sprintf("%s.bak-%d", target, time.Now().UnixNano())
}

func dropBackups(binDir string, files []StampFile) {
	entries, err := os.ReadDir(binDir)
	if err != nil {
		return
	}
	want := make(map[string]bool, len(files))
	for _, f := range files {
		want[f.File+".bak-"] = true
	}
	for _, e := range entries {
		for prefix := range want {
			if strings.HasPrefix(e.Name(), prefix) {
				_ = os.Remove(filepath.Join(binDir, e.Name()))
			}
		}
	}
}

func writeStamp(binDir string, stamp Stamp) error {
	data, err := json.MarshalIndent(stamp, "", "  ")
	if err != nil {
		return err
	}
	path := bindir.StampPath(binDir, stamp.Name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create stamp dir: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("write stamp: %w", err)
	}
	return os.Rename(tmp, path)
}

// Uninstall removes exactly the files a stamp owns, then the stamp.
func Uninstall(opt Options, name string) (Result, error) {
	res := Result{Name: name}
	if err := validateDataDir(opt.DataDir); err != nil {
		return res, err
	}
	binDir := bindir.Dir(opt.DataDir)
	res.BinDir = binDir
	if !opt.LockHeld {
		unlock, err := bindir.Lock(opt.DataDir)
		if err != nil {
			return res, err
		}
		defer unlock()
	}

	stamp, err := ReadStamp(opt.DataDir, name)
	if err != nil {
		if errors.Is(err, ErrNoStamp) {
			return res, fmt.Errorf("%s is not installed by suwu tools (remove the file yourself if it is there)", name)
		}
		return res, err
	}
	res.Version, res.Origin = stamp.Version, stamp.Origin
	for _, f := range stampFiles(stamp) {
		target := filepath.Join(binDir, filepath.FromSlash(f))
		if err := bindir.Within(binDir, target); err != nil {
			return res, fmt.Errorf("%s: %w", f, err)
		}
		info, err := os.Lstat(target)
		if err != nil {
			res.Warnings = append(res.Warnings, f+" was already gone")
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return res, fmt.Errorf("%s is a symlink; refusing to remove it", f)
		}
		if opt.DryRun {
			res.Files = append(res.Files, f)
			continue
		}
		if err := os.Remove(target); err != nil {
			return res, fmt.Errorf("remove %s: %w", f, err)
		}
		res.Files = append(res.Files, f)
		pruneEmptyDirs(binDir, filepath.Dir(target))
	}
	if opt.DryRun {
		return res, nil
	}
	if err := os.Remove(bindir.StampPath(binDir, name)); err != nil && !os.IsNotExist(err) {
		return res, fmt.Errorf("remove stamp: %w", err)
	}
	return res, nil
}

// pruneEmptyDirs removes empty parents up to (never including) the bin dir.
func pruneEmptyDirs(binDir, dir string) {
	for dir != binDir && strings.HasPrefix(dir, binDir+string(filepath.Separator)) {
		if err := os.Remove(dir); err != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}

func stampFiles(s Stamp) []string {
	out := make([]string, 0, len(s.Files))
	for _, f := range s.Files {
		out = append(out, f.File)
	}
	sort.Strings(out)
	return out
}

// download fetches the archive to the data dir's tmp area, hashing as it goes.
func download(ctx context.Context, spec Spec, opt Options) (string, error) {
	if err := verifyDigestFormat(spec); err != nil {
		return "", err
	}
	client := opt.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Minute}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, spec.URL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "suwu-tools")
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("download %s: %w", spec.Name, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download %s: %s", spec.Name, resp.Status)
	}
	var body io.Reader = resp.Body
	if opt.Progress != nil {
		body = &countingReader{r: resp.Body, name: spec.Name, total: resp.ContentLength, cb: opt.Progress}
	}
	path, actual, err := spool(body, spec.Name, opt.DataDir)
	if err != nil {
		return "", err
	}
	if err := verifyDigest(spec, actual); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return path, nil
}

// spool writes a stream to a temp file, hashing it, with the archive cap applied
// so a hostile server cannot fill the disk.
func spool(r io.Reader, name, dataDir string) (string, string, error) {
	dir := filepath.Join(dataDir, "tmp")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", fmt.Errorf("create tmp dir: %w", err)
	}
	f, err := os.CreateTemp(dir, "tool-"+name+"-")
	if err != nil {
		return "", "", fmt.Errorf("create download file: %w", err)
	}
	path := f.Name()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(r, MaxArchiveBytes+1))
	closeErr := f.Close()
	if err != nil {
		_ = os.Remove(path)
		return "", "", fmt.Errorf("download %s: %w", name, err)
	}
	if closeErr != nil {
		_ = os.Remove(path)
		return "", "", fmt.Errorf("download %s: %w", name, closeErr)
	}
	if n > MaxArchiveBytes {
		_ = os.Remove(path)
		return "", "", fmt.Errorf("download %s is larger than %d MiB", name, MaxArchiveBytes>>20)
	}
	return path, hex.EncodeToString(h.Sum(nil)), nil
}

func verifyDigest(spec Spec, actual string) error {
	if spec.SHA256 == "" {
		return fmt.Errorf("install %s: no sha256 pin", spec.Name)
	}
	if !strings.EqualFold(spec.SHA256, actual) {
		return fmt.Errorf("install %s: checksum mismatch (catalog %s, download %s)", spec.Name, spec.SHA256, actual)
	}
	return nil
}

func verifyDigestFormat(spec Spec) error {
	if !shaRe.MatchString(spec.SHA256) {
		return fmt.Errorf("install %s: sha256 pin %q is not a digest", spec.Name, spec.SHA256)
	}
	return nil
}

func validateSpec(spec Spec) error {
	if !nameRe.MatchString(spec.Name) {
		return fmt.Errorf("install: invalid tool name %q", spec.Name)
	}
	if strings.TrimSpace(spec.Version) == "" {
		return fmt.Errorf("install %s: no version", spec.Name)
	}
	if _, err := wants(spec); err != nil {
		return err
	}
	return nil
}

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

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
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

// countingReader reports download progress without changing the byte stream.
type countingReader struct {
	r     io.Reader
	name  string
	done  int64
	total int64
	cb    func(string, int64, int64)
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.done += int64(n)
	c.cb(c.name, c.done, c.total)
	return n, err
}

// DefaultPlatform is this build's target, for callers that have no opinion.
func DefaultPlatform() (string, string) { return runtime.GOOS, runtime.GOARCH }
