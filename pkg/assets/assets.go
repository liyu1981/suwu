// Package assets embeds the static web assets served by the demo server.
//
// The web/ tree is embedded for single-binary production deployments. In dev
// mode the server instead reads the same tree from disk so edits apply without
// a rebuild.
package assets

import "embed"

// FS is the embedded web/ directory (contains index.html, dist/, and the
// ghostty-vt.wasm file when populated before building).
//
//go:embed web
var FS embed.FS

// DevDir is the filesystem path of the web tree relative to the module root.
// Dev mode serves from this directory on disk so edits apply without a rebuild.
const DevDir = "pkg/assets/web"
