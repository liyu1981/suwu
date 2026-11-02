//go:build darwin

package pty

// GetSessionState is a stub on macOS, where /proc is unavailable. It returns
// empty values so callers degrade gracefully (no CWD/foreground detection).
func GetSessionState(shellPid int) (cwd string, foreground string) {
	return "", ""
}

// foregroundPgid is unavailable on macOS (/proc); return 0 so callers fall back.
func foregroundPgid(shellPid int) int { return 0 }
