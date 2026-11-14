package diagnostics

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStartRejectsNonLoopback(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:6060", ":6060", "192.168.1.10:6060", "example.com:6060"} {
		if _, err := Start(context.Background(), Options{Addr: addr, Dir: t.TempDir()}); err == nil {
			t.Errorf("Start(%q) succeeded; a heap profile must never be exposed off-loopback", addr)
		}
	}
}

func TestStartServesPprofAndSnapshots(t *testing.T) {
	dir := t.TempDir()
	d, err := Start(context.Background(), Options{
		Addr:     "127.0.0.1:0",
		Dir:      dir,
		Interval: time.Minute,
		Keep:     2,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	// The initial snapshot is written before Start returns, so a process that
	// is already bloated has a baseline on disk.
	for _, kind := range []string{"heap-", "goroutine-", "memstats-"} {
		matches, err := filepath.Glob(filepath.Join(dir, kind+"*"))
		if err != nil {
			t.Fatal(err)
		}
		if len(matches) != 1 {
			t.Fatalf("%s* files = %v, want one snapshot", kind, matches)
		}
	}

	// /debug/pprof/heap is a gzipped protobuf when debug=0.
	resp, err := http.Get("http://" + d.Addr() + "/debug/pprof/heap")
	if err != nil {
		t.Fatalf("GET /debug/pprof/heap: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("heap status = %d, want 200", resp.StatusCode)
	}
	if len(body) < 2 || body[0] != 0x1f || body[1] != 0x8b {
		t.Fatalf("heap profile is not gzip-compressed protobuf (starts %q)", body[:min(8, len(body))])
	}

	// The human-readable index lists the named profiles.
	idx, err := http.Get("http://" + d.Addr() + "/debug/pprof/")
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(idx.Body)
	_ = idx.Body.Close()
	for _, name := range []string{"goroutine", "heap", "allocs"} {
		if !strings.Contains(string(page), name) {
			t.Errorf("pprof index does not mention %q", name)
		}
	}
}

func TestSnapshotContents(t *testing.T) {
	dir := t.TempDir()
	d := &Diagnostics{dir: dir, keep: 2}
	snap, err := d.Snapshot()
	if err != nil {
		t.Fatal(err)
	}

	goroutine, err := os.ReadFile(snap.Goroutine)
	if err != nil {
		t.Fatalf("read goroutine dump: %v", err)
	}
	if !strings.Contains(string(goroutine), "goroutine profile") {
		t.Error("goroutine dump does not look like a pprof dump")
	}
	// debug=1 groups identical stacks, which is what makes a leaked handler
	// obvious at a glance.
	if !strings.Contains(string(goroutine), "goroutine") {
		t.Error("goroutine dump has no stacks")
	}

	raw, err := os.ReadFile(snap.MemStats)
	if err != nil {
		t.Fatalf("read memstats: %v", err)
	}
	var stats struct {
		NumGoroutine int     `json:"numGoroutine"`
		HeapAllocMiB float64 `json:"heapAllocMiB"`
	}
	if err := json.Unmarshal(raw, &stats); err != nil {
		t.Fatalf("decode memstats: %v", err)
	}
	if stats.NumGoroutine < 1 {
		t.Errorf("numGoroutine = %d, want at least 1", stats.NumGoroutine)
	}

	info, err := os.Stat(snap.Heap)
	if err != nil {
		t.Fatalf("stat heap profile: %v", err)
	}
	if info.Size() == 0 {
		t.Error("heap profile is empty")
	}
	// Profiles are only readable by the owner: they name every type in the
	// process.
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		t.Errorf("heap profile mode = %v, want owner-only", mode)
	}
}

func TestPruneKeepsNewest(t *testing.T) {
	dir := t.TempDir()
	d := &Diagnostics{dir: dir, keep: 2}

	stamps := []string{"20260101T000000Z", "20260102T000000Z", "20260103T000000Z"}
	for _, stamp := range stamps {
		for _, name := range []string{"heap-" + stamp + ".pprof", "goroutine-" + stamp + ".txt", "memstats-" + stamp + ".json"} {
			if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}

	if err := d.prune(); err != nil {
		t.Fatal(err)
	}
	left, err := d.stamps()
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 2 || left[0] != stamps[1] || left[1] != stamps[2] {
		t.Fatalf("kept %v, want the two newest", left)
	}
	if _, err := os.Stat(filepath.Join(dir, "heap-"+stamps[0]+".pprof")); !os.IsNotExist(err) {
		t.Error("oldest heap profile was not pruned")
	}
}

func TestKeepNegativeRetainsEverything(t *testing.T) {
	dir := t.TempDir()
	d := &Diagnostics{dir: dir, keep: -1}
	for _, stamp := range []string{"20260101T000000Z", "20260102T000000Z", "20260103T000000Z"} {
		if err := os.WriteFile(filepath.Join(dir, "memstats-"+stamp+".json"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := d.prune(); err != nil {
		t.Fatal(err)
	}
	if left, _ := d.stamps(); len(left) != 3 {
		t.Fatalf("kept %d snapshots, want all 3", len(left))
	}
}

func TestIntervalFloor(t *testing.T) {
	if _, err := Start(context.Background(), Options{
		Addr:     "127.0.0.1:0",
		Dir:      t.TempDir(),
		Interval: time.Second,
	}); err == nil {
		t.Fatal("a 1s snapshot interval should be rejected")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
