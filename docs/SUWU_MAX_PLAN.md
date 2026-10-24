# Suwu Max — single-file self-extracting bundle

Status: **plan** · Owner: TBD

`suwu-max` is one executable that carries the real `suwu` binary plus a small
set of core utilities, extracts them into `~/.suwu/bin/` on first run, makes
that directory available on `PATH`, and then runs the real binary with the
original arguments.

```
suwu-max serve --env-file .env
   │
   ├─ first run: extract  ~/.suwu/bin/{suwu, rg, …}   (version-stamped)
   ├─ first run: add      ~/.suwu/bin to PATH          (bash/zsh/fish)
   └─ exec                ~/.suwu/bin/suwu serve --env-file .env
```

Later runs skip extraction and `exec` the real binary immediately.

---

## 1. Why a launcher + payload

The project already embeds the web assets in `pkg/assets` (`//go:embed web`),
so "one binary" is an established pattern. `suwu-max` extends it to *files that
must exist on disk* — the real server binary (so it can be replaced/updated)
and external tools that `suwu` looks up with `exec.LookPath` (today that is
`rg`, used by `/api/files/search`; see `pkg/server/file_search.go`).

A tiny Go launcher is better than a shell stub because it:

- cross-compiles with the rest of the repo,
- can verify checksums, lock concurrent runs and re-exec cleanly,
- can patch shell rc files idempotently,
- keeps the payload compressed and architecture-checked.

## 2. Bundle format

Build output: `cmd/SuwuMax/bundle/` (generated, git-ignored) containing:

- `bundle.tar.gz` — compressed payload:
  - `suwu` — the real binary for this GOOS/GOARCH
  - `rg` — ripgrep
  - `tools/<name>/LICENSE` — licenses for bundled third-party tools
  - `NOTICE` — attribution summary
- `manifest.json` — metadata checked into the archive at build time:

```json
{
  "schema": 1,
  "version": "0.1.13",
  "goos": "linux",
  "goarch": "amd64",
  "bundleSha256": "…",
  "entries": [
    { "name": "suwu", "file": "suwu", "mode": "0755", "sha256": "…", "version": "0.1.13" },
    { "name": "rg",   "file": "rg",   "mode": "0755", "sha256": "…", "version": "14.1.1", "license": "MIT" }
  ]
}
```

Why a tar.gz inside the launcher rather than `//go:embed` of each binary:
one compressed blob keeps the launcher build reproducible and lets extraction
stream without holding both copies in memory.

The launcher embeds both files:

```go
//go:embed bundle/bundle.tar.gz bundle/manifest.json
var bundleFS embed.FS
```

`cmd/SuwuMax` is built with a `max` build tag so a plain `go build ./...`
(dev, CI unit tests) skips it. The reusable logic lives in `pkg/maxbundle`
(no build tag, unit-testable).

## 3. Extraction

Target: `~/.suwu/bin/` (override with `--dir` or `SUWU_MAX_DIR`). Flat layout,
matching the requirement that `~/.suwu/bin/suwu` is the real binary.

Stamp: `~/.suwu/bin/.suwu-max.json` — the manifest plus `extractedAt` and a
`files` map of `{size, sha256}`. Written **last**.

### Algorithm

```
ensureExtracted():
  dir  = expand(SUWU_MAX_DIR or ~/.suwu/bin)
  mkdirAll(dir, 0755); chmod ~/.suwu 0700
  lock = flock(dir/.lock)                        # serialise concurrent runs
  defer unlock

  if stampMatches(dir, manifest):                # version + hashes + modes
      return

  staging = mkdirTemp(dir, ".staging-")
  stream bundle.tar.gz → staging, preserving modes
  verify each entry's sha256
  for each entry (suwu first):                   # replace atomically
      os.Rename(staging/file, dir/file)          # rename over target is atomic
  chmod 0755 every binary
  write stamp atomically (temp + rename)
  remove staging
  return FIRST_RUN
```

- `stampMatches` requires: same `version`, `goos`, `goarch`, and every entry
  present with its executable bit. File hashes are verified while extracting,
  but not on later runs — a bundled tool that self-updates must keep working
  until the next `suwu-max` version re-extracts the payload.
- Replacing a running `suwu` is safe on Unix: `rename(2)` swaps the directory
  entry while the old inode stays alive for the running process.
- `flock` uses `golang.org/x/sys/unix` (already indirect). If `flock` is
  unavailable, fall back to an O_EXCL pid file with a stale check.
- Extraction is offline: no network on first run.

## 4. Dispatch

