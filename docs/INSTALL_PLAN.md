# `suwu install` — Feature Plan

> **Status:** **Phases 1–5 implemented.** Phases 1 (rename), 2 (`pkg/install`
> core + zip), 3 (GitHub catalog), 4 (CLI + TUI) and 5 (docs) have landed; §12
> records what shipped and §14 what was left out.
> **Goal:** one front door for putting a background or an extension into a Suwu
> data directory — from the first-party GitHub catalog, from a zip file, or
> from an interactive picker — plus the data-dir rename that makes the two
> trees read the same.

Companion docs: `docs/EXTENSION_TILE_PLAN.md` (what an extension is),
`docs/EXTENSION_API_PLAN.md` (metadata and the API/static contract),
`docs/WEBGPU_BACKGROUND_EXTERNALIZATION_PLAN.md` (what a background directory
must contain).

---

## 1. Goal

```sh
suwu install                       # TUI: pick backgrounds and extensions
suwu install --github              # TUI, fed by the GitHub catalog
suwu install --extension eye.zip   # install one extension from a zip
suwu install --background rain.zip # install one background from a zip
```

and one consistency fix underneath it:

```
<dataDir>/extensions/<id>/…      →   <dataDir>/extension/<id>/…
<dataDir>/background/webgpu/<id>/…  (unchanged)
```

`extension` (singular) matches `background` (singular) and matches the zip
layout the user specified, so "the tree inside the zip" and "the tree in the
data dir" are the same string.

Today installing anything means hand-writing a `cp -r`. That is fine until you
have six backgrounds and three extensions, and it is how the wrong path gets
pasted in the first place.

---

## 2. Scope

### In scope (v1)

- `suwu install` with a `huh` TUI (kind → items → overwrite confirm), reusing
  `tuiTheme()` so it is legible on 16-color and monochrome terminals.
- `suwu install --github` — enumerate `examples/extension/<id>/` and
  `examples/background/webgpu/<id>/` in the first-party repo, show real labels
  and descriptions, download only the selected directories.
- `suwu install --extension <zip>` / `suwu install --background <zip>` —
  extract, validate, and install one archive.
- Non-interactive equivalents for every mode (`--list`, positional ids, `--all`,
  `--kind`), so scripts and agents can use it without a TTY.
- Zip extraction hardened: no zip-slip, no symlinks, no absolute paths, no
  bombs, normalized permissions, single-payload-root enforcement.
- Post-install validation by **reusing the server's own resolvers**, so an
  install can never leave a half-valid directory behind.
- The data-dir rename with a legacy read-path (`extensions/`) so existing users
  keep working.
- Docs sweep: `examples/extension/README.md`, the website docs, `suwu help`.

### Out of scope (v1)

- **Signing / provenance.** No checksums, signatures, or mirrors. §10 says why
  that is acceptable for the first-party catalog and what we print for a
  third-party zip instead.
- **Uninstall / update.** `suwu remove` and `suwu install --upgrade` are a
  follow-up (§12); `--force` covers the v1 upgrade story.
- **Installing plugins or themes.** The generic "install anything from GitHub"
  shape is deliberately not built yet — see §12.
- **Progress bars for large downloads.** The catalog items are tens of files
  and hundreds of KiB; plain per-file lines are honest and simple.

---

## 3. Decisions to confirm

| # | Decision | Recommendation |
|---|---|---|
| D1 | Flag spelling | `--background` (the request said `--backgroun`) |
| D2 | Data-dir rename `extensions/` → `extension/` | Yes. Additive on the read side (§4) |
| D3 | Repo examples rename `examples/extensions/` → `examples/extension/` | Done by the user in the working tree (uncommitted) |
| D4 | Legacy `extensions/` handling | Read-only fallback + one-time warning naming the exact `mv`. **No migration tooling** — the user migrates by hand (§4.2) |
| D5 | GitHub source | First-party `liyu1981/suwu` only in v1; `--repo`/`--ref` exist but are documented as advanced |
| D6 | Non-TTY behavior | No TTY + no mode flag → print usage, exit `64` (matches `suwu gq`) |
| D7 | Overwrite | Refuse without `--force`; with `--force`, stage → validate → swap, keeping a `.bak-<stamp>` until the swap succeeds |

---

## 4. The data-dir rename

### 4.1 Current state

