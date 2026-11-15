//go:build linux

package pty

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// tpgid is the sixth field after the parenthesised comm. The parse has to
// survive a comm that contains spaces, parentheses and digits — a shell can be
// renamed to anything, and `(foo) bar` style names exist in the wild.
func TestParseTpgid(t *testing.T) {
	cases := []struct {
		name string
		stat string
		want int
	}{
		{
			name: "plain bash at a prompt",
			// pid (bash) S ppid pgrp session tty tpgid ...
			stat: "1234 (bash) S 1200 1234 1234 34816 1234 4194304 100 0 0 0 1 2",
			want: 1234,
		},
		{
			name: "foreground child",
			stat: "1234 (bash) S 1200 1234 1234 34816 4321 4194304 100 0 0 0",
			want: 4321,
		},
		{
			name: "comm with spaces and parentheses",
			stat: "777 (weird ) name (x)) S 700 777 777 1024 4242 0 0 0",
			want: 4242,
		},
		{
			name: "too few fields",
			stat: "1234 (bash) S 1200 1234",
			want: 0,
		},
		{
			name: "no closing paren",
			stat: "1234 bash S 1200 1234 1234 34816 4321",
			want: 0,
		},
		{
			name: "kernel thread sentinel",
			stat: "1234 (bash) S 1200 1234 1234 34816 0 0 0 0",
			want: 0,
		},
		{
			name: "not a number",
			stat: "1234 (bash) S 1200 1234 1234 34816 xyz 0 0 0",
			want: 0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseTpgid([]byte(tc.stat)); got != tc.want {
				t.Fatalf("parseTpgid(%q) = %d, want %d", tc.stat, got, tc.want)
			}
		})
	}
}

// The read path must not allocate a buffer per call: it runs on every PTY write
// (the mouse-report heuristic) and, while a client is attached, on the state
// poller. A fresh os.ReadFile plus strings.Fields per call is what made this the
// largest source of garbage in a production run (docs/MEMORY_GROWTH_INVESTIGATION.md
// §5.6: ~5.3 KiB and 25 allocations per call before the pool). The pool brings it under 1 KiB, and this pins that.
func TestGetSessionStateAllocations(t *testing.T) {
	pid := os.Getpid()
	// Warm the pool so the measurement is of the steady state.
	GetSessionState(pid)

	const calls = 2000
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	for i := 0; i < calls; i++ {
		GetSessionState(pid)
	}
	runtime.ReadMemStats(&after)
	perCall := float64(after.TotalAlloc-before.TotalAlloc) / calls
	if perCall > 1200 {
		t.Fatalf("GetSessionState allocates %.0f bytes per call, want < 1200 (the /proc read must come from the pool)", perCall)
	}
	if allocs := testing.AllocsPerRun(50, func() { GetSessionState(pid) }); allocs > 20 {
		t.Fatalf("GetSessionState allocates %.1f times per call, want <= 20", allocs)
	}
}

func TestGetSessionStateReadsCWD(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	got, _ := GetSessionState(os.Getpid())
	// /proc/PID/cwd may resolve symlinks differently (e.g. /tmp -> /private/tmp
	// on other platforms); accept a suffix match.
	if got != cwd && !strings.HasSuffix(cwd, got) && !strings.HasSuffix(got, cwd) {
		t.Fatalf("GetSessionState cwd = %q, want %q", got, cwd)
	}
}

func TestReadProcFilePools(t *testing.T) {
	path := "/proc/" + strconv.Itoa(os.Getpid()) + "/stat"
	for i := 0; i < 3; i++ {
		buf, err := readProcFile(path)
		if err != nil {
			t.Fatalf("readProcFile: %v", err)
		}
		if buf.Len() == 0 {
			t.Fatal("readProcFile returned no data")
		}
		releaseProcFile(buf)
	}
}
