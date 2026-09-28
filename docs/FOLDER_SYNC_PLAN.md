# Folder Sync Tile — Feature Plan (v2: one-way server → local mirror)

## 1. Overview

A new tile plugin, **Folder Sync**, that mirrors a remote folder (on the Suwu
host) into a local folder chosen by the browser user.

Requirements (revised — v2 replaces the earlier two-way design):

1. Sync a remote folder (Suwu host filesystem) **→** a local folder (picked by
   the browser user via the File System Access API). **Single direction: the
   local folder always ends up identical to the server folder.**
2. Periodic sync, default **every 5 s**, in **two phases per cycle**:
   **pre-flight** (scan both folders, diff) and **sync** (apply the plan).
3. The tile plugin **folder sync** manages which remote folder is synced with
   which local folder.
4. The *active* sync state is **not persisted**: sync only runs while the tile
   is open and the user has activated it. *Configs* are persisted; on reload
   they come back **idle, waiting for the user to start sync again**.

> **What one-way sync buys us** (vs. the original two-way plan):
> - No push endpoint on the server, no mtime preservation on writes, no
>   destructive-rate-limit budget — the backend shrinks to a single read-only
>   manifest endpoint.
> - **No conflict detection, no resolution prompts** — remote is always the
>   source of truth, so the "same timestamp" rule has no cases left.
> - No ping-pong risk, no `expectMtimeMs` concurrency dance, simpler diff.

---

## 2. Why the sync engine lives in the browser

The local folder exists only on the browser user's machine; the Go server can
never see it. The browser tab is the only party that sees both sides:

- **Browser (TypeScript)** — owns the sync engine: local FS access
  (`FileSystemDirectoryHandle`), scanning, diffing, the periodic scheduler,
  downloads, and (optional) removal of local extras.
- **Go server** — one new **read-only** endpoint that returns a recursive
  folder manifest with millisecond mtimes.

No background daemon; when the tile iframe dies, the loop dies with it —
exactly requirement 4.

### Platform constraint (accepted)

`window.showDirectoryPicker()` is Chromium-only (Chrome/Edge/Opera). The tile
detects the API and shows a clear "requires a Chromium-based browser" empty
state elsewhere. Sync also requires a secure context (HTTPS or localhost) —
already true for Suwu deployments.

---

## 3. Scope

### In scope (v1)

- Multiple managed sync **jobs** (remote folder ↔ local folder, interval).
- Transfer of **added and modified** files/directories, remote → local.
- **Removal of local extras** (files/dirs absent on the server) behind a
  per-job toggle `removeExtra` — this is what makes "local always equals
  server" literally true. Default **on**, with a warning in the job editor.
- Pre-flight + sync phases per cycle, default 5 s.
- Overwrite of locally-edited files (remote wins), logged as an explicit
  `overwrote local change` entry so nothing disappears silently.
- Persisted configs (localStorage) + persisted local directory handles
  (IndexedDB) + the sync journal kept as a **local meta file
  `.suwu-sync.json` inside the synced folder** (§5.2); non-persisted run
  state.
- Activity log, per-cycle stats, Run-now toolbar button.

### Out of scope (v1)

- **Two-way sync / conflict prompts** — dropped by the direction change.
- Pushing anything to the server (the engine never writes to the remote).
- Delta/compression/bandwidth throttling.
- Running sync when the tile is closed (forbidden by req 4).

---

## 4. Backend design

One new file: `pkg/server/sync.go`, one new endpoint registered in
`pkg/server/server.go` `route()`.

### 4.1 `GET /api/sync/manifest?path=/abs/dir`

One request returns the **whole subtree** with millisecond mtimes (existing
`/api/files` is single-level and RFC3339/second precision — too coarse and too
chatty for a 5 s loop).

```jsonc
{
  "path": "/home/me/proj",
  "entries": [
    { "rel": "src",            "isDir": true,  "size": 4096, "mtimeMs": 1712345678901 },
    { "rel": "src/main.go",    "isDir": false, "size": 1821, "mtimeMs": 1712345678902 }
  ],
  "entryCount": 2,
  "truncated": false
}
```

- `rel` is POSIX-style, relative to `path`; root entry omitted.
- Walk with `filepath.WalkDir`; **skip symlinks** (`ModeSymlink`) so the
  mirror can never pull in content from outside the synced folder.
- Caps: `maxSyncEntries = 20000`, `maxSyncDepth = 32`. If hit →
  `truncated: true`; the UI refuses to run the cycle and tells the user
  (better than silently mirroring a partial view).
- Errors: `404 path not found`, `400 not a directory`, plus the usual
  `validateRequest` auth.