| Concern | Where |
| --- | --- |
| Extension root | `pkg/extension/extension.go` `Dir()` → `<dataDir>/extensions` (hard-coded string) |
| Background root | `pkg/background/background.go` `DirName = "background/webgpu"`, `Dir()` |
| Server consumers | `pkg/server/extension.go` `extensionDir()` → `extension.Dir(s.dataDir)`; `pkg/server/background.go` `ListDisk(background.Dir(s.dataDir))` |
| The runner root | `pkg/server/extension.go` passes `--root /ext=<extensionDir>` to `suwu gq` |
| Data-dir default | `~/.suwu`, `SUWU_VAR` override — resolved in `cmd/Suwu/main.go:582` |
| Both registries | Read from disk **per request** (`handleExtensionsList`, `handleBackgroundsList`) — no server restart needed after an install |

### 4.2 Change

```go
// pkg/extension/extension.go
const (
    // DirName is the extension tree below the data dir: <dataDir>/extension.
    DirName = "extension"
    // LegacyDirName is the pre-0.1.12 name, still read but never written.
    LegacyDirName = "extensions"
)

func Dir(dataDir string) string        { return filepath.Join(dataDir, DirName) }
func LegacyDir(dataDir string) string   { return filepath.Join(dataDir, LegacyDirName) }

// ResolveDir returns the directory to read extensions from, preferring the new
// name. legacy is true when it fell back, so the caller can warn once.
func ResolveDir(dataDir string) (dir string, legacy bool)
```

`ResolveDir` is two `os.Stat` calls; `s.extensionDir()` calls it per request,
so it costs nothing and stays correct when an install lands mid-run.

Fallback rules:

- new dir exists **and** has ≥1 valid extension → use it; if the legacy dir
  also exists, log once (server startup + install output) naming the exact
  `mv ~/.suwu/extensions ~/.suwu/extension` command.
- new dir missing or empty, legacy exists → use legacy, warn once.
- neither → use the new path (so `suwu install` creates it).

`suwu install` **never** writes to the legacy path, and **there is no migration
command** — the user moves the directory by hand. The fallback is a
compatibility read-path, not a migration: without it, every install done from
the released docs (`cp -r … ~/.suwu/extensions/`) would silently stop being
listed after an upgrade, which is the one failure mode a rename must not have.

### 4.3 Blast radius

Deliberately small — the string appears in Go, docs, and the example README:

- `pkg/extension/extension.go` — `Dir()`, package doc (`extensions/` → `extension/`).
- `pkg/server/extension.go` — `extensionDir()`; the doc comment on the `--root` flag.
- `pkg/server/extension_static.go` — comment referencing `examples/extensions/…`.
- `pkg/extension/extension_test.go`, `pkg/server/extension_test.go` — fixtures +
  one stale comment (`copy examples/extensions/eye into <dataDir>/extensions`).
- `examples/extension/README.md` — still says `examples/extensions/eye` and
  `~/.suwu/extensions`; both wrong after D2/D3.
- Plan docs that describe the contract: `EXTENSION_TILE_PLAN.md` (§3.1, §6),
  `EXTENSION_API_PLAN.md`, `EXTENSION_TOKEN_SCOPING_PLAN.md`,
  `EXTENSION_SANDBOX_LINKS_ANALYSIS.md`,
  `WEBGPU_BACKGROUND_EXTERNALIZATION_PLAN.md`.
- `website/docs/pages/extensions.content.html` — install instructions (§12).
- `.pi/skills/suwu-tools/SKILL.md` — **does not exist**; the skill source is
  `cmd/Suwu/agent_skill.md` (`//go:embed agent_skill.md`, written by
  `suwu agent`). It documents commands for agents and mentions neither
  extensions nor backgrounds, so the rename does not touch it — but phase 5
  should add a `suwu install` entry so agents can install their own tiles.

**Not affected:** `pkg/server/file_search.go`'s `Extensions []string` is the
*file*-extension search filter, unrelated. `~/.suwu/extensions` is not
referenced by `install.sh` or the systemd unit.

---

## 5. CLI surface

