//go:build hcbin

package herdr

import _ "embed"

// herdr-core.tar.gz is fetched for the build's platform by
// scripts/fetch-herdr-core.sh and embedded by release builds (-tags hcbin), so
// `suwu hc` works on a machine that has never installed herdr-core.
//
//go:embed assets/herdr-core.tar.gz
var herdrCoreArchive []byte

func embeddedTarball() []byte { return herdrCoreArchive }
