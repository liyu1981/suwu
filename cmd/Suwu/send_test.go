package main

import (
	"errors"
	"io"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"suwu/pkg/notify"
)

func TestSendStdinMessage(t *testing.T) {
	for _, tc := range []struct{ name, input, want string }{
		{"multiline", "first\nsecond\n", "first\nsecond"},
		{"blank lines", "first\n\nsecond\n\n", "first\n\nsecond\n"},
		{"no final newline", "first\nsecond", "first\nsecond"},
		{"single line", "hello\n", "hello"},
		{"CRLF preserved", "first\r\nsecond\r\n", "first\r\nsecond\r"},
		{"JSON is text", "{\"action\":\"example\"}\n", "{\"action\":\"example\"}"},
		{"unicode", "你好\n世界\n", "你好\n世界"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sock := filepath.Join(t.TempDir(), "notify.sock")
			listener, err := notify.NewListener(sock)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { listener.Close() })
			ch := listener.Subscribe()
			if err := sendStdinMessage(sock, strings.NewReader(tc.input)); err != nil {
				t.Fatal(err)
			}
			select {
			case n := <-ch:
				if n.Message != tc.want {
					t.Fatalf("message = %q, want %q", n.Message, tc.want)
				}
				if n.ID == "" || n.Timestamp == 0 {
					t.Fatal("missing server-assigned notification metadata")
				}
			case <-time.After(time.Second):
				t.Fatal("notification not received")
			}
			select {
			case n := <-ch:
				t.Fatalf("unexpected extra notification: %+v", n)
			case <-time.After(30 * time.Millisecond):
			}
		})
	}
}

func TestSendStdinMessageRejectsInvalidInput(t *testing.T) {
	for _, tc := range []struct{ name, input, wantError string }{
		{"empty", "", "usage:"},
		{"newline only", "\n", "usage:"},
		{"oversize raw", strings.Repeat("a", notify.MaxMessageBytes+1), "too large"},
		{"oversize escaped", strings.Repeat("\t", notify.MaxMessageBytes/2), "too large"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Input validation must happen before attempting to connect.
			err := sendStdinMessage("", strings.NewReader(tc.input))
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("error = %v, want %q", err, tc.wantError)
			}
			if tc.wantError == "too large" && (!strings.Contains(err.Error(), "1 MiB (1048576 bytes)") || !strings.Contains(err.Error(), "nothing was sent")) {
				t.Fatalf("missing limit or no-send explanation: %v", err)
			}
		})
	}
}

type stdinErrorReader struct{ err error }

func (r stdinErrorReader) Read([]byte) (int, error) { return 0, r.err }

func TestSendStdinMessageReadError(t *testing.T) {
	want := errors.New("input failed")
	input := io.MultiReader(strings.NewReader("partial\n"), stdinErrorReader{want})
	if err := sendStdinMessage("", input); !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}
