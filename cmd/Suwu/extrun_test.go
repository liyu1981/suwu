package main

import (
	"testing"

	"suwu/pkg/extension"
)

func TestParseCommandResult(t *testing.T) {
	cases := []struct {
		raw    string
		body   string
		status int
	}{
		{`"done"`, "done", 0},
		{`{"status":201,"body":"/tmp/x.bento.html"}`, "/tmp/x.bento.html", 201},
		{`{"body":"plain"}`, "plain", 0},
		{``, "", 0},
		{`null`, "", 0},
	}
	for _, tc := range cases {
		got, err := parseCommandResult([]byte(tc.raw))
		if err != nil {
			t.Fatalf("parseCommandResult(%q): %v", tc.raw, err)
		}
		if got.Body != tc.body || got.Status != tc.status {
			t.Errorf("parseCommandResult(%q) = %+v, want body=%q status=%d", tc.raw, got, tc.body, tc.status)
		}
	}
	if _, err := parseCommandResult([]byte(`{`)); err == nil {
		t.Error("malformed JSON must fail")
	}
}

// A command must only write where the sandbox mounts it: with suwu.fs the handler
// gets /fs, without it there is no writable place at all.
func TestVirtualTargetDir(t *testing.T) {
	if got := virtualTargetDir(extension.Extension{ID: "x"}, "/home/u"); got != "" {
		t.Errorf("without suwu.fs target = %q, want empty", got)
	}
	if got := virtualTargetDir(extension.Extension{ID: "x", FS: true}, "/home/u"); got != "/fs" {
		t.Errorf("with suwu.fs target = %q, want /fs", got)
	}
	if got := virtualTargetDir(extension.Extension{ID: "x", FS: true}, ""); got != "" {
		t.Errorf("without a dir target = %q, want empty", got)
	}
}
