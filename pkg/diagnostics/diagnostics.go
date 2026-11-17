// Package diagnostics is the opt-in introspection surface for a running server:
// an HTTP pprof listener and periodic heap snapshots written to disk.
//
// It exists because a production box grew to 3.7 GiB with no way to attribute
// it: the released binary carries neither pprof nor a heap profile hook, so the
// only visible symptom was RSS (see docs/MEMORY_GROWTH_INVESTIGATION.md). With
// this package enabled, `go tool pprof` can be pointed at the live process and
// the periodic snapshots leave a trail for later analysis.
//
// It is deliberately hard to turn on by accident: the CLI flag that enables it
// is undocumented (cmd/Suwu/debug_flags.go), and the listener refuses to bind
// anything but a loopback address. A heap profile names every type and every
// stack in the process; it must never reach a public interface.
package diagnostics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	httppprof "net/http/pprof"
	"os"
	"path/filepath"
	"runtime"
	runtimepprof "runtime/pprof"
	"sort"
	"strings"
	"sync"
	"time"
)

// Defaults for the flags; exported so the CLI and tests agree.
const (
	DefaultAddr     = "127.0.0.1:6060"
	DefaultInterval = 2 * time.Hour
	DefaultKeep     = 12
)

// Options configures Start.
type Options struct {
	// Addr is the TCP address for the pprof listener. It must resolve to a
	// loopback address; anything else is rejected.
	Addr string
	// Interval is how often a snapshot is written. Zero means DefaultInterval.
	Interval time.Duration
	// Dir is where snapshots are written. Created if missing.
	Dir string
	// Keep is how many snapshots to retain (each snapshot is three files).
	// Zero means DefaultKeep; negative means keep everything.
	Keep int
	// Extra is called for every snapshot and its values are recorded alongside
	// the heap numbers. It is how the caller contributes counters this package
	// cannot know about (live sessions, attached clients, …) without importing
	// them — the same reason a snapshot holds the goroutine dump next to
	// MemStats. Must be cheap and must not block.
	Extra func() map[string]any
}

// Diagnostics is a running collector.
type Diagnostics struct {
	addr     string
	dir      string
	keep     int
	interval time.Duration
	extra    func() map[string]any
	server   *http.Server
	stop     chan struct{}
	stopOnce sync.Once
	done     chan struct{}
}

// Snapshot is the set of files written for one sample.
type Snapshot struct {
	Heap      string `json:"heap"`
	Goroutine string `json:"goroutine"`
	MemStats  string `json:"memstats"`
	At        string `json:"at"`
}

// Start binds the pprof listener and begins writing snapshots.
func Start(ctx context.Context, opts Options) (*Diagnostics, error) {
	if opts.Addr == "" {
		opts.Addr = DefaultAddr
	}
	if opts.Interval == 0 {
		opts.Interval = DefaultInterval
	}
	if opts.Keep == 0 {
		opts.Keep = DefaultKeep
	}
	if opts.Dir == "" {
		return nil, errors.New("diagnostics: a snapshot directory is required")
	}
	if opts.Interval < time.Minute {
		return nil, fmt.Errorf("diagnostics: interval %s is too short (minimum 1m)", opts.Interval)
	}
	if err := checkLoopback(opts.Addr); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(opts.Dir, 0o700); err != nil {
		return nil, fmt.Errorf("diagnostics: create snapshot dir: %w", err)
	}

	ln, err := net.Listen("tcp", opts.Addr)
	if err != nil {
		return nil, fmt.Errorf("diagnostics: listen %s: %w", opts.Addr, err)
	}

	mux := http.NewServeMux()
	// httppprof.Index serves the named profiles (heap, goroutine, allocs, block,
	// mutex, threadcreate) off /debug/pprof/<name>.
	mux.HandleFunc("/debug/pprof/", httppprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", httppprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", httppprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", httppprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", httppprof.Trace)

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	d := &Diagnostics{
		addr:     ln.Addr().String(),
		dir:      opts.Dir,
		keep:     opts.Keep,
		interval: opts.Interval,
		extra:    opts.Extra,
		server:   srv,
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Warn("diagnostics: pprof listener stopped", "addr", d.addr, "error", err)
		}
	}()

	// One snapshot at startup: whatever is leaking is usually already there,
	// and it gives a baseline to diff the later ones against.
	if _, err := d.Snapshot(); err != nil {
		slog.Warn("diagnostics: initial snapshot failed", "error", err)
	}

	go d.loop(ctx)

	slog.Info("diagnostics: enabled",
		"pprof", "http://"+d.addr+"/debug/pprof/",
		"snapshots", d.dir,
		"interval", d.interval.String(),
		"keep", d.keep)
	return d, nil
}

