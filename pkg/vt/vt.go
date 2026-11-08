// Package vt runs libghostty-vt, the VT engine of Ghostty, in-process to keep
// an authoritative copy of each terminal's screen on the server.
//
// The engine is the official libghostty-vt 1.0.0 WebAssembly build (speed
// optimized ReleaseFast; see PROVENANCE.md for the pinned artifact), executed
// by wazero so the binary stays pure Go and cross-compiles without cgo. Each
// Terminal is its own wasm module instance: isolated linear memory, no shared
// global state, ~1.2 MiB of RAM and ~1 ms to instantiate.
//
// A Terminal here is a passive mirror. Bytes read from a PTY are written in,
// and DumpVT hands back VT escape sequences that rebuild the screen and its
// retained scrollback in any terminal — xterm.js in the browser, after a
// refresh or a reattach.
//
// The 1.0 C ABI is stable, so the syscall surface this package wraps is small
// on purpose: terminal_new / terminal_set / terminal_vt_write /
// terminal_resize / formatter_* / terminal_free. Anything the browser can
// infer on its own is deliberately not modelled here.
package vt

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

//go:embed ghostty-vt.wasm
var wasmBinary []byte

// EngineVersion is the libghostty-vt release the embedded module was built
// from. NewRuntime refuses to load a module that reports anything else.
const EngineVersion = "1.0.0"

// wasm32 ABI: size_t and pointers are 4 bytes.
const wordSize = 4

// GhosttyResult codes (ghostty/vt/types.h). Success is zero, every error is
// negative.
const (
	resultSuccess      = 0
	resultOutOfMemory  = -1
	resultInvalidValue = -2
	resultOutOfSpace   = -3
	resultNoValue      = -4
	resultIOError      = -5
	resultLimitExceed  = -6
	resultRejected     = -7
	resultUnsupported  = -8
)

func resultName(code int32) string {
	switch code {
	case resultSuccess:
		return "success"
	case resultOutOfMemory:
		return "out of memory"
	case resultInvalidValue:
		return "invalid value"
	case resultOutOfSpace:
		return "out of space"
	case resultNoValue:
		return "no value"
	case resultIOError:
		return "io error"
	case resultLimitExceed:
		return "limit exceeded"
	case resultRejected:
		return "rejected"
	case resultUnsupported:
		return "unsupported"
	default:
		return fmt.Sprintf("unknown result %d", code)
	}
}

// Error reports a non-success GhosttyResult from a specific call.
type Error struct {
	Op   string
	Code int32
}

func (e *Error) Error() string {
	return "vt: " + e.Op + ": " + resultName(e.Code)
}

func checkCode(op string, code int32) error {
	if code == resultSuccess {
		return nil
	}
	return &Error{Op: op, Code: code}
}

// Terminal options we set (ghostty/vt/terminal.h).
const (
	optScrollbackMaxBytes = 28
	optScrollbackMaxLines = 29
)

// scrollbackMaxBytes bounds what the emulator keeps beyond the screen. The
// library's own default is 10,000 bytes, which retains a few hundred lines
// only because history is pruned in whole pages (a page is a few hundred KiB
// of grid). We set the byte budget explicitly so the line cap is normally what
// binds, and so a session with very long lines cannot pin memory.
const scrollbackMaxBytes = 8 << 20

// Formatter options and formats (ghostty/vt/formatter.h, types.h).
const (
	formatVT          = 1
	formatterOptEmit  = 1
	formatterOptExtra = 5
)

// Extras selects which terminal state a VT dump carries. They are only
// meaningful for Extras-less formats: for the VT format they emit the modes,
// palette and other state a fresh terminal would otherwise not have.
type Extras uint32

