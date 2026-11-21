package herdr

import (
	"context"
	"encoding/json"
	"net"
	"sync"
	"testing"
	"time"
)

// fakeDialer hands the Core an in-memory connection backed by startFakeCore, and
// counts how often the Core decided to (re)dial.
type fakeDialer struct {
	t      *testing.T
	mu     sync.Mutex
	calls  int
	fake   *fakeCore
	client *Conn
}

func (d *fakeDialer) dial(context.Context, ConnOptions) (*Conn, error) {
	d.mu.Lock()
	d.calls++
	d.mu.Unlock()
	c, f := startFakeCore(d.t, map[string]func(json.RawMessage) (any, error){
		"terminal.list": func(json.RawMessage) (any, error) {
			return map[string]any{"terminals": []any{}, "machines": []any{}}, nil
		},
		"events.subscribe": func(json.RawMessage) (any, error) {
			return map[string]any{"seq": 0, "terminals": []any{}, "channel": 5}, nil
		},
		"doc.get": func(json.RawMessage) (any, error) {
			return map[string]any{"value": nil, "version": 0}, nil
		},
	})
	d.mu.Lock()
	d.fake = f
	d.client = c
	d.mu.Unlock()
	// newConn skips the handshake, so give the Core the metadata it would have.
	c.Version = "0.1.21"
	c.CoreName = "testbox"
	return c, nil
}

func (d *fakeDialer) current() (*Conn, *fakeCore) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.client, d.fake
}

func newTestCore(t *testing.T) (*Core, *fakeDialer) {
	t.Helper()
	dialer := &fakeDialer{t: t}
	core := &Core{
		session:   "test",
		repos:     newGitRootCache(),
		home:      "/home/tester",
		terminals: make(map[string]Terminal),
		dial:      dialer.dial,
	}
	t.Cleanup(core.Close)
	return core, dialer
}

// sendEvent pushes one framed event (JSON lines on the subscribe channel).
func sendEvent(t *testing.T, fake *fakeCore, channel uint32, typ, terminal string, data any) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "event",
		"params":  map[string]any{"seq": time.Now().UnixNano(), "type": typ, "terminal": terminal, "data": data},
	})
	if err != nil {
		t.Fatal(err)
	}
	fake.send(channel, KindData, append(payload, '\n'))
	// Give the client's events loop a moment to fold it in.
	time.Sleep(60 * time.Millisecond)
}

func labels(space string) map[string]string {
	if space == "" {
		return map[string]string{}
	}
	return map[string]string{"space": space}
}