// Addr is the address the pprof listener is bound to.
func (d *Diagnostics) Addr() string { return d.addr }

// Dir is the snapshot directory.
func (d *Diagnostics) Dir() string { return d.dir }

func (d *Diagnostics) loop(ctx context.Context) {
	ticker := time.NewTicker(d.interval)
	defer ticker.Stop()
	defer close(d.done)
	for {
		select {
		case <-ctx.Done():
			return
		case <-d.stop:
			return
		case <-ticker.C:
			snap, err := d.Snapshot()
			if err != nil {
				slog.Warn("diagnostics: snapshot failed", "error", err)
				continue
			}
			slog.Info("diagnostics: snapshot written", "heap", snap.Heap, "goroutine", snap.Goroutine)
		}
	}
}

// Close stops the listener and the snapshot loop. It is safe to call twice, and
// it does not depend on the context passed to Start being cancelled (a server
// runs with a background context for its whole life).
func (d *Diagnostics) Close() error {
	d.stopOnce.Do(func() { close(d.stop) })
	err := d.server.Close()
	<-d.done
	return err
}

// Snapshot writes a heap profile, a goroutine dump and a MemStats sample, then
// prunes old snapshots. The files share one timestamp so they can be read as a
// set; the heap profile is gzip-compressed protobuf, readable with
// `go tool pprof -http :0 <file>` (it includes the full stack traces).
func (d *Diagnostics) Snapshot() (Snapshot, error) {
	stamp := time.Now().UTC().Format("20060102T150405Z")
	snap := Snapshot{
		Heap:      filepath.Join(d.dir, "heap-"+stamp+".pprof"),
		Goroutine: filepath.Join(d.dir, "goroutine-"+stamp+".txt"),
		MemStats:  filepath.Join(d.dir, "memstats-"+stamp+".json"),
		At:        stamp,
	}

	if err := writeProfile(snap.Heap, "heap", 0); err != nil {
		return Snapshot{}, err
	}
	// debug=1 is the grouped form: "N goroutines" per stack, which is what
	// makes a leak of one handler obvious at a glance.
	if err := writeProfile(snap.Goroutine, "goroutine", 1); err != nil {
		return Snapshot{}, err
	}

	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	stats := struct {
		At            string           `json:"at"`
		NumGoroutine  int              `json:"numGoroutine"`
		OpenFDs       int              `json:"openFds"`
		MemStats      runtime.MemStats `json:"memStats"`
		HeapAllocMiB  float64          `json:"heapAllocMiB"`
		HeapInuseMiB  float64          `json:"heapInuseMiB"`
		HeapIdleMiB   float64          `json:"heapIdleMiB"`
		HeapSysMiB    float64          `json:"heapSysMiB"`
		TotalAllocMiB float64          `json:"totalAllocMiB"`
		Extra         map[string]any   `json:"extra,omitempty"`
	}{
		At:            stamp,
		NumGoroutine:  runtime.NumGoroutine(),
		OpenFDs:       OpenFDCount(),
		MemStats:      ms,
		HeapAllocMiB:  mib(ms.HeapAlloc),
		HeapInuseMiB:  mib(ms.HeapInuse),
		HeapIdleMiB:   mib(ms.HeapIdle),
		HeapSysMiB:    mib(ms.HeapSys),
		TotalAllocMiB: mib(ms.TotalAlloc),
		Extra:         d.extraValues(),
	}
	body, err := json.MarshalIndent(stats, "", "  ")
	if err != nil {
		return Snapshot{}, fmt.Errorf("diagnostics: encode memstats: %w", err)
	}
	if err := os.WriteFile(snap.MemStats, append(body, '\n'), 0o600); err != nil {
		return Snapshot{}, fmt.Errorf("diagnostics: write memstats: %w", err)
	}

	if err := d.prune(); err != nil {
		slog.Warn("diagnostics: prune failed", "error", err)
	}
	return snap, nil
}

