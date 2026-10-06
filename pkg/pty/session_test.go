package pty

import (
	"syscall"
	"testing"
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
