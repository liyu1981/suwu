# Extension Dependency Bundles — local serving for CDN modules

> **SUPERSEDED by `docs/EXTENSION_BUILD_PLAN.md`.** The decision was to compile
> extensions like a normal JS project (Vite 8 → `dist/`, CDN modules become npm
> `dependencies`) instead of mirroring a CDN's URL space. This document is kept
> for its measurements — the crawl numbers, URL-shape census and the
> Excalidraw runtime-asset findings all still apply, and the builder/asset
> sections are the reference for anything the build phase cannot bundle.
>
> **Status:** research complete, design proposed, **not implemented**. Every
> number below was measured (see Appendix A for how to reproduce it); anything
> estimated is labelled as such.
>
> **Goal:** let an extension ship (or fetch) the third-party modules it loads
> from a CDN — `esm.sh` for `excalidraw` today — and serve them from Suwu, so
> tiles work offline / behind a firewall / without trusting a third-party CDN.
>
> Companion docs: `docs/EXTENSION_TILE_PLAN.md` (render pipeline),
> `docs/EXTENSION_API_PLAN.md` (metadata, CSP extras, static assets).

---

## 1. Problem

`examples/extension/excalidraw` declares `"script-src": ["https://esm.sh"]`
and pulls React + Excalidraw + ~100 transitive modules, plus an `index.css`,
≈260 font files, locale chunks and a 1.8 MB worker chunk, from esm.sh at
runtime. That is:

- **a network dependency** — no CDN, no whiteboard;
- **a trust dependency** — third-party JS executed in the tile;
- **an unpinned surface** — esm.sh can rebuild a path under the same URL.

The ask: a `*.dep.zip` (or equivalent) holding pre-downloaded modules, one
line in `package.json` to serve it, and CDN URLs in the page replaced with a
local mount like `/extension/<id>/dep/<path>`.

---

## 2. Goals / non-goals

**Goals**

1. Mirror a CDN's URL space into a local mount, byte-faithful and verifiable.
2. Declare the mount in `package.json` (`suwu.deps`), like `suwu.static`.
3. Generic: works for any extension, not just excalidraw.
4. No CDN URL left in the served page or its module graph (CSP proves it).
5. Deterministic rebuilds (manifest with source URL + digest per file).

**Non-goals (v1)**

- Automatic upstream updates (bumping a dep is an explicit rebuild).
- Runtime downloading from a CDN by the server (build-time only).
- Bundling/rewriting with a JS toolchain (see §4.7 option B).

---

## 3. Research findings (measured)

### 3.1 What excalidraw actually loads

Two very different kinds of payload, and only the first is an import graph:

| Kind | How it is reached | Measured size |
|---|---|---|
| **ES module graph** | `import` / `export … from` / `import("…")` from the entry stub | 73 URLs fetched = **1,174,519 B** in ~7 min, 0 errors, 49 URLs still queued ⇒ estimate **~120–160 files / ~2.5–4 MB** (incl. one **1,825,752 B** `es2022/dist/prod/subset-worker.chunk.mjs`) |
| **Runtime assets** | `EXCALIDRAW_ASSET_PATH` (4 refs in the entry module), `@font-face url(...)` in `index.css`, dynamic `import("./dist/prod/locales/*.mjs")` | npm `dist/prod` = **18 MB / 300 files** (`fonts` 14 MB, `locales` 1.7 MB) |

So the honest budget for excalidraw is **≈20 MB / ≈450 files**.

esm.sh serves *both* kinds (verified with GETs):

```
@excalidraw/excalidraw@0.18.1/dist/prod/index.css        200  144,689 B  text/css
@excalidraw/excalidraw@0.18.1/dist/prod/fonts/… .woff2   200    2,656 B  font/woff2
@excalidraw/excalidraw@0.18.1/es2022/dist/prod/subset-worker.chunk.mjs
                                                        200  1,825,752 B  application/javascript
…/es2022/dist/prod/locales/en-US-<hash>.mjs (guessed)    404       29 B  text/plain
```

→ the asset side **must be crawled from real references, never guessed** (the
404 above is a guessed locale hash).

