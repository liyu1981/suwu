package extension

// Tests for suwu.commands (CLI verbs) and the shared exec sandbox policy.

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// commandExt writes an extension declaring the given suwu.commands JSON.
func commandExt(t *testing.T, dir, id, commandsJSON string, files ...string) {
	t.Helper()
	writeExt(t, dir, id, `{"name":"Cmd","suwu":{"fs":true,"commands":`+commandsJSON+`}}`,
		`function handler(){}`)
	for _, f := range files {
		p := filepath.Join(dir, id, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("function handler(){}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestResolveCommands(t *testing.T) {
	dir := t.TempDir()
	commandExt(t, dir, "draw",
		`[{"name":"new","handler":"new.js","description":"Create a document"},
		  {"name":"export-pdf","handler":"export.js"}]`,
		"new.js", "export.js")

	ext, err := Resolve(dir, "draw")
	if err != nil {
		t.Fatal(err)
	}
	if len(ext.Commands) != 2 {
		t.Fatalf("commands = %+v", ext.Commands)
	}
	// Sorted by name, so `--list` output is stable.
	if ext.Commands[0].Name != "export-pdf" || ext.Commands[1].Name != "new" {
		t.Errorf("command order = %v", ext.Commands)
	}
	if ext.Commands[1].Description != "Create a document" {
		t.Errorf("description = %q", ext.Commands[1].Description)
	}
	if c, ok := ext.Command("new"); !ok || c.Handler != "new.js" {
		t.Errorf("Command(new) = %+v, %v", c, ok)
	}
	if _, ok := ext.Command("nope"); ok {
		t.Error("Command(nope) must not resolve")
	}

	// No declaration: the extension simply offers no verbs.
	writeExt(t, dir, "plain", `{"name":"Plain"}`, `function handler(){}`)
	plain, err := Resolve(dir, "plain")
	if err != nil {
		t.Fatal(err)
	}
	if len(plain.Commands) != 0 {
		t.Errorf("plain commands = %+v, want none", plain.Commands)
	}
}

func TestResolveRejectsBadCommands(t *testing.T) {
	cases := map[string]string{
		"name with a space": `[{"name":"new doc","handler":"new.js"}]`,
		"upper-case name":   `[{"name":"New","handler":"new.js"}]`,
		"empty name":        `[{"name":"","handler":"new.js"}]`,
		"leading dash":      `[{"name":"-new","handler":"new.js"}]`,
		"duplicate name":    `[{"name":"new","handler":"new.js"},{"name":"new","handler":"new.js"}]`,
		"handler not js":    `[{"name":"new","handler":"new.ts"}]`,
		"handler traversal": `[{"name":"new","handler":"../escape.js"}]`,
		"handler absolute":  `[{"name":"new","handler":"/etc/new.js"}]`,
		"missing handler":   `[{"name":"new","handler":"gone.js"}]`,
	}
	for name, decl := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			commandExt(t, dir, "bad", decl, "new.js")
			if _, err := Resolve(dir, "bad"); err == nil {
				t.Errorf("commands %s must fail Resolve", decl)
			}
		})
	}

	t.Run("too many", func(t *testing.T) {
		dir := t.TempDir()
		parts := make([]string, maxCommands+1)
		for i := range parts {
			parts[i] = `{"name":"c` + strings.Repeat("x", i%3) + itoa(i) + `","handler":"new.js"}`
		}
		commandExt(t, dir, "many", "["+strings.Join(parts, ",")+"]", "new.js")
		if _, err := Resolve(dir, "many"); err == nil {
			t.Error("more than the command cap must be rejected")
		}
	})
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// The sandbox is one policy for renders, API calls and CLI commands: the
// extensions tree is always readable, and suwu.fs is the only thing that adds
// writable mounts (its own data dir, plus the target directory when one is known).
func TestExecSandbox(t *testing.T) {
	extRoot := filepath.Join("/data", "extension")

	t.Run("no suwu.fs is read-only", func(t *testing.T) {
		mounts, readOnly := ExecSandbox(Extension{ID: "eye"}, extRoot, "/home/u/docs")
		if !readOnly {
			t.Error("without suwu.fs the run must be read-only")
		}
		want := []ExecMount{{Virtual: "/ext", Real: extRoot}}
		if !reflect.DeepEqual(mounts, want) {
			t.Errorf("mounts = %+v, want %+v", mounts, want)
		}
	})

	t.Run("suwu.fs adds data and target", func(t *testing.T) {
		mounts, readOnly := ExecSandbox(Extension{ID: "bento", FS: true}, extRoot, "/home/u/decks")
		if readOnly {
			t.Error("suwu.fs must give a writable sandbox")
		}
		want := []ExecMount{
			{Virtual: "/ext", Real: extRoot},
			{Virtual: "/ext-data", Real: filepath.Join("/data", "extension-data", "bento")},
			{Virtual: "/fs", Real: "/home/u/decks"},
		}
		if !reflect.DeepEqual(mounts, want) {
			t.Errorf("mounts = %+v, want %+v", mounts, want)
		}
	})

	t.Run("no target dir means no /fs", func(t *testing.T) {
		mounts, readOnly := ExecSandbox(Extension{ID: "bento", FS: true}, extRoot, "")
		if readOnly {
			t.Errorf("suwu.fs is still writable without a target")
		}
		for _, m := range mounts {
			if m.Virtual == "/fs" {
				t.Error("/fs must not be mounted without a target directory")
			}
		}
	})

	t.Run("legacy extension dir still maps ext-data beside it", func(t *testing.T) {
		legacy := filepath.Join("/data", "extensions")
		mounts, _ := ExecSandbox(Extension{ID: "note", FS: true}, legacy, "/home/u")
		if mounts[1].Real != filepath.Join("/data", "extension-data", "note") {
			t.Errorf("ext-data = %q, want it beside the extensions tree", mounts[1].Real)
		}
	})
}
