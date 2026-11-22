package herdr

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"suwu/pkg/tools"
)

// Binary is a runnable herdr-core.
type Binary struct {
	Path    string
	Version string
}

// BinName is the executable's name inside the release archive. The installer
// only symlinks `hc` beside it, because some window managers already own that
// name; Suwu always runs the real one.
const BinName = "herdr-core"

// VersionFile records what was extracted, so a newer release re-extracts.
const VersionFile = "herdr-core.version"

var (
	resolveMu   sync.Mutex
	resolvedBin *Binary
)

// Resolve finds a usable herdr-core:
//
//	$SUWU_HC_BIN
//	<var dir>/bin/herdr-core        (managed; embedded extraction lives here)
//	herdr-core, then hc, on PATH    (a user install)
//	the embedded release tarball    (release builds, build tag hcbin)
//	the pinned release download     (verified by sha256)
//
// The result is cached for the process; a server restart picks up an update.
func Resolve() (Binary, error) {
	resolveMu.Lock()
	defer resolveMu.Unlock()
	if resolvedBin != nil {
		return *resolvedBin, nil
	}
	bin, err := resolveUncached()
	if err != nil {
		return Binary{}, err
	}
	resolvedBin = &bin
	return bin, nil
}

// ResetResolveCache forgets the cached binary (tests, after an install).
func ResetResolveCache() {
	resolveMu.Lock()
	resolvedBin = nil
	resolveMu.Unlock()
}

func resolveUncached() (Binary, error) {
	if p := strings.TrimSpace(os.Getenv("SUWU_HC_BIN")); p != "" {
		return describe(p)
	}

	managed, err := managedPath()
	if err == nil {
		if _, statErr := os.Stat(managed); statErr == nil {
			if bin, descErr := describe(managed); descErr == nil {
				// A managed copy from a different pin is upgraded in place; if
				// that is not possible (no embedded archive, offline) the copy we
				// have still works, and the API is additive-only.
				if pinned := PinnedVersion(); pinned == "" || bin.Version == pinned {
					return bin, nil
				}
				if len(embeddedTarball()) > 0 {
					if err := installFromTarball(embeddedTarball(), managed); err == nil {
						return describe(managed)
					}
				}
				return bin, nil
			}
		}
	}

	for _, name := range []string{BinName, "hc"} {
		if p, lookErr := exec.LookPath(name); lookErr == nil {
			if bin, descErr := describe(p); descErr == nil {
				return bin, nil
			}
		}
	}

	if managed != "" {
		if data := embeddedTarball(); len(data) > 0 {
			if err := installFromTarball(data, managed); err == nil {
				_ = os.WriteFile(filepath.Join(filepath.Dir(managed), VersionFile), []byte(PinnedVersion()+"\n"), 0o644)
				return describe(managed)
			}
		}
		if err := downloadPinned(context.Background(), managed); err == nil {
			return describe(managed)
		}
	}

	return Binary{}, errors.New("herdr-core not found: install hc (https://herdr.dev/core/) or set SUWU_HC_BIN")
}

// ManagedDir is where Suwu keeps tools it downloaded or extracted.
func ManagedDir() (string, error) {
	dir := strings.TrimSpace(os.Getenv("SUWU_VAR"))
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home dir: %w", err)
		}
		dir = filepath.Join(home, ".suwu")
	}
	return filepath.Join(dir, "bin"), nil
}

func managedPath() (string, error) {
	dir, err := ManagedDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, BinName), nil
}

// describe runs --version and parses "hc 0.1.21".
func describe(path string) (Binary, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, abs, "--version").Output()
	if err != nil {
		return Binary{}, fmt.Errorf("herdr: %s --version: %w", abs, err)
	}
	version := strings.TrimSpace(string(out))
	version = strings.TrimPrefix(version, "hc ")
	version = strings.TrimSpace(strings.SplitN(version, "\n", 2)[0])
	return Binary{Path: abs, Version: version}, nil
}

// installFromTarball extracts BinName from a release archive into dest.
func installFromTarball(data []byte, dest string) error {
	dir := filepath.Dir(dest)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	body, err := readTarballEntry(data, BinName)
	if err != nil {
		return err
	}
	return writeExecutable(dest, body)
}

// readTarballEntry returns one regular file from a .tar.gz.
func readTarballEntry(data []byte, name string) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("herdr: open archive: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("herdr: read archive: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		// Releases contain `herdr-core` and, on macOS, a `Herdr Core.app`
		// bundle; the plain executable is what we want.
		if filepath.Base(hdr.Name) != name {
			continue
		}
		return io.ReadAll(tr)
	}
	return nil, fmt.Errorf("herdr: %s not found in archive", name)
}

// writeExecutable writes atomically: a running binary keeps its inode, and a
// half-copied one is never executed.
func writeExecutable(dest string, body []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".herdr-core-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return err
	}
	return os.Rename(tmpName, dest)
}

// Lock is the pinned release this build was made against.
type Lock struct {
	Version string                `json:"version"`
	Targets map[string]LockTarget `json:"targets"`
}

// LockTarget is one platform's archive.
type LockTarget struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

// CatalogName is the tool name herdr-core is pinned under in tools/catalog.json.
// One catalog means the engine a build embeds, the archive a server downloads
// and the tool the settings page installs are always the same version.
const CatalogName = "herdr-core"

// PinnedLock returns this build's herdr-core pins, read from the embedded tool
// catalog.
func PinnedLock() (Lock, error) {
	c, err := tools.Builtin()
	if err != nil {
		return Lock{}, fmt.Errorf("herdr: catalog: %w", err)
	}
	t, ok := c.Find(CatalogName)
	if !ok {
		return Lock{}, fmt.Errorf("herdr: catalog has no %s entry", CatalogName)
	}
	lock := Lock{Version: t.Version, Targets: make(map[string]LockTarget, len(t.Platforms))}
	for key, p := range t.Platforms {
		lock.Targets[key] = LockTarget{URL: p.URL, SHA256: p.SHA256}
	}
	return lock, nil
}

// PinnedVersion is the release this build expects.
func PinnedVersion() string {
	lock, err := PinnedLock()
	if err != nil {
		return ""
	}
	return lock.Version
}

// downloadPinned fetches this platform's archive, verifies its sha256 and
// installs BinName at dest.
func downloadPinned(ctx context.Context, dest string) error {
	lock, err := PinnedLock()
	if err != nil {
		return err
	}
	target, ok := lock.Targets[platformKey()]
	if !ok {
		return fmt.Errorf("herdr: no pinned build for %s", platformKey())
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.URL, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("herdr: download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("herdr: download: %s", resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return fmt.Errorf("herdr: download: %w", err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != target.SHA256 {
		return errors.New("herdr: download checksum mismatch")
	}
	if err := installFromTarball(data, dest); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(filepath.Dir(dest), VersionFile), []byte(lock.Version+"\n"), 0o644)
}

// platformKey is the catalog's <goos>-<goarch> key, the same one the tools
// installer resolves with.
func platformKey() string { return tools.PlatformKey(runtime.GOOS, runtime.GOARCH) }
