package notify

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMaximumNotificationSize(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "notify.sock")
	l, err := NewListener(sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	ch := l.Subscribe()
	empty, err := json.Marshal(Notification{})
	if err != nil {
		t.Fatal(err)
	}
	message := strings.Repeat("a", MaxMessageBytes-len(empty))
	encoded, err := json.Marshal(Notification{Message: message})
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) != MaxMessageBytes {
		t.Fatalf("encoded length = %d", len(encoded))
	}
	if err := Send(sock, string(encoded)); err != nil {
		t.Fatal(err)
	}
	select {
	case n := <-ch:
		if n.Message != message {
			t.Fatal("maximum-sized notification was truncated or changed")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("maximum-sized notification not received")
	}
}

func TestOversizedBatchRejectedBeforeConnecting(t *testing.T) {
	// An invalid socket path makes an attempted connection observable. Size
	// validation must win even when a valid message precedes the oversized one.
	err := Send("", "first", strings.Repeat("a", MaxMessageBytes+1))
	if err == nil || err.Error() != MessageTooLargeError().Error() {
		t.Fatalf("error = %v, want size rejection before connecting", err)
	}
}
