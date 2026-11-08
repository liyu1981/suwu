package vt

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
)

// The checksum published in PROVENANCE.md. A mismatch means the embedded
// module is not the artifact we vetted.
const wantModuleSHA256 = "7b428fee6d0677bc81279458f8f9a3335454834123a9ff47efb3fd177f6da5a8"

var (
	sharedOnce sync.Once
	sharedRT   *Runtime
	sharedErr  error
)

// testRuntime compiles the module once for the whole package: a cold compile
// costs ~0.6 s, which would otherwise dominate the suite.
func testRuntime(t *testing.T) *Runtime {
	t.Helper()
	sharedOnce.Do(func() {
		sharedRT, sharedErr = NewRuntime(context.Background())
	})
	if sharedErr != nil {
		t.Fatalf("NewRuntime: %v", sharedErr)
	}
	return sharedRT
}

func TestMain(m *testing.M) {
	code := m.Run()
	if sharedRT != nil {
		_ = sharedRT.Close()
	}
	os.Exit(code)
}

func newTerm(t *testing.T, cols, rows uint16, scrollback uint32) *Terminal {
	t.Helper()
	term, err := testRuntime(t).NewTerminal(cols, rows, scrollback)
	if err != nil {
		t.Fatalf("NewTerminal(%d, %d, %d): %v", cols, rows, scrollback, err)
	}
	t.Cleanup(func() { _ = term.Close() })
	return term
}

func feed(t *testing.T, term *Terminal, s string) {
	t.Helper()
	if err := term.Write([]byte(s)); err != nil {
		t.Fatalf("Write: %v", err)
	}
}

func dump(t *testing.T, term *Terminal, extras Extras) []byte {
	t.Helper()
	out, err := term.DumpVT(extras)
	if err != nil {
		t.Fatalf("DumpVT: %v", err)
	}
	return out
}

func TestEmbeddedModuleChecksum(t *testing.T) {
	sum := sha256.Sum256(wasmBinary)
	if got := hex.EncodeToString(sum[:]); got != wantModuleSHA256 {
		t.Fatalf("embedded module sha256 = %s, want %s (see PROVENANCE.md)", got, wantModuleSHA256)
	}
}

func TestRuntimeInfo(t *testing.T) {
	info := testRuntime(t).Info()
	if info.LibraryVersion != EngineVersion {
		t.Errorf("LibraryVersion = %q, want %q", info.LibraryVersion, EngineVersion)
	}
	if info.Target != "wasm32" || info.PointerSize != 4 {
		t.Errorf("abi = %s/%d, want wasm32/4", info.Target, info.PointerSize)
	}
}

func TestDumpReproducesScreen(t *testing.T) {
	term := newTerm(t, 80, 24, 1000)
	feed(t, term, "\x1b[2J\x1b[H$ ls\r\n"+
		"\x1b[34mdir\x1b[0m  \x1b[32mfile.txt\x1b[0m  README.md\r\n"+
		"$ echo h\u00e9llo \u2192 \u65e5\u672c\u8a9e\r\n"+
		"h\u00e9llo \u2192 \u65e5\u672c\u8a9e\r\n"+
		"$ \x1b[7m\x1b[1mreverse\x1b[0m\r\n")

	first := dump(t, term, ExtrasRestore)
	if len(first) == 0 {
		t.Fatal("dump is empty")
	}

	// Replaying a dump into a fresh terminal must reproduce it exactly.
	replay := newTerm(t, 80, 24, 1000)
	feed(t, replay, string(first))
	second := dump(t, replay, ExtrasRestore)
	if !bytes.Equal(first, second) {
		t.Fatalf("dump is not a fixed point: %d bytes then %d bytes\nfirst:  %q\nsecond: %q",
			len(first), len(second), first, second)
	}
}

