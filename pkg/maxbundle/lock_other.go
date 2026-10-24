//go:build !unix

package maxbundle

import "path/filepath"
import "os"

// lockDir is a no-op on platforms without flock. suwu-max targets Linux; this
// keeps cross-compilation of the rest of the module honest.
func lockDir(dir string) (func(), error) {
	_ = os.MkdirAll(dir, 0o755)
	_ = filepath.Join(dir, ".lock")
	return func() {}, nil
}
