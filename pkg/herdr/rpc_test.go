package herdr

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"sync"
	"testing"
	"time"
)

// fakeCore speaks the wire protocol over one end of a net.Pipe so the client can
// be exercised without a daemon.
type fakeCore struct {
	t    *testing.T
	conn net.Conn
	mu   sync.Mutex
	// wmu serialises frame writes: the serve loop answers calls while the test
	// pushes events, and a frame is two Writes (header, payload).
	wmu    sync.Mutex
	nextCh uint32
	// handlers answer a JSON-RPC method: a result, or an error.
	handlers map[string]func(params json.RawMessage) (any, error)
	// sent records every frame the client wrote (channel 0 calls included).
	sent chan Frame
}

// startFakeCore returns a client Conn already handshaken with a fake core.
func startFakeCore(t *testing.T, handlers map[string]func(json.RawMessage) (any, error)) (*Conn, *fakeCore) {
	t.Helper()
	clientSide, serverSide := net.Pipe()
	f := &fakeCore{t: t, conn: serverSide, nextCh: 10, handlers: handlers, sent: make(chan Frame, 256)}
	go f.serve()
	c := newConn(clientSide)
	// The client under test skips hello (newConn does); register no-op so calls
	// have somewhere to go. Version metadata is set by the test when needed.
	return c, f
}

func (f *fakeCore) serve() {
	defer f.conn.Close()
	r := bufio.NewReader(f.conn)
	for {
		fr, err := readFrame(r)
		if err != nil {
			return
		}
		select {
		case f.sent <- fr:
		default:
		}
		if fr.Channel != 0 || fr.Kind != KindData {
			continue
		}
		var req struct {
			ID     uint64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(fr.Payload, &req) != nil || req.Method == "" {
			continue
		}
		f.mu.Lock()
		handler := f.handlers[req.Method]
		f.mu.Unlock()
		var result any
		var callErr error
		if handler != nil {
			result, callErr = handler(req.Params)
		}
		env := map[string]any{"jsonrpc": "2.0", "id": req.ID}
		if callErr != nil {
			env["error"] = map[string]any{
				"code":    -32000,
				"message": callErr.Error(),
				"data":    map[string]any{"kind": "not_found", "hint": "check hc ls"},
			}
		} else {
			env["result"] = result
		}
		reply, _ := json.Marshal(env)
		f.writeFrame(Frame{Channel: 0, Kind: KindData, Payload: reply})
	}
}

// setHandler installs a handler for a method (safe against the serve loop).
func (f *fakeCore) setHandler(method string, fn func(json.RawMessage) (any, error)) {
	f.mu.Lock()
	f.handlers[method] = fn
	f.mu.Unlock()
}

// send pushes a frame from the core to the client.
func (f *fakeCore) send(channel uint32, kind byte, payload []byte) {
	f.writeFrame(Frame{Channel: channel, Kind: kind, Payload: payload})
}

// writeFrame serialises writes so a reply and an event never interleave bytes.
func (f *fakeCore) writeFrame(fr Frame) {
	f.wmu.Lock()
	defer f.wmu.Unlock()
	_ = writeFrame(f.conn, fr)
}

// waitFrame waits for a frame the client wrote with the given channel and kind.
func (f *fakeCore) waitFrame(t *testing.T, channel uint32, kind byte) Frame {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case fr := <-f.sent:
			if fr.Channel == channel && fr.Kind == kind {
				return fr
			}
		case <-deadline:
			t.Fatalf("no frame on channel %d kind %d", channel, kind)
		}
	}
}

func TestCallReplies(t *testing.T) {
	client, _ := startFakeCore(t, map[string]func(json.RawMessage) (any, error){
		"terminal.list": func(json.RawMessage) (any, error) {
			return map[string]any{"terminals": []map[string]any{
				{"address": "t1", "state": "live", "labels": map[string]string{"space": "b1"}, "cwd": "/tmp"},
			}}, nil
		},
	})
	defer client.Close()

	var out listResult
	if err := client.Call(context.Background(), "terminal.list", map[string]any{}, &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Terminals) != 1 || out.Terminals[0].Address != "t1" {
		t.Fatalf("result = %+v", out)
	}
}

func TestCallErrorCarriesHint(t *testing.T) {
	client, _ := startFakeCore(t, map[string]func(json.RawMessage) (any, error){
		"terminal.get": func(json.RawMessage) (any, error) {
			return nil, errFakeNoTerminal
		},
	})
	defer client.Close()

	err := client.Call(context.Background(), "terminal.get", map[string]any{"terminal": "t9"}, nil)
	if err == nil {
		t.Fatal("want an error")
	}
	if got := err.Error(); got == "" || !contains(got, "no terminal t9") || !contains(got, "check hc ls") {
		t.Fatalf("error = %q, want the message and the hint", got)
	}
}