```
Usage: suwu install [flags]

Install backgrounds and extensions into the Suwu data directory
(default ~/.suwu, override with SUWU_VAR). With no flags and a terminal,
an interactive picker lists the first-party catalog from GitHub.

Modes (mutually exclusive):
  (none)                    interactive catalog picker (requires a TTY)
  --github                  the same picker, named explicitly
  --extension <file.zip>    install one extension from a zip archive
  --background <file.zip>   install one background from a zip archive

Catalog flags (with --github or the bare form):
  --kind <extension|background>  restrict the picker to one kind
  --all                          select every item of --kind
  --id <name>                    repeatable; select by id without a TTY
  --list                         print the catalog and exit (no install)
  --repo <owner/name>            source repo (default liyu1981/suwu)
  --ref <ref>                    source ref (default master)
  --token <token>                GitHub token; or $SUWU_GITHUB_TOKEN
  --refresh                      bypass the cached catalog

Common flags:
  --force         replace an existing install of the same id
  --dry-run       show what would be written; change nothing
  --yes           assume yes for the overwrite confirm (TUI only)

Exit codes: 0 ok · 1 install/validation failure · 64 usage error
```

Dispatch: add `case "install"` in `cmd/Suwu/main.go` next to `agent`/`gq`, an
entry in `printUsage`, and a `case "install"` in `printSubcommandHelp` (so
`suwu help install` works, like `suwu help gq`).

`suwu install` is **not** gated on the server running. It is a filesystem
operation against the data dir; the server picks the result up on the next
request.

---

## 6. `--github`: the catalog

### 6.1 Why not the repo tarball

`https://github.com/liyu1981/suwu/archive/refs/heads/master.tar.gz` is simple
but drags in `website/assets/*.mp4` and the built frontend — tens of MiB to
install a 40 KiB background. Instead:

1. **One** `GET https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1`
   → the full path list.
2. Group paths by prefix:
   - `examples/extension/<id>/…` → extension `<id>`
   - `examples/background/webgpu/<id>/…` → background `<id>`
3. For each candidate, fetch **one** manifest
   (`package.json` / `background.json`) from
   `https://raw.githubusercontent.com/{repo}/{ref}/{path}` to learn its display
   name and description. Failures degrade to the bare id — the install path
   validates the real files anyway (§7.3).
4. Download only the selected items' files into the staging dir.

Cost for the whole catalog today: 1 API call + 9 raw calls, ~420 KiB total.

### 6.2 Tree paths are untrusted input

A GitHub tree is attacker-influenced data (a PR, a compromised ref). Every
path from step 1 goes through **the same validation as a zip entry** (§7.2)
before it is used to build a destination path — no absolute paths, no `..`, no
backslashes, no empty segments — and a path that fails is dropped with a
warning, not written. Requests are additionally pinned to
`raw.githubusercontent.com/{repo}/{ref}/` and the payload must stay under the
per-file and total caps.

### 6.3 Catalog cache

`<dataDir>/cache/github-catalog.json` holds the tree-derived catalog plus the
tree `ETag`. Reused for 6 h; `--refresh` bypasses; `--list` may serve a stale
cache when the network fails, marking entries `stale`. Unauthenticated GitHub
allows 60 requests/hour/IP (one per run is fine); `$SUWU_GITHUB_TOKEN` raises
it and is sent only to `api.github.com` / `raw.githubusercontent.com`.

### 6.4 TUI flow

Mirrors `suwu agent` (`cmd/Suwu/agent.go`): `huh.NewSelect` for the kind →
`huh.NewMultiSelect` of items (already-installed ones pre-checked and labelled
`installed`) → `huh.NewConfirm` when anything is being replaced → progress
lines → summary. All forms use `tuiTheme()`.

---

## 7. Zips

### 7.1 Layout contract

| Kind | Canonical zip root | Also accepted |
| --- | --- | --- |
| Extension | `extension/<id>/…` | `extensions/<id>/…`, bare `<id>/…` |
| Background | `background/webgpu/<id>/…` | `webgpu/<id>/…`, bare `<id>/…` |

The canonical prefixes are **derived from the same constants the server uses**
(`extension.DirName`, `background.DirName`) so the contract cannot drift.
Rules:

- The archive must contain exactly **one** payload root after normalization.
  The root directory name is the **id** and must satisfy
  `extension.ValidID` / `background.ValidID` (`^[a-z0-9][a-z0-9_-]{0,63}$`).
- `__MACOSX/**` and `.DS_Store` are skipped (zip round-trips from Finder).
- A zip whose root is missing is a hard error naming the expected layout, with
  a `find`-equivalent hint.