func TestSnapshotAssemblesSpacesFromLabelsAndCwd(t *testing.T) {
	core, dialer := newTestCore(t)
	ctx := context.Background()
	if _, err := core.Snapshot(ctx); err != nil {
		t.Fatal(err)
	}
	_, fake := dialer.current()

	sendEvent(t, fake, 5, "created", "t1", map[string]any{
		"address": "t1", "state": "live", "cwd": "/home/tester/project", "created_ms": 1,
		"labels":     labels("b1"),
		"foreground": map[string]any{"pid": 1, "name": "bash", "argv": []string{"bash"}, "cwd": "/home/tester/project"},
	})
	sendEvent(t, fake, 5, "created", "t2", map[string]any{
		"address": "t2", "state": "live", "cwd": "/tmp/loose", "created_ms": 2, "labels": labels(""),
	})

	snap, err := core.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Spaces) != 1 || snap.Spaces[0].ID != "b1" {
		t.Fatalf("spaces = %+v", snap.Spaces)
	}
	if snap.Spaces[0].Name != "project" {
		t.Errorf("space name = %q, want the directory basename", snap.Spaces[0].Name)
	}
	if len(snap.Unassigned) != 1 || snap.Unassigned[0].Address != "t2" {
		t.Errorf("unassigned = %+v", snap.Unassigned)
	}

	// The name follows the space's FIRST tab (its identity terminal): a later
	// terminal in the same space with a different directory must not rename it.
	sendEvent(t, fake, 5, "created", "t3", map[string]any{
		"address": "t3", "state": "live", "cwd": "/elsewhere", "created_ms": 5,
		"labels": labels("b1"),
	})
	sendEvent(t, fake, 5, "foreground", "t3", map[string]any{"pid": 2, "name": "bash", "argv": []string{"bash"}, "cwd": "/elsewhere"})
	snap, err = core.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Spaces[0].Name != "project" {
		t.Errorf("a later terminal renamed the space: %q", snap.Spaces[0].Name)
	}

	// The identity terminal's own cd does rename it (the first tab's cwd).
	sendEvent(t, fake, 5, "foreground", "t1", map[string]any{"pid": 1, "name": "bash", "argv": []string{"bash"}, "cwd": "/home/tester/other"})
	snap, err = core.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Spaces[0].Name != "other" {
		t.Errorf("after the first tab cd: name = %q, want other", snap.Spaces[0].Name)
	}
	if snap.Spaces[0].ID != "b1" {
		t.Errorf("the space id must not change when the cwd does")
	}
	if got := snap.Spaces[0].Terminals[0].Cwd; got != "/home/tester/other" {
		t.Errorf("terminal cwd = %q, want the live directory", got)
	}

	// A status makes a terminal an agent, with the program's own words.
	sendEvent(t, fake, 5, "status", "t1", map[string]any{
		"status": map[string]any{"state": "working", "msg": "building", "app": "claude"},
	})
	snap, _ = core.Snapshot(ctx)
	if got := snap.Spaces[0].Terminals[0].Status; got == nil || got.State != "working" || got.Msg != "building" {
		t.Errorf("status = %+v", got)
	}

	// Relabelling moves a terminal between groups.
	sendEvent(t, fake, 5, "labels", "t2", map[string]any{"labels": labels("b1")})
	snap, _ = core.Snapshot(ctx)
	if len(snap.Unassigned) != 0 || len(snap.Spaces[0].Terminals) != 3 {
		t.Errorf("after relabel: spaces=%+v unassigned=%+v", snap.Spaces, snap.Unassigned)
	}

	// Finished terminals drop out of the view.
	sendEvent(t, fake, 5, "finished", "t2", map[string]any{"reason": "exited", "exit_code": 0, "finished_ms": 123})
	snap, _ = core.Snapshot(ctx)
	if len(snap.Spaces[0].Terminals) != 2 {
		t.Errorf("finished terminal still listed: %+v", snap.Spaces[0].Terminals)
	}
}

func TestDocBackedNamesOverrideAndClear(t *testing.T) {
	core, dialer := newTestCore(t)
	ctx := context.Background()
	if _, err := core.Snapshot(ctx); err != nil {
		t.Fatal(err)
	}
	_, fake := dialer.current()
	sendEvent(t, fake, 5, "created", "t1", map[string]any{
		"address": "t1", "state": "live", "cwd": "/srv/app", "created_ms": 1,
		"labels": labels("b1"),
	})

	// doc.set answers with a version; the fake records the value it was given.
	var setValue map[string]any
	var setVersion int
	dialer.mu.Lock()
	dialer.fake.handlers["doc.set"] = func(params json.RawMessage) (any, error) {
		var req struct {
			Value   json.RawMessage `json:"value"`
			Version int             `json:"version"`
		}
		_ = json.Unmarshal(params, &req)
		setVersion = req.Version
		_ = json.Unmarshal(req.Value, &setValue)
		return map[string]any{"version": req.Version + 1}, nil
	}
	dialer.mu.Unlock()

	if err := core.SetSpaceMeta(ctx, "b1", func(m *SpaceMeta) { m.CustomName = "pinned"; m.Colour = "violet" }); err != nil {
		t.Fatal(err)
	}
	if setVersion != 0 {
		t.Errorf("first write used version %d, want 0", setVersion)
	}
	spacesValue, _ := setValue["spaces"].(map[string]any)
	if spacesValue == nil {
		t.Fatalf("doc value = %v", setValue)
	}

	// Apply it locally the way a successful write does, then read the snapshot.
	core.mu.Lock()
	core.doc = DocState{Spaces: map[string]SpaceMeta{"b1": {CustomName: "pinned", Colour: "violet"}}}
	core.mu.Unlock()

	snap, _ := core.Snapshot(ctx)
	if snap.Spaces[0].Name != "pinned" {
		t.Errorf("custom name did not win: %q", snap.Spaces[0].Name)
	}
	if snap.Spaces[0].Colour != "violet" {
		t.Errorf("colour = %q", snap.Spaces[0].Colour)
	}

	// Clearing the name returns to the derived one.
	if err := core.SetSpaceMeta(ctx, "b1", func(m *SpaceMeta) { m.CustomName = "" }); err != nil {
		t.Fatal(err)
	}
	core.mu.Lock()
	core.doc = DocState{Spaces: map[string]SpaceMeta{"b1": {}}}
	core.mu.Unlock()
	snap, _ = core.Snapshot(ctx)
	if snap.Spaces[0].Name != "app" {
		t.Errorf("after clearing: %q, want the directory name", snap.Spaces[0].Name)
	}
}