- **Read-only → no rate-limit changes at all.** `validateRequestRateLimit`
  only gates `/api/file/…`, `/api/dropbox/…`, `/api/forward/…`,
  `/api/update/…`; a GET manifest passes through untouched.

### 4.2 Reused as-is

- `GET /api/file?path=` — the download path; already streams, already sends
  `X-Suwu-Mtime-Ms`.
- `GET /api/files?path=` + the `RepoPicker` pattern — remote folder browsing
  in the job editor.

### 4.3 Explicitly *not* built (one-way simplifications)

| dropped | why |
|---|---|
| `POST /api/sync/push` + mtime preservation | engine never writes remote |
| dedicated `syncLimit` rate bucket | no write traffic; manifest is a GET |
| `expectMtimeMs` optimistic concurrency | no writes to clobber |
| mkdir-remote / `/api/file/mkdir` use | dirs only ever get *created locally* |

---

## 5. Sync algorithm

### 5.1 The two manifests

Each cycle builds two `rel → { size, mtimeMs }` maps:

- **Remote**: one `GET /api/sync/manifest`.
- **Local**: recursive `dirHandle.values()` walk; `getFile()` yields `size` +
  `lastModified` (ms) without reading content. Depth/entry caps mirror the
  server (32 / 20000).

### 5.2 The meta file `.suwu-sync.json` (why we don't re-download forever)

The File System Access API cannot set `lastModified` — every local write
stamps *now*. So after a download, the local file's mtime will **never** equal
the remote's, and a naive "mtimes differ → pull" would re-download the whole
folder every 5 s. We need memory of *what we already mirrored*.

**That memory is one meta file at the root of the local folder:
`.suwu-sync.json`.** The name is namespaced to the product so it collides
with no common tool. Keeping it *inside the folder* rather than in IndexedDB
means the sync state travels with the data — it survives browser-profile
changes, re-picking the same folder, and job edits; deleting the file is a
deliberate reset. (Only the directory *handle* must stay in IndexedDB — a
`FileSystemDirectoryHandle` cannot be serialized into a file.)

```jsonc
{
  "version": 1,
  "plugin": "suwu-foldersync",
  "remotePath": "/srv/docs",        // guard: two jobs must not share one folder
  "lastCycleAt": 1712345678901,
  "files": {
    // key: relative path
    "src/main.go": { "size": 1821, "remoteMtimeMs": 1712345678902, "localMtimeMs": 1712400000003 }
  }
}
```

**Ignore rule — the sync algorithm never touches this file:**

- `rel === '.suwu-sync.json'` (**root only**) is stripped from the local scan
  *and* from the remote manifest before diffing: never pulled, never deleted
  by `removeExtra`, never reported as a local extra. A nested file that merely
  shares the name mirrors normally.
- A same-named file at the *server* root is likewise never pulled — the
  server's copy simply doesn't exist as far as sync is concerned.
- Its absence, parse failure, or `version` mismatch → the job behaves as
  first-run.

Lifecycle:

- **Read once on Start**, before the first pre-flight; validated against the
  `version` field.
- `remotePath` mismatch with the job config → show a warning and require an
  explicit *reset meta* confirmation (so a second job pointed at the same
  local folder can't silently eat the first one's state).
- **Rewritten at cycle end only when the cycle changed something** (dirty
  flag): per successful download record `{ size, remoteMtimeMs, localMtimeMs }`
  (local values read back via `getFile()`); on delete drop the entry; stale
  entries for server-deleted files are pruned each rewrite.
- Written via `createWritable()` → `close()`, which stages into a swap file
  and commits atomically — no torn meta. A crash before commit costs at most
  one cycle of redundant downloads.
- **Entries are self-bounding:** only files present on the remote are kept, so
  `entries ≤ remote entryCount ≤ 20000` — no separate cap needed.

Pre-flight consults it:

- remote matches meta **and** local matches meta → **skip** (steady state:
  zero hashing, zero transfers);
- remote matches meta but local doesn't → the user edited the local file →
  **remote wins**: re-download, log `overwrote local change`;
- remote doesn't match → server changed → download.

### 5.3 Per-file decision table (pre-flight)

| situation | action |
|---|---|
| dir only remote | `mkdir-local` |
| dir only local | `rmdir-local` *(if `removeExtra`)* |
| file only remote | `pull` |
| file only local | `delete-local` *(if `removeExtra`)* |
| root `.suwu-sync.json` (either side) | **ignore — never planned** (§5.2) |
| both, meta matches on both sides | skip |
| both, local `(size,mtime)` == remote `(size,mtime)` exactly | identical → seed meta, skip |
| both, size equal, **no meta entry** (first run) | hash both (SHA-256): equal → seed meta & skip; differ → `pull` |
| both, anything else | `pull` — reason `remote-changed` / `local-diverged` / `first-run` |

