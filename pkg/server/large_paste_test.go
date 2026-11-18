package server

import (
	"bytes"
	"context"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A browser paste arrives as a single xterm onData event, so the whole payload
// lands in one WebSocket frame. coder/websocket refuses a frame larger than its
// 32 KiB default read limit by closing the connection with StatusMessageTooBig,
// which the browser sees as "connection lost" and answers with a reconnect —
// the paste is gone.
//
// Regression test for a 92,535-byte log paste that dropped the session.
func TestWebSocketAcceptsLargePaste(t *testing.T) {
	ts, cfg := testServer(t)
	origin := "http://" + hostOf(ts)
	q := url.Values{}
	q.Set("cols", "80")
	q.Set("rows", "24")
	q.Set("token", cfg.Token)

	conn := dialWS(t, ts, origin, q)
	defer conn.CloseNow()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	waitForReady(t, conn, ctx, "")

	// Turn echo off first: this test is about the input frame the server used to
	// refuse, and an echoing shell answers a 40 KB line with megabytes of
	// readline redraw — a different mechanism that (by design) drops a client
	// that falls a whole subBuffer behind. See docs/TERM_INPUT_LIMITS.md.
	if err := conn.Write(ctx, websocket.MessageBinary, []byte("stty -echo\r")); err != nil {
		t.Fatalf("stty -echo: %v", err)
	}
	time.Sleep(300 * time.Millisecond)

	// Just past the library's old 32 KiB default.
	paste := bytes.Repeat([]byte("0123456789abcdef"), 2500)
	if err := conn.Write(ctx, websocket.MessageBinary, paste); err != nil {
		t.Fatalf("writing a %d-byte paste: %v", len(paste), err)
	}
	time.Sleep(300 * time.Millisecond)
	// Discard the half-typed line, restore echo, then prove the session works.
	_ = conn.Write(ctx, websocket.MessageBinary, []byte("\x03"))
	if err := conn.Write(ctx, websocket.MessageBinary, []byte("stty echo\recho LARGE-PASTE-MARK\r")); err != nil {
		t.Fatalf("writing after a large paste: %v", err)
	}

	// Accumulate: a PTY read boundary can split the echo of the marker across
	// two frames, so scanning frame by frame would flake.
	var seen strings.Builder
	for {
		if ctx.Err() != nil {
			t.Fatalf("did not receive the marker after a large paste; got %d bytes back", seen.Len())
		}
		_, data, err := conn.Read(ctx)
		if err != nil {
			tail := seen.String()
			if len(tail) > 300 {
				tail = tail[len(tail)-300:]
			}
			t.Fatalf("connection dropped after a large paste (%d bytes echoed, tail %q): %v", seen.Len(), tail, err)
		}
		seen.Write(data)
		if strings.Contains(seen.String(), "LARGE-PASTE-MARK") {
			return
		}
	}
}
