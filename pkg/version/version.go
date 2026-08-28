// Package version tracks the application version for `suwu version`.
// Set via -ldflags "-X suwu/pkg/version.Version=..." at build time;
// the zero value "dev" is used for untagged development builds.
package version

// Version is the application version string. It is overwritten by the
// linker during release builds.
var Version = "dev"
