package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"suwu/pkg/install"
)

func TestInstallFlagsCheckModes(t *testing.T) {
	tests := []struct {
		name    string
		f       installFlags
		wantErr string
	}{
		{name: "bare", f: installFlags{}},
		{name: "github", f: installFlags{github: true}},
		{name: "one archive", f: installFlags{extension: "a.zip"}},
		{name: "github with a kind", f: installFlags{github: true, kind: "background"}},
		{name: "all", f: installFlags{all: true, kind: "extension"}},
		{
			name:    "github and an archive conflict",
			f:       installFlags{github: true, extension: "a.zip"},
			wantErr: "mutually exclusive",
		},
		{
			name:    "two archives conflict",
			f:       installFlags{extension: "a.zip", background: "b.zip"},
			wantErr: "mutually exclusive",
		},
		{
			name:    "kind with an archive is meaningless",
			f:       installFlags{extension: "a.zip", kind: "extension"},
			wantErr: "does not apply to a zip",
		},
		{
			name:    "unknown kind",
			f:       installFlags{kind: "theme"},
			wantErr: "unknown kind",
		},
		{
			name:    "all with names",
			f:       installFlags{all: true, names: []string{"eye"}},
			wantErr: "cannot be combined",
		},
		{
			name:    "refresh with an archive",
			f:       installFlags{extension: "a.zip", refresh: true},
			wantErr: "does not apply to a zip",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.f.checkModes()
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want it to contain %q", err, tc.wantErr)
			}
		})
	}
}

func TestInstallPickByName(t *testing.T) {
	cat := &install.Catalog{
		Repo: "o/r", Ref: "master",
		Entries: []install.CatalogEntry{
			{Kind: install.KindExtension, ID: "eye"},
			{Kind: install.KindExtension, ID: "note"},
			// An id shared by both kinds: bare names must stay unambiguous.
			{Kind: install.KindBackground, ID: "note"},
		},
	}

	t.Run("bare name prefers extensions", func(t *testing.T) {
		got, err := pickByName(cat, []string{"eye"})
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 1 || got[0].Kind != install.KindExtension {
			t.Errorf("got %+v, want the extension", got)
		}
	})

	t.Run("kind qualified", func(t *testing.T) {
		got, err := pickByName(cat, []string{"background/note"})
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 1 || got[0].Kind != install.KindBackground {
			t.Errorf("got %+v, want the background", got)
		}
	})

	t.Run("several names", func(t *testing.T) {
		got, err := pickByName(cat, []string{"eye", "background/note"})
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 2 {
			t.Errorf("got %d items, want 2", len(got))
		}
	})

	t.Run("unknown name", func(t *testing.T) {
		if _, err := pickByName(cat, []string{"nope"}); err == nil || !strings.Contains(err.Error(), "--list") {
			t.Fatalf("err = %v, want a not-in-catalog error pointing at --list", err)
		}
	})

	t.Run("bad kind qualifier", func(t *testing.T) {
		if _, err := pickByName(cat, []string{"theme/eye"}); err == nil {
			t.Fatal("an unknown kind qualifier was accepted")
		}
	})
}

func TestInstallDataDir(t *testing.T) {
	t.Run("SUWU_VAR wins", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("SUWU_VAR", dir)
		got, err := installDataDir()
		if err != nil {
			t.Fatal(err)
		}
		if got != dir {
			t.Errorf("data dir = %q, want %q", got, dir)
		}
	})

	t.Run("defaults to ~/.suwu", func(t *testing.T) {
		t.Setenv("SUWU_VAR", "")
		got, err := installDataDir()
		if err != nil {
			t.Fatal(err)
		}
		if filepath.Base(got) != ".suwu" {
			t.Errorf("data dir = %q, want the ~/.suwu default", got)
		}
	})
}

func TestHumanBytes(t *testing.T) {
	cases := map[int64]string{
		0:           "0 B",
		512:         "512 B",
		1024:        "1.0 KiB",
		1536:        "1.5 KiB",
		1 << 20:     "1.0 MiB",
		40 << 20:    "40.0 MiB",
		1<<30 + 512: "1.0 GiB",
	}
	for in, want := range cases {
		if got := humanBytes(in); got != want {
			t.Errorf("humanBytes(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestInstallLegacyNotice(t *testing.T) {
	dir := t.TempDir()
	if got := extensionLegacyNotice(dir); got != "" {
		t.Errorf("notice on a fresh data dir: %q", got)
	}
	// A legacy directory with an extension produces the hint.
	legacy := filepath.Join(dir, "extensions", "eye")
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(legacy, "package.json"), `{"name":"Eye"}`)
	writeFile(t, filepath.Join(legacy, "index.js"), "function handler(){}")
	got := extensionLegacyNotice(dir)
	if !strings.Contains(got, "move it to") {
		t.Errorf("notice = %q, want a migration hint", got)
	}
}

func TestReportItemFailureExitsNonZero(t *testing.T) {
	// A failed archive install must surface a non-nil error so main's
	// log.Fatalf path exits non-zero.
	err := reportItem(install.Item{Kind: install.KindExtension, ID: "eye"},
		errStub("not a valid extension"), install.Options{DataDir: t.TempDir()})
	if err == nil {
		t.Fatal("reportItem swallowed the failure")
	}
}

type errStub string

func (e errStub) Error() string { return string(e) }

// writeFile is a test helper for the few fixtures that need a file.
func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPrintInstallUsageMentionsTheModes(t *testing.T) {
	// The help text is the only documentation a non-TTY user gets, so it must
	// name all three modes and the data dir.
	var buf bytes.Buffer
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	printInstallUsage()
	_ = w.Close()
	os.Stdout = old
	if _, err := buf.ReadFrom(r); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	for _, want := range []string{"--github", "--extension", "--background", "--force", "--dry-run", "SUWU_VAR"} {
		if !strings.Contains(out, want) {
			t.Errorf("usage text does not mention %q", want)
		}
	}
}
