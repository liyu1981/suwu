// Package assets embeds the static web assets served by the demo server.
//
// The web/ tree is embedded into the binary at build time. In dev mode air
// rebuilds this tree (pnpm build:web) together with the server binary before
// restarting, so the served assets always match the sources.
package assets

import "embed"

// FS is the embedded web/ directory (contains index.html and the bundled JS/CSS
// assets when populated before building).
//
//go:embed web
var FS embed.FS
