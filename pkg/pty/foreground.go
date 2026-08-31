// Package pty — /proc-based session state detection (Linux only).
//
// Queries a shell process's CWD and foreground command by reading /proc.
package pty

import (
	"os"
	"strconv"
	"strings"
)

// StateUpdate carries the detected session state for a shell process.
type StateUpdate struct {
	CWD        string `json:"cwd"`
	Foreground string `json:"foreground,omitempty"`
}

// getCWD reads the current working directory of a process from /proc.
func getCWD(pid int) string {
	link, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/cwd")
	if err != nil {
		return ""
	}
	return link
}

// detectForeground reads the foreground process group of the shell's TTY
// from /proc/PID/stat (tpgid field) and returns its full cmdline.
func detectForeground(shellPid int) string {
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(shellPid) + "/stat")
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(stat))
	if len(fields) < 8 {
		return ""
	}

	// Field 8 (1-indexed) is tpgid — the foreground process group of the TTY.
	tpgid, err := strconv.Atoi(fields[7])
	if err != nil || tpgid == shellPid {
		return "" // shell itself is foreground — no user command running.
	}

	cmdline, err := os.ReadFile("/proc/" + strconv.Itoa(tpgid) + "/cmdline")
	if err != nil {
		return ""
	}
	// cmdline is null-separated: "vim\0file.txt\0--line\042\0"
	// Return the full command line so it can be re-executed on restore.
	raw := strings.TrimRight(strings.ReplaceAll(string(cmdline), "\x00", " "), " ")
	return raw
}

// GetSessionState is a one-shot query for a shell process's CWD and
// foreground command. Used by the HTTP polling endpoint.
func GetSessionState(shellPid int) (cwd string, foreground string) {
	return getCWD(shellPid), detectForeground(shellPid)
}
