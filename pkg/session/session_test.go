package session

import (
	"strings"
	"testing"
	"time"
)

// readUntil drains frames until one contains substr or the timeout passes.
func readUntil(t *testing.T, ch <-chan []byte, substr string, timeout time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case data, ok := <-ch:
			if !ok {
				return false
			}
			if strings.Contains(string(data), substr) {
				return true
			}
		case <-time.After(50 * time.Millisecond):
		}
	}
	return false
}

func TestAttachReattachRestoresScreen(t *testing.T) {
	mgr, err := NewManager()
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()

	client, snapshot, created, err := mgr.Attach("reattach-test", 80, 24, "")
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("first attach should be a new session")
	}
	if len(snapshot) != 0 {
		t.Fatalf("fresh session should have no snapshot, got %d bytes", len(snapshot))
	}

	client.Write([]byte("echo VTRESTORE-MARK-99\r"))
	if !readUntil(t, client.Frames(), "VTRESTORE-MARK-99", 8*time.Second) {
		t.Fatal("marker output not received")
	}
	client.Detach()

	// Reattach on the same key: the emulator's screen dump must contain the
	// echoed marker even though nothing was sent in between.
	client2, snapshot, created, err := mgr.Attach("reattach-test", 80, 24, "")
	if err != nil {
		t.Fatal(err)
	}
	defer client2.Detach()
	if created {
		t.Fatal("reattach should not be a new session")
	}
	if !strings.Contains(string(snapshot), "VTRESTORE-MARK-99") {
		t.Fatalf("restored screen missing marker, got %q", snapshot)
	}
}

func TestSessionKeyIsolation(t *testing.T) {
	mgr, err := NewManager()
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()

	a, _, _, err := mgr.Attach("iso-a", 80, 24, "")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Detach()
	b, _, _, err := mgr.Attach("iso-b", 80, 24, "")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Detach()

	a.Write([]byte("echo ONLY-IN-A-777\r"))
	if !readUntil(t, a.Frames(), "ONLY-IN-A-777", 8*time.Second) {
		t.Fatal("marker not seen in session A")
	}

	select {
	case data := <-b.Frames():
		if strings.Contains(string(data), "ONLY-IN-A-777") {
			t.Fatalf("session B received session A's output: %q", data)
		}
	case <-time.After(300 * time.Millisecond):
	}
}

func TestFanOutToMultipleClients(t *testing.T) {
	mgr, err := NewManager()
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()

	c1, _, _, err := mgr.Attach("fanout", 80, 24, "")
	if err != nil {
		t.Fatal(err)
	}
	defer c1.Detach()
	c2, _, _, err := mgr.Attach("fanout", 80, 24, "")
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Detach()

	c1.Write([]byte("echo FANOUT-MARK-55\r"))
	if !readUntil(t, c1.Frames(), "FANOUT-MARK-55", 8*time.Second) {
		t.Fatal("client 1 missed output")
	}
	if !readUntil(t, c2.Frames(), "FANOUT-MARK-55", 8*time.Second) {
		t.Fatal("client 2 missed output")
	}
}

func TestTTLExpiryCreatesFreshSession(t *testing.T) {
	mgr, err := NewManager()
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	mgr.SetTTL(100 * time.Millisecond)

	client, _, _, err := mgr.Attach("ttl-test", 80, 24, "")
	if err != nil {
		t.Fatal(err)
	}
	client.Detach()

	// Wait past the TTL so the idle session is reaped.
	time.Sleep(400 * time.Millisecond)

	_, snapshot, created, err := mgr.Attach("ttl-test", 80, 24, "")
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("expired session should have been replaced by a new one")
	}
	if len(snapshot) != 0 {
		t.Fatalf("expired session should have been replaced by a fresh one, got snapshot %d bytes", len(snapshot))
	}
}

func TestResizeAdoptedOnReattach(t *testing.T) {
	mgr, err := NewManager()
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()

	client, _, _, err := mgr.Attach("resize-test", 80, 24, "")
	if err != nil {
		t.Fatal(err)
	}
	client.Write([]byte("echo RESIZE-MARK-11\r"))
	if !readUntil(t, client.Frames(), "RESIZE-MARK-11", 8*time.Second) {
		t.Fatal("marker output not received")
	}
	client.Detach()

	// Reattach with a different grid size: must not error, and the restored
	// screen must still contain the marker.
	client2, snapshot, created, err := mgr.Attach("resize-test", 120, 40, "")
	if err != nil {
		t.Fatal(err)
	}
	defer client2.Detach()
	if created {
		t.Fatal("reattach should not be a new session")
	}
	if !strings.Contains(string(snapshot), "RESIZE-MARK-11") {
		t.Fatalf("restored screen missing marker after resize, got %q", snapshot)
	}
}