Notes:

- **No conflict state exists**: equal timestamps are irrelevant, because
  remote content wins unconditionally.
- A local-only directory is only removed when the server holds nothing under
  it (the manifest's ancestor set is checked), so an inconsistent manifest can
  never delete a directory that still has mirrored content.
- Hashing happens in exactly two places: the first-run equal-size probe (so a
  fresh job over an already-mirrored folder doesn't re-download everything)
  and never again — after that `.suwu-sync.json` carries the steady state.
- Files > 64 MiB (`maxSyncFileBytes`) are never hashed and never pulled; they
  appear in the plan as `skipped: too-large` with a log warning.
- Ordering: deletions run **last**, after all successful pulls — a half-failed
  cycle can never remove data it didn't manage to re-download.

**Result of pre-flight** = `{ actions[], skipped[] }` (no `conflicts[]`).

### 5.4 Phase 2 — sync

- Actions run through a small worker pool (concurrency 4); each download is
  guarded by `AbortController` so Stop cancels in-flight work.
- Download: `GET /api/file?path=…` → bytes →
  `getFileHandle(rel, { create: true })` (parent dirs created on demand,
  depth-first) → `createWritable()` → write → read back `lastModified` for the
  meta file. Local deletion: `removeEntry(name, { recursive: true })` for dirs.
- Per-file failure → collected, shown in the log, **retried next cycle**
  (pre-flight re-detects it because the state never converged).
- `.suwu-sync.json` is rewritten at cycle end **only when the cycle changed
  something** (dirty flag); Stop flushes a dirty meta best-effort.
- Cycle end → status **cooldown** → `setTimeout(interval)` → next pre-flight.
  `setTimeout` chaining (never `setInterval`) so cycles can never overlap.

### 5.5 Engine state machine (per job)

```
idle ── Start ──▶ requesting-permission ──▶ preflight ──▶ syncing ──▶ cooldown ─┐
  ▲                                                                             │
  │                                                                             │
  │        error (3 consecutive failures → stop retrying) ◀─────────────────────┘
  └──── Stop / tile unmount ◀─────── (user Start required to recover)
```

- Start is always a user gesture → `requestPermission({ mode: 'readwrite' })`
  if `queryPermission()` isn't `granted` (handles come back from IndexedDB
  with permissions revoked — this is exactly the "waiting for user to active
  sync again" state).
- 3 consecutive pre-flight failures (network/auth/truncated) → **error**,
  auto-retry stops until the user presses Start again.
- **Tile unmount / pagehide stops every engine** — module-level registry, last
  panel unmount tears it down. The loop only ever runs while the tile lives.

---

## 6. Persistence model (requirement 4)

| data | where | persisted? |
|---|---|---|
| job configs (name, remotePath, dirId, localDirName, intervalMs, removeExtra) | localStorage atom `suwu:folder-sync` | ✅ |
| local `FileSystemDirectoryHandle`s | IndexedDB `suwu-folder-sync` / `dirs` | ✅ (permission is *not* — re-requested on Start) |
| sync journal (what was mirrored) | `.suwu-sync.json` **inside the local folder** | ✅ — travels with the folder; delete it to reset |
| running state, active flags | module memory only | ❌ |
| plans, progress, activity log | React state only | ❌ |
| selected job (UI-only) | tile session state | ✅ (restores selection, never a run) |

On load every job is **idle** with a Start button. Nothing resumes by itself.

---

## 7. Frontend design

### 7.1 Tile plugin contract (per suwu-tile-plugin-design skill)

```ts
// frontend/src/wm/plugins/foldersync.tsx
registerTilePlugin({
  id: 'foldersync',
  get label() { return i18n.t('plugin.foldersync') },        // lazy i18n
  get description() { return i18n.t('plugin.foldersyncDesc') },
  supportedParams: [
    { key: 'remotePath', label: 'Remote folder', description: 'Remote folder to mirror (pre-fills the job editor)' },
    { key: 'interval',   label: 'Interval (ms)', description: 'Sync cycle interval in milliseconds (default 5000)' },
  ],
  render: (paneId, context) => ( /* iframe → /foldersync?pane=…&…, data-pane, transparent */ ),
  renderToolbar: ctx => ( /* "Run now" → postMessage { type: 'foldersync-run' } */ ),
})
```

Params pre-fill the **job editor dialog** rather than starting anything — a
job can't exist without a local folder, which only the user can grant.

### 7.2 Route + page

- `frontend/src/routes/FolderSyncPage.tsx` under `rootRoute`, path
  `/foldersync`; `setPageTransparent()` on mount; wrapped in
  `CommonTileContainer zoomAtom={folderSyncZoomAtom}` (default padding — it's
  a control panel, not a full-bleed viewer).
- New zoom atom: `folderSyncZoomAtom = atomWithStorage('suwu.foldersync-zoom', ZOOM_DEFAULT)`
  in `store/zoom.ts`.

### 7.3 Component tree

```
frontend/src/lib/foldersync/            ← engine, no React
├── types.ts        SyncJobConfig, FileRecord, Manifest, PlanAction,
│                   JobStatus, CycleStats, ActivityEvent
├── handleStore.ts  tiny promise-based IndexedDB wrapper (single `dirs` store),
│                   permission query/request helpers
├── localFs.ts      pickDirectory(), scanLocal(dirHandle) → Manifest (root
│                   `.suwu-sync.json` stripped), writeLocal(rel, bytes),
│                   deleteLocal(rel), mkdirLocal(rel)
├── remoteApi.ts    fetchManifest(), fetchFile(rel) — all via authFetch
├── hash.ts         sha256Hex(bytes) — used only by the first-run probe
├── meta.ts         read/validate/write `.suwu-sync.json` (version +
│                   remotePath guard, dirty-flag rewrite, stale-entry prune)
├── diff.ts         buildPlan(remote, local, meta, removeExtra)
│                   → { actions[], skipped[] }   ← pure, and covered by
│                   scripts/check-foldersync-diff.mjs (it imports `./types.ts`
│                   with an explicit extension so Node can load it)
└── engine.ts       SyncEngine class: start/stop/runNow, scheduler, phase events,
                    AbortController wiring; module-level registry keyed by jobId

frontend/src/store/foldersync.ts        atomWithStorage('suwu:folder-sync', …)

frontend/src/components/foldersync/
├── FolderSyncPanel.tsx     main tile UI: header, job list, detail, log
├── JobEditorDialog.tsx     name / remote folder (RemoteDirPicker) /
│                           local folder (showDirectoryPicker button) /
│                           interval / removeExtra toggle
├── RemoteDirPicker.tsx     extracted RepoPicker-style browser (dirs + manual path)
├── ActivityLog.tsx         micro-timestamped cycle log
└── StatusChip.tsx          idle / preflight / syncing / cooldown / error
```

Engine events → React via a small `useSyncEngine(jobId)` hook (subscribe on
mount, unsub + stop on unmount).

### 7.4 Tile layout (typography per skill §11)

```
┌───────────────────────────────────────────────┬──────────────┐
│ Folder Sync        status ● running  [+ Add]  │ (toolbar zone│
│                                             │  kept clear) │
│ ─ Jobs ────────────────────────────────────── │  w-56 h-12   │
│ ● docs-mirror  /srv/docs → Documents  5s  [Stop]            │
│ ○ notes        /home/me/n → Notes       5s  [Start]         │
│ ─ Detail: docs-mirror ──────────────────────────────────────│
│ cycle #41 · checked 214 · ↓3 · −1 deleted · 38 ms           │
│ 12:04:05 pre-flight  214 files, 4 changes                   │
│ 12:04:05 pull docs/changelog.md (1.2 KB)                    │
│ 12:04:05 overwrote local change notes/todo.md               │
└─────────────────────────────────────────────────────────────┘
```

- Title/section titles Heading 16; job rows, paths, buttons Body/Label 12–14;
  cycle counters & timestamps Micro 10; hints Caption 11. No off-scale sizes
  (enforced by `frontend/scripts/check-typography.mjs`).
- `glass-control` / `glass-btn` classes only; the **top-right 224×48 corner
  stays empty** (TileTools owns it); Add/Start/Stop cluster left.

---

## 8. Files inventory

### New — backend
- `pkg/server/sync.go` — manifest handler (walk, symlink skip, caps).
- `pkg/server/sync_test.go` — walk correctness, symlink skip, truncation,
  depth cap, 404/400, auth.

### New — frontend
- `frontend/src/lib/foldersync/*` (§7.3)
- `frontend/src/components/foldersync/*`
- `frontend/src/routes/FolderSyncPage.tsx`
- `frontend/src/wm/plugins/foldersync.tsx`
- `frontend/scripts/check-foldersync-diff.mjs` — pure diff regressions
  (steady state, local edit, server edit, first-run probe, extras, ordering,
  type mismatch, meta invisibility, 64 MiB skip); wired into `pnpm check`
  as `check:foldersync-diff`.

### Modified
- `pkg/server/server.go` — 2 route registrations (manifest only; **no**
  rate-limit changes).
- `frontend/src/router.tsx` — `/foldersync` under `rootRoute`.
- `frontend/src/wm/TilingWM.tsx` — `import './plugins/foldersync'`.
- `frontend/src/wm/appIcons.ts` — `foldersync: { bg: 'bg-fuchsia-500/20', text: 'text-fuchsia-400', letter: 'S' }`.
- `frontend/src/store/zoom.ts` — `folderSyncZoomAtom`.
- `frontend/src/wm/sessionState.ts` — optional `FolderSyncSessionState { selectedJobId? }`.
- `frontend/src/locales/en.json`, `zh_CN.json` — `plugin.foldersync(Desc)` +
  `foldersync.*` namespace (every string i18n'd, lazy getters).

---

## 9. Verification

- `go test ./pkg/server/` — 9 manifest tests (tree walk, symlink skip, depth and
  entry truncation, 404/400/405/401)
- `go vet ./...`, `go test ./...`
- `pnpm --dir frontend typecheck`, `pnpm --dir frontend check` (biome,
  typography, and every `check-*.mjs`, including the new diff regressions)
- `pnpm --dir frontend build`
- Live check against a throwaway server instance: manifest returns ms mtimes
  and skips symlinks, `/api/sync/manifest` 404s a missing path, 401s without
  a token, and `/api/file` still sends `X-Suwu-Mtime-Ms` for downloads.
- Manual E2E script (Chromium; the rest needs a real folder picker):
  1. Add job: remote `/tmp/fs-test` ↔ a local folder; Start → observe 5 s
     cycles in the log.
  2. Create/modify a file on the server → appears locally within one cycle.
  3. **Steady state**: no transfers on idle cycles (meta working), and the
     local file's mtime staying "now" does *not* cause re-downloads.
  4. Edit a local file → next cycle overwrites it and logs
     `overwrote local change`.
  5. Delete a server file → removed locally when `removeExtra` is on; kept
     (and logged) when off.
  6. Reload the page → job is idle with Start (req 4); closing the tile stops
     the loop immediately.
  7. Split/swap/move the tile → iframe (and any running sync) survives.
  8. 20 001-file folder → `truncated` refusal message, no partial mirror.
  9. First-run probe: identical folder contents → job seeds `.suwu-sync.json`
     and downloads nothing.
 10. Meta is invisible to sync: never pulled even when a same-named file sits
     on the server root, never deleted by `removeExtra`, absent from every
     plan and log line count.
 11. Delete the meta file → next Start behaves like first-run (equal-size
     files are hashed, nothing re-downloaded when content matches).
 12. Point a job with a different `remotePath` at a folder that already has a
     meta → reset-confirmation warning appears before anything runs.

---

## 10. Implementation phases

1. **Phase 1 — backend**: `sync.go` manifest endpoint + tests.
2. **Phase 2 — engine**: `lib/foldersync` pure core (`diff.ts`, `meta.ts`,
   `hash.ts`) + `localFs`/`remoteApi`/`handleStore` + `engine.ts`.
3. **Phase 3 — UI**: panel, job editor, remote dir picker, page, plugin
   registration, route, i18n, icons, zoom, toolbar button.
4. **Phase 4 — polish & verify**: typography audit, E2E script, docs, run all
   checks.

---

## 11. Open questions

1. **`removeExtra` default** — plan says **on** (that's what makes "local
   always equals server" true), with a warning in the editor since it will
   delete local-only files on first run. Confirm, or prefer default **off**
   (additive mirror: pull + overwrite, never delete)?
2. **Local edits** — remote wins unconditionally (edit is overwritten next
   cycle, logged). Confirm — no prompt, per the one-way simplification?
3. **Browser support** — Chromium-only (File System Access API) acceptable?
4. **Exclusions** — ship v1 with no ignore list, a default one
   (`.git/`, `.DS_Store`, `Thumbs.db`), or per-job exclude globs?
5. **Interval options** — fixed choices `2 / 5 / 10 / 30 / 60 s` with 5 s
   default, or free-form input?
6. **Multiple jobs** — run concurrently (each with its own timer) or only one
   active at a time? Plan assumes concurrent; all are read-only GETs now, so
   it's cheap.
7. **Meta file name & ignore scope** — `.suwu-sync.json` at the local folder
   root, and the *root-only* ignore rule (a same-named file deeper in the tree
   mirrors normally; a same-named file on the server root is ignored rather
   than pulled). Any preference for a different name, or should the ignore
   apply at every depth?