const (
	ExtrasPalette         Extras = 1 << 0
	ExtrasModes           Extras = 1 << 1
	ExtrasScrollingRegion Extras = 1 << 2
	ExtrasTabstops        Extras = 1 << 3
	ExtrasPwd             Extras = 1 << 4
	ExtrasKeyboard        Extras = 1 << 5
	ExtrasCursor          Extras = 1 << 6
	ExtrasStyle           Extras = 1 << 7
	ExtrasHyperlink       Extras = 1 << 8
	ExtrasProtection      Extras = 1 << 9
	ExtrasKittyKeyboard   Extras = 1 << 10
	ExtrasCharsets        Extras = 1 << 11

	// ExtrasRestore is the set suwu replays into the browser on reattach:
	// styles, cursor position, scroll region and modes. It reproduces what
	// libghostty-go's DumpVTFull emitted byte for byte, and deliberately
	// leaves out the palette and tab stops, which cost ~5.6 KiB of OSC 4
	// per dump and change nothing on screen.
	ExtrasRestore = ExtrasModes | ExtrasScrollingRegion | ExtrasCursor | ExtrasStyle
)

// Info describes the embedded module, as reported by the library itself.
type Info struct {
	LibraryVersion string
	Target         string
	PointerSize    uint32
}

// Option configures a Runtime.
type Option func(*options)

type options struct {
	cacheDir string
}

// WithCacheDir persists wazero's compiled module in dir. Compiling the module
// costs ~0.6 s, so a cache makes restarts (and upgrades) fast. The directory
// is wazero-version specific and must only be written by us.
func WithCacheDir(dir string) Option {
	return func(o *options) { o.cacheDir = dir }
}

// Runtime owns the compiled module. It is safe for concurrent use; created
// once per process and shared by every Terminal.
type Runtime struct {
	rt       wazero.Runtime
	cache    wazero.CompilationCache
	compiled wazero.CompiledModule
	info     Info
	next     atomic.Uint64
}

// NewRuntime compiles the embedded module and verifies its ABI. The compile
// takes ~0.6 s cold, ~0.05 s when WithCacheDir has a warm hit.
func NewRuntime(ctx context.Context, opts ...Option) (*Runtime, error) {
	var cfg options
	for _, opt := range opts {
		opt(&cfg)
	}

	rc := wazero.NewRuntimeConfig()
	var cache wazero.CompilationCache
	if cfg.cacheDir != "" {
		c, err := wazero.NewCompilationCacheWithDir(cfg.cacheDir)
		if err != nil {
			return nil, fmt.Errorf("vt: open wasm cache %s: %w", cfg.cacheDir, err)
		}
		cache = c
		rc = rc.WithCompilationCache(c)
	}

	rt := wazero.NewRuntimeWithConfig(ctx, rc)
	compiled, err := rt.CompileModule(ctx, wasmBinary)
	if err != nil {
		if cache != nil {
			_ = cache.Close(ctx)
		}
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("vt: compile libghostty-vt %s: %w", EngineVersion, err)
	}

	probe, err := rt.InstantiateModule(ctx, compiled, wazero.NewModuleConfig().WithName("libghostty-probe"))
	if err != nil {
		if cache != nil {
			_ = cache.Close(ctx)
		}
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("vt: instantiate probe: %w", err)
	}
	info, err := probeInfo(ctx, probe)
	_ = probe.Close(ctx)
	if err != nil {
		if cache != nil {
			_ = cache.Close(ctx)
		}
		_ = rt.Close(ctx)
		return nil, err
	}

	return &Runtime{rt: rt, cache: cache, compiled: compiled, info: info}, nil
}

// Info reports the version and ABI of the embedded module.
func (r *Runtime) Info() Info { return r.info }

// Close releases the runtime. Terminals created from it must be closed first.
func (r *Runtime) Close() error {
	err := r.rt.Close(context.Background())
	if r.cache != nil {
		if cerr := r.cache.Close(context.Background()); err == nil {
			err = cerr
		}
	}
	return err
}