func TestDumpCarriesAltScreenAndModes(t *testing.T) {
	term := newTerm(t, 80, 24, 1000)
	feed(t, term, "\x1b[?1049h\x1b[2J\x1b[Hfull screen TUI\r\n\x1b[?25l\x1b[?1h\x1b=")
	d := dump(t, term, ExtrasRestore)

	replay := newTerm(t, 80, 24, 1000)
	feed(t, replay, string(d))
	if got := dump(t, replay, ExtrasRestore); !bytes.Equal(got, d) {
		t.Fatalf("alt-screen dump not reproduced:\nwant %q\ngot  %q", d, got)
	}
	if !strings.Contains(string(d), "full screen TUI") {
		t.Fatalf("alt-screen content missing from dump: %q", d)
	}
}

func TestExtrasRestoreMatchesPreviousDumpFormat(t *testing.T) {
	// The reattach snapshot is replayed by xterm.js in the browser. It must
	// stay small: the palette extras would add 256 OSC 4 entries (~5.6 KiB)
	// without changing what is on screen.
	term := newTerm(t, 80, 24, 1000)
	feed(t, term, "hello\r\n\x1b[1;32mbold green\x1b[0m\r\n\x1b[33mprivate\x1b[0m\r\n")

	restore := dump(t, term, ExtrasRestore)
	withPalette := dump(t, term, ExtrasRestore|ExtrasPalette)
	if len(restore) >= 200 {
		t.Errorf("restore dump is %d bytes, want the compact form (~90 for 3 lines)", len(restore))
	}
	if len(withPalette) < 5000 {
		t.Errorf("palette dump is %d bytes, expected the 256-entry palette expansion", len(withPalette))
	}
	if !bytes.Contains(restore, []byte("\x1b[1m")) || !bytes.Contains(restore, []byte("\x1b[38;5;2m")) {
		t.Errorf("restore dump lost styles: %q", restore)
	}
	if !bytes.Contains(restore, []byte("\x1b[4;1H")) {
		t.Errorf("restore dump lost the cursor position: %q", restore)
	}
}

func TestResizeReflowsAndKeepsContent(t *testing.T) {
	term := newTerm(t, 80, 24, 1000)
	line := strings.Repeat("0123456789", 8) // 80 columns, exactly the width
	feed(t, term, strings.Repeat(line+"\r\n", 30))

	if err := term.Resize(40, 24); err != nil {
		t.Fatalf("Resize narrow: %v", err)
	}
	narrow := dump(t, term, ExtrasRestore)
	if !bytes.Contains(narrow, []byte("0123456789")) {
		t.Fatalf("content lost after narrowing: %q", narrow)
	}

	if err := term.Resize(120, 40); err != nil {
		t.Fatalf("Resize wide: %v", err)
	}
	wide := dump(t, term, ExtrasRestore)
	if !bytes.Contains(wide, []byte("0123456789")) {
		t.Fatalf("content lost after widening: %q", wide)
	}

	// A resized terminal still has to be a valid replay source.
	replay := newTerm(t, 120, 40, 1000)
	feed(t, replay, string(wide))
	if got := dump(t, replay, ExtrasRestore); !bytes.Equal(got, wide) {
		t.Fatal("dump after resize is not reproducible")
	}
}

func TestDumpRestoresRetainedScrollback(t *testing.T) {
	// libghostty-vt 1.0's C formatter emits the retained history too, oldest
	// line first. This is what makes a refreshed browser keep its scrollback:
	// the client resets xterm.js and replays the whole dump.
	term := newTerm(t, 80, 24, 1000)
	for i := 0; i < 300; i++ {
		feed(t, term, fmt.Sprintf("history line %03d\r\n", i))
	}
	feed(t, term, "last visible line\r\n")

	d := dump(t, term, ExtrasRestore)
	if !bytes.Contains(d, []byte("last visible line")) {
		t.Fatalf("current line missing from dump: %q", d)
	}
	history := bytes.Count(d, []byte("history line"))
	if history <= 24 {
		t.Fatalf("dump carries %d history lines, want the retained scrollback", history)
	}
	if len(d) > 256*1024 {
		t.Fatalf("dump is %d bytes for a 300-line session, want a bounded payload", len(d))
	}

	// The history has to survive the round trip, not just appear once.
	replay := newTerm(t, 80, 24, 1000)
	feed(t, replay, string(d))
	if got := dump(t, replay, ExtrasRestore); !bytes.Equal(got, d) {
		t.Fatalf("dump with history is not a fixed point: %d bytes then %d bytes", len(d), len(got))
	}
}

