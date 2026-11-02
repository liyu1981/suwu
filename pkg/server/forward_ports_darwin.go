//go:build darwin

package server

// readListeningPorts is a stub on macOS, where /proc/net/tcp is unavailable.
func readListeningPorts() []int {
	return nil
}
