package maxbundle

import "suwu/pkg/bindir"

// lockDir takes the lock every writer of the bin directory shares: the payload
// extraction here, the tools installer, and `suwu upgrade`'s binary rename.
func lockDir(dir string) (func(), error) { return bindir.Lock(dir) }
