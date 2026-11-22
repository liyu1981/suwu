// Command suwu-max is the bootstrap installer for Suwu. It carries the real
// suwu binary plus a small tool set, writes the app to ~/.local/bin and the
// tools to ~/.suwu/bin on first run, then execs the app with the original
// arguments. From the second run on it is only a re-seed for the tools: what
// runs is the normal suwu binary, which `suwu upgrade` keeps current.
//
// The payload itself is embedded only when the binary is built with
// `-tags max` (see scripts/build-max.sh); a plain `go build ./...` produces a
// payload-less launcher that explains how it was built.
package main

import (
	"io/fs"
	"os"

	"suwu/pkg/maxbundle"
	"suwu/pkg/version"
)

// bundlePayload is assigned by bundle_max.go in a `-tags max` build.
var bundlePayload fs.FS

func main() {
	os.Exit(maxbundle.Main(bundlePayload, version.Version, os.Args[1:]))
}