```
if handledEarlyArgs (--version, --help, --extract-only, --print-path):
    handle and exit
first = ensureExtracted()
if first: print extraction + PATH result
env = prependPath(os.Environ(), dir)
env = append(env, "SUWU_MAX=1", "SUWU_BIN="+dir)
syscall.Exec(dir/suwu, [dir/suwu] + os.Args[1:], env)
# fallback if Exec is unavailable/fails:
cmd := exec.Command(dir/suwu, os.Args[1:]...)
cmd.Env, cmd.Stdin/out/err = env, os.Stdin/out/err
exit(cmd.Run())
```

- `syscall.Exec` replaces the launcher: signals, exit codes and the terminal
  belong to the real server; there is no extra parent process.
- `PATH` is prepended for the child, so `suwu`'s own `exec.LookPath("rg")`
  finds the bundled `rg` even before any rc change takes effect.
- No recursion: the launcher always names the absolute extracted path.
- `argv[0]` is the real binary path; arguments pass through untouched.

## 5. PATH setup

Goal: the bundled tools work in the user's own shells too.

On first extraction (or `suwu-max setup-path`), insert a managed block into
the rc files that exist for the detected shells:

| Shell | File |
| --- | --- |
| bash | `~/.bashrc` (fallback `~/.bash_profile` / `~/.profile`) |
| zsh | `~/.zshrc`; also `~/.zshenv` when present for non-interactive use |
| fish | `~/.config/fish/config.fish` |
| sh/others | `~/.profile` |

Block (POSIX shells):

```sh
# >>> suwu-max >>>
case ":$PATH:" in *":$HOME/.suwu/bin:"*) ;; *) PATH="$HOME/.suwu/bin:$PATH" ;; esac
export PATH
# <<< suwu-max <<<
```

Fish:

```fish
# >>> suwu-max >>>
if not contains "$HOME/.suwu/bin" $PATH
    set -gx PATH "$HOME/.suwu/bin" $PATH
end
# <<< suwu-max <<<
```

Rules:

- **Idempotent**: replace an existing marked block, never duplicate. If the
  block is present and current, leave the file untouched (mtime preserved).
- **Least surprise**: only edit files that already exist; do not create
  `~/.zshrc` for a user who does not use zsh. Always offer `--no-path`.
- **Backup once** before the first edit (`file.suwu-max.bak`) so a surprised
  user can revert; document `suwu-max unsetup-path` to remove the block.
- Print what changed, e.g. `Added ~/.suwu/bin to PATH in ~/.bashrc (new shells
  only; run 'source ~/.bashrc' or open a new terminal).`
- `--no-path` / `SUWU_MAX_NO_PATH=1` skips rc edits; the extracted tools still
  work for processes launched by `suwu` because the child `PATH` is prepended.

Optional (document, do not do by default): `~/.config/environment.d/90-suwu.conf`
for systemd user sessions, which needs no rc parsing.

## 6. Bundled tools (chosen)

| Binary | Version | Why | Archive | Size (amd64) | License |
| --- | --- | --- | --- | --- | --- |
| `rg` | 15.2.0 | `/api/files/search` + code search | tar.gz | 2.2 MiB | Unlicense/MIT |
| `fzf` | 0.74.5 | fuzzy finder for the shell | tar.gz | 2.2 MiB | MIT |
| `asdf` | 0.20.2 | polyglot runtime manager | tar.gz | 1.7 MiB | MIT |
| `witr` | 0.3.4 | explain why a process runs | binary | 7.5 MiB | Apache-2.0 |
| `pig` | 0.5.3 | Pi code agent (Go) | tar.gz | 28.5 MiB | MIT |
| `herdr` | 0.9.5 | runtime for AI coding agents | binary | 30.3 MiB | Apache-2.0 |

Sources, per-arch URLs and pinned sha256 values live in
`scripts/max-tools.json`. `scripts/build-max.sh --update-pins` recomputes and
rewrites the pins.

Notes:

- **asdf depends on git.** git is not bundled (large, GPL-2.0, needs exec-path
  helpers); the launcher prints a warning at first run when `git` is absent.
- PiG ships `LICENSES/`, `NOTICE` and `THIRD_PARTY_NOTICES.md`; those are
  installed under `~/.suwu/bin/tools/pig/`. witr's man page goes under
  `tools/witr/`.
- PiG/herdr can update themselves. Because the stamp is presence-only, their
  updates survive until the next `suwu-max` version.
- Payload ≈ 191 MiB extracted; `suwu-max` is **~72 MiB (amd64) / ~68 MiB
  (arm64)** gzip-compressed.

## 7. Build and release

`pnpm run build:max` builds the payload for the **current host** (its `go env
GOOS/GOARCH`), which is the normal way to produce a local installer. The
underlying `scripts/build-max.sh` also accepts `--goos`/`--goarch` for CI
cross-builds (Linux amd64/arm64 only).

Steps:

