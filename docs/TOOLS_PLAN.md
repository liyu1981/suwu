# System tools — catalog, installer, and `suwu exec`

Status: **phases 0–6 implemented** · §16 records what shipped and where it
deviated from the plan.

Suwu already depends on a handful of binaries that must exist on disk: `rg` (used
by `/api/files/search`), `pig` and `herdr`/`herdr-core` (agents and the Baikal
tile), `fzf` and `asdf` (the shell a user drops into). Today the only way to get
them is the `suwu-max` bundle, which is all-or-nothing and Linux-only. A user on
a plain `suwu` release, or on macOS, is left reading "ripgrep (rg) is not
installed on the server".

This plan turns that into a first-class thing: **a curated tool catalog on
GitHub, an installer that writes into `~/.suwu/bin`, a Settings page that lists
and installs them, and one command that runs the managed copy.**

It lands with a change already decided for `suwu-max`: the bundle stops being a
launcher and becomes a one-shot installer that puts the real app in
`~/.local/bin/suwu` and its tools in `~/.suwu/bin`, then runs the app. That
makes `~/.suwu/bin` a plain tool directory with two writers instead of one, and
it removes almost all of the special-casing the first draft of this plan needed
(§7).

```
Tools (top-level menu)        ~/.suwu/bin/          ~/.local/bin/
┌────────────────────────┐       rg                      suwu  ← the app
│ ripgrep   15.2.0 [ins] │       fzf
│ fzf       0.74.5 ✓     │       pig                     (suwu-max writes both
│ pig        0.5.3 ↑     │       .tools/rg.json    ← per-tool stamp, one format
│ herdr      0.9.5 bundle│
└────────────────────────┘
        │                │
        │                └─ POST /api/tools/install  → download, sha256, extract, stamp
        └────────────────── GET  /api/tools          → catalog ∪ installed, per platform
```

and

```sh
suwu exec rg --json -n TODO .      # runs ~/.suwu/bin/rg, no PATH guessing
```

---

## 1. Goal

1. **One place to install the tools Suwu tells you about.** `~/.suwu/bin`, the
   same directory the `suwu-max` installer seeds, so a bundled and a
   hand-installed copy live in the same place and `suwu exec` needs no special
   cases.
2. **A catalog we can update without a release.** The tool list (versions, URLs,
   checksums, descriptions) lives in the Suwu repository on GitHub; the server
   reads it, caches it, and the Settings page renders it. Same technique as
   `suwu install --github` (see `docs/INSTALL_PLAN.md` §6), same cache rules.
3. **Install = download + verify + extract + stamp.** No shell, no `curl | tar`,
   no half-installed directory, and a version we can compare next time. The
   `suwu-max` bundle uses the same installer, fed from its embedded payload
   instead of the network.
4. **Three ways to reach the tools**, from narrowest to widest: `suwu exec <name>`
   for scripts and agents, the server's own environment (so sessions and
   `/api/files/search` see them), and an always-on shell rc block for interactive
   shells outside Suwu.

Out of scope for v1: a general package manager, arbitrary URLs (a user can still
drop a binary into `~/.suwu/bin` by hand), signatures/provenance beyond
sha256, Windows, auto-update on a timer, and installing system packages with a
package manager.

---

## 2. What already exists (reuse map)

The point of this plan is to *not* write a second installer. Building blocks:

| Piece | Where | What we take |
| --- | --- | --- |
| Catalog fetch + cache | `pkg/install/catalog.go` | `Client` (token, `api.github.com` / `raw.githubusercontent.com`, per-request caps), 6 h ETag cache under `<dataDir>/cache/`, `--refresh`, stale-on-offline |
| Hardened extraction | `pkg/install/archive.go`, `pkg/maxbundle/maxbundle.go` | entry-kind/path/size/permission checks, payload-root rules, no symlinks, no zip-slip |
| Atomic install | `pkg/install/install.go` (`Stage`) | stage → validate → commit, `.bak-<stamp>`, never write through a symlink |
| Payload + stamp layout | `pkg/maxbundle` (`Manifest`, `Entry`, `Stamp`, `Ensure`) | the on-disk stamp shape for a tool — with the aggregate payload stamp shrinking to a small bundle record in the data dir once `suwu-max` is an installer (§7) |
| Bin dir + PATH block | `pkg/maxbundle/path.go` (`EnsurePath`, `RemovePath`, `rcTargets`) | `# >>> suwu-max >>>` block machinery, bash/zsh/fish/profile targets, backups, idempotency — repointed at `~/.local/bin` (§7.2) |
| Locking | `pkg/maxbundle/lock_unix.go` | one writer at a time across `~/.suwu/bin` **and** `~/.local/bin/suwu` (needs exporting, §6.4) |
| Server API shape | `pkg/server/background.go`, `extension.go`, `server.go` | `GET /api/…` authenticated list handlers, `validateRequest`, `writeJSON` |
| Settings UI | `frontend/src/components/dialogs/AppSettingsView.tsx` | tab/section idiom, `TerminalTheme`-style row components, i18n under `settings.*` |
| Pinned versions to seed the catalog | `scripts/max-tools.json`, `pkg/herdr/herdr-core-lock.json` | every entry with a real, current URL + sha256 |

