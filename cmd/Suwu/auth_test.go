package main

// Tests for `suwu auth ls|rm`: the CLI half. The server half is covered in
// pkg/server/sessions_test.go; here the contract is the socket command and what
// the user reads.

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"suwu/pkg/notify"
)

// fakeSocket answers one command and records it.
func fakeSocket(t *testing.T, respond func(notify.Command) notify.CommandResponse) (string, *[]notify.Command) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "suwu.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	seen := &[]notify.Command{}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			// Read one newline-terminated command; the client keeps the
			// connection open waiting for the reply, so ReadAll would deadlock.
			data, err := bufio.NewReader(conn).ReadBytes('\n')
			if err != nil && len(data) == 0 {
				_ = conn.Close()
				continue
			}
			var cmd notify.Command
			_ = json.Unmarshal(data, &cmd)
			*seen = append(*seen, cmd)
			resp, _ := json.Marshal(respond(cmd))
			_, _ = conn.Write(resp)
			_ = conn.Close()
		}
	}()
	return path, seen
}

// captureAuthStdout runs fn and returns what it printed. (The package already
// has a captureStdout for a func(); this one has to see the error as well.)
func captureAuthStdout(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	runErr := fn()
	_ = w.Close()
	os.Stdout = old
	out, _ := io.ReadAll(r)
	return string(out), runErr
}

func TestAuthListPrintsSessions(t *testing.T) {
	respond := func(cmd notify.Command) notify.CommandResponse {
		if cmd.Action != "sessions-list" {
			return notify.CommandResponse{OK: false, Error: "unexpected action " + cmd.Action}
		}
		data, _ := json.Marshal(map[string]any{"sessions": []map[string]any{
			{"id": "aaaa1111bbbb", "label": "iPhone · Safari", "created": "2026-11-23T10:00:00Z",
				"lastSeen": "2026-11-23T12:00:00Z", "expires": "2026-12-23T12:00:00Z", "current": false},
			{"id": "cccc2222dddd", "label": "Mac · Chrome", "created": "2026-11-20T10:00:00Z",
				"lastSeen": "2026-11-23T12:30:00Z", "expires": "2026-12-23T12:30:00Z", "current": true},
		}})
		return notify.CommandResponse{OK: true, Data: data}
	}
	path, seen := fakeSocket(t, respond)
	out, err := captureAuthStdout(t, func() error { return authList([]string{"--sock", path}) })
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"aaaa1111bbbb", "iPhone · Safari", "cccc2222dddd", "Mac · Chrome", "(this session)"} {
		if !strings.Contains(out, want) {
			t.Errorf("output is missing %q:\n%s", want, out)
		}
	}
	if len(*seen) != 1 || (*seen)[0].Action != "sessions-list" {
		t.Fatalf("commands: %+v", *seen)
	}
}

func TestAuthListJSON(t *testing.T) {
	data, _ := json.Marshal(map[string]any{"sessions": []map[string]any{{"id": "abc", "label": "phone"}}})
	path, _ := fakeSocket(t, func(notify.Command) notify.CommandResponse {
		return notify.CommandResponse{OK: true, Data: data}
	})
	out, err := captureAuthStdout(t, func() error { return authList([]string{"--sock", path, "--json"}) })
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Sessions []struct {
			ID string `json:"id"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("not JSON: %q (%v)", out, err)
	}
	if len(parsed.Sessions) != 1 || parsed.Sessions[0].ID != "abc" {
		t.Fatalf("parsed %+v", parsed)
	}
}

func TestAuthRemoveSendsTheId(t *testing.T) {
	path, seen := fakeSocket(t, func(cmd notify.Command) notify.CommandResponse {
		data, _ := json.Marshal(map[string]any{"revoked": 1, "label": "iPhone · Safari"})
		return notify.CommandResponse{OK: true, Data: data}
	})
	out, err := captureAuthStdout(t, func() error {
		return authRemove([]string{"--sock", path, "--yes", "aaaa1111bbbb"})
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "aaaa1111bbbb") || !strings.Contains(out, "iPhone · Safari") {
		t.Fatalf("output %q", out)
	}
	if len(*seen) != 1 || (*seen)[0].Action != "sessions-revoke" {
		t.Fatalf("commands: %+v", *seen)
	}
	var payload struct {
		ID  string `json:"id"`
		All bool   `json:"all"`
	}
	if err := json.Unmarshal((*seen)[0].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.ID != "aaaa1111bbbb" || payload.All {
		t.Fatalf("payload %+v", payload)
	}
}

func TestAuthRemoveAll(t *testing.T) {
	path, seen := fakeSocket(t, func(notify.Command) notify.CommandResponse {
		data, _ := json.Marshal(map[string]any{"revoked": 3})
		return notify.CommandResponse{OK: true, Data: data, Message: "Devices signed out."}
	})
	out, err := captureAuthStdout(t, func() error { return authRemove([]string{"--sock", path, "--yes", "--all"}) })
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Revoked 3 session(s).") {
		t.Fatalf("output %q", out)
	}
	var payload struct {
		All bool `json:"all"`
	}
	_ = json.Unmarshal((*seen)[0].Payload, &payload)
	if !payload.All {
		t.Fatalf("payload %+v", payload)
	}
}

func TestAuthUsageErrors(t *testing.T) {
	if code := authMain(nil); code != 64 {
		t.Fatalf("no args: %d", code)
	}
	if code := authMain([]string{"nonsense"}); code != 64 {
		t.Fatalf("unknown command: %d", code)
	}
	if err := authRemove([]string{"--all", "someid"}); err == nil {
		t.Fatal("--all with an id was accepted")
	}
	if err := authRemove([]string{"--hard"}); err == nil {
		t.Fatal("--hard without --all was accepted")
	}
}
