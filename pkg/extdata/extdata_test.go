package extdata

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	dataDir := t.TempDir()
	s, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	return s, dataDir
}

func TestSetGetDelete(t *testing.T) {
	s, dataDir := newStore(t)
	value := []byte(`{"v":2,"notes":[]}`)
	if err := s.Set("note", "v2", value); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dataDir, DirName, "note", "v2.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("record not written where the layout says: %v", err)
	}
	got, err := s.Get("note", "v2")
	if err != nil || string(got) != string(value) {
		t.Fatalf("Get = %q, %v", got, err)
	}
	// A second write replaces it atomically, leaving no temp files behind.
	if err := s.Set("note", "v2", []byte(`{"v":2,"notes":[1]}`)); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Get("note", "v2"); string(got) != `{"v":2,"notes":[1]}` {
		t.Fatalf("second write: %q", got)
	}
	entries, _ := os.ReadDir(filepath.Join(dataDir, DirName, "note"))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
	if err := s.Delete("note", "v2"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get("note", "v2"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after delete: %v", err)
	}
	// Deleting again is fine.
	if err := s.Delete("note", "v2"); err != nil {
		t.Fatal(err)
	}
}

func TestNamesAreValidated(t *testing.T) {
	s, dataDir := newStore(t)
	for _, id := range []string{"../etc", "", "Note", "a b"} {
		if err := s.Set(id, "v2", []byte(`1`)); err == nil {
			t.Errorf("id %q accepted", id)
		}
	}
	for _, key := range []string{"../v2", "", "a b", "x/y", strings.Repeat("a", 65)} {
		if err := s.Set("note", key, []byte(`1`)); err == nil {
			t.Errorf("key %q accepted", key)
		}
	}
	// Nothing escaped the tree.
	if _, err := os.Stat(filepath.Join(dataDir, DirName, "note")); !os.IsNotExist(err) {
		t.Fatal("a rejected write created a directory")
	}
}

func TestValueMustBeJSONAndBounded(t *testing.T) {
	s, _ := newStore(t)
	if err := s.Set("note", "v2", []byte("not json")); err == nil {
		t.Fatal("non-JSON accepted")
	}
	if err := s.Set("note", "v2", nil); err == nil {
		t.Fatal("empty value accepted")
	}
	big := make([]byte, MaxValueBytes+1)
	big[0] = '"'
	big[len(big)-1] = '"'
	for i := 1; i < len(big)-1; i++ {
		big[i] = 'a'
	}
	if err := s.Set("note", "big", big); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversized value: %v", err)
	}
	if _, err := s.Get("note", "big"); !errors.Is(err, ErrNotFound) {
		t.Fatal("an oversized value was written")
	}
}

func TestList(t *testing.T) {
	s, _ := newStore(t)
	if keys, err := s.List("note"); err != nil || len(keys) != 0 {
		t.Fatalf("empty list: %v %v", keys, err)
	}
	for _, key := range []string{"v2", "a.note", "z"} {
		if err := s.Set("note", key, []byte(`1`)); err != nil {
			t.Fatal(err)
		}
	}
	keys, err := s.List("note")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(keys, ",") != "a.note,v2,z" {
		t.Fatalf("keys %v", keys)
	}
	// Noise is not a key.
	if err := os.WriteFile(filepath.Join(s.Root(), "note", ".hidden.json"), []byte(`1`), 0o644); err != nil {
		t.Fatal(err)
	}
	if keys, _ := s.List("note"); strings.Join(keys, ",") != "a.note,v2,z" {
		t.Fatalf("hidden file listed: %v", keys)
	}
	// One extension cannot see another's records.
	if keys, err := s.List("other"); err != nil || len(keys) != 0 {
		t.Fatalf("other extension: %v %v", keys, err)
	}
}

func TestNewRequiresAbsoluteDataDir(t *testing.T) {
	if _, err := New(""); err == nil {
		t.Fatal("empty data dir accepted")
	}
	if _, err := New("relative/dir"); err == nil {
		t.Fatal("relative data dir accepted")
	}
}
