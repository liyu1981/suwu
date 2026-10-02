package backup

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// container builds a minimally valid container: the server only checks the
// prologue, so the ciphertext here is arbitrary bytes on purpose.
func container(header string) []byte {
	body := []byte("ciphertext-goes-here")
	out := make([]byte, 0, prologueBytes+len(header)+len(body))
	out = append(out, Magic...)
	lenBuf := make([]byte, 4)
	binary.BigEndian.PutUint32(lenBuf, uint32(len(header)))
	out = append(out, lenBuf...)
	out = append(out, header...)
	return append(out, body...)
}

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

const testSlot = "abcdefghijklmnopqrstuvwxyz" // 26 chars, a-z: valid base32 alphabet

func TestPutAndReadRoundTrip(t *testing.T) {
	s := newStore(t)
	blob := container(`{"v":1}`)

	meta, err := s.Put(testSlot, nil, bytes.NewReader(blob))
	if err != nil {
		t.Fatal(err)
	}
	if meta.Slot != testSlot || len(meta.Generations) != 1 {
		t.Fatalf("unexpected meta %+v", meta)
	}
	got, err := s.Read(testSlot, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatalf("blob round-trip mismatch: %d vs %d bytes", len(got), len(blob))
	}
	if meta.Bytes != int64(len(blob)) {
		t.Fatalf("bytes = %d, want %d", meta.Bytes, len(blob))
	}
	if len(meta.Generations[0].SHA256) != 64 {
		t.Fatalf("sha256 = %q, want 64 hex chars", meta.Generations[0].SHA256)
	}
}

func TestGenerationsIncrementAndPrune(t *testing.T) {
	s := newStore(t)
	for i := 0; i < MaxGenerations+4; i++ {
		if _, err := s.Put(testSlot, nil, bytes.NewReader(container(`{"v":1}`))); err != nil {
			t.Fatalf("put %d: %v", i, err)
		}
	}
	meta, err := s.Meta(testSlot)
	if err != nil {
		t.Fatal(err)
	}
	if len(meta.Generations) != MaxGenerations {
		t.Fatalf("generations = %d, want %d", len(meta.Generations), MaxGenerations)
	}
	// Oldest pruned, newest kept, contiguous.
	for i, g := range meta.Generations {
		want := int64(i + 5)
		if g.Gen != want {
			t.Fatalf("gen[%d] = %d, want %d", i, g.Gen, want)
		}
	}
	// The pruned blobs are gone, not just de-indexed.
	for _, gone := range []int64{1, 2, 3, 4} {
		if _, err := s.Read(testSlot, gone); !errors.Is(err, ErrNotFound) {
			t.Fatalf("read pruned gen %d: %v", gone, err)
		}
	}
	if _, err := s.Read(testSlot, int64(MaxGenerations+4)); err != nil {
		t.Fatalf("read newest gen: %v", err)
	}
}

func TestPutConflictLeavesSlotUntouched(t *testing.T) {
	s := newStore(t)
	if _, err := s.Put(testSlot, nil, bytes.NewReader(container(`{"v":1}`))); err != nil {
		t.Fatal(err)
	}
	stale := int64(0) // a client that thinks nothing is stored yet
	_, err := s.Put(testSlot, &stale, bytes.NewReader(container(`{"v":1}`)))
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
	meta, err := s.Meta(testSlot)
	if err != nil {
		t.Fatal(err)
	}
	if len(meta.Generations) != 1 {
		t.Fatalf("generations = %d, want 1 (conflict must write nothing)", len(meta.Generations))
	}

	// The matching base proceeds.
	current := int64(1)
	if _, err := s.Put(testSlot, &current, bytes.NewReader(container(`{"v":1}`))); err != nil {
		t.Fatalf("put with correct base: %v", err)
	}
}

func TestRejectsInvalidSlots(t *testing.T) {
	s := newStore(t)
	for _, slot := range []string{
		"", "short", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxy", // 25
		"abcdefghijklmnopqrstuvwxyz1", // 27, and '1' is not in the alphabet
		"../../../etc", "abcdefghijklmnopqrstuvwxz/", "abcdefghijklmnopqrstuvwxy\u00e9",
	} {
		if ValidSlot(slot) {
			t.Errorf("ValidSlot(%q) = true, want false", slot)
		}
		if _, err := s.Put(slot, nil, bytes.NewReader(container(`{}`))); err == nil {
			t.Errorf("Put(%q) succeeded, want rejection", slot)
		}
		if _, err := s.Meta(slot); err == nil {
			t.Errorf("Meta(%q) succeeded, want rejection", slot)
		}
		if _, err := s.Read(slot, 1); err == nil {
			t.Errorf("Read(%q) succeeded, want rejection", slot)
		}
		if err := s.Delete(slot); err == nil {
			t.Errorf("Delete(%q) succeeded, want rejection", slot)
		}
	}
}

func TestRejectsNonContainers(t *testing.T) {
	s := newStore(t)
	for name, body := range map[string][]byte{
		"empty":        {},
		"too short":    []byte("SUW"),
		"wrong magic":  []byte("NOTSUW1!................"),
		"zero header":  append([]byte(Magic), 0, 0, 0, 0),
		"header lies":  append([]byte(Magic), 0xff, 0xff, 0xff, 0xff),
		"json garbage": []byte(`{"not":"a container"}`),
	} {
		if _, err := s.Put(testSlot, nil, bytes.NewReader(body)); !errors.Is(err, ErrNotContainer) {
			t.Errorf("%s: err = %v, want ErrNotContainer", name, err)
		}
	}
}

