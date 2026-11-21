//go:build !hcbin

package herdr

// Builds without the embedded archive (development, `go test ./...`) resolve
// herdr-core from the managed path, PATH or the pinned download instead.
func embeddedTarball() []byte { return nil }
