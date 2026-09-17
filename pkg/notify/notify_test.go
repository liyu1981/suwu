package notify

import (
	"sync"
	"testing"
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