- Nested files under the id are free-form (`public/`, `shaders/`, handlers).

### 7.2 Extraction safety

`archive/zip` gives an attacker the file list, the names, the declared sizes,
and the mode bits. Every one of those is checked:

| Guard | Rule |
| --- | --- |
| Entry kind | Reject anything that is not a regular file or directory: symlink, device, FIFO, socket, irregular |
| Name | Reject absolute paths, `\` separators, volume names, empty or `.`/`..` segments |
| Containment | `filepath.Rel(stage, join(stage, name))` must not start with `..` — the same `ensureWithin` idea as `pkg/extension` |
| Post-walk | Re-walk the staged tree and re-check containment (defends against odd Unicode/normalization surprises) |
| Declared size | Reject an entry whose `UncompressedSize64` exceeds 16 MiB, or when the declared total exceeds 64 MiB |
| Actual size | Copy through `io.LimitReader` per file and a running total counter, so a lying header cannot pass |
| Entries | Cap at 4096 entries |
| Permissions | Ignore the zip's mode bits; write dirs `0755` and files `0644` (never setuid, never world-writable) |
| Target | Refuse if the destination exists as a symlink (`Lstat`), never write through one |

Sizes match the server's own limits (`extensionStaticMaxBody` /
`backgroundStaticMaxBody` are 8 MiB; the per-file cap is deliberately looser at
16 MiB so a future large asset is not rejected, while the total cap still
bounds the work).

### 7.3 Validate, then commit

Both sources (zip and GitHub) fill one staging directory and share the tail:

```
<dataDir>/.install/<kind>-<id>-<pid>/
```

1. Extract/download into the stage.
2. **Validate with the server's resolver** — this is the load-bearing step, and
   it is free:
   - extension: `extension.Resolve(<stage>, id)` — checks `ValidID`,
     containment, a readable/valid `package.json`, and a regular-file `index.js`;
     it also re-validates every `suwu.api` handler path and the `suwu.static`
     subtree rules.
   - background: `background.ResolveDisk(<stage>, id)` — manifest parse plus a
     regular-file `scene.js`.
   A failure aborts with the resolver's own message and removes the stage, so
   nothing partial is ever visible to the server.
3. **Freshness warning** for backgrounds: if a `.wgsl` file has no sibling
   `.shader.js`, warn that the entry shader is uncompiled and the browser will
   fail to import it (the invariant `check-background-shaders.mjs` enforces
   for the repo). Warn, do not fail — a future format change should not brick
   an install.
4. **Commit** into `Dir(dataDir)/<id>`:
   - target missing → `os.Rename(stage, target)` (same filesystem, atomic).
   - target exists and no `--force` → error naming the path.
   - target exists and `--force` → rename the old dir to
     `<id>.bak-<unixstamp>`, rename the new one in, delete the backup; restore
     the backup if the second rename fails.
   - the target's parent is created with `MkdirAll(0755)` if absent.
5. Remove `<dataDir>/.install`.

`--dry-run` runs steps 1–3 in a temp dir under `.install`, prints the resolved
name, file count and bytes, then removes it and exits.

---

## 8. Output

Follows `suwu agent`'s style (`✅` per line, then a short summary):

```
  ✅ extension  eye                ~/.suwu/extension/eye
  ✅ background matrix-rain        ~/.suwu/background/webgpu/matrix-rain

  Installed 2 item(s).

  Reload the Suwu tab to pick them up.
  Extensions: enable the Extension app in the App Menu, then add a tile with id: eye
  Backgrounds: pick one in Settings → Background.
