package herdr

import _ "embed"

// lockFile pins the herdr-core release Suwu is built against: the version, and
// per-target archive URL + sha256. It is also what releases are fetched from
// when a build carries no embedded archive.
//
//go:embed herdr-core-lock.json
var lockFile []byte
