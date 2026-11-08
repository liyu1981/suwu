# libghostty-vt 1.0 — Dependency Review & Upgrade Plan

> **Status:** **done** — the dependency is replaced by `pkg/vt`, a thin binding
> to the official libghostty-vt 1.0.0 WebAssembly release. See §8 for what
> shipped and how it was verified.
> **Upstream release:** libghostty-vt **1.0.0**, tag `vt-1.0.0`, 2026-11-06
> ([announcement](https://mitchellh.com/writing/libghostty-1-0)).

---

## 1. What we used to depend on

```
github.com/shintaoku/libghostty-go v0.1.0    (removed from go.mod/go.sum)
```

That module was a **third-party wrapper**, not the upstream library. It vendored
a patched Ghostty checkout and re-exported a private `gx_*` C-WASM shim:

| Part | Fact |
|---|---|
| Canonical repo | `github.com/gx14ac/libghostty-go` — the `shintaoku` account redirects here. Single commit, single tag (`v0.1.0`, 2026-03-21), 0 open issues, 1 star. |
| Pinned Ghostty source | commit `1576a09` = **`ghostty-1.3.0-dev`**, a pre-release app branch snapshot (`vt/build.zig.zon`) |
| Build | Zig 0.15.1 → `wasm32-freestanding`, `ReleaseSmall` → `runevt.wasm` (364 KB) |
| Patches carried | `vt/ghostty.patch` (Zig 0.15 `@intCast` compile fixes), `vt/ghostty-report-pwd.patch` (store the OSC 7 URL in the read-only stream) |
| Shipped ABI | 14 hand-written exports (`gx_alloc`, `gx_init`, `gx_feed`, `gx_dump_screen`, …) — no upstream ABI, no stability guarantee |
| Process model | Global state (`var g_terminal`, `var g_dump`) ⇒ **one WASM module instance per terminal**, imposed by the shim |

Our old API surface was small: five calls in `pkg/session/session.go`
(`NewRuntime`, `NewTerminal`, `Feed`, `Resize`, `DumpScreen(DumpVTFull)`,
`Close`). `gx_get_pwd_*`, `gx_encode_key` and `gx_is_alt_screen` were unused —
CWD comes from `/proc`, key encoding happens in xterm.js — so the fork's pwd
patch was dead weight.

## 2. What 1.0 changes upstream

libghostty-vt is now versioned **independently of the Ghostty app** and is a
standalone C library with a stable ABI. Our old pin (`ghostty 1.3.0-dev`, a Zig
module) and `libghostty-vt 1.0.0` (versioned C library) are different products.

* **Stable C ABI from 1.0.** Opaque handles only; values go through enum-keyed
  `ghostty_*_get`/`_set`, so new fields never add symbols. Newer headers
  against an older library return `GHOSTTY_UNSUPPORTED` instead of crashing.
  Enforced by libabigail against a committed baseline, plus golden type
  manifests per target. Minor/patch releases only add.
* **Real packaging.** Signed source + deps tarballs, shared/static libs, SONAME
  `libghostty-vt.so.1`, versioned ELF symbols (`GHOSTTY_VT_1.0`), pkg-config,
  CMake config, XCFramework, DLL, Android `.so`.
* **Official WebAssembly artifacts** at
  `https://release.files.ghostty.org/libghostty-vt/1.0.0/`:
  `ghostty-vt-1.0.0.wasm` (speed optimized, 1,240,850 B) and
  `ghostty-vt-1.0.0-small.wasm` (844,279 B), plus `SHA256SUMS` and `.minisig`.
  `wasm32-freestanding`, **zero imports**, 214 exports, stable `ghostty_*`
  names, and a documented host helper ABI (`include/ghostty/vt/wasm.h`, plus
  `ghostty_type_json` for pointer widths and struct layouts).
* **Optional feature trimming** (`-Dvt-features=…`); disabled features keep
  their exports and return `GHOSTTY_UNSUPPORTED`.

## 3. Feasibility — measured, not assumed

The official module was downloaded, verified against the published
`SHA256SUMS`, and driven from Go with **wazero v1.11.0 as pinned**, so the qjs
v1.12+ pin is untouched. It validates and runs unmodified: wazero's default
`CoreFeaturesV2` already includes `CoreFeatureSIMD`.

| Metric | old `runevt.wasm` (364 KB) | 1.0.0 speed-optimized (1.24 MB) |
|---|---|---|
| `CompileModule`, cold | 140 ms | 642 ms |
| `CompileModule`, warm (`WithCacheDir`) | n/a | **17 ms** |
| Instantiate per terminal | 7.7 ms | 1.2 ms |
| RAM per terminal (n=40, `MemStats.Sys`) | ~8.5 MiB | ~1.2 MiB |
| VT throughput (spike, 1 MiB × 20 terminals) | 16.0 MiB/s | 55.8 MiB/s |
| `Write` in the shipped binding (`BenchmarkWrite`) | — | 60.5 MB/s, 48 B/op, 2 allocs |
| Full-screen dump (`BenchmarkDumpVT`) | — | 28 µs, 10.8 KB, 22 allocs |

Correctness checks against the real artifact:

* `dump → feed into a fresh terminal → dump` is **byte-identical**, including
  alt-screen modes (`?1049h`, `?25l`, `?1h`, `=`) and cursor position.
* Snapshot `encode → decode → encode` is **byte-identical** (spike only, not
  used yet) for a session with 500 lines of scrollback.
* `DumpScreen(DumpVTFull)` is reproduced exactly by the 1.0 formatter with
  `GHOSTTY_FORMATTER_FORMAT_VT` + `extras = 0xC6` (MODES | SCROLLING_REGION |
  STYLE | CURSOR); the only difference is a trailing `\x1b[0m` after the final
  cursor move. ⚠️ `EXTRAS_ALL` / the palette extras emit 256 `OSC 4` entries
  and a tab-stop train: an 89-byte snapshot becomes 5.7 KB.

## 4. What changed in the tree

| Area | Change |
|---|---|
| `pkg/vt/` (new) | ~650 LOC binding: `Runtime` (compile once, optional persisted compilation cache, `ghostty_type_json` ABI check), `Terminal` (reusable scratch buffer, mutex), `Write`, `Resize`, `DumpVT(extras)`, `Close`. |
| `pkg/vt/ghostty-vt.wasm` | The official **speed-optimized** module, embedded. Pinned by SHA-256 in `PROVENANCE.md` and in `TestEmbeddedModuleChecksum`. |
| `pkg/session/session.go` | Six call sites swapped; `wasmTimeout` deadlines deleted (wazero only honours `ctx` mid-call with `WithCloseOnContextDone`, which we never enabled, so they were decorative). `NewManager(opts ...Option)` + `WithWasmCacheDir`. |
| `cmd/Suwu/main.go` | Data directory resolved before the session manager and passed as the wasm cache dir. |
| `go.mod` / `go.sum` | `libghostty-go` dropped; `wazero` promoted to a direct dependency at the already-pinned v1.11.0. |
| Docs/website | `website/index.html` credit now points at <https://lib.ghostty.org>; macOS and gqjs plans updated. |

Old → new mapping, for reference:

| Old | 1.0 |
|---|---|
| `NewRuntime(ctx)` | `wazero` runtime + `CompileModule`; no host module (0 imports) |
| `rt.NewTerminal(ctx, cols, rows, sb)` | `ghostty_terminal_new` + `terminal_set(OPT_SCROLLBACK_MAX_LINES=29, OPT_SCROLLBACK_MAX_BYTES=28)` |
| `Feed(ctx, b) error` | `ghostty_terminal_vt_write` — returns `void`, never fails |
| `Resize(ctx, cols, rows)` | `ghostty_terminal_resize(t, cols, rows, cell_w_px, cell_h_px)` |
| `DumpScreen(ctx, DumpVTFull).VT` | formatter `OPT_EMIT=VT`, `OPT_EXTRAS=0xC6`, `format_alloc`, `ghostty_free` |
| `Close(ctx)` | `formatter_free` / `terminal_free` / `wasm_free` |

## 5. Behavior changes to know about

1. **Reattach snapshots now carry scrollback.** libghostty-vt 1.0's C formatter
   emits the retained history, oldest line first, then the cursor position.
   The old fork dumped the visible screen only. This is a UX win — history now
   survives a page refresh — and the client already calls `term.reset()` before
   replaying, so nothing is duplicated. Measured payloads: ≈10 KB for a short
   session, ≈50 KB for a busy full-screen one; xterm.js keeps 5000 lines.
2. **Retention is page-granular.** The library prunes history in whole pages
   (a page is a few hundred KiB of grid), so `vtScrollback = 1000` really keeps
   a few hundred lines, and the library's default byte budget is only 10,000
   bytes. `pkg/vt` sets both caps explicitly (1000 lines, 8 MiB) so long lines
   cannot pin memory.
3. **pty replies are still swallowed** (they were with the fork too: the old
   shim used Ghostty's read-only stream). 1.0 can answer `CSI 6n`, DA1, OSC 10/11
   via `GHOSTTY_TERMINAL_OPT_WRITE_PTY` — see §7.
4. **Startup** pays a one-off wasm compile: 642 ms cold, **17 ms warm** with the
   persisted cache that `suwu serve` now configures.

## 6. Risks carried forward

| # | Risk | Mitigation in place |
|---|---|---|
| 1 | We own the binding: no upstream Go binding targets 1.0. | 5-call surface against a stable, ABI-checked C API; `pkg/vt` is covered by round-trip, alt-screen, resize, scrollback, lifecycle, concurrency and checksum tests. |
| 2 | Trusting a prebuilt wasm blob. | SHA-256 pinned in `PROVENANCE.md` and asserted by a test; download URLs + minisign key documented. |
| 3 | Dump-format drift on a future bump. | `ExtrasRestore` is fixed and asserted (`TestExtrasRestoreMatchesPreviousDumpFormat`); `go test ./pkg/vt/` fails loudly on an ABI change. |
| 4 | Upstream behavior drift on a bump (reflow, size reports, kitty graphics). | Version is pinned and verified at startup via `ghostty_type_json`; a 2.x major would need the binding revisited. |
| 5 | Idle sessions keep their wasm linear memory until closed (24 h TTL). | `ghostty_terminal_compress` + `GHOSTTY_TERMINAL_DATA_MEMORY_USAGE` are available; retention is bounded by the caps. |
| 6 | No cgo, ever. | The engine stays WASM: `CGO_ENABLED=0` cross-compiles still work, which `docs/MACOS_SUPPORT_PLAN.md` depends on. |

## 7. Optional follow-ups

1. **pty replies** via `WRITE_PTY`, so apps that probe the terminal get answers.
   ⚠️ The callback must never touch `Manager.mu`: `broadcast` already holds it
   and the terminal is explicitly non-reentrant.
2. **Snapshot-based session persistence** (`ghostty_snapshot_encode_alloc` /
   `snapshot_decoder_decode`), so a session survives a *server* restart, not
   just a browser refresh. Proven in the spike; the wire format is
   libghostty-specific, so the browser path stays on VT dumps.
3. **Idle-frame budget**: A session with a 1000-line styled scrollback dumps in
   ≈28 µs, so the current per-reattach cost is already negligible; nothing to do
   unless reattach latency shows up in traces.
4. **Reproducible wasm from source**: build `libghostty-vt-X.Y.Z.wasm` from the
   signed source tarball in CI (needs Zig 0.17.0 exactly + the deps tarball) if
   shipping a binary blob ever becomes a policy problem.

## 8. What shipped, and how to verify it

```sh
go build ./...
go vet ./...
go test ./pkg/vt/ ./pkg/session/     # engine + session lifecycle
go test ./pkg/...                    # full suite, incl. the websocket PTY bridge
go test ./pkg/vt/ -bench . -benchtime 200x
```

* `pkg/vt/vt_test.go` covers: embedded-artifact checksum, ABI/version report,
  dump fixed-point (screen + scrollback), alt-screen modes, extras compactness,
  resize reflow, scrollback bounds, large writes, lifecycle, concurrent
  access; plus `BenchmarkWrite` / `BenchmarkDumpVT`.
* `pkg/session/session_test.go` adds `TestWasmCacheDirIsUsed`; the existing
  attach/reattach/TTL/revoke/resize/shutdown tests now run against 1.0.
* `pkg/server` end-to-end tests (websocket PTY bridge, real shells) pass
  unchanged — no protocol or frontend change was needed.