That last row also names a problem this plan fixes: **three pin files whose
versions drift** (`max-tools.json`, `herdr-core-lock.json`, and the release
workflow). §4 makes the catalog the single source.

---

## 3. Scope

### In scope (v1)

- `tools/catalog.json` in the Suwu repo: schema, seeds for `rg`, `fzf`, `asdf`,
  `witr`, `pig`, `herdr`, `herdr-core`, an update procedure, and a CI check that
  every URL answers and every sha256 matches.
- `pkg/tools`: catalog parse/validate/lookup, per-platform resolution,
  install/update/uninstall against a bin dir, stamps.
- Server endpoints `GET /api/tools`, `POST /api/tools/install`,
  `POST /api/tools/uninstall`, `POST /api/tools/setup` (optional per-tool shell
  integration), plus a bin-dir aware `PATH` for PTY sessions and for the server's own
  `exec.LookPath` calls.
- `suwu exec <name> [args…]`, `suwu tools list|install|update|remove`,
  `suwu tools path` (always on; re-asserts the block).
- Tools page (top-level menu, above System Settings): catalog list, per-platform availability,
  installed/update/bundled states, install & update & uninstall, the PATH
  notice for the always-on PATH block, plus explicit add/remove for fzf and asdf shell setup.
- Precedence rules with `suwu-max` (§7) so a seeded tool and an installed tool
  cannot silently fight over `~/.suwu/bin`, and the wrapper's move to
  `~/.local/bin/suwu` does not turn into a second source of `suwu` binaries.
- Docs: `README.md` feature line, website `suwu-cli` page (`exec`, `tools`),
  `docs/` note, release notes.

### Out of scope (v1)

- Unverifiable downloads: **no sha256 for the current platform ⇒ the tool is
  not installable on it** (fail closed; see §5.5).
- A third-party catalog, or per-user catalogs. `--repo`/`--ref` exist internally
  (they already do in `pkg/install`) but the UI never exposes them.
- Background/tile plugins, themes, or arbitrary GitHub zips.
- Servers without outbound HTTPS: the page must degrade honestly
  ("catalog unavailable, showing installed tools only").
- Windows (`suwu` does not support it yet), BSDs, and 32-bit.

---

## 4. The catalog

### 4.1 One file, not a tree walk

`suwu install` walks a GitHub tree because a background is a *directory* of
files. A tool is a *list of pinned downloads*, so one manifest is the honest
shape — and it is what `scripts/max-tools.json` already is, one level short.

```
tools/catalog.json          # new, the single source of truth
pkg/herdr/herdr-core-lock.json   # retired, folded into the catalog
scripts/max-tools.json      # retired, folded into the catalog
```

`scripts/build-max.sh` and `scripts/fetch-herdr-core.sh` read the catalog and
select `bundled: "max"` / `bundled: "hcbin"` entries for the target platform.
The catalog therefore ships in the repo (the builder needs it offline) *and* is
served from `raw.githubusercontent.com/liyu1981/suwu/<ref>/tools/catalog.json`
for the running server to read.

Ref choice: **the running server's own version tag** (`vX.Y.Z`), falling back to
`master`. A catalog is a data file, not code: pinning it to the release means a
user can never be offered a tool version that did not exist when their binary
was built, and `master` is the escape hatch for development (`SUWU_TOOLS_REF`).

### 4.2 Schema

A superset of `max-tools.json` + `maxbundle.Entry`, so the builder, the
installer and the stamp all speak one vocabulary:

```jsonc
{
  "schema": 1,
  "updatedAt": "2026-11-22",
  "tools": [
    {
      "name": "rg",                       // ^[a-z0-9][a-z0-9_-]{0,63}$, also the binary name
      "label": "ripgrep",
      "version": "15.2.0",
      "summary": "Recursive search, used by file search and by agents.",
      "homepage": "https://github.com/BurntSushi/ripgrep",
      "license": "MIT OR Unlicense",
      "requires": [],                     // display-only prerequisites, e.g. ["node >= 20"]
      "bundled": "max",                   // "max" | "hcbin" | absent (catalog-only)
      "platforms": {
        "linux-amd64": {
          "archive": "tar.gz",            // tar.gz | tar.xz | zip | none
          "url": "https://github.com/…/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz",
          "sha256": "33e15bcf…",
          "strip": 1,                     // path components to drop from the archive root
          "entries": [                    // files this tool owns, relative to the bin dir
            { "file": "rg", "mode": "0755" },
            { "file": "rg.1", "mode": "0644" }
          ]
        },
        "linux-arm64": { … },
        "darwin-arm64": { … }
      }
    }
  ]
}
```

Notes that matter:

- **`platforms` is a map keyed `<goos>-<goarch>`**, not "assets per arch", so a
  Linux-only tool (`witr`) simply has no `darwin-*` key and the page greys it
  out with "not available for macOS" instead of downloading something wrong.
