package notify

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestConcurrentBroadcastAndSubscriptions(t *testing.T) {
	l := &Listener{subs: make(map[*sub]struct{})}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for range 100 {
				l.Broadcast(Notification{Message: "test"})
			}
		}()
		go func() {
			defer wg.Done()
			for range 100 {
				ch := l.Subscribe()
				l.Unsubscribe(ch)
			}
		}()
	}
	wg.Wait()
	if len(l.subs) != 0 {
		t.Fatalf("%d subscriptions remain", len(l.subs))
	}
}

func TestBroadcastDropsMessagesForFullSubscriber(t *testing.T) {
	l := &Listener{subs: make(map[*sub]struct{})}
	slow := l.Subscribe()
	defer l.Unsubscribe(slow)
	for range cap(slow) {
		l.Broadcast(Notification{Message: "fill"})
	}
	fast := l.Subscribe()
	defer l.Unsubscribe(fast)
	l.Broadcast(Notification{Message: "latest"})
	select {
	case n := <-fast:
		if n.Message != "latest" {
			t.Fatalf("message = %q, want latest", n.Message)
		}
	default:
		t.Fatal("full subscriber prevented delivery to another subscriber")
	}
}

// socketPathFor returns a path in a temp dir that is short enough for
// sun_path (104 bytes on Linux/BSD).
func socketPathFor(t *testing.T, name string) string {
	t.Helper()
	return filepath.Join(t.TempDir(), name)
}

// A second server must never bind over a live one: that steals the path and
// strands the first server's CLI ingress with no way to repair it short of a
// restart (docs/MEMORY_GROWTH_INVESTIGATION.md §6).
func TestNewListenerRefusesLiveSocket(t *testing.T) {
	path := socketPathFor(t, "suwu.sock")

	first, err := NewListener(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = first.Close() }()

	ch := first.Subscribe()
	defer first.Unsubscribe(ch)

	if _, err := NewListener(path); err == nil {
		t.Fatal("NewListener bound over a live socket; it must refuse")
	} else if !strings.Contains(err.Error(), "already in use") {
		t.Fatalf("error = %v, want one that names the conflict", err)
	}

	// The refusal must not have touched the first listener: it still answers.
	if err := Send(path, `{"message":"still here"}`); err != nil {
		t.Fatalf("send after refusal: %v", err)
	}
	select {
	case n := <-ch:
		if n.Message != "still here" {
			t.Fatalf("message = %q", n.Message)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first listener stopped receiving after a refused bind")
	}
}

// A socket file left behind by a crashed server is not a live one, and must be
// replaced, otherwise a restart after SIGKILL would need manual cleanup.
func TestNewListenerReplacesStaleSocket(t *testing.T) {
	path := socketPathFor(t, "suwu.sock")

	// Bind without our helper and leave the file behind, the way a killed
	// process does.
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	if ul, ok := ln.(*net.UnixListener); ok {
		ul.SetUnlinkOnClose(false)
	}
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("stale socket file missing before the test: %v", err)
	}

	l, err := NewListener(path)
	if err != nil {
		t.Fatalf("NewListener over a stale socket: %v", err)
	}
	defer func() { _ = l.Close() }()

	ch := l.Subscribe()
	defer l.Unsubscribe(ch)
	if err := Send(path, `{"message":"fresh"}`); err != nil {
		t.Fatalf("send to the replacement listener: %v", err)
	}
	select {
	case n := <-ch:
		if n.Message != "fresh" {
			t.Fatalf("message = %q", n.Message)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("replacement listener did not receive its message")
	}
}

// Closing an old instance must not delete a socket that someone else has since
// bound at the same path: remove-by-name was how a stopping dev server used to
// remove the production server's socket.
func TestCloseKeepsAnotherListenersSocket(t *testing.T) {
	path := socketPathFor(t, "suwu.sock")

	old, err := NewListener(path)
	if err != nil {
		t.Fatal(err)
	}

	// Simulate a clobber: the path is replaced by a different listener while
	// the old one is still open.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	replacement, err := NewListener(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = replacement.Close() }()

	ch := replacement.Subscribe()
	defer replacement.Unsubscribe(ch)
	if err := Send(path, `{"message":"replacement alive"}`); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("replacement listener not receiving")
	}

	if err := old.Close(); err != nil {
		t.Fatalf("close old listener: %v", err)
	}
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("old listener removed the replacement's socket: %v", err)
	}
	// And the replacement is still reachable.
	if err := Send(path, `{"message":"still alive"}`); err != nil {
		t.Fatalf("send after old listener closed: %v", err)
	}
	select {
	case n := <-ch:
		if n.Message != "still alive" {
			t.Fatalf("message = %q", n.Message)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("replacement stopped receiving after the old listener closed")
	}

	// Its own close still cleans up.
	if err := replacement.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("socket file survived its owner's close: %v", err)
	}
}

func TestNewListenerRefusesNonSocket(t *testing.T) {
	path := socketPathFor(t, "suwu.sock")
	if err := os.WriteFile(path, []byte("not a socket"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewListener(path); err == nil {
		t.Fatal("NewListener removed a regular file; it must refuse")
	}
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("regular file was deleted: %v", err)
	}
}

// The path is per instance: two servers of the same user must not collide, and
// the installed service keeps the location it has always had.
func TestSocketPathResolution(t *testing.T) {
	t.Run("explicit wins", func(t *testing.T) {
		t.Setenv("SUWU_SOCK_PATH", "/run/custom.sock")
		t.Setenv("SUWU_VAR", "/var/instance")
		t.Setenv("SUWU_DEV", "true")
		got, err := SocketPath()
		if err != nil {
			t.Fatal(err)
		}
		if got != "/run/custom.sock" {
			t.Fatalf("SocketPath = %q", got)
		}
	})

	t.Run("data dir", func(t *testing.T) {
		t.Setenv("SUWU_SOCK_PATH", "")
		t.Setenv("SUWU_VAR", "/var/instance")
		t.Setenv("SUWU_DEV", "")
		got, err := SocketPath()
		if err != nil {
			t.Fatal(err)
		}
		if got != filepath.Join("/var/instance", "suwu.sock") {
			t.Fatalf("SocketPath = %q", got)
		}
	})

	t.Run("dev gets its own name", func(t *testing.T) {
		t.Setenv("SUWU_SOCK_PATH", "")
		t.Setenv("SUWU_VAR", "/var/instance")
		t.Setenv("SUWU_DEV", "true")
		got, err := SocketPath()
		if err != nil {
			t.Fatal(err)
		}
		if got != filepath.Join("/var/instance", "suwu-dev.sock") {
			t.Fatalf("SocketPath = %q", got)
		}
	})

	t.Run("default is the home data dir", func(t *testing.T) {
		t.Setenv("SUWU_SOCK_PATH", "")
		t.Setenv("SUWU_VAR", "")
		t.Setenv("SUWU_DEV", "")
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skip("no home dir")
		}
		got, err := SocketPath()
		if err != nil {
			t.Fatal(err)
		}
		if got != filepath.Join(home, ".suwu", "suwu.sock") {
			t.Fatalf("SocketPath = %q", got)
		}
	})
}