func mib(v uint64) float64 { return float64(v) / (1 << 20) }

// extraValues calls the caller's counter hook, tolerating a nil hook and a
// panicking one: a snapshot is not worth failing a server over.
func (d *Diagnostics) extraValues() (values map[string]any) {
	if d.extra == nil {
		return nil
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Warn("diagnostics: extra counters panicked", "panic", r)
			values = nil
		}
	}()
	values = d.extra()
	if len(values) == 0 {
		return nil
	}
	return values
}

// OpenFDCount reports how many file descriptors the process holds. It is the
// cheapest leak signal there is: a number that only climbs names its own
// investigation (the ARM box reached 2244 before the notify-socket fix), and it
// belongs in every snapshot for the same reason the goroutine dump does.
//
// The value is exact on Linux and macOS to within a descriptor, because reading
// the directory itself briefly holds one.
func OpenFDCount() int {
	for _, dir := range []string{"/proc/self/fd", "/dev/fd"} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		n := len(entries) - 1 // the descriptor held to read the directory
		if n < 0 {
			n = 0
		}
		return n
	}
	return -1
}

func writeProfile(path, name string, debug int) error {
	profile := runtimepprof.Lookup(name)
	if profile == nil {
		return fmt.Errorf("diagnostics: profile %q is not available", name)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("diagnostics: create %s: %w", filepath.Base(path), err)
	}
	if err := profile.WriteTo(f, debug); err != nil {
		_ = f.Close()
		return fmt.Errorf("diagnostics: write %s: %w", filepath.Base(path), err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("diagnostics: close %s: %w", filepath.Base(path), err)
	}
	return nil
}

// prune deletes the oldest snapshots beyond Keep. Snapshots are named
// <kind>-<timestamp>.<ext>, so the timestamp alone orders them.
func (d *Diagnostics) prune() error {
	if d.keep < 0 {
		return nil
	}
	stamps, err := d.stamps()
	if err != nil {
		return err
	}
	for len(stamps) > d.keep {
		old := stamps[0]
		stamps = stamps[1:]
		for _, prefix := range []string{"heap-", "goroutine-", "memstats-"} {
			for _, ext := range []string{".pprof", ".txt", ".json"} {
				_ = os.Remove(filepath.Join(d.dir, prefix+old+ext))
			}
		}
	}
	return nil
}

// stamps lists the snapshot timestamps present in the directory, oldest first.
func (d *Diagnostics) stamps() ([]string, error) {
	entries, err := os.ReadDir(d.dir)
	if err != nil {
		return nil, fmt.Errorf("diagnostics: read snapshot dir: %w", err)
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "memstats-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		seen[strings.TrimSuffix(strings.TrimPrefix(name, "memstats-"), ".json")] = true
	}
	out := make([]string, 0, len(seen))
	for stamp := range seen {
		out = append(out, stamp)
	}
	sort.Strings(out)
	return out, nil
}

// checkLoopback refuses anything that is not a loopback bind: a heap profile
// must not be reachable from the network.
func checkLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("diagnostics: invalid address %q: %w", addr, err)
	}
	if host == "" {
		return fmt.Errorf("diagnostics: address %q binds every interface; use a loopback address", addr)
	}
	if host == "localhost" {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("diagnostics: address %q: host must be an IP literal or localhost", addr)
	}
	if !ip.IsLoopback() {
		return fmt.Errorf("diagnostics: address %q is not loopback; refusing to expose pprof", addr)
	}
	return nil
}