### 3.2 URL shapes inside module bodies — the rewrite problem

`es2022/excalidraw.mjs` (970,262 B) contains 432 import specifiers:

| shape | count | example |
|---|---:|---|
| root-absolute `"/…"` | **373** | `"/node/process.mjs"`, `"/png-chunk-text@1.0.0/es2022/png-chunk-text.mjs"` |
| relative `"./…"` | **59** | `"./dist/prod/subset-worker.chunk.mjs"`, `"./dist/prod/locales/ar-SA-….mjs"` |
| `https://esm.sh/…` | 0 | — |
| bare specifier | 0 | — |

Consequences:

- **Relative specifiers need no rewriting** as long as we mirror the URL space
  1:1 — `"./dist/prod/x.mjs"` resolves against the mirrored module's own URL
  and lands inside the mirror.
- **Only root-absolute specifiers need a prefix.** That is the whole rewrite:
  `"/X"` → `"<mount>/X"`, in `from "…"`, `import "…"` and `import("…")` forms.
- **Query strings are part of the identity**: `/react@^17.0.2%20||%20^18.2.0%20||%20^19.0.0?target=es2022`.
  Go's `r.URL.Path` drops the query, so routing is unaffected, but the stored
  file name must match after decoding (see §4.3).

### 3.3 What the CDN does that we must design around

- **`?bundle` is not a single file.** `@excalidraw/excalidraw@0.18.1?bundle`
  returns a 1,440 B stub that still imports ~21 modules plus
  `/es2022/excalidraw.bundle.mjs`. Useful size win, not a graph elimination.
- **Version ranges are resolved per-requester**, so the graph can contain
  several variants of one package (`react@19.3.1`, `react@^18.3.1`,
  `react@>=17.0.0`, `react@^19.3.0-canary-…`). Mirror **exact URLs**; never
  "dedupe by package name" — dual React copies already exist upstream and
  collapsing them would change behaviour.
- **Almost no CDN URLs in code**: across all crawled modules only one
  non-import reference exists — `https://esm.sh/${oe.PKG_NAME…}` = Excalidraw's
  `ASSETS_FALLBACK_URL`. It becomes dead (and should be blocked by CSP) once
  assets are local.
- esm.sh sends `access-control-allow-origin: *` (our opaque-origin page needs
  CORS; our own handler must grant `Origin: null` the same way static does).

### 3.4 The sandboxed-page landmines

1. **`window.location.origin` is the literal `"null"`** for a sandboxed
   (opaque-origin) document. Excalidraw's `normalizeBaseUrl()` does
   `new URL(path.replace(/^\.?\/+/,""), window.location.origin)` for any
   `/`- or `./`-prefixed base → **a relative `EXCALIDRAW_ASSET_PATH` throws**.
   Today it works only because the base is a full `https://esm.sh/…` URL.
   ⇒ the local asset base must be an **absolute URL**, taken from
   `document.location.href` (readable — it is the URL, not the origin) or,
   better, injected server-side as `input.origin`.
2. **`buildExtensionInput` carries no origin today** — only
   `action, id, token, pane, method, url, query, params`. Adding `origin`
   (derived from `r.Host` + scheme, exactly like `extensionCSPFor` already
   does) is the clean fix.
3. **Wasm**: `chunk-EIO257PC.js` does `fetch("woff2.wasm")` and
   `WebAssembly.instantiate` / `instantiateStreaming` (2 + 2 occurrences).
   The fetch is a `connect-src` check against *our* mount, and wasm
   compilation needs `'unsafe-eval'` (already declared by excalidraw) or
   `'wasm-unsafe-eval'` (already an accepted source in `validCSPSource`).
4. **Module worker**: `new Worker(t, {type:"module"})` — the mount must be in
   `worker-src`, not just `script-src`.

### 3.5 Existing limits we have to stay inside

