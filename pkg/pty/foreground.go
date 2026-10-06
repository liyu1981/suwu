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

// foregroundPgid reads the foreground process group of a shell's controlling
// TTY from /proc/PID/stat (tpgid field). Returns 0 when it cannot be
// determined. The shell itself is a valid foreground group (e.g. at a prompt),
// so callers should treat 0 only as "unknown".
func foregroundPgid(shellPid int) int {
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(shellPid) + "/stat")
	if err != nil {
		return 0
	}
	// Field 2 (comm) is wrapped in parentheses and may itself contain spaces
	// and parentheses, so parse from the last ')' rather than splitting the
	// whole line. In the remainder, tpgid is the sixth field (index 5).
	s := string(stat)
	i := strings.LastIndexByte(s, ')')
	if i < 0 || i+1 >= len(s) {
		return 0
	}
	fields := strings.Fields(s[i+1:])
	if len(fields) < 6 {
		return 0
	}
	tpgid, err := strconv.Atoi(fields[5])
	if err != nil || tpgid <= 1 {
		return 0
	}
	return tpgid
}

// detectForeground reads the foreground process group of the shell's TTY
// from /proc/PID/stat (tpgid field) and returns its full cmdline.
func detectForeground(shellPid int) string {
	tpgid := foregroundPgid(shellPid)
	if tpgid == 0 || tpgid == shellPid {
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