func TestScrollbackIsBounded(t *testing.T) {
	// Long lines must not pin unbounded memory, and the dump they produce
	// must stay small enough to push down a websocket on a reattach.
	term := newTerm(t, 80, 24, 1000)
	line := strings.Repeat("x", 400) + "\r\n"
	for i := 0; i < 1000; i++ {
		feed(t, term, line)
	}
	d := dump(t, term, ExtrasRestore)
	if len(d) > 4<<20 {
		t.Fatalf("dump is %d bytes for 400 KiB of long lines, want it capped", len(d))
	}
	if !bytes.Contains(d, []byte("xxx")) {
		t.Fatal("dump lost the content entirely")
	}
}

func TestWriteIsChunkSafe(t *testing.T) {
	term := newTerm(t, 80, 24, 1000)
	// Large writes must span multiple wasm buffers without truncation.
	var b strings.Builder
	b.WriteString("\x1b[2J\x1b[H")
	for i := 0; i < 4000; i++ {
		b.WriteString("line with \x1b[35mmarker-MARK\x1b[0m text\r\n")
	}
	if err := term.Write([]byte(b.String())); err != nil {
		t.Fatalf("Write large: %v", err)
	}
	if err := term.Write([]byte("tail-marker")); err != nil {
		t.Fatalf("Write tail: %v", err)
	}
	d := dump(t, term, ExtrasRestore)
	if !bytes.Contains(d, []byte("tail-marker")) {
		t.Fatal("second write not reflected in dump")
	}
}

func TestTerminalLifecycle(t *testing.T) {
	term, err := testRuntime(t).NewTerminal(80, 24, 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := term.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := term.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := term.Close(); err != nil {
		t.Fatalf("second Close should be a no-op: %v", err)
	}
	if err := term.Write([]byte("x")); err == nil {
		t.Fatal("Write after Close should fail")
	}
	if _, err := term.DumpVT(ExtrasRestore); err == nil {
		t.Fatal("DumpVT after Close should fail")
	}
	if err := term.Resize(10, 10); err == nil {
		t.Fatal("Resize after Close should fail")
	}
}

func TestNewTerminalRejectsEmptyGrid(t *testing.T) {
	if _, err := testRuntime(t).NewTerminal(0, 24, 100); err == nil {
		t.Fatal("NewTerminal(0, 24) should fail")
	}
	if _, err := testRuntime(t).NewTerminal(80, 0, 100); err == nil {
		t.Fatal("NewTerminal(80, 0) should fail")
	}
}

func TestConcurrentWrites(t *testing.T) {
	term := newTerm(t, 80, 24, 100)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				_ = term.Write([]byte("x"))
				_, _ = term.DumpVT(ExtrasRestore)
			}
		}()
	}
	wg.Wait()
}

func BenchmarkWrite(b *testing.B) {
	rt, err := NewRuntime(context.Background())
	if err != nil {
		b.Fatal(err)
	}
	defer rt.Close()
	term, err := rt.NewTerminal(80, 24, 1000)
	if err != nil {
		b.Fatal(err)
	}
	defer term.Close()

	line := []byte("\x1b[1;32mthe quick brown fox jumps over the lazy dog\x1b[0m 0123456789\r\n")
	b.SetBytes(int64(len(line)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := term.Write(line); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkDumpVT(b *testing.B) {
	rt, err := NewRuntime(context.Background())
	if err != nil {
		b.Fatal(err)
	}
	defer rt.Close()
	term, err := rt.NewTerminal(80, 24, 1000)
	if err != nil {
		b.Fatal(err)
	}
	defer term.Close()
	for i := 0; i < 24; i++ {
		if err := term.Write([]byte("\x1b[32mcolored output line\x1b[0m with text\r\n")); err != nil {
			b.Fatal(err)
		}
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := term.DumpVT(ExtrasRestore); err != nil {
			b.Fatal(err)
		}
	}
}
