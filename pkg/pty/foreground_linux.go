//go:build linux

// Package pty — /proc-based session state detection (Linux only).
//
// Queries a shell process's CWD and foreground command by reading /proc.
package pty

import (
	"bytes"
	"os"
	"strconv"
	"strings"
	"sync"
)

// procBuffers recycles the buffers used to read /proc files.
//
// GetSessionState runs on every PTY write (the mouse-report heuristic) and, while
// a client is attached, on the state poller. A fresh allocation per call made it
// the largest single source of garbage in the process — 28 % of everything
// allocated during a 4 h run, almost all of it a 4 KiB read buffer plus
// strings.Fields (docs/MEMORY_GROWTH_INVESTIGATION.md §5.6). The files are tiny,
// so a small pool removes essentially all of it after warm-up.
var procBuffers = sync.Pool{New: func() any { return new(bytes.Buffer) }}

// procBufferMaxCap bounds what is kept in the pool: /proc/PID/cmdline can be
// megabytes (ARG_MAX), and that is not worth pinning.
const procBufferMaxCap = 64 << 10

// readProcFile reads path into a pooled buffer. The caller must call
// releaseProcFile when done with the bytes.
func readProcFile(path string) (*bytes.Buffer, error) {
	buf := procBuffers.Get().(*bytes.Buffer)
	buf.Reset()
	f, err := os.Open(path)
	if err != nil {
		procBuffers.Put(buf)
		return nil, err
	}
	_, readErr := buf.ReadFrom(f)
	closeErr := f.Close()
	if readErr != nil {
		procBuffers.Put(buf)
		return nil, readErr
	}
	if closeErr != nil {
		procBuffers.Put(buf)
		return nil, closeErr
	}
	return buf, nil
}

func releaseProcFile(buf *bytes.Buffer) {
	if buf.Cap() > procBufferMaxCap {
		return // let an unusually large read go; do not pin it
	}
	procBuffers.Put(buf)
}

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
	buf, err := readProcFile("/proc/" + strconv.Itoa(shellPid) + "/stat")
	if err != nil {
		return 0
	}
	tpgid := parseTpgid(buf.Bytes())
	releaseProcFile(buf)
	return tpgid
}

// parseTpgid extracts the tpgid field from /proc/PID/stat.
//
// Field 2 (comm) is wrapped in parentheses and may itself contain spaces and
// parentheses, so the parse starts after the last ')' — in the remainder tpgid
// is the sixth field. Walked by hand rather than with strings.Fields: this runs
// several times a second for every session, and Fields allocated more than the
// file read did.
func parseTpgid(stat []byte) int {
	closeParen := bytes.LastIndexByte(stat, ')')
	if closeParen < 0 || closeParen+1 >= len(stat) {
		return 0
	}
	rest := stat[closeParen+1:]
	field := 0
	for i := 0; i < len(rest); {
		for i < len(rest) && rest[i] == ' ' {
			i++
		}
		start := i
		for i < len(rest) && rest[i] != ' ' {
			i++
		}
		if start == i {
			return 0
		}
		field++
		// After the comm field the fields are state, ppid, pgrp, session, tty_nr,
		// tpgid — so tpgid is the sixth one counted from 1.
		if field != 6 {
			continue
		}
		value, err := strconv.Atoi(string(rest[start:i]))
		if err != nil || value <= 1 {
			return 0
		}
		return value
	}
	return 0
}

// detectForeground reads the foreground process group of the shell's TTY
// from /proc/PID/stat (tpgid field) and returns its full cmdline.
func detectForeground(shellPid int) string {
	tpgid := foregroundPgid(shellPid)
	if tpgid == 0 || tpgid == shellPid {
		return "" // shell itself is foreground — no user command running.
	}

	cmdline, err := readProcFile("/proc/" + strconv.Itoa(tpgid) + "/cmdline")
	if err != nil {
		return ""
	}
	// cmdline is null-separated: "vim\0file.txt\0--line\042\0"
	// Return the full command line so it can be re-executed on restore.
	raw := strings.TrimRight(strings.ReplaceAll(string(cmdline.Bytes()), "\x00", " "), " ")
	releaseProcFile(cmdline)
	return raw
}

// GetSessionState is a one-shot query for a shell process's CWD and
// foreground command. Used by the HTTP polling endpoint.
func GetSessionState(shellPid int) (cwd string, foreground string) {
	return getCWD(shellPid), detectForeground(shellPid)
}
