//go:build unix

package maxbundle

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// lockDir takes an exclusive advisory lock so two launchers cannot extract at
// the same time. The lock dies with the process, so a crash cannot wedge it.
func lockDir(dir string) (func(), error) {
	file, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open install lock: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("lock install dir: %w", err)
	}
	return func() {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}, nil
}