// probeInfo parses the library's self-description and refuses anything that is
// not the 1.0 wasm32 build this package's constants were written against.
func probeInfo(ctx context.Context, mod api.Module) (Info, error) {
	fn := mod.ExportedFunction("ghostty_type_json")
	if fn == nil {
		return Info{}, fmt.Errorf("vt: embedded module is not libghostty-vt: no ghostty_type_json export")
	}
	results, err := fn.Call(ctx)
	if err != nil {
		return Info{}, fmt.Errorf("vt: ghostty_type_json: %w", err)
	}
	ptr := api.DecodeU32(results[0])
	if ptr == 0 {
		return Info{}, fmt.Errorf("vt: ghostty_type_json returned no data")
	}
	// The type manifest is large (the full ABI description) and lives in the
	// module's static data, so read to the end of memory and cut at the NUL.
	size := mod.Memory().Size()
	if ptr >= size {
		return Info{}, fmt.Errorf("vt: ghostty_type_json pointer %#x is outside wasm memory", ptr)
	}
	raw, ok := mod.Memory().Read(ptr, size-ptr)
	if !ok {
		return Info{}, fmt.Errorf("vt: ghostty_type_json data out of bounds")
	}
	end := bytes.IndexByte(raw, 0)
	if end < 0 {
		return Info{}, fmt.Errorf("vt: ghostty_type_json is not NUL terminated")
	}
	raw = raw[:end]

	var doc struct {
		ABI struct {
			Target      string `json:"target"`
			PointerSize uint32 `json:"pointer_size"`
		} `json:"abi"`
		LibraryVersion string `json:"library_version"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return Info{}, fmt.Errorf("vt: decode ghostty_type_json: %w", err)
	}
	info := Info{
		LibraryVersion: doc.LibraryVersion,
		Target:         doc.ABI.Target,
		PointerSize:    doc.ABI.PointerSize,
	}
	if info.LibraryVersion != EngineVersion {
		return Info{}, fmt.Errorf("vt: embedded module reports libghostty-vt %q, want %s", info.LibraryVersion, EngineVersion)
	}
	if info.Target != "wasm32" || info.PointerSize != wordSize {
		return Info{}, fmt.Errorf("vt: embedded module is %s with %d-byte pointers, want wasm32/4", info.Target, info.PointerSize)
	}
	return info, nil
}

// funcs caches the exported functions a Terminal needs, so hot paths do not
// hit the export map.
type funcs struct {
	alloc       api.Function
	free        api.Function
	allocOpaque api.Function
	takeOpaque  api.Function
	freeOpaque  api.Function

	terminalNew    api.Function
	terminalSet    api.Function
	terminalFree   api.Function
	terminalResize api.Function
	vtWrite        api.Function

	formatterNew   api.Function
	formatterSet   api.Function
	formatterAlloc api.Function
	formatterFree  api.Function

	ghosttyFree api.Function
}

func lookup(mod api.Module) (*funcs, error) {
	f := &funcs{
		alloc:          mod.ExportedFunction("ghostty_wasm_alloc"),
		free:           mod.ExportedFunction("ghostty_wasm_free"),
		allocOpaque:    mod.ExportedFunction("ghostty_wasm_alloc_opaque"),
		takeOpaque:     mod.ExportedFunction("ghostty_wasm_take_opaque"),
		freeOpaque:     mod.ExportedFunction("ghostty_wasm_free_opaque"),
		terminalNew:    mod.ExportedFunction("ghostty_terminal_new"),
		terminalSet:    mod.ExportedFunction("ghostty_terminal_set"),
		terminalFree:   mod.ExportedFunction("ghostty_terminal_free"),
		terminalResize: mod.ExportedFunction("ghostty_terminal_resize"),
		vtWrite:        mod.ExportedFunction("ghostty_terminal_vt_write"),
		formatterNew:   mod.ExportedFunction("ghostty_formatter_terminal_new"),
		formatterSet:   mod.ExportedFunction("ghostty_formatter_set"),
		formatterAlloc: mod.ExportedFunction("ghostty_formatter_format_alloc"),
		formatterFree:  mod.ExportedFunction("ghostty_formatter_free"),
		ghosttyFree:    mod.ExportedFunction("ghostty_free"),
	}
	for name, fn := range map[string]api.Function{
		"ghostty_wasm_alloc":             f.alloc,
		"ghostty_wasm_free":              f.free,
		"ghostty_wasm_alloc_opaque":      f.allocOpaque,
		"ghostty_wasm_take_opaque":       f.takeOpaque,
		"ghostty_wasm_free_opaque":       f.freeOpaque,
		"ghostty_terminal_new":           f.terminalNew,
		"ghostty_terminal_set":           f.terminalSet,
		"ghostty_terminal_free":          f.terminalFree,
		"ghostty_terminal_resize":        f.terminalResize,
		"ghostty_terminal_vt_write":      f.vtWrite,
		"ghostty_formatter_terminal_new": f.formatterNew,
		"ghostty_formatter_set":          f.formatterSet,
		"ghostty_formatter_format_alloc": f.formatterAlloc,
		"ghostty_formatter_free":         f.formatterFree,
		"ghostty_free":                   f.ghosttyFree,
	} {
		if fn == nil {
			return nil, fmt.Errorf("vt: embedded module is missing export %q", name)
		}
	}
	return f, nil
}

// Terminal is one emulated screen: a wasm module instance plus a handle to its
// terminal. All methods are safe for concurrent use and serialized internally,
// because the library itself is not reentrant.
type Terminal struct {
	ctx  context.Context
	mod  api.Module
	f    *funcs
	term uint64

	mu          sync.Mutex
	scratch     uint32 // wasm buffer reused for input
	scratchSize uint32
	closed      bool
}

// NewTerminal creates a terminal of cols×rows cells. scrollback caps retained
// history in lines; the library has no line cap by default, so passing 0
// leaves it effectively unbounded and is not what a server wants. Retention is
// approximate either way: the library prunes in whole pages, so the real depth
// is a few hundred lines for a 1000-line cap. Bytes are capped separately at
// scrollbackMaxBytes.
func (r *Runtime) NewTerminal(cols, rows uint16, scrollback uint32) (*Terminal, error) {
	if cols == 0 || rows == 0 {
		return nil, fmt.Errorf("vt: terminal size %dx%d is invalid", cols, rows)
	}
	ctx := context.Background()
	name := fmt.Sprintf("libghostty-%d", r.next.Add(1))
	mod, err := r.rt.InstantiateModule(ctx, r.compiled, wazero.NewModuleConfig().WithName(name))
	if err != nil {
		return nil, fmt.Errorf("vt: instantiate terminal: %w", err)
	}
	f, err := lookup(mod)
	if err != nil {
		_ = mod.Close(ctx)
		return nil, err
	}

	t := &Terminal{ctx: ctx, mod: mod, f: f}
	if err := t.init(cols, rows, scrollback); err != nil {
		_ = mod.Close(ctx)
		return nil, err
	}
	return t, nil
}

func (t *Terminal) init(cols, rows uint16, scrollback uint32) error {
	slot, err := t.allocSlot()
	if err != nil {
		return err
	}
	defer t.freeOpaque(slot)

	if err := t.check("terminal_new", t.f.terminalNew, 0, uint64(slot), uint64(cols), uint64(rows)); err != nil {
		return err
	}
	t.term = t.call(t.f.takeOpaque, uint64(slot))
	if t.term == 0 {
		return fmt.Errorf("vt: terminal_new returned a null handle")
	}
	if scrollback > 0 {
		if err := t.setSizeT(optScrollbackMaxLines, scrollback); err != nil {
			return err
		}
	}
	return t.setSizeT(optScrollbackMaxBytes, scrollbackMaxBytes)
}

// setSizeT writes a size_t option value (a 4-byte word on wasm32) and applies
// it. Options must be set before the terminal is used.
func (t *Terminal) setSizeT(option uint64, value uint32) error {
	buf, err := t.allocWord(value)
	if err != nil {
		return err
	}
	defer t.free(buf, wordSize)
	return t.check("terminal_set", t.f.terminalSet, t.term, option, uint64(buf))
}

// Write feeds PTY output into the emulator. It never fails on bad input: the
// library logs malformed sequences internally and keeps state consistent.
func (t *Terminal) Write(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return fmt.Errorf("vt: write on closed terminal")
	}
	buf, err := t.reserve(len(data))
	if err != nil {
		return err
	}
	if !t.mod.Memory().Write(buf, data) {
		return fmt.Errorf("vt: write %d bytes into wasm memory at %#x failed", len(data), buf)
	}
	// vt_write returns void and cannot fail.
	return t.check("terminal_vt_write", t.f.vtWrite, t.term, uint64(buf), uint64(len(data)))
}

// Resize adopts a new grid size. The library reflows the primary screen and
// leaves the alternate screen alone, which is what a TUI expects.
func (t *Terminal) Resize(cols, rows uint16) error {
	if cols == 0 || rows == 0 {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return fmt.Errorf("vt: resize on closed terminal")
	}
	// Cell pixel size is only used for image protocols and size reports; we
	// do not track it, so the browser-visible grid is what matters.
	return t.check("terminal_resize", t.f.terminalResize, t.term, uint64(cols), uint64(rows), 0, 0)
}

// DumpVT renders the screen as VT escape sequences carrying the requested
// extras. Replaying the result into a fresh terminal reproduces this one's
// screen exactly, which is how the browser rebuilds a reattached session.
//
// The dump includes the retained scrollback, oldest line first, and ends with
// the cursor position. That is what makes history survive a browser refresh:
// the client resets xterm.js and replays this, so nothing is duplicated. The
// size is bounded by the scrollback caps; measured sessions reattach with tens
// of KiB (≈10 KiB for a short session, ≈50 KiB for a busy full-screen one).
func (t *Terminal) DumpVT(extras Extras) ([]byte, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil, fmt.Errorf("vt: dump on closed terminal")
	}

	fslot, err := t.allocSlot()
	if err != nil {
		return nil, err
	}
	defer t.freeOpaque(fslot)
	if err := t.check("formatter_new", t.f.formatterNew, 0, uint64(fslot), t.term); err != nil {
		return nil, err
	}
	formatter := t.call(t.f.takeOpaque, uint64(fslot))
	if formatter == 0 {
		return nil, fmt.Errorf("vt: formatter_new returned a null handle")
	}
	defer t.call(t.f.formatterFree, formatter)

	// One block holds the two options and the two out-parameters.
	args, err := t.allocBlock(4 * wordSize)
	if err != nil {
		return nil, err
	}
	defer t.free(args, 4*wordSize)
	if !t.mod.Memory().WriteUint32Le(args, formatVT) {
		return nil, fmt.Errorf("vt: write formatter options failed")
	}
	if !t.mod.Memory().WriteUint32Le(args+4, uint32(extras)) {
		return nil, fmt.Errorf("vt: write formatter extras failed")
	}
	if err := t.check("formatter_set emit", t.f.formatterSet, formatter, formatterOptEmit, uint64(args)); err != nil {
		return nil, err
	}
	if err := t.check("formatter_set extras", t.f.formatterSet, formatter, formatterOptExtra, uint64(args+4)); err != nil {
		return nil, err
	}

	outPtr := args + 2*wordSize
	outLen := args + 3*wordSize
	if err := t.check("formatter_format_alloc", t.f.formatterAlloc, formatter, 0, uint64(outPtr), uint64(outLen)); err != nil {
		return nil, err
	}
	ptr, ok := t.mod.Memory().ReadUint32Le(outPtr)
	if !ok {
		return nil, fmt.Errorf("vt: read dump pointer failed")
	}
	size, ok := t.mod.Memory().ReadUint32Le(outLen)
	if !ok {
		return nil, fmt.Errorf("vt: read dump length failed")
	}
	if ptr == 0 || size == 0 {
		return nil, nil
	}
	raw, ok := t.mod.Memory().Read(ptr, size)
	if !ok {
		return nil, fmt.Errorf("vt: dump of %d bytes at %#x is out of bounds", size, ptr)
	}
	out := make([]byte, len(raw))
	copy(out, raw)
	t.call(t.f.ghosttyFree, 0, uint64(ptr), uint64(size))
	return out, nil
}

// Close frees the emulator and its module instance. It is idempotent.
func (t *Terminal) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil
	}
	t.closed = true
	if t.term != 0 {
		t.call(t.f.terminalFree, t.term)
		t.term = 0
	}
	if t.scratch != 0 {
		t.call(t.f.free, uint64(t.scratch), uint64(t.scratchSize))
		t.scratch, t.scratchSize = 0, 0
	}
	return t.mod.Close(t.ctx)
}

// reserve returns a wasm buffer of at least n bytes, reusing the previous one
// when it is already big enough. Linear memory never shrinks, so the scratch
// buffer only ever grows to the largest single write.
func (t *Terminal) reserve(n int) (uint32, error) {
	size := uint32((n + 4095) &^ 4095)
	if t.scratch != 0 && t.scratchSize >= size {
		return t.scratch, nil
	}
	if t.scratch != 0 {
		t.call(t.f.free, uint64(t.scratch), uint64(t.scratchSize))
		t.scratch, t.scratchSize = 0, 0
	}
	ptr, err := t.allocBlock(size)
	if err != nil {
		return 0, err
	}
	t.scratch, t.scratchSize = ptr, size
	return ptr, nil
}

func (t *Terminal) allocBlock(n uint32) (uint32, error) {
	ptr := uint32(t.call(t.f.alloc, uint64(n)))
	if ptr == 0 {
		return 0, fmt.Errorf("vt: allocate %d bytes in wasm memory failed", n)
	}
	return ptr, nil
}

func (t *Terminal) allocWord(v uint32) (uint32, error) {
	ptr, err := t.allocBlock(wordSize)
	if err != nil {
		return 0, err
	}
	if !t.mod.Memory().WriteUint32Le(ptr, v) {
		t.free(ptr, wordSize)
		return 0, fmt.Errorf("vt: write word into wasm memory failed")
	}
	return ptr, nil
}

func (t *Terminal) allocSlot() (uint32, error) {
	slot := uint32(t.call(t.f.allocOpaque))
	if slot == 0 {
		return 0, fmt.Errorf("vt: allocate opaque slot failed")
	}
	return slot, nil
}

func (t *Terminal) free(ptr, size uint32) {
	if ptr != 0 {
		t.call(t.f.free, uint64(ptr), uint64(size))
	}
}

func (t *Terminal) freeOpaque(slot uint32) {
	if slot != 0 {
		t.call(t.f.freeOpaque, uint64(slot))
	}
}

// call invokes a wasm export and returns its first result, or 0 for void
// functions. Errors are reported through check, not here.
func (t *Terminal) call(fn api.Function, args ...uint64) uint64 {
	results, err := fn.Call(t.ctx, args...)
	if err != nil || len(results) == 0 {
		return 0
	}
	return results[0]
}

func (t *Terminal) check(op string, fn api.Function, args ...uint64) error {
	results, err := fn.Call(t.ctx, args...)
	if err != nil {
		return fmt.Errorf("vt: %s: %w", op, err)
	}
	if len(results) == 0 {
		return nil
	}
	return checkCode(op, int32(results[0]))
}