- **`entries` is the ownership list.** It is what makes uninstall safe (§5.4),
  what the stamp records, and what `suwu-max` checks before overwriting (§7).
  `mode` is an octal string like the existing `maxbundle.Entry`.
- **`strip`** covers archives whose payload sits one directory down
  (`ripgrep-15.2.0-x86_64…/rg`); `install`'s payload-root logic is not usable
  here because we are extracting *files*, not a directory.
- Optional `docs` (man pages) and `notes` (a one-line UI hint) as in
  `max-tools.json` today.

### 4.3 Validation, and who enforces what

`pkg/tools` validates on load and refuses the whole catalog when a tool is
malformed (bad name, no `platforms`, non-https URL, missing sha256, duplicate
`name`, or two tools claiming the same owned file). A refusal is loud in the UI
and in `suwu tools list`, never silently skipped.

A CI job (`scripts/check-tools-catalog.mjs`, run from `pnpm check`) does what a
server cannot: for each new/changed entry, `HEAD` the URL and, once a week,
download and verify the sha256 for the host platform. That is how a tool
version gets bumped: change the catalog, CI proves the pins, a release carries
it.

### 4.4 Cache and offline

Same rules as `pkg/install` §6.3, one cache file:
`<dataDir>/cache/tools-catalog.json` + ETag, reused 6 h, `--refresh` (CLI) or
"refresh" (page) bypasses, network failure serves the stale copy marked
`stale: true`, and no cache at all means the page shows installed tools only
with a plain explanation.

---

## 5. Installing a tool

### 5.1 Where things land

```
~/.suwu/bin/rg                       # the tool, executable, flat
~/.suwu/bin/rg.1                     # its extra files (if the entry lists them)
~/.suwu/bin/.tools/rg.json           # stamp: version, platform, sha256, origin, files, at
~/.suwu/bin/.tools/.lock             # install lock (shared with suwu-max)
```

Flat, because that is what `suwu-max` already produces and what `PATH` expects.
The `.tools/` directory is metadata and is never on `PATH` (dot-prefixed, and
`PATH` entries that are dotted are a convention we can also just not create).

The app is *not* a tool: nothing here writes `~/.local/bin/suwu`, and
`suwu tools remove` cannot reach it (§7.1 says who owns it).

### 5.2 The sequence

1. **Resolve** `name` → catalog entry → `platforms[goos-goarch]`. Absent ⇒
   "not available on this platform", no network.
2. **Compare** with the stamp. `installed` / `update` / `conflict` (a file of
   that name exists with no stamp — a hand-installed copy; see §5.4).
3. **Download** to `<dataDir>/tmp/tool-<name>-<rand>` with a per-file cap
   (128 MiB, far above the ~30 MiB of the biggest tool today), a total cap, and a
   two-minute budget.
4. **Verify** the sha256 while streaming; a mismatch deletes the temp file and
   aborts with the expected/actual pair (the only failure worth showing the
   digest for).
5. **Extract** the requested `entries` out of the archive (§5.3), not the whole
   archive.
6. **Stage → commit.** Everything is written into
   `~/.suwu/bin/.stage/<name>-<rand>/`, then each entry is `rename`d into place
   one at a time, keeping `<file>.bak-<stamp>` until the last one lands (so a
   failed commit can be rolled back). The stamp is written last: **a stamp
   always describes a complete install.**
7. **Report** `{name, version, files, replaced}`.

### 5.3 Extraction rules

Reuse the `pkg/install` guard list verbatim — regular files only, no symlinks,
no absolute or `..` paths, no backslashes, declared *and* actual size caps,
entry cap, dirs `0755`, files the catalog's `mode` but never setuid/world-
writable, refuse to write through a symlink — with tar-specific additions:
reject hard links and character/block devices, reject PAX extended-header
tricks that rename an earlier entry, and reject an archive whose member count
exceeds the cap before reading any payload. A `none` archive is a bare binary:
verify the sha256 and `chmod`.

Only entries named in the catalog are written. An archive that also carries a
`completions/` tree installs exactly what the catalog says and nothing else —
"extract only what you declared" is the cheapest way to keep a rogue archive
from decorating `~/.suwu/bin`.

### 5.4 Uninstall, and what we refuse to touch

