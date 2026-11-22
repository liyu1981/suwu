// Package bindir owns the user's managed tool directory: where it is, how it is
// locked, and how it gets onto a shell's PATH.
//
// The directory is `<dataDir>/bin` — `~/.suwu/bin` for the default data dir —
// which is also what `suwu-max` seeds and what `pkg/herdr` looks in for
// `herdr-core`. Three writers share it (the tools installer, the suwu-max
// payload extraction and `suwu upgrade`), which is why the lock lives here and
// is taken by all of them (docs/TOOLS_PLAN.md §6.4).
package bindir

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Metadata directories inside the bin dir. They are dot-prefixed so they can
// never be mistaken for a tool, and the catalog refuses any entry that starts
// with a dot.
const (
	// StampDirName holds one <name>.json per installed tool.
	StampDirName = ".tools"
	// StageDirName holds a tool while it is being unpacked and verified.
	StageDirName = ".stage"
)

// Dir is the bin directory for a data dir.
func Dir(dataDir string) string { return filepath.Join(dataDir, "bin") }

// LockPath is the single lock file for the directory and for the app binary
// beside it. It lives in the data dir, not in the bin dir, so it cannot be
// mistaken for a tool's file nor swept away with one.
func LockPath(dataDir string) string { return filepath.Join(dataDir, "bin.lock") }

// StampDir is where per-tool stamps live.
func StampDir(binDir string) string { return filepath.Join(binDir, StampDirName) }

// StampPath is one tool's stamp.
func StampPath(binDir, name string) string {
	return filepath.Join(StampDir(binDir), name+".json")
}

// LocalBinPath is where `suwu-max` puts the real app: <home>/.local/bin/suwu.
// It is not a tool, so it lives outside the tool directory.
func LocalBinPath(home string) string {
	return filepath.Join(home, ".local", "bin", "suwu")
}

// Ensure creates the bin dir (and its metadata dir) if needed.
func Ensure(dataDir string) (string, error) {
	dir := Dir(dataDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create %s: %w", dir, err)
	}
	return dir, nil
}

// Within reports whether path is inside base. Both sides are compared after
// symlink resolution, so a symlinked bin dir cannot redirect a write.
func Within(base, target string) error {
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
	if absTarget != absBase && !hasPrefixDir(absTarget, absBase) {
		return errors.New("path escapes the bin directory")
	}
	return nil
}

func hasPrefixDir(p, dir string) bool {
	return len(p) > len(dir) && p[:len(dir)] == dir && os.IsPathSeparator(p[len(dir)])
}
