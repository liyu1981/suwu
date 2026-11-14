package server

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"suwu/pkg/assets"
	"suwu/pkg/auth"
	"suwu/pkg/forward"
	"suwu/pkg/notify"
	"suwu/pkg/session"

	"github.com/coder/websocket"
)

// notifyServer builds a server with a real notify listener on a temp socket, so
// the /ws/notify handler runs against its actual subscriber set.
func notifyServer(t *testing.T) (*httptest.Server, *notify.Listener) {
	t.Helper()
	cfg := &auth.Config{
		Token:        "testtoken",
		BindHost:     "127.0.0.1",
		AllowedHosts: []string{"localhost", "127.0.0.1", "::1"},
	}
	sub, err := fs.Sub(assets.FS, "web")
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := session.NewManager()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sessions.Close() })

	sock := filepath.Join(t.TempDir(), "suwu.sock")
	listener, err := notify.NewListener(sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	srv := New(cfg, sub, sessions, listener, forward.NewManager(), "")
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, listener
}

func dialNotify(t *testing.T, ts *httptest.Server) *websocket.Conn {
	t.Helper()
	q := url.Values{"token": {"testtoken"}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h := http.Header{}
	h.Set("Origin", "http://"+hostOf(ts))
	conn, _, err := websocket.Dial(ctx, ts.URL+"/ws/notify?"+q.Encode(), &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		t.Fatalf("dial notify: %v", err)
	}
	return conn
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// A notification socket that the client abandons must release everything it
// holds: the subscriber slot, the goroutine and the connection.
//
// Regression test for the leak found on the ARM box: the handler used to park
// on the subscriber channel, so a peer that went away was invisible and the
// accepted connection (one fd per abandoned socket) was never closed.
func TestNotifyWebSocketReleasesOnClientClose(t *testing.T) {
	ts, listener := notifyServer(t)

	conn := dialNotify(t, ts)
	waitFor(t, "subscriber registration", func() bool { return listener.SubscriberCount() == 1 })

	// Closing from the client side is what a reaped Cloudflare tunnel (or a
	// closed tab) looks like to the server.
	if err := conn.Close(websocket.StatusNormalClosure, "bye"); err != nil {
		t.Fatalf("client close: %v", err)
	}

	waitFor(t, "subscriber release", func() bool { return listener.SubscriberCount() == 0 })
}

// A notification must still reach the client, and the connection must stay
// usable afterwards — the reader goroutine added for liveness must not steal
// frames the server sends.
func TestNotifyWebSocketDeliversNotifications(t *testing.T) {
	ts, listener := notifyServer(t)

	conn := dialNotify(t, ts)
	waitFor(t, "subscriber registration", func() bool { return listener.SubscriberCount() == 1 })

	listener.Broadcast(notify.Notification{ID: "n1", Message: "hello from the test"})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		mt, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read notification: %v", err)
		}
		if mt != websocket.MessageText {
			continue
		}
		if string(data) == "" {
			continue
		}
		var got struct {
			ID      string `json:"id"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatalf("decode notification %q: %v", data, err)
		}
		if got.ID == "n1" && got.Message == "hello from the test" {
			break
		}
	}
	_ = conn.Close(websocket.StatusNormalClosure, "done")
	waitFor(t, "subscriber release", func() bool { return listener.SubscriberCount() == 0 })
}

// Two clients at once must both be counted and both released: the subscriber
// set is not a single slot.
func TestNotifyWebSocketMultipleClients(t *testing.T) {
	ts, listener := notifyServer(t)

	a := dialNotify(t, ts)
	b := dialNotify(t, ts)
	waitFor(t, "two subscribers", func() bool { return listener.SubscriberCount() == 2 })

	_ = a.Close(websocket.StatusNormalClosure, "bye")
	waitFor(t, "one subscriber", func() bool { return listener.SubscriberCount() == 1 })

	_ = b.Close(websocket.StatusNormalClosure, "bye")
	waitFor(t, "no subscribers", func() bool { return listener.SubscriberCount() == 0 })
}