| Limit | Value | Where | Verdict for ≈20 MB / ≈450 files |
|---|---|---|---|
| static file body | 8 MiB | `extensionStaticMaxBody` | ✓ (largest module 1.83 MB) |
| static type allow-list | no `.wasm` | `extensionStaticTypes` | ✗ add if a dep really fetches `.wasm` |
| per-file install | 16 MiB (`MaxFileBytes`) | `pkg/install` | ✓ unpacked; a single `deps.zip` must compress to **< 16 MiB** |
| per-item install | 64 MiB (`MaxTotalBytes`) | `pkg/install` | ✓ (~20 MB) |
| file count | 4096 (`MaxFiles`) | `pkg/install` | ✓ (~450) |
| CSP sources | strict validator, no bare `*` | `validCSPSource` | ✓ mount origins pass as `https://host/…` paths |
| segment rules | no empty/dot/dotfile/backslash segments | `validateRelSegments` | ✓ esm.sh names (`@scope/`, `react@^17…`, `?target=`) pass; **`|` in `\|\|` is legal on POSIX but illegal on Windows filenames** |
| catalog download | one HTTP GET per file, 6 h tree cache | `pkg/install/catalog.go` | ✗ unpacked deps ⇒ ~450 fetches ⇒ **argument for one archive** |

---

## 4. Design

### 4.1 `package.json`

```json
"suwu": {
  "static": "public",
  "deps": "deps"
}
```

- `suwu.deps`: directory **inside the extension directory** holding the
  mirrored CDN tree (a dedicated subtree, same segment rules as `suwu.static`).
