# Bento Slides extension — Suwu integration plan

> **Status:** phase 1 implemented — `examples/extension/bento` opens a deck,
> edits it, and writes it back with Bento's own save. See §10 for what the build
> added to the platform and what is still open. All upstream facts below were
> read from the repository (`nyblnet/bento`, MIT) and from the released shell;
> the commands to reproduce each are in the appendix.
>
> **Goal:** open a `.bento.html` deck in a Suwu tile, edit it, and have Bento's
> own save write the file back to the Suwu server — the same "open and save to
> the server" story the Excalidraw extension has, without re-implementing
> Bento's document format or its UI.

---

## 1. Why this is a good fit

Bento Slides is unusual in a way that makes it almost ideal for Suwu:

- **The file is the app.** A `.bento.html` is a single self-contained HTML file
  (~721 KB released) that carries the deck, the editor, the presenter and every
  font/image the deck uses. The released shell has **zero external `src`/`href`
  references** — no CDN, no API, no network of any kind is needed to open it.
- **The document is a plaintext JSON block** near the top:
  `<script type="application/bento+json" id="bento-doc">…</script>`. Saving
  rewrites that block in a copy of the shell. Nothing is opaque, and splicing it
  needs no knowledge of the schema.
- **It already has a host-integration contract.** The kernel's file I/O keys off
  `window.showSaveFilePicker` and a documented "transient DOM" convention, so an
  embedder can own where saves go (details in §3). Bento's own browser-extension
  and iOS shells use exactly this.
- **No workers, no wasm, no `eval`** anywhere in `slides/src` or `kernel/src`,
  so the tile needs no `'unsafe-eval'` and no `worker-src` — a tighter CSP than
  the Excalidraw tile gets away with.

What we give up, deliberately: Bento's **self-update** (a signed release fetch)
and its **collaboration relay** (a Cloudflare worker). Both are network
features; a Suwu tile ships one pinned shell and works offline.

---

## 2. Measured upstream facts

| Fact | Value / where |
|---|---|
| License | MIT (`LICENSE`, plus `THIRD_PARTY_NOTICES.md` to propagate) |
| App source | `slides/` (TS), shared kernel in `kernel/src` |
| Build (product) | `npm run build:single` → `dist-single/Bento_Slides.bento.html` |
| Released shell | **721,347 B**, 4 `<script>` tags, **0 external references** |
| Document block | `<script type="application/bento+json" id="bento-doc">` (empty in the released shell) |
| Runtime deps | `moveable`, `reveal.js`, `selecto` — all inlined by `vite-plugin-singlefile` (`assetsInlineLimit: 100_000_000`) |
| Workers / wasm / eval | none (`grep -rn "new Worker\|WebAssembly\|new Function(\|eval(" slides/src kernel/src` → empty) |
| Print path | `window.print()` in `slides/src/editor/editor.ts:2281` (PDF export) |
| Download path | `downloadFile()` fallback in `kernel/src/save.ts` |

The three seams we will use, all read from `kernel/src/save.ts`:

```ts
// 1. The one switch for "can write in place":
const hasFsAccess = () => typeof window.showSaveFilePicker === 'function'

// 2. What a host is handed: the FULL new .bento.html, as a Blob.
interface FsFileHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>
  getFile?(): Promise<{ text(): Promise<string> }>
  name: string
}
writeHandle() → handle.createWritable() → write(blob) → close()

// 3. Intent is explicit in the picker options — the only signal a host gets:
pickerIdFor(purpose) = 'bento-doc' | 'bento-copy' | 'bento-backup' | 'bento-share'
showSaveFilePicker({ suggestedName, startIn?, id, types })

// 4. Injected DOM is stripped from every save if it carries this attribute:
const TRANSIENT_SELECTOR = '[data-bento-transient]'
// "anything injected before the pristine capture carries this attribute and is
//  stripped from every serialized shell" — already used by spaces/type apps.

// 5. Extra host services are announced, not assumed:
window.__bentoHost = { ops: ['store', …] }   // + docStore() wire protocol
hostCan(op) = ops.includes(op) && typeof window.showSaveFilePicker === 'function'
```

