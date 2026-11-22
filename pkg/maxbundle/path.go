package maxbundle

import "suwu/pkg/bindir"

// The PATH block machinery lives in pkg/bindir so the two markers that may sit
// in one rc file — suwu-max's app directory and the tools page's tool directory
// — share one implementation, one backup rule and one idempotency test.
//
// The blocks below are the historical API of this package; new code should call
// bindir directly.

// EnsurePath adds (or refreshes) the suwu-max block that puts dir on PATH.
func EnsurePath(dir string) ([]string, error) {
	return bindir.EnsurePath(dir, bindir.MaxBlock)
}

// RemovePath removes the suwu-max block everywhere it is found.
func RemovePath() ([]string, error) { return bindir.RemovePath(bindir.MaxBlock) }