func TestDocSetRetriesOnConflict(t *testing.T) {
	core, dialer := newTestCore(t)
	ctx := context.Background()
	if _, err := core.Snapshot(ctx); err != nil {
		t.Fatal(err)
	}
	var attempts int
	dialer.fake.setHandler("doc.set", func(json.RawMessage) (any, error) {
		attempts++
		if attempts == 1 {
			return nil, fakeErr("conflict: version changed")
		}
		return map[string]any{"version": 2}, nil
	})

	if err := core.SetSpaceMeta(ctx, "b1", func(m *SpaceMeta) { m.CustomName = "x" }); err != nil {
		t.Fatalf("conflict should have been retried: %v", err)
	}
	if attempts != 2 {
		t.Errorf("attempts = %d, want 2", attempts)
	}
}

func TestEnsureRedialsAfterTheConnectionDies(t *testing.T) {
	core, dialer := newTestCore(t)
	ctx := context.Background()
	if _, err := core.Snapshot(ctx); err != nil {
		t.Fatal(err)
	}
	first, firstFake := dialer.current()
	firstFake.conn.Close() // the core went away
	select {
	case <-first.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("client did not notice the closed connection")
	}

	if _, err := core.Snapshot(ctx); err != nil {
		t.Fatal(err)
	}
	dialer.mu.Lock()
	calls := dialer.calls
	dialer.mu.Unlock()
	if calls < 2 {
		t.Fatalf("dial calls = %d, want a redial", calls)
	}
}

func TestEventsFromChannelZeroAlsoApply(t *testing.T) {
	core, dialer := newTestCore(t)
	ctx := context.Background()
	if _, err := core.Snapshot(ctx); err != nil {
		t.Fatal(err)
	}
	_, fake := dialer.current()

	// A core without an events channel sends notifications on channel 0.
	payload, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "event",
		"params": map[string]any{
			"seq": 99, "type": "created", "terminal": "t9",
			"data": map[string]any{"address": "t9", "state": "live", "cwd": "/x/y", "created_ms": 9, "labels": labels("b9")},
		},
	})
	fake.send(0, KindData, payload)
	time.Sleep(80 * time.Millisecond)
	snap, _ := core.Snapshot(ctx)
	found := false
	for _, space := range snap.Spaces {
		if space.ID == "b9" && space.Name == "y" {
			found = true
		}
	}
	if !found {
		t.Fatalf("channel-0 event was not applied: %+v", snap.Spaces)
	}
}

func TestSplitLinesKeepsEmptyFramesSafe(t *testing.T) {
	if got := splitLines(nil); len(got) != 0 {
		t.Errorf("nil -> %v", got)
	}
	select {
	case <-time.After(time.Millisecond):
	}
	if _, err := net.Listen("tcp", "127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
}
