//go:build unix

package bindir

import (
	"fmt"
	"os"
	"syscall"
)

// Lock takes the exclusive advisory lock that serialises every writer of the
// bin directory and of `~/.local/bin/suwu`. It is released by the returned
// function, and by the kernel if the process dies — a crash cannot wedge it.
func Lock(dataDir string) (func(), error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	path := LockPath(dataDir)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open bin lock: %w", err)
	}
	// Blocking is the right default: an install is seconds, and a caller that
	// raced it wants the tool, not an error. The server reports "already
	// running" from its own single-flight guard instead of from here.
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("lock %s: %w", path, err)
	}
	return func() {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}, nil
}

// Held reports whether some other process currently holds the lock. The server
// uses it to answer "an install is already running" instead of blocking a
// request for the duration of a download.
func Held(dataDir string) bool {
	file, err := os.OpenFile(LockPath(dataDir), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return false
	}
	defer func() { _ = file.Close() }()
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return true
	}
	_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	return false
}
