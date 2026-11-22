//go:build !unix

package bindir

import "os"

// Lock is a no-op on platforms without flock. Suwu targets Linux and macOS;
// this keeps cross-compilation of the rest of the module honest.
func Lock(dataDir string) (func(), error) {
	_ = os.MkdirAll(dataDir, 0o755)
	return func() {}, nil
}

// Held is always false without flock.
func Held(string) bool { return false }