func TestAttachStreamsDataAndDetaches(t *testing.T) {
	client, fake := startFakeCore(t, map[string]func(json.RawMessage) (any, error){
		"terminal.attach": func(json.RawMessage) (any, error) {
			return map[string]any{
				"channel":         10,
				"terminal":        map[string]any{"address": "t1", "state": "live"},
				"automatic_input": true,
			}, nil
		},
	})
	defer client.Close()

	stream, err := client.Attach(context.Background(), "t1", 100, 30, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if stream.Channel != 10 {
		t.Fatalf("channel = %d", stream.Channel)
	}

	fake.send(10, KindData, []byte("first paint"))
	select {
	case chunk := <-stream.Data():
		if string(chunk) != "first paint" {
			t.Fatalf("data = %q", chunk)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no data")
	}

	if err := stream.Write([]byte("ls\n")); err != nil {
		t.Fatal(err)
	}
	fr := fake.waitFrame(t, 10, KindData)
	if string(fr.Payload) != "ls\n" {
		t.Fatalf("input frame = %q", fr.Payload)
	}

	if err := stream.Resize(120, 40); err != nil {
		t.Fatal(err)
	}
	fr = fake.waitFrame(t, 10, KindResize)
	if len(fr.Payload) != 4 {
		t.Fatalf("resize payload = %v", fr.Payload)
	}

	stream.Credit(11)
	fr = fake.waitFrame(t, 10, KindCredit)
	if len(fr.Payload) != 4 {
		t.Fatalf("credit payload = %v", fr.Payload)
	}

	// The core ends the stream: the client sees Closed and the reason.
	fake.send(10, KindClose, []byte(`{"reason":"exited","exit_code":0}`))
	select {
	case <-stream.Closed():
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not close")
	}
	if reason := stream.Reason(); !contains(reason, "exited") {
		t.Fatalf("reason = %q", reason)
	}
}

var errFakeNoTerminal = fakeErr("no terminal t9")

type fakeErr string

func (e fakeErr) Error() string { return string(e) }

func TestSplitLines(t *testing.T) {
	lines := splitLines([]byte("{\"a\":1}\n{\"b\":2}\n"))
	if len(lines) != 2 || string(lines[1]) != `{"b":2}` {
		t.Fatalf("lines = %q", lines)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle ||
		indexOf(haystack, needle) >= 0)
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}

// The core paints a freshly attached channel immediately, so its frames can beat
// the attach reply through this reader. Dropping them left the viewer blank until
// the program wrote again — a history replay that never arrived.
func TestAttachKeepsFramesThatBeatTheReply(t *testing.T) {
	var core *fakeCore
	handlers := map[string]func(json.RawMessage) (any, error){
		"terminal.attach": func(json.RawMessage) (any, error) {
			// Paint before the reply: exactly the ordering a real core can use.
			core.send(11, KindData, []byte("first paint"))
			core.send(11, KindData, []byte(" + history"))
			return map[string]any{
				"channel":  11,
				"terminal": map[string]any{"address": "t1", "state": "live"},
			}, nil
		},
	}
	var client *Conn
	client, core = startFakeCore(t, handlers)
	defer client.Close()

	stream, err := client.Attach(context.Background(), "t1", 100, 30, 600, false)
	if err != nil {
		t.Fatal(err)
	}
	got := ""
	deadline := time.After(2 * time.Second)
	for got != "first paint + history" {
		select {
		case chunk := <-stream.Data():
			got += string(chunk)
		case <-deadline:
			t.Fatalf("data = %q, want the frames that arrived before registration", got)
		}
	}
}

// A frame for a channel nobody registers must not accumulate forever.
func TestHeldFramesAreBounded(t *testing.T) {
	client, fake := startFakeCore(t, map[string]func(json.RawMessage) (any, error){})
	defer client.Close()

	payload := make([]byte, 1024)
	for i := 0; i < heldFramesMax*4; i++ {
		fake.send(99, KindData, payload)
	}
	time.Sleep(200 * time.Millisecond)

	client.hmu.Lock()
	held, bytesHeld := len(client.held[99].frames), client.heldBytes
	client.hmu.Unlock()
	if held > heldFramesMax || bytesHeld > heldBytesMax {
		t.Fatalf("held %d frames / %d bytes, want at most %d / %d", held, bytesHeld, heldFramesMax, heldBytesMax)
	}
}
