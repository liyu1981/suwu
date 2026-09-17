package session

import "testing"

func TestCloseStopsSessionPoller(t *testing.T) {
	mgr, err := NewManager()
	if err != nil {
		t.Fatal(err)
	}
	client, _, _, err := mgr.Attach("shutdown-test", 80, 24, t.TempDir())
	if err != nil {
		mgr.Close()
		t.Fatal(err)
	}
	mgr.Close()

	select {
	case <-client.s.done:
	default:
		t.Fatal("session state poller was not signaled to stop")
	}
	select {
	case <-client.s.pollerDone:
	default:
		t.Fatal("Close returned before the state poller exited")
	}
	for range client.Frames() {
		// Drain any output buffered before shutdown; the channel must close.
	}
}