And two conveniences: `window.bento.loadDoc(json)` (a supported way to replace a
running document's content) and `openedFileName()`, which falls back to the URL
basename **only when it ends in `.bento.html`**.

---

## 3. Design

Three layers, each small. The theme: **let Bento do the document work; Suwu only
owns the bytes and the file path.**

### 3.1 Serve — the tile page *is* the deck

`index.js` (gqjs render stub) builds the page, exactly like the Excalidraw stub
but with a splice instead of a `loadDoc` call:

1. Read the vendored shell from the extension mount: `/ext/bento/dist/shell.html`.
2. Read the deck from the document mount: `/fs/<basename>` (as Excalidraw's stub
   does — `suwu.fs` puts the opened file's directory at `/fs`).
3. Extract the deck's document JSON from the file's
   `<script type="application/bento+json" id="bento-doc">…</script>` — opaque
   string surgery, no schema knowledge.
4. Splice it into the shell's own (empty) `#bento-doc` block.
5. Inject, **before** the shell's own scripts and all marked
   `data-bento-transient` so Bento strips them on save:
   - `window.__SUWU = { file, token, apiBase, staticBase }`
   - `<script src="/gqjs/static/bento/suwu-host.js">`

The result is a page that *is* a real `.bento.html` (same shell, same doc block,
same boot path), so the app's own idea of "the file I am editing" holds, and
`openedFileName()`-style logic cannot drift.

### 3.2 Load — nothing to do

The document is already in the page, so Bento boots straight into the deck. No
`loadDoc()` call, no race with boot, no second parse. (Keeping `loadDoc` in our
pocket matters only for the optimisation in §6.3.)

### 3.3 Save — one shim, Bento's own save path

`dist/suwu-host.js` is a classic script that runs before the app bundle and
installs the host contract:

```js
window.__bentoHost = { ops: ['store'] };          // §4.2, for side data

window.showSaveFilePicker = async ({ id, suggestedName }) => {
  if (id !== 'bento-doc') {           // copy / share / backup: not the open file
    return downloadHandle(suggestedName);   // see §6.1
  }
  return serverHandle(window.__SUWU.file);  // the opened deck
};
```

`serverHandle(name)` returns an `FsFileHandle` whose writable buffers the Blob
and `POST`s it to the extension API on `close()`:

```js
{
  name,
  async createWritable() {
    let blob = null;
    return {
      write: async (b) => { blob = b; },
      close: async () => { await save(blob); },     // POST /gqjs/api/bento/save?token=…&file=…
    };
  },
  async getFile() { return new File([…], name); },  // only used by one path
  queryPermission: async () => 'granted',
  requestPermission: async () => 'granted',
}
```

Because `hasFsAccess()` becomes true, the app's **⌘S, the Save button, the dirty
indicator and its in-place write-back all start working unchanged** — which is
the whole point. There is no menu-item surgery, unlike Excalidraw (whose 0.18
had no save hook at all).

One detail the handle's `name` covers: upstream's `openedFileName()` falls back to
the URL's last path segment only when it ends in `.bento.html`, and our tile URL
is `/gqjs/ext/bento?file=…`, so the basename would be `bento`. Because the shim
returns a handle whose `name` is the real deck filename, the app uses that and
every "save as" suggestion starts from the right name.

### 3.4 `save.js` — the API handler

`POST /gqjs/api/bento/save?token=…&file=/abs/deck.bento.html`

- Validates the target is inside `/fs` (the mount is already scoped to the
  document's directory), refuses anything not ending in `.bento.html`.
- Body = the complete file. **Cap it explicitly** (proposal: 64 MiB, matching
  install limits) and fail 413 above it, rather than streaming an unbounded
  write.
- Writes atomically: temp file in the same directory + `rename` — a half-written
  deck is the one failure mode that would hurt (the file *is* the app).
- Returns `{ ok: true, bytes }`; the shim surfaces a failure to Bento as a
  rejected `close()`, which the app already treats as a save error.
- No stripping needed: our injected nodes carry `data-bento-transient`, and the
  app omits them when it serializes.

---

## 4. Capabilities

### 4.1 `package.json`

```json
{
  "name": "suwu-bento",
  "version": "1.0.0",
  "private": true,
  "description": "Suwu extension tile: Bento Slides decks (.bento.html)",
  "license": "MIT",
  "suwu": {
    "name": "Bento Slides",
    "description": "The office suite that fits in a file — opens and saves .bento.html decks",
    "version": "1.0.0",
    "static": "dist",
    "fs": true,
    "api": [{ "route": "/save", "handler": "save.js" }],
    "fileExtensions": [".bento.html"],
    "sandbox": ["allow-downloads", "allow-modals"],
    "csp": { "img-src": ["blob:"], "media-src": ["blob:", "data:"], "style-src": ["'unsafe-inline'"] }
  }
}
```

Notes:

- **`fileExtensions: [".bento.html"]`** — the validator's grammar
  (`^\.[a-z0-9]+(\.[a-z0-9]+)*$`) already accepts a compound extension, and the
  notification resolver matches suffixes on the whole path, so
  `suwu open Q3.bento.html` opens this tile while plain `.html` still goes to the
  viewer.
- **`net: false`** — the shell needs nothing. Self-update and collab will fail
  silently (see §6.2).
- `allow-modals` is for `window.print()` (PDF export) and any password prompt;
  `allow-downloads` for the export paths that fall back to a download.
- CSP stays tight: no `'unsafe-eval'`, no `worker-src`, no CDN origin. The
  extension CSP already adds `'unsafe-inline'` for script/style and the static
  origin for script/style/img/font/connect.

### 4.2 Side data (`DocStore`)

The kernel keeps two per-document entries — `recovery` (crash copy) and
`memberkey` (collab identity) — in a host store when one exists, and otherwise in
`localStorage`/IndexedDB. **A sandboxed tile has neither** (opaque origin), so:

- v1: install the same in-memory `localStorage`/`sessionStorage` shim the
  Excalidraw extension uses, so nothing throws; recovery is then per-session
  only.
- v1.1 (optional): announce `ops: ['store']` and answer the documented
  `__bento_tray__` message protocol (`store.get/set/list/delete`) from the shim,
  backed by the tile's existing `ext-store` bridge → real persistence in the
  parent frame's IndexedDB, exactly the storage the sandbox cannot reach.

That protocol is small (four ops, `{dir:'req'|'res', id, op, payload}`), but it is
not needed for the open/save story, so it is deliberately phase 2.

---

## 5. Packaging: folder, not archive

`dist/` holds one file plus the shim and the notices:

```
examples/extension/bento/
  package.json          # above
  index.js              # render stub: shell + doc splice + transient injections
  save.js               # POST /save
  vendor.mjs            # fetch/build the shell, verify sha256, write dist/
  shell.lock.json       # pinned upstream version + sha256 (see below)
  dist/
    shell.html          # 721 KB, verbatim upstream single-file build
    suwu-host.js        # the host shim
    THIRD_PARTY_NOTICES.md
  README.md
```

This is the **plain-folder** pattern from the build plan, not `dist.zip`: three
files, one of them large, no chunk explosion — an archive would buy nothing.

**Vendoring** (not rebuilding) is the right default:

- `node vendor.mjs` downloads `Bento_Slides.bento.html` from the pinned GitHub
  release, verifies its sha256 against `shell.lock.json`, and writes
  `dist/shell.html`. Deterministic, no npm toolchain, works offline in CI once
  cached.
- `node vendor.mjs --from-source` builds from a pinned commit
  (`cd slides && npm i && npm run build:single`) for contributors who want to
  test a local Bento change.
- Why vendor and not build in-tree: Bento's build needs the whole monorepo
  (`server.fs.allow: ['..']`, shared `kernel/`), and every deck already carries
  its own copy of the shell — a Suwu-installed extension should not be a second
  copy of upstream's source tree.
- **Licensing:** MIT. Ship `LICENSE` + `THIRD_PARTY_NOTICES.md` from upstream in
  `dist/`, and note the pinned version in `README.md`. Suwu's own
  `THIRD_PARTY_NOTICES` generation (build plan §9.6) should include it.

---

## 6. Failure modes and UX decisions

### 6.1 "Save a copy", exports, backups

Bento asks the picker with `id: 'bento-copy'` / `'bento-share'` /
`'bento-backup'`. Those must **not** overwrite the open deck (upstream comments
are explicit about this). Shim behaviour:

- `bento-copy` → write `<base>.copy.bento.html` beside the original (inside
  `/fs`, so the server handler stays scoped) — or a download if the deck lives
  outside a mounted dir.
- `bento-share` / `bento-backup` → **download** through
  `URL.createObjectURL` + `<a download>` (needs `allow-downloads`), which matches
  the plain-browser behaviour for a deck opened from a public URL.

### 6.2 Features that go quiet

- **Self-update**: fetches a release manifest; blocked by `connect-src`. The
  update UI must not promise anything — verify it degrades to "couldn't check"
  rather than a scary error. Our docs should say the tile ships a pinned shell.
- **Collaboration**: needs the Cloudflare relay + WebSocket; `connect-src` has no
  such origin, so joining fails. Decks keep their collab keys (they are in the
  file, and the shim's store keeps `memberkey`), so nothing is lost — live
  sessions simply are not offered in v1.
- **Dirty indicator / "can write in place"**: with the shim present the app
  believes it can write in place, which is *true*. Good.

### 6.3 Render cost

The page we serve is shell (721 KB) + deck (unbounded). Per open that is one
`suwu gq` child plus that many bytes through the result file and the response.
On a LAN that is fine; a 40 MB deck with images would not be. Mitigations, in
order:

1. Cap the deck at ~32 MiB in `index.js` and fail the render with a clear
   message ("deck too large to open in the tile") rather than a timeout.
2. Optimisation (only if measured slow): serve the **shell from static**
   (immutable, gzip ≈150 KB) and have a 2 KB bootstrap page fetch the deck from
   the API and call `window.bento.loadDoc(json)` into a shell loaded as the
   page's own document via `document.write`-free means — i.e. the shell page
   reads `?file=` and fetches its own doc. Keeps the render stub tiny and the
   shell cacheable. Design it as a follow-up, not v1.

### 6.4 What we will not do

- Parse or validate the document schema. The JSON is opaque to Suwu; Bento
  validates it (`window.bento.validate()`).
- Run Bento's relay or reimplement collab.
- Patch the shell. If a future Bento breaks a seam, that is a vendor update, not
  a local hack — `shell.lock.json` makes the difference explicit.

---

## 7. Phasing

**Phase 0 — spike (half a day, throwaway)**
Vendor the shell, hand-write a 30-line page that splices a trivial doc block and
defines `showSaveFilePicker` logging what it receives. Answer three questions in
a real tile:
1. Does ⌘S reach `createWritable()`/`write(blob)` with the *complete* file?
2. Does the app write back automatically once a handle exists, and how often?
3. Do the injected nodes disappear from the written file (`data-bento-transient`)?
4. Does anything throw on missing `localStorage`/IndexedDB at boot?

**Phase 1 — MVP**
1. `examples/extension/bento/`: `index.js` splice + transient injections,
   `save.js` (atomic write, cap, `.bento.html` check), `suwu-host.js` (in-place
   only; copies/exports download), `vendor.mjs` + `shell.lock.json`, README.
2. `package.json` per §4.1; `fileExtensions: [".bento.html"]` so
   `suwu open`/the file browser reach the tile.
3. Storage shim so nothing throws in the sandbox.
4. Verify: open → edit → ⌘S → reopen shows the edit; `suwu install --local`
   installs the payload (package.json, index.js, save.js, dist/shell.html,
   dist/suwu-host.js, notices — the vendoring script and lock file are
   build inputs); the saved file still opens standalone in a plain browser.

**Phase 2 — polish**
- DocStore over the ext-store bridge (§4.2), so crash recovery survives reload.
- Auto-save affordance: if the app's write-back turns out to be chatty, add a
  server-side debounce (e.g. coalesce writes within 1 s) or a status chip like
  the Excalidraw tile's.
- Big-deck handling (§6.3), PDF/print check (`allow-modals`), encrypted-deck
  round trip.

---

## 8. Test plan

- **Splice unit test** (node): given a shell + a `#bento-doc` block, the splice
  output contains the doc exactly once and keeps the shell byte-identical
  elsewhere.
- **Transient stripping**: a saved file contains no `__SUWU`, no `suwu-host`
  reference and no `data-bento-transient` nodes; the doc block is the only
  difference from the vendored shell.
- **Handler matrix** (Go or node): 405 on GET, 401 without a token, 413 over the
  cap, 400 for a non-`.bento.html` target, atomic write leaves no `.tmp` behind
  on failure.
- **End to end** (manual, must-pass): open a deck with images and a chart, edit
  text, ⌘S, reopen — content persisted; open the saved file in a plain browser
  tab and confirm it still works standalone; "Save a copy" produces a second
  file that does **not** become the ⌘S target.
- **Resolver**: `suwu open Q3.bento.html` opens the Bento tile, while `.html`
  still opens the viewer.

---

## 9. Risks & open questions

1. **Write-back cadence.** "Silent autosave write-back" is listed upstream as one
   of the things FS Access buys. If it writes on every keystroke-ish change, each
   write is a 721 KB+ POST. Phase 0 measures it; the fix is a debounce, not a
   redesign.
2. **Render size** (§6.3). Needs a real measurement with a heavy deck before
   deciding whether the static-shell optimisation is needed.
3. **`pristine` capture semantics.** We rely on `data-bento-transient` being
   honoured for *our* injected nodes. Verified in source and used by three
   upstream apps, but the phase-0 test must confirm our exact markup.
4. **Sandbox and `window.print()`.** PDF export may need `allow-modals`; if the
   print dialog is unavailable in the sandbox, offer "download a copy" instead
   and document it.
5. **Encrypted decks** (`bento/enc`): the password prompt path is untested in a
   sandboxed frame; the round trip must be verified, not assumed.
6. **Upstream drift.** A Bento release that changes `showSaveFilePicker` usage,
   the `pickerIdFor` ids or the transient convention breaks the integration. The
   lock file plus the phase-0 tests make this visible; treat it like any vendored
   dependency bump.
7. **Naming**: the extension id `bento` claims `.bento.html`; if a future
   `bento/type` or `bento/spaces` app is added, decide whether they share the
   claim (one tile, app chosen by the file) or get their own ids.

---

## Appendix — how each fact was obtained

```sh
# upstream shape
git clone --depth 1 https://github.com/nyblnet/bento /tmp/bento
cat /tmp/bento/slides/package.json            # build:single → dist-single/*.bento.html
sed -n '1,80p' /tmp/bento/slides/vite.config.ts   # viteSingleFile, assetsInlineLimit 1e8

# the released shell: size + self-containment + doc block
curl -sSL https://bento.page/releases/slides/Bento_Slides.bento.html -o shell.html
wc -c shell.html                              # 721347
grep -c 'src="http\|href="http' shell.html    # 0
grep -o '<script type="application/bento+json" id="bento-doc">' shell.html

# the host contract
grep -n "hasFsAccess\|showSaveFilePicker\|pickerIdFor\|createWritable" /tmp/bento/kernel/src/save.ts
grep -n "TRANSIENT_SELECTOR\|data-bento-transient" /tmp/bento/kernel/src/save.ts
grep -rn "__bentoHost\|__bento_tray__" /tmp/bento/kernel/src /tmp/bento/home/webext/src | head

# no workers / wasm / eval in the app
grep -rn "new Worker\|WebAssembly\|new Function(\|eval(" /tmp/bento/slides/src /tmp/bento/kernel/src
```

---

## 10. What building it changed (phase 1, as built)

Two platform additions were needed, both deliberate and both tested:

1. **`suwu.sandbox: ["allow-modals"]`** (`pkg/extension/csp.go`). Bento's PDF
   export is `window.print()`, which a sandboxed frame refuses without that
   token, and an encrypted deck needs a password prompt. The allow-list grew by
   exactly one entry, with the trade-off written next to it (a hostile extension
   can open dialogs and block its own tab until dismissed).
2. **`fs.renameSync`** (`pkg/gqjs/bindings.go`). Bento's save rewrites a whole
   `.bento.html`, and a half-written one is a broken *application*, so the
   handler writes a temp file and renames it over the target. `renameSync` is
   gated like the other write bindings (absent in a read-only env) and validates
   both paths through the same root resolution, so it cannot move a file out of a
   mounted root.

As designed, nothing else in Suwu changed: the tile is `suwu.static` +
`suwu.fs` + one API route + a file-extension claim.

**One correctness fix after the first real file:** a pristine Bento shell (the
official download) has a `#bento-doc` block that is *present but empty*, and
upstream's own reader treats that as "a pristine New shell" — a new deck — while
`null` (no block) means "not a Bento file". The stub originally rejected both, so
opening a fresh download failed with "has no Bento document block". It now
splices the empty block through, and the file-less tile downloads on ⌘S instead
of failing the save. That also answers "how do I make a blank deck": the shell
itself is one.

What the implementation confirmed:

- The splice is exact: a saved file differs from the vendored shell **only** in
  the `#bento-doc` block (verified byte-for-byte, head and tail).
- `data-bento-transient` works as documented — and `save.js` strips our nodes
  again on the way in, so a scoped token can never be persisted into a user's
  document (defence in depth; the token-bearing block is the only thing we
  inject).
- Chunked upload: 512 KiB parts, assembled only when every index is present,
  `bytes`/`chars` reported honestly (gqjs strings are UTF-16 code units, so the
  response says `chars` rather than pretending to count bytes).
- Guards behave: non-`.bento.html` target → 400, a body without a `bento-doc`
  block → 400 (never overwrite a good deck with a non-deck), bad part range →
  400, missing token → 401, oversized upload → 413.

Still open, in the order they matter:

1. **Write-back cadence** (§9.1). Phase 0 could not be run without a browser; the
   shim is in place and each save is a chunked POST of the whole file. Measure
   before adding a debounce.
2. **DocStore** (§4.2): claim `ops: ['store']` and answer `__bento_tray__` over
   the tile's ext-store bridge, so crash recovery survives a reload and the
   collab member key persists.
3. **Render size** for heavy decks (§6.3) — measure a real 10 MB deck before
   deciding on the static-shell optimisation.
