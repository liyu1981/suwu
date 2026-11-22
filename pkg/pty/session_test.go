package pty

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestSignalForegroundUnstarted(t *testing.T) {
	var s Session
	if err := s.SignalForeground(syscall.SIGWINCH); err == nil {
		t.Fatal("expected error signalling an unstarted session")
	}
}

func TestSignalForegroundStarted(t *testing.T) {
	s, err := StartWithCWD(80, 24, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Kill()

	// A live shell (itself the foreground process group when idle) must accept
	// the signal without error.
	if err := s.SignalForeground(syscall.SIGWINCH); err != nil {
		t.Fatalf("SignalForeground on a live shell: %v", err)
	}
}

// A server that put the managed tool directory on its own PATH expects the
// shells it starts to see it: the PTY inherits the process environment, which is
// what makes an installed tool usable inside a Suwu terminal with no rc block.
func TestSessionInheritsProcessPATH(t *testing.T) {
	dir := t.TempDir()
	// A "shell" that reports the PATH it was given.
	script := filepath.Join(dir, "printpath.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s\\n' \"$PATH\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	managed := filepath.Join(dir, "managed-bin")
	if err := os.MkdirAll(managed, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", script)
	t.Setenv("PATH", managed+string(os.PathListSeparator)+"/usr/bin:/bin")

	s, err := StartWithCWD(80, 24, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Kill()

	out := make(chan string, 1)
	go func() {
		var buf bytes.Buffer
		_, _ = io.Copy(&buf, io.LimitReader(s, 4096))
		out <- buf.String()
	}()
	select {
	case got := <-out:
		if !strings.Contains(got, managed) {
			t.Fatalf("the shell did not inherit the managed PATH entry: %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the shell never reported its PATH")
	}
}
