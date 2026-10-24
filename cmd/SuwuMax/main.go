// Command suwu-max is the self-extracting launcher for Suwu. It carries the
// real suwu binary plus a small tool set, installs them into ~/.suwu/bin on
// first run, puts that directory on PATH, and then execs the real binary with
// the original arguments.
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
