package extension

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidID(t *testing.T) {
	valid := []string{"eye", "a", "eye-chart", "my_ext", "a1-b2_c3"}
	invalid := []string{"", "Eye", "eye.js", "../eye", "a/b", ".eye", "-eye", "a b", strings.Repeat("a", 65)}
	for _, id := range valid {
		if !ValidID(id) {
			t.Errorf("ValidID(%q) = false, want true", id)
		}
	}
	for _, id := range invalid {
		if ValidID(id) {
			t.Errorf("ValidID(%q) = true, want false", id)
		}
	}
}

func writeExt(t *testing.T, dir, id, meta, entry string) {
	t.Helper()
	extDir := filepath.Join(dir, id)
	if err := os.MkdirAll(extDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if meta != "" {
		if err := os.WriteFile(filepath.Join(extDir, MetaFile), []byte(meta), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if entry != "" {
		if err := os.WriteFile(filepath.Join(extDir, EntryFile), []byte(entry), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestResolve(t *testing.T) {
	dir := t.TempDir()
	writeExt(t, dir, "eye", `{"name":"Eye","description":"eye demo","params":[{"key":"size","label":"Size"}]}`, `function handler(){return "x"}`)

	ext, err := Resolve(dir, "eye")
	if err != nil {
		t.Fatal(err)
	}
	if ext.ID != "eye" || ext.Name != "Eye" || ext.Description != "eye demo" {
		t.Errorf("ext = %+v", ext)
	}
	if len(ext.Params) != 1 || ext.Params[0].Key != "size" || ext.Params[0].Label != "Size" {
		t.Errorf("params = %+v", ext.Params)
	}
	if ext.Entry != filepath.Join(dir, "eye", EntryFile) {
		t.Errorf("entry = %q", ext.Entry)
	}
	if ext.Dir != filepath.Join(dir, "eye") {
		t.Errorf("dir = %q", ext.Dir)
	}
}

func TestResolveErrors(t *testing.T) {
	dir := t.TempDir()

	if _, err := Resolve(dir, "../evil"); err == nil {
		t.Error("expected error for invalid id")
	}
	if _, err := Resolve(dir, "missing"); err == nil {
		t.Error("expected error for missing extension")
	}

	// name defaults to id when omitted
	writeExt(t, dir, "unnamed", `{}`, `function handler(){return "x"}`)
	ext, err := Resolve(dir, "unnamed")
	if err != nil {
		t.Fatal(err)
	}
	if ext.Name != "unnamed" {
		t.Errorf("name = %q, want unnamed", ext.Name)
	}

	// missing entry
	writeExt(t, dir, "noidx", `{"name":"x"}`, "")
	if _, err := Resolve(dir, "noidx"); err == nil {
		t.Error("expected error for missing index.js")
	}

	// invalid meta.json
	writeExt(t, dir, "badmeta", `{not json}`, `function handler(){}`)
	if _, err := Resolve(dir, "badmeta"); err == nil {
		t.Error("expected error for invalid meta.json")
	}
}

func TestList(t *testing.T) {
	dir := t.TempDir()

	// Missing dir → empty, no error.
	if got, err := List(dir); err != nil || len(got) != 0 {
		t.Errorf("List(missing) = %v, %v; want empty, nil", got, err)
	}

	writeExt(t, dir, "beta", `{"name":"Beta"}`, `function handler(){return "b"}`)
	writeExt(t, dir, "alpha", `{"name":"Alpha"}`, `function handler(){return "a"}`)
	// Broken entries are skipped.
	writeExt(t, dir, "broken", `{bad`, `function handler(){}`)
	writeExt(t, dir, "noidx", `{"name":"n"}`, "")
	// A stray file (not a dir) is ignored.
	if err := os.WriteFile(filepath.Join(dir, "stray.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := List(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (%+v)", len(got), got)
	}
	if got[0].ID != "alpha" || got[1].ID != "beta" {
		t.Errorf("order = [%s %s], want [alpha beta]", got[0].ID, got[1].ID)
	}
}

func TestSeed(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "extensions")
	if err := Seed(dir); err != nil {
		t.Fatal(err)
	}

	list, err := List(dir)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range list {
		if e.ID == "eye" {
			found = true
			if e.Name != "Eye" {
				t.Errorf("eye name = %q, want Eye", e.Name)
			}
		}
	}
	if !found {
		t.Errorf("seeded 'eye' not found in %+v", list)
	}

	// Seeding again must not overwrite a user's edited copy.
	custom := filepath.Join(dir, "eye", EntryFile)
	if err := os.WriteFile(custom, []byte("// user edit"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Seed(dir); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(custom)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "// user edit" {
		t.Errorf("seed overwrote user file: %q", data)
	}
}

func TestDir(t *testing.T) {
	if got, want := Dir("/srv/suwu"), filepath.Join("/srv/suwu", "extensions"); got != want {
		t.Errorf("Dir = %q, want %q", got, want)
	}
}
