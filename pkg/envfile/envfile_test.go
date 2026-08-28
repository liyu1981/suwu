package envfile

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func loadString(t *testing.T, content string) map[string]string {
	t.Helper()
	got := map[string]string{}
	if err := LoadFrom(&stringReader{s: content}, func(k, v string) {
		got[k] = v
	}); err != nil {
		t.Fatal(err)
	}
	return got
}

type stringReader struct {
	s string
	i int
}

func (r *stringReader) Read(p []byte) (int, error) {
	if r.i >= len(r.s) {
		return 0, io.EOF
	}
	n := copy(p, r.s[r.i:])
	r.i += n
	return n, nil
}

func TestParseBasic(t *testing.T) {
	got := loadString(t, `
# comment
HOST=0.0.0.0
PORT=8080
export EXTRA_HOSTS=192.168.0.221
QUOTED="hello world"
SINGLE='single quoted'
  SPACED = trimmed
`)
	want := map[string]string{
		"HOST":        "0.0.0.0",
		"PORT":        "8080",
		"EXTRA_HOSTS": "192.168.0.221",
		"QUOTED":      "hello world",
		"SINGLE":      "single quoted",
		"SPACED":      "trimmed",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}

func TestParseEscapes(t *testing.T) {
	got := loadString(t, `MSG="line1\nline2\t\"quoted\" \\ path"`)
	if got["MSG"] != "line1\nline2\t\"quoted\" \\ path" {
		t.Errorf("MSG = %q", got["MSG"])
	}
}

func TestLoadFileExistingEnvWins(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := os.WriteFile(path, []byte("HOST=0.0.0.0\nPORT=9999\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Existing env wins over the file.
	t.Setenv("HOST", "keep.me")
	t.Setenv("PORT", "")

	if err := Load(path); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("HOST") != "keep.me" {
		t.Errorf("HOST = %q, want keep.me (existing env must win)", os.Getenv("HOST"))
	}
	if os.Getenv("PORT") != "9999" {
		t.Errorf("PORT = %q, want 9999", os.Getenv("PORT"))
	}
}

func TestLoadMissingFile(t *testing.T) {
	if err := Load(filepath.Join(t.TempDir(), "nope.env")); err != nil {
		t.Fatalf("missing file should be a no-op, got %v", err)
	}
}

func TestUpsertNewFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", ".env")
	if err := Upsert(path, map[string]string{"TLS_CERT_FILE": "/x/cert.pem", "TLS_KEY_FILE": "/x/key.pem"}); err != nil {
		t.Fatal(err)
	}
	got := loadFile(t, path)
	if got["TLS_CERT_FILE"] != "/x/cert.pem" || got["TLS_KEY_FILE"] != "/x/key.pem" {
		t.Errorf("got %v", got)
	}
}

func TestUpsertUpdatesInPlacePreservingComments(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	before := "# header comment\nHOST=0.0.0.0\n\n# bind note\nPORT=8080\n"
	if err := os.WriteFile(path, []byte(before), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := Upsert(path, map[string]string{"PORT": "9090", "TLS_CERT_FILE": "/c.pem"}); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	want := "# header comment\nHOST=0.0.0.0\n\n# bind note\nPORT=9090\n\nTLS_CERT_FILE=/c.pem\n"
	if got != want {
		t.Errorf("file =\n%q\nwant\n%q", got, want)
	}
	parsed := loadFile(t, path)
	if parsed["HOST"] != "0.0.0.0" || parsed["PORT"] != "9090" || parsed["TLS_CERT_FILE"] != "/c.pem" {
		t.Errorf("parsed %v", parsed)
	}
}

func TestUpsertQuotesSpaces(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := Upsert(path, map[string]string{"MSG": "hello world #2"}); err != nil {
		t.Fatal(err)
	}
	if got := loadFile(t, path)["MSG"]; got != "hello world #2" {
		t.Errorf("MSG = %q", got)
	}
}

func TestUpsertExportLineUpdated(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("export PORT=8080\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Upsert(path, map[string]string{"PORT": "9000"}); err != nil {
		t.Fatal(err)
	}
	got := loadFile(t, path)
	if got["PORT"] != "9000" {
		t.Errorf("parsed %v", got)
	}
}

func loadFile(t *testing.T, path string) map[string]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	got := map[string]string{}
	if err := LoadFrom(f, func(k, v string) { got[k] = v }); err != nil {
		t.Fatal(err)
	}
	return got
}
