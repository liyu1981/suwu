package staticserve

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCreateIDConflictsAndIdempotency(t *testing.T) {
	parent := t.TempDir()
	dirA := filepath.Join(parent, "a", "myweb")
	dirB := filepath.Join(parent, "b", "myweb")
	if err := os.MkdirAll(dirA, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dirB, 0o755); err != nil {
		t.Fatal(err)
	}

	m := NewManager()
	defer m.CloseAll()

	e1, created, err := m.Create(dirA, false)
	if err != nil || !created || e1.ID != "myweb" {
		t.Fatalf("first create = %+v created=%v err=%v", e1, created, err)
	}
	e1b, created, err := m.Create(dirA, false)
	if err != nil || created || e1b != e1 {
		t.Fatalf("same path should reuse: entry=%p created=%v err=%v", e1b, created, err)
	}
	e2, created, err := m.Create(dirB, false)
	if err != nil || !created || e2.ID != "myweb1" {
		t.Fatalf("second base name = %+v created=%v err=%v", e2, created, err)
	}
	e3, created, err := m.Create(dirB, true)
	if err != nil || !created || e3.ID != "myweb2" {
		t.Fatalf("force new = %+v created=%v err=%v", e3, created, err)
	}
}

func TestSlugBase(t *testing.T) {
	for in, want := range map[string]string{
		"/home/user/myweb":       "myweb",
		"/home/user/My Web!":     "my-web",
		"/":                      "root",
		"/tmp/---":               "static",
		"/tmp/...":               "static",
		"/tmp/Ünicode folder":    "nicode-folder",
		"/tmp/already-safe_name": "already-safe_name",
	} {
		if got := slugBase(in); got != want {
			t.Errorf("slugBase(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPauseResumeRemove(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "site")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	m := NewManager()
	e, _, err := m.Create(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Pause(e.ID); err != nil || !e.Paused() {
		t.Fatalf("pause: paused=%v err=%v", e.Paused(), err)
	}
	if _, err := m.Resume(e.ID); err != nil || e.Paused() {
		t.Fatalf("resume: paused=%v err=%v", e.Paused(), err)
	}
	if err := m.Remove(e.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Get(e.ID); err == nil {
		t.Fatal("removed entry still resolvable")
	}
}