`suwu tools remove <name>` deletes exactly the stamp's `files`, then the stamp.
It refuses when a file is not owned by that stamp (someone replaced it) and it
never deletes the bin dir itself. A name with files but no stamp is reported,
not removed (`rm` is the user's decision, and the page says so). A tool whose
stamp says `origin: "suwu-max"` *can* be removed — under the new bundle model
the wrapper only seeds what is missing, so removing one is a real decision and
the page confirms it with "re-running suwu-max will put it back".

### 5.5 Failure modes the UI must state plainly

| Case | Behaviour |
| --- | --- |
| No network | "catalog unavailable — showing installed tools", install disabled |
| No sha256 for this platform | row shows "not installable here", no button |
| sha256 mismatch | install fails, digest pair shown, nothing on disk changed |
| Disk full / permission denied | install fails, stage removed, previous version intact |
| Another install running | 409 "an install is already running", one at a time |
| Archive has extra/unknown members | ignored with a note, declared entries installed |

### 5.6 The embedded path — one installer, two sources

The bundle must not grow a second extractor. `pkg/tools` therefore exposes the
download step and everything after it separately:

```go
InstallFromURL(ctx, entry, platform)      // fetch → verify → extract → commit
InstallFromReader(entry, platform, r, n)  // payload already in hand: verify → …
```

`suwu-max` calls `InstallFromReader` once per embedded tool archive, so the
bundle inherits the same staging, the same hostile-archive guards, the same
stamps and the same uninstall bookkeeping as a page install — it just skips the
network and the platform resolution (the payload is built for one platform).
The single difference that remains is the stamp's `origin: "suwu-max"`, which is
what the precedence rule in §7 compares.

---

## 6. PATH, the three layers

### 6.1 Layer 1 — the server process, so everything it spawns inherits it

At startup (`suwu serve`), prepend `~/.suwu/bin` to the process `PATH` if the
directory exists, once, with a log line at `-v`. That single change covers:

- **PTY sessions** (`pkg/pty.StartWithCWD` inherits `os.Environ()`), so a user's
  shell inside Suwu finds `rg`, `fzf`, `pig`, `herdr` without an rc block;
- **the server's own `exec.LookPath` calls** — `rg` for `/api/files/search`
  stops reporting "not installed" the moment the tool lands;
- **git and hooks** (`gitEnv()` in `pkg/server/git.go` prepends user tool dirs),
  where `.suwu/bin` is also added to `userToolDirs` so a minimal systemd `PATH`
  cannot hide it.

No rc file is touched for this layer: it is scoped to Suwu's own children, which
is the polite amount of surprise.

### 6.2 Layer 2 — `suwu exec <name>`

Strict by construction: it resolves **only** `~/.suwu/bin/<name>`, executes it
with `argv[0]` = the tool name, the caller's argv/cwd/env, and `PATH` prefixed
by the bin dir (so a tool that shells out to its siblings finds them), forwards
signals, and returns the child's exit status. Missing tool ⇒ exit 127 with
`suwu tools install <name>` in the message. `--system` opts back into
`exec.LookPath`.

Flags: `--list` (installed tools + versions, one per line, machine-readable),
`--path [name]` (print the resolved path), `--system`, `--` for arguments that
look like flags. Why strict: agents and extensions call this, and "which rg did
I get" must never depend on the user's `PATH` order.

### 6.3 Layer 3 — the rc block, always on

For shells the user opens outside Suwu, Suwu keeps a managed block in the rc
files that already exist (bash, zsh, fish, profile — reuse `rcTargets`), after
backing each file up once. It is written at startup and after every install:
the tool directory is part of the product, not an option:

```sh
# >>> suwu-bin >>>
case ":$PATH:" in *":$HOME/.suwu/bin:"*) ;; *) export PATH="$HOME/.suwu/bin:$PATH" ;; esac
# <<< suwu-bin <<<
```

Distinct markers from `suwu-max`'s block (so each can remove its own), guarded
against a duplicate entry and idempotent. `suwu tools path` re-asserts and
prints the block. Since the `suwu-max` installer now puts `~/.local/bin` — not
this directory — on the user's PATH (§7.2), the two blocks do not overlap.

### 6.4 The lock

`~/.suwu/bin` and `~/.local/bin/suwu` now have several writers: this installer,
the `suwu-max` payload extraction, and `suwu upgrade` (which replaces
`os.Executable()` in place). Exactly one of them may run at a time, so the flock
helper moves out of `pkg/maxbundle` into a small `pkg/bindir` that owns:

- the bin-dir path (`~/.suwu/bin`, overridable for tests and for `SUWU_BIN_DIR`),
- the lock file (`<dataDir>/bin.lock`, taken by all three writers),
- the stamp paths (`.tools/<name>.json`, `.tools/` as metadata, `.stage/`).

`suwu-max` keeps its shape — lock, check stamps, extract what is missing,
unlock — and `suwu upgrade` takes the lock for the duration of the binary
rename, which is the window where a concurrent `suwu-max` could otherwise
replace the file under it.

---

## 7. `suwu-max`: a bootstrap, and who owns what

`suwu-max` is changing shape. Instead of a launcher that extracts a payload into
`~/.suwu/bin` and `exec`s `~/.suwu/bin/suwu` on **every** run, it becomes a
one-shot installer:

```
suwu-max [serve --env-file .env]
   ├─ write   ~/.local/bin/suwu          the real app (0755, atomic rename)
   ├─ install ~/.suwu/bin/<tool> …       each embedded tool, one stamp each
   ├─ ensure  ~/.local/bin on PATH       managed rc block, or "already there"
   └─ exec    ~/.local/bin/suwu <argv>   from now on, this is just suwu
```

After that first run the wrapper is out of the picture: what runs is the normal
app, `suwu upgrade` replaces `~/.local/bin/suwu`, and `suwu-max` is needed again
only to re-seed tools on a new machine (or after `--force`).

Four things follow, and each one deletes work this plan would otherwise do:

| Consequence | What it changes here |
| --- | --- |
| The app has one canonical path, `~/.local/bin/suwu` | `suwu upgrade` (which already rewrites `os.Executable()` in place) and `suwu-max` write the *same* file, so "which suwu am I running" has one answer. No `suwu` entry in the catalog, no launcher special case in the app's hot path |
| The bundle stops being a runtime layer | No `exec` per invocation, no `SUWU_MAX=1`/`SUWU_BIN` plumbing, nothing in the app needs to know the wrapper ever existed |
| Tools come out of the shared installer | `suwu-max` hands each embedded archive to `tools.InstallFromReader` (§5.6) instead of its own `Ensure`/`promoteEntries`: one extractor, one stamp format, one hostile-archive suite. The bundle is then "an offline install from a frozen catalog" |
| Stamps become comparable | A bundled tool records `origin: "suwu-max"` in the same `~/.suwu/bin/.tools/<name>.json` that a page install writes, so the page can say `bundled by suwu-max · 15.2.0` and precedence is one comparison. The old aggregate `.suwu-max.json` shrinks to a bundle record beside the app's metadata (`<dataDir>/maxbundle.json`: `bundleVersion`, the app path and version it wrote) for `--version` and `--force` — the per-tool truth lives in the tool stamps |

What this plan must therefore pin down is narrow: two programs write
tool binaries, one program writes the app, and none of them may surprise the
others.

### 7.1 Precedence: an explicit install beats the bundle

| Situation | Winner | What the page / CLI says |
| --- | --- | --- |
| Only bundled (`origin: "suwu-max"`) | bundle | `bundled by suwu-max · 15.2.0`, "install" hidden, "update" hidden |
| Bundled, then installed or updated by us | **ours** (`origin: "tools"`) | `15.2.2 · installed here` |
| Ours, then `suwu-max` runs again | **ours** — the extraction skips any name whose stamp says `origin: "tools"` and prints one line per skipped tool | `suwu-max: skipped rg (installed here: 15.2.2)` |
| No stamp, file present | nobody | `unmanaged file in ~/.suwu/bin`, actions disabled, hint to remove it |
| `suwu-max --force` | bundle | force means force; the skipped tools' stamps are replaced so the recorded state is not a lie afterwards |

One sentence: **an explicit install beats the bundle until the user forces a
re-seed**, and every skip is printed rather than hidden. The same rule keeps a
`suwu upgrade` from being overwritten by an old bundle: the app is written only
when `suwu-max` is run deliberately, never as a side effect of starting a tool.

### 7.2 PATH migration for existing users

Today's `# >>> suwu-max >>>` block adds `~/.suwu/bin` to the user's PATH. Under
the new model the wrapper only needs `~/.local/bin` there — that is where `suwu`
lives — while `~/.suwu/bin` is reached through `suwu exec` and the server's own
environment (§6.1, §6.2). So the next `suwu-max` run:

1. keeps a block that adds `~/.local/bin` when that directory is not already on
   PATH, and removes the block when it is;
2. drops the `~/.suwu/bin` line from its own block in either case:
   the directory is no longer something a login shell needs;
3. says what it changed (`~/.bashrc: added ~/.local/bin`, or
   `~/.zshrc: already on PATH, removed the suwu-max block`).

Anyone who wants `rg` and friends in their interactive shell flips the *tools*
block (§6.3), which is written automatically as `# >>> suwu-bin >>>`. The two
blocks now point at different directories, so the dedupe problem the first draft
of this plan worried about simply does not arise — but the migration does have to
be explicit, because a stale block is invisible until someone wonders why `rg`
vanished from their shell.

---

## 8. Server API

All under the existing token check (`validateRequest`), JSON in/out,
`writeJSON` errors shaped like the rest of `/api/*`.

```
GET  /api/tools
  → { os, arch, binDir,
      source: { repo, ref, fetchedAt, stale },
      path:   { enabled, files: ["/home/u/.bashrc"], via: "tools"|"max"|"" },
      tools: [ { name, label, version, summary, homepage, license, requires,
                 bundled, state: "installed"|"update"|"missing"|"unsupported"|"unmanaged",
                 available: { version, archive, url } | null,
                 installed: { version, origin, installedAt, files } | null } ] }

POST /api/tools/install     { name, refresh? }  → { name, version, files }      (200)
POST /api/tools/uninstall   { name }            → { name, removed: [files] }     (200)
POST /api/tools/setup       { name, enabled }   → { name, enabled, files, … }    (200)
POST /api/tools/refresh                         → { source }                     (200)
```

- **Synchronous in v1.** The largest tool today is a few tens of MiB; a blocking
  POST with the client's own spinner is simpler than a job queue, and the server
  already holds similar requests (update/upgrade). If a tool grows past that,
  add `GET /api/tools/events` (SSE) later — the installer already has one
  progress callback to hang it on.
- **Errors**: `400` bad name/shape, `404` unknown tool or not on this platform,
  `409` unmanaged file or install already running, `502` upstream download /
  checksum failure (with `expected`/`actual`), `503` no catalog available.
- Downloads happen **in the server process**, never in the browser: the browser
  cannot write `~/.suwu/bin`, and a proxy that allows `/api/*` should not have
  to allow `github.com`.

---

## 9. Tools (top-level menu)

A new section in System Settings next to Fonts/Theme/Backgrounds, rendered by
`frontend/src/components/dialogs/SystemToolsView.tsx`, following the tile type
scale (Heading 16, Label 12, Caption 11) and the existing row idiom.

```
┌ Tools ─────────────────────────────────────  ~/.suwu/bin  [refresh] ┐
│ ripgrep        15.2.0 · MIT OR Unlicense      [read the source]      │
│ Recursive search, used by file search…              [Install]        │
│ fzf            0.74.5 · MIT                   ✓ installed in 0.74.5  │
│ …                                                                   │
│ pig            0.5.3 · MIT                    ↑ 0.5.4 available      │
│ needs node >= 20                                       [Update]      │
│ herdr          0.9.5 · Apache-2.0             bundled by suwu-max    │
│ witr           0.3.4 · Apache-2.0             not available on macOS │
│                                                                     │
│ ~/.suwu/bin is always on your shell PATH   bash, fish                  │
│   writes a small block in ~/.bashrc — preview                          │
└──────────────────────────────────────────────────────────────────────┘
```

- **One row per catalog entry**, in catalog order, with the platform and
  installed states of §7; unsupported rows are visibly inert rather than
  hidden (so a user knows the tool exists and why it is not offered).
- **Install/update/uninstall** call the endpoints above and re-render from a
  fresh `GET /api/tools`; no optimistic state, because the truth is on disk.
- **The PATH notice** names the files Suwu keeps the block in (a
  always-on notice naming the files it is written to). The optional fzf/asdf
  shell setup has its own add/remove button and shows the line it writes.
- **Empty/offline/error states** are first-class: "no catalog (offline) —
  installed tools: rg 15.2.0", "the catalog lists no tools for this platform".
- i18n under `tools.*` in `en.json` + `zh_CN.json`; every string in both files
  (the `check-i18n` script enforces it).
- The page is server-state, not an atom: opening it refetches, like the
  backgrounds/extension lists do today, so a CLI install shows up on reopen.

---

## 10. Security summary

| Risk | Mitigation |
| --- | --- |
| Malicious catalog (compromised ref, PR) | https-only URLs, name/entry validation, ownership collisions rejected, catalog pinned to the release tag, sha256 mandatory |
| Malicious archive | §5.3 guard list; only declared entries extracted; caps on size and count |
| MITM / swapped asset | sha256 from the catalog, compared before anything is written |
| Path traversal from archive or catalog | same `ensureWithin`-style containment check, re-walked after staging |
| Symlink attacks on the bin dir | `Lstat` before every write, never write through a link, `.stage` inside the bin dir |
| Privilege | never root: the whole feature is user-scoped by design; a failed write is an error, not an escalation |
| Token leakage | `SUWU_GITHUB_TOKEN` used only for `api.github.com`/`raw.githubusercontent.com`, never logged, never sent to the browser |
| Supply chain of the tools themselves | we publish the exact URL, sha256, version and license for each entry; the page links the upstream repo so the pin is checkable |

---

## 11. Tests and checks

- `pkg/tools`: catalog parse/validate (unknown platform, missing sha, duplicate
  name, colliding `entries`, non-https URL); resolve per platform; stamp
  round-trip; uninstall ownership refusals.
- `pkg/tools` extraction: the hostile-archive suite from `pkg/install`, plus
  tar-specific cases (hard link, device, PAX rename, member-count bomb, `strip`
  off-by-one).
- Install e2e against `httptest`: first install, update, downgrade warning,
  sha mismatch leaves the old binary byte-identical, interrupted install leaves
  no stamp, concurrent installs 409.
- `suwu-max` interaction: a seeded tool records `origin: "suwu-max"`; a later
  page install replaces it with `origin: "tools"`; a second `suwu-max` run
  skips it and prints one line; `--force` overwrites and rewrites the stamp; the
  app lands at `~/.local/bin/suwu` with `0755` through an atomic rename, and a
  second run does not rewrite a newer app.
- PATH migration: an old `# >>> suwu-max >>>` block that only adds `~/.suwu/bin`
  becomes a `~/.local/bin` block (or disappears when that path is already
  present), leaves `# >>> suwu-bin >>>` alone, and is idempotent on a second run.
- Locking: a page install and a `suwu-max` run against the same bin dir cannot
  interleave (one wins, the other reports "an install is already running");
  `suwu upgrade` takes the lock for its rename window.
- Embedded path: `InstallFromReader` over a real bundled archive produces a
  byte-identical result to `InstallFromURL` over the same URL (`sha256` and the
extracted file list compared).
- PATH: enable/disable/again on temp `$HOME` for bash/zsh/fish, no duplicate
  entries, `suwu-max` block not doubled, backups created once.
- `suwu exec`: managed wins over a `PATH` copy, missing ⇒ 127 with the hint,
  exit status and signals pass through, `--path`/`--list` output.
- Server: `/api/tools` shapes per state, auth required, 409/502/503 mappings,
  path traversal in a name rejected.
- `frontend/scripts/check-tools.mjs`: the page calls only the four endpoints,
  i18n keys exist in both locales, no `~/.suwu/bin` string hard-coded in the UI
  (it comes from the server).
- `scripts/check-tools-catalog.mjs`: schema valid, every platform asset
  reachable, sha256 matches (network-marked, so CI can run it nightly rather
  than per PR).

---

## 12. Delivery phases

| Phase | Work | Done when |
| --- | --- | --- |
| P0 — bundle split (separate change, prerequisite for P6) | `suwu-max` writes `~/.local/bin/suwu` + per-tool payloads and execs the app; its PATH block repointed at `~/.local/bin`; stamps moved to `.tools/` | `suwu-max` run once leaves a normal `suwu` install; a second run is a no-op except for missing tools; `suwu upgrade` still works afterwards |
| P1 — catalog + pins | `tools/catalog.json`, schema validation, `check-tools-catalog.mjs`, fold `max-tools.json` and `herdr-core-lock.json` into it, teach `build-max.sh`/`fetch-herdr-core.sh` to read it | a release builds from the catalog alone; CI proves every pin; no duplicated version numbers in the tree |
| P2 — `pkg/tools` core | catalog load/cache, platform resolution, `InstallFromURL` + `InstallFromReader`, stamp, install/update/uninstall, shared `pkg/bindir` lock | unit + httptest suites green; hostile-archive cases covered; one extractor, no second one in `pkg/maxbundle` |
| P3 — CLI | `suwu exec`, `suwu tools list/install/update/remove/path`, help text, exit codes, non-TTY behaviour | `suwu exec rg --version` works on a machine with no system rg; `suwu tools path` is idempotent |
| P4 — PATH layer 1 | server startup prepends the bin dir; `userToolDirs` gains `.suwu/bin`; PTY env test | `/api/files/search` succeeds right after `suwu tools install rg`, with the server untouched otherwise |
| P5 — API + page | four endpoints, `SystemToolsView`, settings entry, i18n (en/zh), manual states (offline, unsupported, update, unmanaged) | every state of §9 rendered from a mocked server in a headless check; install from the page lands a stamped binary |
| P6 — precedence + docs | skip-on-`origin: "tools"` in the bundle extraction, `--force` override, `suwu upgrade` lock, PATH migration of the old block, website `suwu-cli` + README + release notes | a `suwu-max` re-run over a tool-installed `rg` prints one skip line and leaves the file alone; the docs no longer describe a launcher |

Suggested order is exactly the table, with one caveat: **P0 belongs to the
`suwu-max` work, not to this plan** — but P2 must expose `InstallFromReader` and
the `.tools/` stamp before P0 can land, so in practice P1→P2 land first and P0
follows immediately. P1 alone already removes the pin drift that is in the tree
today.

---

## 13. Decisions to confirm

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Catalog location/shape | `tools/catalog.json`, one manifest, single source for the builders too |
| D2 | Ref the server reads | `master` (the raw GitHub copy), `SUWU_TOOLS_REF` for dev |
| D3 | Fail closed on a missing sha256 | yes — an unpinned asset is not installable |
| D4 | `suwu exec` resolution | managed-only, `--system` to opt out (predictable for agents) |
| D5 | rc block for `~/.suwu/bin` | always on, page notice, own `# >>> suwu-bin >>>` markers; `suwu-max` no longer adds this dir |
| D6 | Precedence | explicit install beats the bundle; the bundle seeds only what is missing, `--force` overrides |
| D7 | Downloads in the server, not the browser | yes (the browser cannot write the bin dir) |
| D8 | Progress reporting | blocking POST in v1; SSE only if a tool outgrows it |
| D9 | Initial catalog contents | the six bundle tools + `herdr-core`; nothing new until the plumbing is proven |
| D10 | `~/.suwu/bin` vs a new dir | reuse it — the bundle already targets it, so bundle users get the feature for free |
| D11 | Who owns `~/.local/bin/suwu` | `suwu-max` writes it once, `suwu upgrade` thereafter; both under the same lock, and the wrapper only writes when the app is missing or `--force` |
| D12 | The old `suwu-max` PATH block | rewrite it on the next wrapper run (drop `~/.suwu/bin`, add `~/.local/bin` only if needed), printing what changed |

## 14. Open questions

1. **Does the catalog belong in the release artifact too?** Embedding
   `tools/catalog.json` with `go:embed` would let an offline server show the
   list (greyed, uninstallable). Cheap, and it makes the page useful on an
   air-gapped box — worth doing if the file stays small. The `suwu-max` payload
   is already a frozen copy of the same catalog, so the embed is only interesting
   for the plain binary.
2. **Tool versions vs. Suwu versions.** Should a release *require* a minimum
   `rg` (e.g. for `--json` output the file search already parses)? A
   `minimum` field per consumer is tempting; v1 just documents the version
   each feature needs.
3. **Is `suwu-max` still the recommended install path?** With the wrapper now
   writing a normal `~/.local/bin/suwu`, it is a bootstrap: `suwu-max` once, then
   `suwu upgrade` forever. That also makes "grow `suwu-max` to macOS" a much
   smaller question — the payload is the app plus a few darwin-capable tools —
   but the catalog already solves macOS for a user who installs `suwu` by
   hand, so it can stay Linux-only for now.
4. **Should the wrapper tell the user it stays behind?** It must remain
   installed to re-seed tools; the docs should say so in one line rather than
   leaving `suwu-max` looking like a tidiness problem.
5. **Man pages.** `rg.1` etc. land in `~/.suwu/bin`, which `man` does not read.
   Install them under `~/.suwu/share/man/man1` and tell the user the
   `MANPATH` line, or drop the `docs` field from v1?
6. **Agents as consumers.** `cmd/Suwu/agent_skill.md` should mention
   `suwu exec`; the tools page is also the natural place for "what the agents
   need", which may be a `requires`-driven "install what's missing" button.

---

## 16. What shipped

| Phase | Status | Notes |
|---|---|---|
| P0 — bundle split | done | `suwu-max` is a bootstrap: app to `~/.local/bin`, tools to `~/.suwu/bin` through `pkg/tools`, manifest schema 2 (`app` + per-tool `files`), record in `<dataDir>/maxbundle.json`, PATH block repointed and the old one migrated |
| P1 — catalog + pins | done | `tools/catalog.json` (schema 1, seven tools, four platforms where the vendor ships them), embedded by `tools/catalog.go`, validated by `pkg/tools` and `check-tools-catalog.mjs`; `scripts/max-tools.json` and `pkg/herdr/herdr-core-lock.json` are gone |
| P2 — `pkg/tools` core | done | `pkg/bindir` (paths, one flock, marker-parameterised PATH blocks) + catalog, source/cache, extraction, install/update/uninstall, stamps, status |
| P3 — CLI | done | `suwu tools list|install|update|remove|path`, `suwu exec` (`--list`, `--path`, `--system`, `--`), help text, exit codes 0/1/64/127 |
| P4 — PATH layer 1 | done | `suwu serve` prepends `<dataDir>/bin` to its own PATH; `userToolDirs` gained `.suwu/bin` |
| P5 — API + page | done | four endpoints + refresh, `SystemToolsView` tab under System Settings, en/zh strings, `check-tools.mjs` |
| P6 — precedence + docs | done | bundle skips tools whose stamp says `origin: tools` (`--force` overrides), `suwu upgrade` takes the same lock, README/website/agent skill updated, `SUWU_MAX_PLAN.md` marked superseded |

Deviations from the plan, and why:

- **`InstallFromFiles` replaced `InstallFromReader`.** The bundle unpacks one
  tarball into a staging directory and verifies the manifest's per-file sha256
  before handing each tool over, which is the same order the download path uses;
  an `io.ReaderAt` variant would have re-implemented that verification for no
  gain. The security property in §5.3 (only declared entries are written) is the
  same, because both paths funnel through `writeEntry` and `verifyStage`.
- **`pkg/bindir`, not `pkg/maxbundle`, owns the PATH machinery.** Two block
  markers have to coexist in one rc file, so `Block` carries its own markers and
  backup tag; `pkg/maxbundle.EnsurePath`/`RemovePath` remain as wrappers so the
  old tests still pin the behaviour.
- **The catalog is keyed `<goos>-<goarch>`** (not per-arch maps) and omits
  platforms a vendor does not build for (`witr` is Linux-only). That is what lets
  the page show "not for this device" instead of a dead button.
- **Ref selection defaults to `master`**, with `SUWU_TOOLS_REF` for development.
  Reading the build's own tag was tried first, but a tag cut before
  `tools/catalog.json` existed has no catalog at all, so that build stayed stale
  forever — even on Refresh. The maintained copy in `master` is the useful source.
- **No SSE.** Installs are synchronous POSTs; the largest tool is a few tens of
  MiB. The installer still carries a progress callback
  (`tools.Options.Progress`), so adding `/api/tools/events` later is additive.
- **`suwu exec` is strict by default** and `--system` is the opt-out, as
  recommended in D4.

Left to do by hand: a visual pass over the Settings › Tools page in a browser
(the page is type-checked, lint-checked and exercised through its API, but not
yet looked at), and the `suwu-max` release itself — the bootstrap is built and
verified locally, but a tagged release is what puts it in users' hands.