- Absent ⇒ no dep mount, no CSP changes (today's behaviour).
- Same fail-closed philosophy as the rest of the spec: bad value ⇒ the whole
  extension fails to resolve.

*(If the zip-at-rest container of §4.9 lands, this becomes
`"deps": "excalidraw.deps.zip"` and the backend extracts once — the JSON shape
does not change, only what the value points at.)*

### 4.2 URL space

`/gqjs/deps/<id>/<path>` — mirroring `https://esm.sh/<path>` exactly:

```
https://esm.sh/react@19.3.1/jsx-runtime?target=es2022
  → /gqjs/deps/excalidraw/react@19.3.1/jsx-runtime?target=es2022
https://esm.sh/@excalidraw/excalidraw@0.18.1/es2022/excalidraw.mjs
  → /gqjs/deps/excalidraw/@excalidraw/excalidraw@0.18.1/es2022/excalidraw.mjs
```

`/gqjs/deps/` matches the existing family (`/gqjs/ext/`, `/gqjs/api/`,
`/gqjs/static/`) rather than the ad-hoc `/extension/<id>/dep/` from the ask.

Keeping the URL path identical to the CDN's is what makes relative imports,
`import.meta.url` and `new URL(x, import.meta.url)` all stay inside the
mirror without any rewriting.

### 4.3 Serving

New `pkg/server/extension_deps.go`, modelled on `extension_static.go`:

- **GET/HEAD only**; `grantOpaqueOriginCORS(w, r)` (module fetches come from
  the opaque-origin page); **unauthenticated**, same contract as static:
  *"public, client-shipped source — never a secret"*.
- Path after the id validated with `validateRelSegments` (no traversal, no
  dotfiles, dedicated subtree) then resolved under the declared deps root.
- **Name mapping:** store files under a *filesystem-safe form* of the URL
  path: percent-encode only the characters that are illegal or ambiguous
  (`| < > : " ? * \` and `%`), because `react@^17.0.2||…` is fine on Linux and
  invalid on Windows. The handler applies the same normalization to the
  **decoded** `r.URL.Path` before lookup, so `/…/react@^17.0.2%20||…` and the
  stored name always agree. Query strings are ignored for lookup (Go already
  separates them).
- **Content types**: reuse `extensionStaticTypes` + add `.wasm`
  (`application/wasm`) if the smoke test shows one is fetched.
- **Caps**: same 8 MiB body cap (raise only if a dep exceeds it — the current
  max is 1.83 MB).
- **Caching**: `Cache-Control: public, max-age=31536000, immutable` when a
  manifest digest is present (paths are version-pinned), otherwise
  `no-cache` + `Last-Modified` → 304, exactly like static.

### 4.4 CSP

`extensionCSPFor` gains a fourth optional origin list next to the existing
`static`/`api` ones:

```go
deps := []string{
  "https://" + host + "/gqjs/deps/" + ext.ID + "/",
  "http://"  + host + "/gqjs/deps/" + ext.ID + "/",
}
```

appended to `script-src`, `style-src`, `font-src`, `img-src`, `worker-src`
and `connect-src` (the worker and `fetch("woff2.wasm")` need the last two;
**omitting either is a silent breakage** — the page renders, assets 404/CSP).

Everything else stays core: `default-src 'none'`, the sandbox directive, and
the extension's declared `suwu.csp` extras still layer on top.

### 4.5 Render input

Add `origin` to `buildExtensionInput` (and document it next to `token`):

```go
"origin": originOf(r),   // scheme + "://" + r.Host, same sanitizer extensionCSPFor uses
```

so an extension can build an absolute asset base:

```js
window.EXCALIDRAW_ASSET_PATH =
  `${input.origin}/gqjs/deps/${input.id}/@excalidraw/excalidraw@0.18.1/dist/prod/`;
```

Fallback for extensions that do not get it: `new URL(document.location.href)`
(must be used — `location.origin` is `"null"` in the sandbox; §3.4).

### 4.6 Manifest

`<deps dir>/manifest.json`, written by the builder:

```json
{
  "source": "esm.sh",
  "createdAt": "…",
  "seeds": ["https://esm.sh/@excalidraw/excalidraw@0.18.1"],
  "files": [
    { "path": "@excalidraw/excalidraw@0.18.1/es2022/excalidraw.mjs",
      "url": "https://esm.sh/@excalidraw/excalidraw@0.18.1/es2022/excalidraw.mjs",
      "bytes": 970262, "sha256": "…", "ct": "application/javascript" }
  ],
  "unresolved": []          // runtime references the crawl could not resolve
}
```

Purposes: integrity check at build time, cache-key/invalidation signal at
serve time, and the input for any future import-map strategy (§4.7).

### 4.7 Rewrite strategies — decision required

| | **R1 build-time rewrite** | **R2 serve-time rewrite** | **R3 generated import map** |
|---|---|---|---|
| what | rewrite `"/X"` → `"<mount>/X"` while writing files | same rewrite in the handler, per request | leave files byte-identical; inline `<script type="importmap">` generated from the manifest |
| file bytes == CDN bytes | ✗ (digest of source kept in manifest) | ✗ response differs, ✓ disk bytes | ✓✓ |
| runtime cost | none | regex over ≤1 MB/module, cacheable | none |
| needs extension HTML changes | yes (importmap/link/asset base) | yes | yes (importmap **must** be inline and pre-load) |
| id-coupling | baked in at build (rebuild if the id changes) | none | none |
| risk | regex false positives (`from "…"` inside a comment/string) — same risk in R2 | same, but unobservable until a request fails | import-map spec subtleties for `/`-leading specifiers — **unverified** |
| new server code | minimal (a static-like handler) | handler + cache | handler only |

**Recommendation: R1 for v1.** It keeps the runtime a plain static serve,
makes the rewrite verifiable once at build time (fail the build if any
root-absolute specifier survives), and the rewrite itself is identical code
to what R2 would run anyway. **R3 is the better end-state** (byte-identical
files, no mutation) but needs a 20-line spike first: serve a mirrored module
containing `import "/x"` under an import map with key `"/x"` and confirm the
browser consults the map for `/`-leading specifiers. Do the spike before
investing in R3; keep R1 working regardless.

**Option B (bundling) — worth stating:** run esbuild/rolldown at build time
and emit one bundled module per entry (+ copied `dist/**` assets). Then no
specifier rewriting exists at all, the graph collapses to 1–3 files, and
React identity is guaranteed single. Cost: a JS toolchain in the build path,
loss of "the bytes are exactly what the CDN served", and dynamic imports /
module workers still need real URLs. Recommend as **phase 3** if mirror
size or crawl time becomes the pain point.

### 4.8 Builder

A dev/CI-time tool (network required) — `scripts/build-extension-deps.mjs`
(Node, matching the repo's existing `scripts/*.mjs` checks) or a
`suwu ext-deps` subcommand if we want it shipped in the binary.

Algorithm:

1. **Seed** from `deps.config.json` in the extension dir:
   ```json
   { "source": "https://esm.sh",
     "seeds": ["https://esm.sh/@excalidraw/excalidraw@0.18.1"],
     "assets": ["https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/index.css"],
     "maxFiles": 600, "maxBytes": 41943040 }
   ```
2. **BFS the graph**: fetch each URL, parse import/export/dynamic-import
   string literals, resolve relative to the current URL and root-absolute
   against the CDN origin, enqueue. Skip already-seen (exact URL, query
   included).
3. **Expand assets**: for each `.css` seed, extract `url(…)` refs (fonts) and
   recurse; report anything referencing other origins.
4. **Store** under the filesystem-safe name of the URL path (§4.3).
5. **Rewrite** root-absolute specifiers (R1) in `.mjs`/`.js` only; verify no
   `https://<cdn>` and no unrewritten `from "/` survives (build fails otherwise).
6. **Report `unresolved`**: any `fetch("/…")`, `new Worker("/…")`,
   `https://cdn/…` string found outside import position (§3.3's
   `ASSETS_FALLBACK_URL` lands here — expected, documented).
7. **Write manifest** with sha256 per file, and the total/count budget.
8. **Smoke test** (phase 2): render the tile against the local mount with
   esm.sh unreachable (or blocked by CSP) and assert zero failed
   subresources — this is what catches runtime-only assets the crawl missed.

### 4.9 Packaging & distribution

Measured tension: **≈450 files** vs **catalog = 1 HTTP GET per file**.

| | Unpacked `deps/` in the extension package | Single `<id>.deps.zip` |
|---|---|---|
| git repo growth | 450 entries, ~20 MB (bad for history) | 1 file, ~12–16 MB (better) |
| `suwu install --github` | ~450 fetches | **1 fetch** ✓ |
| install limits | ✓ 64 MiB total / 4096 files | ✓ only if the zip compresses **< 16 MiB** (`MaxFileBytes`), else raise the cap |
| runtime | zero new code (already a directory) | must extract (once, atomic, into `extension-data/<id>/deps`, keyed by manifest digest) **or** read members from the zip |
| `suwu.static` reuse | possible if deps live under `public/deps/` | no |

**Recommendation:** ship **one archive** (the ask's instinct is right, and it
wins on catalog fetch count and git history), extracted **once, atomically**
into `<dataDir>/extension-data/<id>/deps/` on first resolve — a directory we
already create for `suwu.fs` — then served with the ordinary file path.
Keep unpacked-as-a-directory as the documented escape hatch for local
development (point `suwu.deps` at a directory and skip the archive).

Do **not** serve directly out of the zip in v1: `archive/zip` members are
deflate streams with no `ReaderAt`, so `http.ServeContent` (Range/304) would
need either full in-memory reads (1.8 MB × concurrency) or a pre-extract.

---

## 5. Phasing

**Phase 0 — spike (half a day, no product code)**
- Confirm relative `EXCALIDRAW_ASSET_PATH` really throws in the sandboxed
  frame (§3.4) and that `new URL(document.location.href).origin` works there.
- R3 import-map spike (§4.7): does `"/x"` consult the map?

**Phase 1 — MVP**
1. `pkg/extension`: `suwu.deps` + validation (`Extension.Deps`).
2. `pkg/server/extension_deps.go`: `/gqjs/deps/<id>/<path>` (§4.3).
3. `pkg/server/extension.go`: `extensionCSPFor` deps origins + `input.origin`.
4. Builder script + `deps.config.json` for excalidraw; generate `deps/`.
5. `examples/extension/excalidraw`: importmap, `<link>` and
   `EXCALIDRAW_ASSET_PATH` switched to `/gqjs/deps/excalidraw/…`; drop
   `"csp.script-src": ["https://esm.sh"]`.
6. Tests: resolve/CSP/route/path-validation (mirror `extension_static_test.go`),
   builder unit tests (rewrite + no-CDN assertion).

**Phase 2 — hardening**
- Archive packaging + atomic extraction into `extension-data`.
- Manifest digest → `immutable` caching; `suwu install` size accounting.
- Smoke test: render with esm.sh blocked, assert no failed subresource;
  feed `unresolved` back into seeds.
- `.wasm` content type if the smoke test asks for it.

**Phase 3 — optional**
- `suwu ext-deps` in the binary; import-map strategy (R3) if the spike
  passes; bundling (option B) if crawl/size becomes the pain point;
- de-duplicate identical mirrored files across extensions (share one
  content-addressed pool).

---

## 6. Risks & open questions

1. **`.wasm` + worker + font origins** are the classic "renders fine, assets
   blocked" traps — covered by CSP additions (§4.4) and the phase-2 smoke
   test; needs an explicit test each.
2. **Import-map semantics (R3)** are unverified — do not build on them until
   the spike says yes.
3. **`ASSETS_FALLBACK_URL`** points back at esm.sh inside Excalidraw; after
   the switch it must fail *silently* — confirm it is behind a try/catch, and
   that CSP blocking it does not surface an error toast.
4. **Size**: ~20 MB/extension is a lot to carry per extension; the shared
   content-addressed pool (phase 3) only helps across extensions, not
   upstream updates.
5. **Windows filenames** (`||`, `%20`) — §4.3 normalization; Linux/macOS are
   unaffected, and today's releases are Linux-only.
6. **Legal/licence**: bundling third-party JS/fonts into a shipped artifact
   requires licence attribution — add a `THIRD_PARTY_NOTICES` file generated
   from the manifest.

---

## 7. Test plan

- `pkg/extension`: `suwu.deps` accept/reject matrix (dedicated subtree, no
  dotfiles, no `..`, must exist), list/resolve propagation.
- `pkg/server`: route matrix (GET/HEAD only, unknown id, no `deps`, traversal,
  dotfile, 404, 413), CORS for `Origin: null`, content types incl. `.wasm`,
  query-string paths, CSP string contains the deps origins in
  `script-src` **and** `worker-src`/`connect-src`, and *does not* contain them
  when `suwu.deps` is absent.
- Builder: graph crawl on a tiny fixture (root-absolute + relative + query
  + cycle), rewrite produces no CDN URL and no bare `"/…"` specifier,
  budget exceeded ⇒ non-zero exit, manifest digests verify.
- Integration: render `excalidraw` with esm.sh unreachable (test server hosts
  the mirror) → canvas loads, font renders, worker starts.

---

## Appendix A — reproducing the research

```sh
# entry stub shape (29 root-absolute sibling imports + 1 re-export)
curl -s https://esm.sh/@excalidraw/excalidraw@0.18.1

# specifier census of the main module (373 root-abs / 59 relative)
curl -s https://esm.sh/@excalidraw/excalidraw@0.18.1/es2022/excalidraw.mjs -o m.mjs
grep -oE '(from|import)[( ]*"[^"]+"' m.mjs | sort | uniq -c | sort -rn | head

# ?bundle is not self-contained
curl -s 'https://esm.sh/@excalidraw/excalidraw@0.18.1?bundle' | head -30

# asset side (served raw by esm.sh)
curl -sI https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/index.css
curl -sI https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Excalifont/Excalifont-Regular-349fac6ca4700ffec595a7150a0d1e1d.woff2

# npm-side asset budget (what the mirror has to cover)
npm pack @excalidraw/excalidraw@0.18.1 && tar tzf excalidraw-0.18.1.tgz | wc -l
du -sh package/dist/prod/{fonts,locales}

# sandbox landmine: relative base throws
grep -o 'static normalizeBaseUrl[^}]*}' dist/prod/*.js
```

Crawl harness used for the numbers in §3.1: BFS over `from/import/import()`
string literals with a 10 s timeout, 8-way parallel, resuming across runs —
73 URLs / 1,174,519 B / 0 errors in ~7 minutes, 49 URLs still queued.
