# `ghostty-vt.wasm` provenance

The embedded module is the **official, speed-optimized** libghostty-vt
WebAssembly build. It is a release artifact, not something this repository
compiles — we never build or patch the engine ourselves.

| | |
|---|---|
| Release | libghostty-vt **1.0.0** (tag `vt-1.0.0`, 2026-11-06) |
| Artifact | `ghostty-vt-1.0.0.wasm` — ReleaseFast / speed-optimized flavour |
| URL | https://release.files.ghostty.org/libghostty-vt/1.0.0/ghostty-vt-1.0.0.wasm |
| Size | 1,240,850 bytes |
| SHA-256 | `7b428fee6d0677bc81279458f8f9a3335454834123a9ff47efb3fd177f6da5a8` |
| Flavour | `wasm32-freestanding`, SIMD enabled, no imports, 214 exports |
| License | MIT (dependencies: simdutf, Google Highway, Wuffs — all permissive) |

## Verifying

The release directory ships `SHA256SUMS` and detached minisign signatures:

```sh
curl -fsSLO https://release.files.ghostty.org/libghostty-vt/1.0.0/ghostty-vt-1.0.0.wasm
curl -fsSLO https://release.files.ghostty.org/libghostty-vt/1.0.0/ghostty-vt-1.0.0.wasm.minisig
curl -fsSLO https://release.files.ghostty.org/libghostty-vt/1.0.0/SHA256SUMS
curl -fsSLO https://release.files.ghostty.org/libghostty-vt/1.0.0/SHA256SUMS.minisig

sha256sum -c --ignore-missing SHA256SUMS
minisign -V -P RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV -m SHA256SUMS
minisign -V -P RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV -m ghostty-vt-1.0.0.wasm
```

`TestEmbeddedModuleChecksum` in `vt_test.go` fails if the embedded bytes drift
from the hash above.

## Why the speed-optimized build, not `-small`

Runtime throughput matters more than binary size here:

| | this module (ReleaseFast) | `-small` (ReleaseSmall) |
|---|---|---|
| Size on disk | 1.24 MB | 844 KB |
| VT parse throughput | 55.8 MiB/s | 53.0 MiB/s |
| Cold compile (once per process) | 642 ms | 326 ms |

The 400 KB difference is ~0.6% of the `suwu` binary, and the extra compile time
is paid once per process and mostly avoided by `vt.WithCacheDir` (a persisted
[wazero compilation cache](https://wazero.io/languages/features/#compilation-cache)
— see `session.WithWasmCacheDir`). Under `wazero` v1.11.0 the module validates
and runs unmodified: `CoreFeaturesV2` already includes `CoreFeatureSIMD`.

## Updating to a later libghostty-vt

1. Take the new `ghostty-vt-X.Y.Z.wasm` from
   `https://release.files.ghostty.org/libghostty-vt/X.Y.Z/`, verify signatures
   as above.
2. Drop it in as `pkg/vt/ghostty-vt.wasm` and update the table here.
3. Run `go test ./pkg/vt/` — `TestDumpVTRoundTrip` and
   `TestEmbeddedModuleChecksum` will catch an ABI change or a bad download.
4. Bump `EngineVersion` in `vt.go`; `NewRuntime` verifies the module reports
   that exact version via `ghostty_type_json()` and refuses to start otherwise.

Minor releases only add to the ABI, so a 1.x bump should not require code
changes. A 2.0 bump changes the SONAME and will need the binding revisited.
