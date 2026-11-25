// Package tools carries the tool catalog Suwu installs from: the versions,
// per-platform download URLs and sha256 pins for the binaries Suwu looks up
// (rg for file search, pig and herdr for agents, fzf and asdf for the shell).
//
// The catalog is one JSON file under tools/ so that three readers agree on it:
// this package (embedded into the binary, so an offline server can still show
// the list), the release builders (`scripts/build-max.sh`,
// `scripts/fetch-herdr-core.sh`) and a running server, which fetches the same
// path from raw.githubusercontent.com at master. docs/TOOLS_PLAN.md §4 is the
// contract.
package tools

import _ "embed"

// Builtin is the catalog this build was made with. It is embedded rather than
// read at runtime so `suwu tools list` works on a machine with no network, and
// so the builder and the server can never be looking at different files.
//
//go:embed catalog.json
var Builtin []byte