func TestRejectsOversizedUpload(t *testing.T) {
	s := newStore(t)
	huge := container(`{"v":1}`)
	huge = append(huge, make([]byte, MaxUploadBytes)...)
	if _, err := s.Put(testSlot, nil, bytes.NewReader(huge)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	// Nothing was written.
	if _, err := s.Meta(testSlot); !errors.Is(err, ErrNotFound) {
		t.Fatalf("meta = %v, want ErrNotFound", err)
	}
}

func TestMissingSlotAndGeneration(t *testing.T) {
	s := newStore(t)
	if _, err := s.Meta(testSlot); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Meta on empty slot: %v, want ErrNotFound", err)
	}
	if _, err := s.Read(testSlot, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Read on empty slot: %v, want ErrNotFound", err)
	}
	if _, err := s.Read(testSlot, -1); err == nil {
		t.Fatal("Read with negative generation succeeded")
	}
}

func TestDeleteRemovesSlot(t *testing.T) {
	s := newStore(t)
	if _, err := s.Put(testSlot, nil, bytes.NewReader(container(`{"v":1}`))); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(testSlot); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Meta(testSlot); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Meta after delete: %v, want ErrNotFound", err)
	}
}

func TestFilePermissions(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Put(testSlot, nil, bytes.NewReader(container(`{"v":1}`))); err != nil {
		t.Fatal(err)
	}
	slotDir := filepath.Join(dir, "backup", testSlot)
	for _, p := range []string{
		filepath.Join(dir, "backup"),
		slotDir,
		filepath.Join(slotDir, "g00000001.bin"),
		filepath.Join(slotDir, "meta.json"),
	} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o700 && perm != 0o600 {
			t.Errorf("%s mode = %o, want 0700 or 0600", p, perm)
		}
	}
}

func TestReadRefusesSymlinkedBlob(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Put(testSlot, nil, bytes.NewReader(container(`{"v":1}`))); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(dir, "secret.txt")
	if err := os.WriteFile(secret, []byte("top secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	blob := filepath.Join(dir, "backup", testSlot, "g00000001.bin")
	if err := os.Remove(blob); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, blob); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := s.Read(testSlot, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound for a symlinked blob", err)
	}
}

func TestConcurrentPutsKeepDistinctGenerations(t *testing.T) {
	s := newStore(t)
	const workers = 8
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := s.Put(testSlot, nil, bytes.NewReader(container(fmt.Sprintf(`{"v":1,"n":%d}`, i))))
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent put: %v", err)
		}
	}
	meta, err := s.Meta(testSlot)
	if err != nil {
		t.Fatal(err)
	}
	if len(meta.Generations) != workers {
		t.Fatalf("generations = %d, want %d", len(meta.Generations), workers)
	}
	seen := map[int64]bool{}
	for _, g := range meta.Generations {
		if seen[g.Gen] {
			t.Fatalf("duplicate generation %d", g.Gen)
		}
		seen[g.Gen] = true
		if _, err := s.Read(testSlot, g.Gen); err != nil {
			t.Fatalf("read gen %d: %v", g.Gen, err)
		}
	}
}

func TestSummarizeListsSlotsOnly(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Put(testSlot, nil, bytes.NewReader(container(`{"v":1}`))); err != nil {
		t.Fatal(err)
	}
	other := "234567abcdefghijklmnopqrst"
	if _, err := s.Put(other, nil, bytes.NewReader(container(`{"v":1}`))); err != nil {
		t.Fatal(err)
	}
	// A stray directory is not a backup slot.
	if err := os.MkdirAll(filepath.Join(dir, "backup", "notes"), 0o700); err != nil {
		t.Fatal(err)
	}

	summaries, err := s.Summarize()
	if err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 2 {
		t.Fatalf("summaries = %d, want 2: %+v", len(summaries), summaries)
	}
	for _, sum := range summaries {
		if sum.Generations != 1 || sum.Bytes == 0 || sum.LatestMTime == "" {
			t.Errorf("incomplete summary: %+v", sum)
		}
	}
}

func TestForeignSlotDirIsNotAdopted(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	// A slot directory whose index names a different slot is not ours to
	// serve or extend.
	slotDir := filepath.Join(dir, "backup", testSlot)
	if err := os.MkdirAll(slotDir, 0o700); err != nil {
		t.Fatal(err)
	}
	foreign := `{"slot":"234567abcdefghijklmnopqrst","generations":[]}`
	if err := os.WriteFile(filepath.Join(slotDir, "meta.json"), []byte(foreign), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Meta(testSlot); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestCorruptMetaIsAnErrorNotEmptySlot(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	slotDir := filepath.Join(dir, "backup", testSlot)
	if err := os.MkdirAll(slotDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(slotDir, "meta.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = s.Meta(testSlot)
	if err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want a parse error", err)
	}
	if !strings.Contains(err.Error(), "parse meta") {
		t.Fatalf("err = %v, want a meta parse error", err)
	}
}