```

`--dry-run` prefixes each line with `would install`. The legacy warning (§4.2)
is printed once at the end when it applies.

---

## 9. Files

### New

```
pkg/install/install.go        # Kind, Plan, Result; staging, validation, atomic commit
pkg/install/archive.go        # zip reading, layout normalization, extraction guards
pkg/install/catalog.go        # GitHub tree + raw download + cache
pkg/install/install_test.go   # staging/commit/overwrite/dry-run
pkg/install/archive_test.go   # every hostile-zip case
pkg/install/catalog_test.go   # httptest tree + raw fixtures
cmd/Suwu/install.go           # subcommand, flags, huh forms, output
cmd/Suwu/install_test.go      # flag parsing, non-TTY behavior, exit codes
```

### Modified

```
pkg/extension/extension.go    # DirName/LegacyDirName/ResolveDir, package doc
pkg/server/extension.go       # extensionDir() → ResolveDir (+ one-time warning)
cmd/Suwu/main.go              # dispatch, printUsage, printSubcommandHelp
examples/extension/README.md  # the new install path
docs/EXTENSION_*_PLAN.md      # the `extensions/` tree in the contract
website/docs/pages/*          # install instructions, suwu-cli, backgrounds, extensions
README.md                     # mention `suwu install`
```

`pkg/background` needs no change — `DirName` already exists and is already
singular.

---

## 10. Security summary

1. **Nothing is executed during install.** Files are copied and validated as
   data; the first execution is the server spawning `suwu gq`, which is already
   sandboxed with a read-only root, a deadline, and a concurrency cap.
2. **Zip extraction is the only privileged step** and is guarded as in §7.2;
   the containment check is the same idea as `pkg/extension`'s `ensureWithin`.
3. **Validation reuses the server's resolvers**, so a zip cannot register a
   half-valid extension/background, and handler/static declarations are checked
   by the code that will serve them.
4. **The catalog is first-party and read-only** for the user: it can only write
   under `<dataDir>/{extension,background/webgpu}/<id>` with a validated id.
5. **No secrets are printed.** A token is used for the GitHub header only and
   never echoed; `suwu install` prints paths, ids, names, and sizes.
6. **A third-party zip is unvetted by design.** The output prints the resolved
   name, file count, and total bytes so the user can see what arrived; a
   manifest hash and signature verification are §12 follow-ups, not v1 claims.

---

## 11. Tests

`pkg/install/archive_test.go` — one case per hostile archive:

- `../escape.js` and `a/../../escape.js` → rejected, nothing written outside
- `/etc/passwd`, `C:\x`, `a\\b` → rejected
- symlink entry, device entry, irregular entry → rejected
- declared 100 MiB file, 5000 entries, a stream longer than the declared size
  → rejected with a specific error
- `__MACOSX/…` and `.DS_Store` → skipped, install still succeeds
- two payload roots → rejected; bare `<id>/…` and `extensions/<id>/…` → accepted
- `extension/` with no `package.json`, or a bad one → resolver error, stage
  removed, target absent
- a background with a `.wgsl` and no `.shader.js` → installs **with** a warning
- file mode `0777`/`setuid` in the zip → on-disk mode is `0644`
- id `../../etc` → rejected by `ValidID` before any path is built

`pkg/install/catalog_test.go` (httptest):

- tree grouping, correct prefixes, manifest label/description extraction
- a manifest fetch failure degrades to the bare id
- a tree path containing `../` is dropped with a warning, not downloaded
- `--token` sends the header; a 403/404/500 gives a clean error
- cached catalog reuse, `--refresh` bypass, stale-cache fallback for `--list`

`pkg/install/install_test.go` / integration:

- a synthesized zip of `examples/extension/eye` installs to
  `<dataDir>/extension/eye` and then `extension.List` sees it
- install twice without `--force` → error; with `--force` → replaced, backup gone
- a forced install whose commit rename fails restores the previous directory
- `--dry-run` writes nothing and leaves no `.install` residue
- **rename regression:** legacy-only dir still lists; new dir wins when both
  exist; a warning fires once

`cmd/Suwu/install_test.go`: mode flags are mutually exclusive, `--kind` is
validated, non-TTY bare `suwu install` exits `64` with usage, unknown flag
exits `64`.

---

## 12. Delivery phases

1. **Rename** — `pkg/extension` + `ResolveDir` + server + tests + docs. Lands
   alone so the layout change is reviewable on its own. Includes fixing
   `examples/extension/README.md`. The repo-side rename of
   `examples/extensions/` → `examples/extension/` is already done by the user
   (uncommitted in the working tree); this phase only has to make the Go side
   and the prose agree with it.
2. **`pkg/install` core** — staging, validation, atomic commit, `--dry-run`,
   `--force`, plus the zip reader and its tests. No CLI yet, so it is testable
   in isolation.
3. **Catalog** — GitHub tree/raw + cache, with httptest coverage.
4. **CLI + TUI** — `cmd/Suwu/install.go`, dispatch, help, output, non-TTY paths.
5. **Docs** — website (`suwu-cli`, `extensions`, `backgrounds`), `README.md`,
   `examples/extension/README.md`, `cmd/Suwu/agent_skill.md` (a `suwu install`
   entry for agents), release notes.
6. **Deferred** — `suwu remove`, manifest hashes/signing, `--upgrade`, and
   generalizing the catalog to plugins/themes.

## 12b. What shipped

| Phase | Status | Notes |
|---|---|---|
| 1 — rename | done | `extension.DirName`/`LegacyDirName`/`ResolveDir`; `Server.extensionDir()` resolves per request and logs the migration hint once; server-level test for all three resolution cases |
| 2 — core + zip | done | `pkg/install/install.go` (stage, caps, validation, atomic commit) and `archive.go`; hostile-zip suite covers traversal, non-regular entries, duplicates, layout ambiguity and noise |
| 3 — catalog | done | `pkg/install/catalog.go`: one tree call, per-item manifest enrichment, cache with 6h TTL, `--refresh` bypasses the cache *and* its stale fallback |
| 4 — CLI + TUI | done | `cmd/Suwu/install.go`; kind → items → replace confirm; `--list`/`--id`/positional names for non-TTY use; `reorderFlags` so flags after a name still parse |
| 5 — docs | done | `examples/{extension,background}/README.md`, website extensions/backgrounds/suwu-cli pages, README feature list, `cmd/Suwu/agent_skill.md` |

Verified against the live repository: `suwu install --list` enumerates the five
catalog backgrounds with their labels, and `suwu install --github matrix-rain`
installs the seven real files. Extensions are absent from the catalog until the
`examples/extensions` → `examples/extension` rename lands on the branch, which
is expected.

Deviations from the plan, and why:

- **`--id` is an alias, not the primary spelling.** Positional names
  (`suwu install --github eye`) are what the help text leads with; `--id` is
  repeatable and merges with them.
- **The staging directory is `<dataDir>/.install/<kind>/<id>`,** not a
  per-process suffix: the payload directory name has to be exactly `<id>` for
  the resolver call to match what the server does. A duplicate id in one
  archive is rejected by `O_EXCL` rather than silently overwriting.
- **The bare-archive form requires the manifest at the root.** A zip with one
  loose `docs/` directory is not a payload.
- **`checkSize` is a separate function** so the size budgets are tested with
  synthetic numbers instead of writing tens of megabytes.
- **The background freshness check warns, it does not fail** (as planned), and
  only fires for entry shaders (`@fragment`/`@compute`), since helper modules
  are inlined.

### Collateral from the working-tree changes (the user already did these)

- `examples/extensions/` → `examples/extension/` — assumed by this plan; §4.3
  lists the prose that still says `extensions/`.
- `examples/gqjs/` **removed** as no longer needed. Two places still advertise
  the deleted files and must be fixed in phase 5 (or sooner, since they are
  user-visible):
  - `cmd/Suwu/gq.go` `gqUsageText` — `suwu help gq` prints
    `examples/gqjs/{hello,handler,timeout,fetch}.js` in its examples. Rewrite
    the examples as inline heredocs or `/tmp/…` scripts so the help text is
    copy-pasteable on a machine with no checkout.
  - `website/docs/pages/gqjs.content.html` — the "Examples" section claims
    "the repository ships runnable samples under `examples/gqjs/`". Replace it
    with the scripts inline, and the same for the one `suwu gq` line in
    `website/docs/pages/suwu-cli.content.html`.

---

## 13. Open questions

1. **Should `--github` be allowed to install from a third-party repo?** The
   plumbing supports it, but v1 should probably keep `--repo` documented-as-
   advanced and print the repo it used, so a surprise origin is visible.
2. **Signature/checksum metadata** in a new `suwu.install` block inside
   `package.json` / `background.json`? Deferring means a v1 zip carries no
   integrity story beyond "validated as an extension".
3. **Background overwrite semantics**: a data-dir copy already overrides the
   embedded builtin of the same id, so installing `seascape` from the catalog
   silently shadows the built-in. Keep that (it is the documented behavior) or
   warn when the id is also a builtin?

---

## Appendix: what this replaces

```sh
# before
cp -r examples/extension/eye ~/.suwu/extensions/
cp -r examples/background/webgpu/matrix-rain ~/.suwu/background/webgpu/

# after
suwu install --extension eye.zip
suwu install --github --id matrix-rain
```
