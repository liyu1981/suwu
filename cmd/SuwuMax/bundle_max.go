//go:build max

package main

import (
	"embed"
	"io/fs"
)

// The payload is produced by scripts/build-max.sh into this directory before
// the launcher is compiled.
//
//go:embed bundle/manifest.json bundle/bundle.tar.gz
var embeddedBundle embed.FS

func init() {
	sub, err := fs.Sub(embeddedBundle, "bundle")
	if err != nil {
		panic(err)
	}
	bundlePayload = sub
}