1. `pnpm --dir frontend build` (populates `pkg/assets/web`).
2. `go build -o build/suwu ./cmd/Suwu` with the version ldflag.
3. Read `scripts/max-tools.json`; download each tool for the target platform
   into `build/tools/`, verify its pinned sha256.
4. Assemble `build/bundle/` (`suwu`, tools, licenses), write `manifest.json`.
5. `tar czf cmd/SuwuMax/bundle/bundle.tar.gz -C build/bundle .` and copy
   `manifest.json`.
6. `go build -tags max -o suwu-max ./cmd/SuwuMax` with the version ldflag.

CI (`release.yml`) gains the same per-platform steps in the existing matrix
(`linux-amd64`, `linux-arm64`) and publishes:

```
suwu-<v>-linux-<arch>.tar.gz          # existing
suwu-max-<v>-linux-<arch>.tar.gz      # new, one file inside: suwu-max
suwu-max-<v>-linux-<arch>.sha256      # checksum
```

The artifact is the launcher alone (the payload is inside it), so installation
is: download, `tar xzf`, `install -m755 suwu-max ~/.local/bin/`.

Expected size: `suwu` (~60–70 MB, mostly embedded web assets + QuickJS) plus
`rg` (~5 MB), compressed to roughly 25–35 MB.

## 8. Versioning and upgrades

- The payload version is embedded in the stamp. A new `suwu-max` extracts over
  the old files, so `~/.suwu/bin/suwu` always matches the launcher that ran.
- Interrupted extraction never updates the stamp, so the next run retries; the
  staging directory is removed on the next successful run.
- Add `suwu-max --version`: launcher version, payload version, GOOS/GOARCH.
- Optional `--keep-backup`: copy the previous `suwu` to `suwu.prev` before
  replacement, for an emergency rollback path.

## 9. Security

- Extract only into a user-owned directory (`~/.suwu` 0700, `bin` 0755); no
  setuid, no privileged writes.
- Verify every extracted file against the embedded manifest hash before writing
  the stamp; a mismatch re-extracts once and then fails loudly.
- PATH prepends a user-writable directory — the same trust model as
  `~/.local/bin`; document it.
- The payload is embedded, not downloaded, so first run needs no network and
  cannot be swapped by a MITM. Checksums still catch packaging/build mistakes.
- Shell rc edits are marked, backed up and reversible (`unsetup-path`).

## 10. CLI surface

```
suwu-max [--dir <path>] [--no-path] [--extract-only] [--force] <suwu args…>
suwu-max --version | --print-path | setup-path | unsetup-path
```

Flags are consumed by the launcher; everything else passes through to the real
`suwu`. `--extract-only` and `--print-path` make the behaviour testable and
scriptable without starting the server.

## 11. Testing

`pkg/maxbundle` (no build tag):

- `stampMatches` — version, OS/arch, per-file hash, missing file, wrong mode.
- extraction — build a tiny in-memory tar.gz, extract to `t.TempDir()`, assert
  contents/modes/stamp; run twice and assert the second run is a no-op (mtime
  unchanged); corrupt a file and assert it re-extracts.
- atomic replace — existing read-only target, existing executable in use.
- concurrency — two goroutines extract into the same dir under the lock.
- PATH patcher — insert into empty/bash/zsh/fish files; idempotent re-run
  byte-identical; remove via `unsetup-path`; preserves unrelated lines;
  ignores nonexistent rc files.

`cmd/SuwuMax` smoke test (skipped when the payload is absent, i.e. not built
with `-tags max`):

- `--extract-only --dir <tmp>` produces `suwu` + `rg` and a stamp;
- `--print-path` prints `<tmp>`;
- `--version` prints launcher + payload versions.

CI: build `suwu-max` for both arches and run `--extract-only` against a temp
dir as a packaging smoke test.

## 12. Rollout

1. **Phase 1** — `pkg/maxbundle` + tests, `cmd/SuwuMax`, build script, `rg`
   only, bash/zsh/fish PATH patcher.
2. **Phase 2** — release artifacts + checksums in CI; install docs.
3. **Phase 3** — add `git` or other tools only if a feature requires them;
   consider `environment.d` support.

## 13. Decisions

1. **Tools** — `rg`, `fzf`, `asdf`, `pig`, `herdr`, `witr` (see §6).
2. **PATH** — on by default for existing bash/zsh/fish rc files; `--no-path` /
   `SUWU_MAX_NO_PATH=1` opts out; `unsetup-path` removes the block.
3. **Existing installs** — an existing `~/.suwu/bin/suwu` is copied to
   `suwu.prev` before it is replaced.
4. **Platforms** — Linux amd64 and arm64 (matching the release matrix).
5. **Compression** — stdlib gzip.
6. **Stamp** — presence-only (version/platform/file presence), so tool
   self-updates persist within a version.
