# Extension Build Phase — Vite bundling instead of CDN mirroring

> **Status:** implemented (phase 1 + the phase-2 items listed in §8).
> `examples/extension/excalidraw` is bundled by Vite into a committed `dist/`,
> `suwu install --local <dir> [--build]` exists, the `suwu` manifest domain
> split is in, and static text assets are gzipped. Remaining: §8 phase 3.
>
> **Supersedes** `docs/EXTENSION_DEPS_PLAN.md` (mirror-the-CDN + rewrite
> specifiers). That approach needed a crawler, a manifest, an import-map or
> regex rewrite, ~450 mirrored files and a new `/gqjs/deps/` route. Building
> the extension like a normal JS project gets the same outcome — no CDN at
> runtime — with a tool the repo already uses (Vite 8), **zero new server
> routes**, and third-party code that is simply `dependencies` in
> `package.json` again.
>
> **Decisions taken** (from the request):
> 1. Vite 8 compiles the extension into `dist/`.
> 2. `package.json` gains a `build` script; output is a self-contained `dist/`.
> 3. esm.sh imports become ordinary npm dependencies.
> 4. `suwu install` copies `dist/` into the installed extension; `dist/` is
>    **committed** so `suwu install --github excalidraw` keeps working.
> 5. New `suwu install --local <path>` for installing from a checkout.

---

## 1. Why this is the better shape

| | CDN mirroring (`EXTENSION_DEPS_PLAN`) | **Build phase (this plan)** |
|---|---|---|
| output | ~450 files, ~20 MB, byte-identical to CDN | one `dist/`, hashed chunks |
| new server code | `/gqjs/deps/` route + manifest + CSP wiring | **none** (existing `suwu.static`) |
| specifier rewriting | regex/import-map, build-time or serve-time | **not needed** — Vite resolves it |
| deps declared as | JSON list inside an extension file | ordinary `dependencies` |
| offline | yes | yes |
| update path | re-crawl the CDN | `pnpm update` + rebuild |
| authoring | mirror + config | normal Vite project |

The only thing bundling costs us is "the served bytes are exactly what the CDN
served" — which is a property nobody needs, and the tree-shaking/locales
benefits go the other way.

---

## 2. Current state (measured)

`examples/extension/excalidraw` today: 44 KB, 5 files — `index.js` (render
stub, gqjs), `package.json`, `save.js` (API handler), `public/app.js`,
`public/page.css`. The page loads React + Excalidraw + ~100 transitive modules
and ~260 fonts from `https://esm.sh` at runtime, requiring
`"csp": { "script-src": ["https://esm.sh"] }`.

Upstream facts that drive the design (from the `@excalidraw/excalidraw@0.18.1`
tarball and esm.sh, measured):

| Fact | Value |
|---|---|
| `package.json` main/module/`exports.default` | `./dist/prod/index.js` (pre-bundled ESM, `production` condition picks prod) |
| peer deps | `react`, `react-dom` (`^17 || ^18 || ^19`) |
| runtime deps | 42 (radix, roughjs, pako, pica, jotai, …) — all normal npm |
| `dist/prod` payload | **18 MB / 300 files** (`fonts` 14 MB, `locales` 1.7 MB) |
| largest JS in `dist/prod` | `chunk-EIO257PC.js` 1.8 MB (font subsetting + `woff2.wasm`), `index.js` 492 KB, `chunk-K2UTITRG.js` 432 KB |
| `index.css` | 145 KB, `@font-face url("./fonts/Assistant/*.woff2")` |
| fonts referenced from JS | ~230 `"./fonts/<family>/<file>.woff2"` **string literals**, built at runtime |
| wasm | `"woff2.wasm"` fetched at runtime + `WebAssembly.instantiateStreaming` |
| worker | `new Worker(url, {type:"module"})`, chunk `subset-worker.chunk.js` |
| dynamic imports | `./dist/prod/locales/*.js` (111 refs), mermaid, pica, image-blob-reduce |
| `EXCALIDRAW_ASSET_PATH` | 4 references; `normalizeBaseUrl()` does `new URL(path, window.location.origin)` |

Repo install plumbing that matters:

- `extension.Resolve` validates `index.js` + `package.json` and the shape of
  `suwu.static`, but **never checks that the directory exists**.
- The manifest has **two owners today**: `pkg/extension` reads `name` /
  `description` from the top level, and `pkg/install/catalog.go`'s `enrich()`
  re-declares its **own** `struct{Name, Description string}` to read the same
  file. Two parsers, one contract — they are guaranteed to drift the moment a
  field moves (§3.3).
- All four example manifests put the display name in the npm `name` slot
  (`"Excalidraw"`, `"Hacker News Top Stories"` — neither is a legal npm
  name), and excalidraw's `"version": "0.18.1"` is the *vendored Excalidraw*
  version, not the extension's.
- `install` copies an archive/source tree wholesale; `noisePath` only skips
  `__MACOSX/` and `.DS_Store`, so `node_modules/`, `src/`, `vite.config.ts`
  would all be installed (and, via the catalog, downloaded one GET each).
- Limits: 4096 files, 16 MiB/file, 64 MiB/item; catalog download is
  **one HTTP GET per file**, tree API truncates on very large repos.
- `.gitignore` already ignores `/dist/` **only at the repo root**, so
  `examples/extension/*/dist/` is committable today with no .gitignore change.

---

## 3. Extension layout after the change

```
examples/extension/excalidraw/
  package.json          # npm project + Suwu manifest (one file, both jobs)
  vite.config.ts
  index.js              # gqjs render stub — server-side, NOT bundled
  save.js               # gqjs API handler — server-side, NOT bundled
  src/
    main.js             # the Vite entry (today's public/app.js)
    style.css           # today's public/page.css
  dist/                 # committed build output, served by suwu.static
    .vite/manifest.json # read by index.js at render time
    assets/app-<hash>.js
    assets/*.css
    fonts/…
  README.md
```

`public/app.js` and `public/page.css` disappear into `src/`; `suwu.static`
becomes `"dist"`. Nothing else in the extension contract changes.

### 3.1 One `package.json`, two jobs — with a clean domain split

The extension manifest **is** a package.json (that was the point of metadata
v2), so the build script just moves in. But once it is a real npm project the
top level must mean *npm* things only, and every Suwu setting must live under
`suwu` — today `name`/`description` are read from the top level and are both
npm fields *and* the tile's display name, which cannot hold once the same file
also has `dependencies`, `scripts` and a real npm identity.

```json
{
  "name": "suwu-excalidraw",
  "version": "1.0.0",
  "private": true,
  "description": "Suwu tile that edits .excalidraw files on the server",
  "license": "MIT",
  "scripts": { "build": "vite build" },
  "dependencies": {
    "@excalidraw/excalidraw": "0.18.1",
    "react": "19.3.1",
    "react-dom": "19.3.1"
  },
  "devDependencies": { "vite": "^8.2.0" },
  "suwu": {
    "name": "Excalidraw",
    "description": "Hand-drawn style whiteboard that opens and saves .excalidraw files",
    "version": "1.0.0",
    "static": "dist",
    "fs": true,
    "api": [{ "route": "/save", "handler": "save.js" }],
    "fileExtensions": [".excalidraw"]
  }
}
```

Note how the split removes a real ambiguity: the old top-level
`"version": "0.18.1"` was the **vendored Excalidraw** version sitting in the
slot npm expects to hold this package's own version. After the split the
upstream version lives only in `dependencies` and `suwu.version` is the
extension's own.

`suwu.csp.script-src: ["https://esm.sh"]` **goes away** — that is the whole
point. `'unsafe-eval'` stays only if the mermaid/TTD path is kept (it is
needed for wasm; `'wasm-unsafe-eval'` is the narrower alternative already
accepted by `validCSPSource`).

### 3.2 `vite.config.ts`

```ts
export default defineConfig({
  root: __dirname,
  publicDir: false,                  // nothing needs copying verbatim…
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    manifest: true,                  // index.js reads dist/.vite/manifest.json
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: 'src/main.js',
      output: {
        entryFileNames: 'assets/app-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
```

The entry is a plain ES module (`src/main.js` = today's `public/app.js`
importing `@excalidraw/excalidraw`), so Vite resolves the 42 dependencies the
same way it already does for `frontend/`.

**Code splitting stays on — the archive is what bounds the file count.** Vite's
default output preserves every dynamic `import()`, and Excalidraw has a lot:
**70 i18n chunks (1.36 MB)** and **33 mermaid/diagram chunks (1.75 MB)**, 162 JS
files in `dist/assets` total. That used to be the argument for
`inlineDynamicImports`, but with `suwu.static: "dist.zip"` (§5) the chunk count
costs nothing: the whole tree is **one blob** in the repository, in the install
payload and in the catalog. So the split is kept and the lazy loading is real:

| | one bundle (measured) | code split (shipped) |
|---|---:|---:|
| first paint (entry + CSS, gzipped) | 2.52 MB | **0.45 MB** |
| everything fetched | always | only what a locale/diagram needs |
| blobs in the repo | 1 (`dist.zip`) | 1 (`dist.zip`) |

(An earlier revision set `inlineDynamicImports: true`; the archive removed the
only reason for it. The module worker is a 348 B re-export chunk now, which also
avoids the `data:` URL worker that inlining produced.)

`extensionStaticMaxBody` was still raised 8 → 16 MiB (matching `MaxFileBytes`):
the largest single chunk is the 1.8 MB font-subsetter, but a future inlined
bundle must not be able to exceed what install allows.

### 3.3 The `suwu` domain — all Suwu settings, one place

After the split the top level is *only* npm's business (`name`, `version`,
`private`, `description`, `license`, `scripts`, `dependencies`,
`devDependencies`, `packageManager`, …) and `suwu` is *only* Suwu's.

**Field table (final contract)**

| `suwu` key | Type | Default | Meaning | Status |
|---|---|---|---|---|
| `name` | string | id | Tile/picker display name | **moved** from top level |
| `description` | string | `""` | One-line description in the picker/App Menu | **moved** from top level |
| `version` | string | `""` | Extension's own version (informational) | **moved** (was top-level, held the vendored lib version) |
| `static` | string | `""` | Public asset subtree (`dist` after the build phase) | existing |
| `params` | array | `[]` | Documented launch params | existing |
| `api` | array | `[]` | Ordered `{route, handler}` registrations | existing |
| `fileExtensions` | array | `[]` | File suffixes claimed for the notification resolver | existing |
| `net` | bool | `false` | Scripts may use `fetch()` | existing |
| `fs` | bool | `false` | Scripts get `/ext-data` + `/fs` mounts | existing |
| `csp` | object | `{}` | Additive CSP sources | existing |
| `sandbox` | array | `[]` | Allow-listed extra iframe sandbox tokens | existing |
| `install.include` | array | `[]` | Extra payload globs for install (build plan §6.1) | new |

Deliberately **not** in `suwu`:

- `license` — a real npm field, and the source for the generated
  `THIRD_PARTY_NOTICES` (§9.6).
- `id` — identity is the **directory name**; install must not be able to
  rename an item via its contents. `suwu.id` is ignored (documented), so a
  hand-copied `@scope/name` npm package cannot claim another extension's id.

**Resolution rules**

- id: directory name (unchanged).
- name: `suwu.name` → top-level `name` *(deprecated fallback)* → id.
- description: `suwu.description` → top-level `description`*(deprecated)* → `""`.
- version: `suwu.version` → `""` (do **not** fall back to the npm `version`:
  that number describes the package, not the tile).

The deprecated top-level fallbacks keep already-installed extensions looking
right (an un-updated `hn-top-stories` still shows "Hacker News Top Stories"
instead of `hn-top-stories`). They get removed one release after every bundled
and example extension has migrated — say **0.1.18** — at which point the
reader drops to `suwu.*` only.

**Validation** (fail-closed, like the rest of the manifest): type mismatch,
control characters, or over-long values fail `Resolve` for the whole
extension. Caps: name ≤ 64 runes, description ≤ 200, version ≤ 32. Values are
`strings.TrimSpace`d; empty-after-trim is treated as absent.

**Code changes**

1. `pkg/extension/extension.go`
   - `packageJSON` → keep `Name`/`Description` but mark deprecated; read
     display fields from `suwuSpecs` (`Name`, `Description`, `Version`).
   - `Resolve` applies the precedence above and runs `normalizeDisplay()`.
   - `Extension` gains `Version string \`json:"version,omitempty"\`` so the
     API can expose it later; `/api/extensions` shape stays additive.
2. **Kill the duplicated parser.** `pkg/install/catalog.go`'s `enrich()`
   re-declares its own `struct{Name, Description string}` and would silently
   drift the moment the fields move. Export one reader from `pkg/extension`
   (`ReadManifest(path) (Manifest, error)` returning the *resolved* display
   fields) and have `enrich` call it — one source of truth, one test.
3. Doc comments: `pkg/extension` package doc and `PackageFile` comment say
   "npm-style name/description at the top level" — invert them.
4. Frontend: nothing. `/api/extensions` still returns `{id, name,
   description, …}`; the App Menu and picker read the same keys.

**Migration list** (mechanical, one commit)

- `examples/extension/{excalidraw,eye,hn-top-stories,note}/package.json` —
  move `name`/`description` under `suwu`, add `suwu.version`, keep `license`
  and the new npm fields (`private`, `scripts`, deps) only where the
  extension is built.
- Test fixtures that inline a package JSON string:
  `pkg/extension/extension_test.go`, `csp_test.go`, and
  `pkg/install/{install,archive,catalog}_test.go`.
- Docs that assert the old rule: `docs/EXTENSION_API_PLAN.md` (§1 example +
  the “No duplication” bullet), `docs/EXTENSION_TILE_PLAN.md`,
  `examples/extension/README.md`.

**Tests**

- `suwu.name` wins; top-level `name` fallback; both absent → id.
- `suwu.version` does **not** inherit the npm `version`.
- caps/control chars/type mismatch ⇒ `Resolve` error; whitespace trimmed.
- `catalog.enrich` returns the same name/description as `extension.Resolve`
  for the same file (this is the anti-drift test).

---

## 4. The four things Vite will *not* do for us

These are the real work items; each needs an explicit test.

### 4.1 Fonts (`url()` in CSS + runtime string literals)

- `@excalidraw/excalidraw/index.css` carries `url("./fonts/Assistant/…")` →
  Vite rewrites and emits those into `dist/assets/`.
- The ~230 other font URLs are **string literals built at runtime** from a
  family→file map; Vite cannot see them, and the file names are content-hashed
  upstream (`Excalifont-Regular-349fac6c….woff2`).
- Fix: copy `node_modules/@excalidraw/excalidraw/dist/prod/fonts/**` verbatim
  into `dist/fonts/` in a small `closeBundle` hook (≈10 lines), and set
  `EXCALIDRAW_ASSET_PATH` so those literals resolve into that folder.
- Size: the full set is **14 MB**; shipping only the four CSS-referenced
  `Assistant` faces is ~200 KB but breaks the handwritten families. Recommend
  shipping the full set for excalidraw (fonts are immutable, cached forever)
  and documenting a `--fonts=all|css` knob if repo size becomes a problem.

### 4.2 `EXCALIDRAW_ASSET_PATH` must be absolute — and must be *right*

In the sandboxed tile `window.location.origin === "null"`, and
`normalizeBaseUrl()` feeds `/`-leading paths into `new URL(path, origin)` —
so a relative base **throws**. Today it works only because the base is a full
`https://esm.sh/…` URL.

Fix: set it from an absolute URL built at runtime, from *two* places so neither
can be silently wrong:

```js
// index.js, inline classic script in <head>, before the module:
window.EXCALIDRAW_ASSET_PATH =
  new URL("/gqjs/static/<id>/", document.location.href).href;

// src/main.js, as a fallback (no relative specifier — see the trap below):
const u = new URL(import.meta.url);
u.pathname = u.pathname.replace(/assets\/[^/]*$/, "");
window.EXCALIDRAW_ASSET_PATH = u.href;
```

**Trap, found the hard way:** `new URL("../", import.meta.url)` is rewritten by
Rolldown into a reference to a *sibling output file* (`index-<hash>.js`), which
made the base `…/assets/index-….js` → every font URL 404 → Excalidraw fell back
to its hardcoded CDN candidate → CSP blocked it → "font loading failed because
csp". `createUrls()` always appends that CDN candidate
(`r.push(new URL(n, ASSETS_FALLBACK_URL))`), so it is only ever *fetched* when
the local URL fails — the symptom is the CSP errors, the cause is the base.

(Optional server assist: add `origin` to `buildExtensionInput` — it carries
`action, id, token, pane, method, url, query, params` today, no origin. Nice
for other extensions, not required for this one.)

### 4.3 `woff2.wasm`

Fetched at runtime by the font-subsetting module and compiled with
`WebAssembly.instantiateStreaming`. Two consequences:

- **server**: `extensionStaticTypes` has no `.wasm` → the request 404s. Add
  `.wasm: "application/wasm"` (one line, plus a test). This is the *only*
  `pkg/server` change in this plan.
- **CSP**: `connect-src`/`script-src` already include our static origin, and
  the wasm compile needs `'unsafe-eval'` or `'wasm-unsafe-eval'` — already
  declared by excalidraw.

### 4.4 Module worker

`new Worker(url, {type:"module"})` needs `worker-src` to include the static
origin — `extensionCSPFor` already appends the static origin to `worker-src`
when the extension declares it. Verify in the smoke test; Excalidraw falls
back to the main thread if worker creation fails, so a failure here degrades
export performance, not correctness.

---

## 5. Serving — no new route

`suwu.static` is served by the existing `/gqjs/static/<id>/<path>` handler, and
the value may be **either a directory or a zip archive**
(`"static": "dist.zip"`). Added with this phase, because a built extension is
hundreds of small files:

| What | Files | On disk |
|---|---:|---:|
| `dist/` directory (one bundle per file) | 241 | 21 MB |
| `dist.zip` (deflated text, stored binaries) | **1** | **15 MB** |

The archive is built by `pack-static.mjs` in the extension (no dependencies, fixed
timestamps → byte-reproducible), which also writes `build.json` next to it: the
gqjs sandbox cannot read inside a zip, so the render stub reads the hashed entry
name from that file. `install` skips the unpacked tree next to its archive, so
excalidraw installs as **6 files / 15 MB** instead of 401 files / 20 MB.

Serving accepts both sources with the same guarantees:

- **Path safety is identical.** Request segments are validated before anything
  is joined or looked up, and an entry whose *name* is `../../etc/passwd` simply
  never matches a validated path — tested both ways.
- **Content types** come from the same allow-list (so `package.json`, `.env`
  and unknown suffixes are still 404 inside the archive).
- **HEAD, Range (206) and `If-Modified-Since` (304)** still work: the entry is
  read whole and handed to `http.ServeContent`; the compressed-text path keeps
  its own validator (`Last-Modified` = entry mtime, so a rebuild invalidates).
- **gzip** applies exactly as before (measured on the archive: 7,844,174 →
  2,520,893 B on the wire).
- **Containment:** the archive itself must resolve inside the extension
  directory (a symlinked `dist.zip` pointing elsewhere fails `Resolve`).

And for the directory source:

1. **`Resolve` must validate the declared directory exists** (`os.Stat` +
   is-a-dir). Today a source-only install (no `dist/`) resolves fine and then
   serves 404s for every asset — a confusing failure we would hit constantly
   once `dist/` becomes a build artifact. Fail resolution with a message that
   names the missing directory.
2. The static handler's 8 MiB/file cap is above our largest chunk (1.8 MB). ✓
3. Cache: `dist/assets/*-[hash]` is immutable; the handler currently sends
   `no-cache` + `Last-Modified`. Optional improvement: `immutable,
   max-age=31536000` for paths matching the hashed asset pattern. Not required
   for v1 (revalidation is a 304, cheap on a LAN).

### 5.1 gzip for text assets (required)

A Vite build makes the JS/CSS payload much bigger than today's small
hand-written files, so the server must compress. The repo already knows the
numbers: the app's own production build reports

```
pkg/assets/web/assets/index-<hash>.js        5,713.57 kB │ gzip: 1,497.36 kB   (74% off)
pkg/assets/web/assets/fileViewerPeleMermaid-<hash>.js
                                               698.46 kB │ gzip:   257.86 kB   (63% off)
```

A bundled Excalidraw entry lands in the same range. **Nothing in the tree
compresses today** — `grep gzip pkg/server` is empty.

**Three serving paths, one helper.** Add `pkg/server/compress.go` and use it
from all of them, so the rules cannot drift:

| path | handler | today |
|---|---|---|
| app assets (`/assets/*`, `/index.html`) | `serveAsset` | `io.ReadAll` into memory, `Cache-Control: no-store`, identity |
| extension static (`/gqjs/static/<id>/*`) | `extension_static.go` | `http.ServeContent`, `no-cache` + `Last-Modified`/304 |
| background static (`/backgrounds/webgpu/<id>/*`) | `handleBackgroundStatic` | same shape as extension static |

**Strategy: compress once per file, cache the result.** For each of these
paths the file is immutable for a given `(path, size, mtime)` — app assets are
embedded and never change while the process lives. So:

```go
// compress.go
func acceptsGzip(r *http.Request) bool          // parses Accept-Encoding, honours gzip;q=0
func compressibleType(ext string) bool          // js/mjs/css/html/json/svg/txt/map/wasm
func gzipped(key string, src []byte) ([]byte, bool)  // bounded cache, sync.RWMutex
```

- **Cache**: `sync.Map`-style map keyed by `name + size + mtimeUnixNano`, with
  a global byte budget (start at **32 MiB** compressed, largest entry 8 MiB —
  the same cap the handler already enforces) and an oversized-entry bypass
  (stream with a pooled `gzip.Writer` instead of caching).
- **Serve**: set `Content-Encoding: gzip`, `Vary: Accept-Encoding`, keep
  `Content-Type`/`nosniff`, and set an accurate **`Content-Length`** (that is
  the whole point of caching: no chunked encoding, progress bars keep working).
- **Correctness gate — always send `Vary: Accept-Encoding`** for compressible
  types even when answering identity, or a proxy/CDN can hand the gzipped bytes
  to a client that did not ask for them.
- **Skip** (fall back to today's behaviour): non-GET/HEAD, `Range` request
  present (`http.ServeContent` owns byte ranges and a gzip stream would break
  them), already-compressed types (`.png .webp .ico .woff2 .zip .gz`), bodies
  under **1 KiB** (no win, adds a header), and any response that already set
  `Content-Encoding`.
- **Level**: measure, do not guess — on this repo's 5.7 MB app bundle
  (Python's zlib via `gzip.compress`, one shot):

  | level | size | ratio | time |
  |---|---|---|---|
  | 1 (BestSpeed) | 1,797,508 B | 31.5% | 55 ms |
  | 6 (Default) | 1,479,836 B | 25.9% | 142 ms |
  | 9 (Best) | 1,474,223 B | 25.8% | 218 ms |

  Level 9 buys 0.1% over 6 for +54% time — pointless. Level 1 is 3× faster but
  21% larger. Since the cost is paid **once per file per boot** (then cached),
  use **DefaultCompression (6)**, and drop to `BestSpeed` only if a future
  8 MiB chunk makes the first-request latency visible. The same measurement on
  the Excalidraw entry module (970,262 B) gives 358,471 / 311,178 / 309,574 B
  for levels 1/6/9 — same conclusion.
- **`.wasm` is included**: it gzips ~50%, and `WebAssembly.instantiateStreaming`
  is unaffected — the browser decodes `Content-Encoding` before the MIME check,
  and the type stays `application/wasm`.

**Rejected alternative: committed `.gz` sidecars.** `dist/` is committed (§7),
so build-time precompression would double the blob count (≈300 → ≈600 per
extension), add churn to every rebuild, and force the GitHub catalog to
fetch twice as many files. A runtime cache pays the cost once per boot and
keeps the repo clean.

**Security: do NOT gzip the extension render HTML.** The render page embeds
the extension-scoped token *and* echoes caller-controlled input into the same
response (`?file=` → `window.__SUWU_FILE__`). Compressing attacker-influenced
text next to a secret in one response is exactly the BREACH oracle. The page is
only a few KB, so the rule is simple and absolute: **static assets compress;
anything carrying a token does not.** Add a test asserting
`/gqjs/ext/<id>` never returns `Content-Encoding`.

**Bonus win spotted while measuring:** `serveAsset` sends
`Cache-Control: no-store` for *every* asset, so the app re-downloads its full
5.7 MB bundle on every page load. Switch hashed files (`assets/*-[hash].*`) to
`public, max-age=31536000, immutable` and keep `no-cache` (revalidate) for
`index.html`. Verify against the auth model first — these URLs are served
before the token check today, so caching them changes nothing security-wise,
but the plan should assert it rather than assume.

**Expected effect** on a cold tile load of the bundled Excalidraw (est. from
§3/§4 payload sizes): entry+chunks ≈ 5–8 MB → **≈1.5–2.5 MB** on the wire, with
fonts (`woff2`) deliberately excluded because they are already compressed.

**Verify:** `curl -sI -H 'Accept-Encoding: gzip' <asset>` shows
`content-encoding: gzip` and a content-length near the Vite-reported gzip size;
`curl -s --compressed <asset> | wc -c` matches the original byte count (round
trip); `curl -sI <asset>` (no header) shows no `content-encoding` but still
`vary: Accept-Encoding`; a `Range` request still gets `206`.

---

## 6. Install changes

### 6.1 Payload rule (shared by all three sources)

Today install copies everything; with npm projects that would drag
`node_modules/`, `src/`, `vite.config.ts`, lockfiles into the data dir and —
worse — make the GitHub catalog download every one of them (one GET per file).

Add to `pkg/install` one **payload rule**, applied by archive, catalog and
local installs alike:

```
include:  package.json, index.js, <suwu.static>/**      (always)
          README.md, LICENSE, THIRD_PARTY_NOTICES      (small, useful)
          suwu.install.include globs                   (opt-in extras)
exclude:  node_modules/**, src/**, .git/**, dist/.vite/**, *.config.{js,ts,mjs},
          pnpm-lock.yaml, package-lock.json, yarn.lock, .gitignore, tsconfig*.json
```

`dist/.vite/` is excluded because the manifest is a build-time artifact — but
see §7 note: `index.js` reads the manifest at render time, so **it must be
installed**; keep `.vite/manifest.json` and only drop sourcemaps/hashes.
(Simplest: exclude nothing under `dist/**`.)

The rule lives in one function with unit tests, so the three paths cannot
drift.

### 6.2 `suwu install --local <path>`

```
suwu install --local <dir> [--build] [--force] [--dry-run] [--kind <kind>]
```

- Reads `<dir>/package.json` (`suwu` object) for the id (directory name),
  validates with `extension.Resolve` after staging.
- `--build` runs the package's `build` script first (detect `pnpm`/`npm` via
  the lockfile present: `pnpm-lock.yaml` → `pnpm`, `package-lock.json` →
  `npm`; export a clear error if neither tool is on PATH).
- Without `--build`: if a `build` script exists and `<suwu.static>` is missing
  → **error**, "run `suwu install --local <dir> --build` or build first".
- Stages via the existing `Stage`/`Commit` (atomic rename, no server restart),
  so `--force`, `--dry-run` and validation behave exactly like a zip install.
- Prints what the payload rule skipped, e.g.
  `skipped: node_modules (1 342 files), src (6 files)`.
- `--local` with a *background* directory works too (`--kind background`).

CLI wiring is small: a `local string` flag, one more branch in `installCmd`,
plus `checkModes` (mutually exclusive with `--github`/`--extension`/
`--background`) and the `valueFlags` map (`local`, `kind` already there).

### 6.3 Catalog — dist is committed, so this keeps working

Since `examples/extension/*/dist/` is committed:

- `suwu install --github excalidraw` keeps working with **no catalog code
  change beyond the payload rule** (`collect()` already walks every blob under
  `examples/extension/<id>/`).
- Cost: excalidraw becomes ~40 files → ~40 GETs (JS/CSS/fonts as bundles), or
  a few hundred if the full font set ships. Acceptable; `--extension <zip>`
  and `--local` remain the fast paths.
- Watch out: GitHub's tree API truncates on very large repos, and `install`
  already errors out with "the repository tree is too large to enumerate".
  Committed `dist/` adds ~300 blobs to `examples/`. If that flips the tree
  over the limit, the fallback is a release-asset channel (out of scope here,
  noted as a risk).
- The catalog reads `package.json` for name/description (`enrich`) — unchanged.

### 6.4 Build orchestration

Add to the root `package.json`:

```json
"build:ext": "pnpm --dir examples/extension -r --if-present run build",
"check:ext-dist": "pnpm run build:ext && git diff --exit-code -- examples/extension/*/dist"
```

`examples/extension/` becomes a tiny pnpm workspace root
(`pnpm-workspace.yaml` with `packages: ["*"]` + a private `package.json`
holding shared devDeps: `vite`, `@vitejs/plugin-react` if needed), so one
`pnpm --dir examples/extension install` covers every extension and
`node_modules` stays out of each extension dir where possible.

⚠️ Files directly under `examples/extension/` (`package.json`,
`pnpm-workspace.yaml`, `pnpm-lock.yaml`, `node_modules/`) are **not** valid
catalog ids (the collector requires `examples/extension/<id>/<file>`, so a
one-segment path is skipped) — but per-extension `node_modules/` symlinks
*pnpm* creates **would** be collected. That is exactly what §6.1's exclude
list prevents; make sure it is applied in `collect()` too.

---

## 7. Repo hygiene for committed `dist/`

- `.gitattributes`:
  ```
  examples/extension/*/dist/** -diff linguist-generated=true
  ```
  keeps build output out of diffs and out of language stats.
- `check:ext-dist` (above) in CI: a PR that edits `src/` without rebuilding
  fails with a message telling the author to run `pnpm run build:ext`.
- Sizes: today `examples/extension` is 252 KB / 32 files. After this:
  excalidraw ≈ 5–8 MB JS+CSS + fonts (14 MB full set, ~1 MB CSS-only) + fonts
  are the only large item; the other three examples stay tiny (no deps, no
  build — `eye`/`note`/`hn-top-stories` keep working as source-only
  extensions).
- Decision to revisit later: gitignoring `dist/` and publishing prebuilt zips
  as release assets (cleaner history, needs a catalog change).

---

## 8. Phasing

**Phase 0 — spike (half a day, throwaway branch)**
Build today's `public/app.js` through Vite against real npm deps and confirm
in a live tile: canvas renders, fonts load, `woff2.wasm` is fetched (add the
MIME type first), the subset worker starts, and export/save still work. This
is the go/no-go: if `EXCALIDRAW_ASSET_PATH` + the copied `fonts/` tree cannot
be made to work, the fallback is the mirroring plan for fonts only.

**Phase 1 — manifest split, then excalidraw converts (the template)**
0. `suwu` domain split (§3.3): move the display fields, export
   `extension.ReadManifest`, delete the duplicate struct in `catalog.enrich`,
   migrate the four examples + fixtures + docs. Do this **before** the
   excalidraw conversion so its `package.json` is rewritten once.
1. `src/` layout + `vite.config.ts` + `package.json` build script.
2. Font/wasm copy step (§4.1/§4.3) + absolute `EXCALIDRAW_ASSET_PATH` (§4.2).
3. `index.js` reads `dist/.vite/manifest.json` through the existing read-only
   `/ext` mount and injects the hashed `<script>`/`<link>` into the HTML shell.
4. Drop `suwu.csp.script-src`, keep `'unsafe-eval'`/wasm.
5. `pkg/server`: `.wasm` MIME type + `Resolve` validates the static dir.
6. Commit `dist/`.

**Phase 2 — install**
1. Payload rule + tests (§6.1).
2. `suwu install --local <path> [--build]` (§6.2) + docs/`suwu help install`.
3. `examples/extension` workspace + `build:ext` + `check:ext-dist` + CI.
4. Verify `suwu install --github excalidraw` still works end to end.
5. **gzip** (§5.1): `compress.go` + the three static paths + the "never gzip
   a token-bearing page" test. Land it *before* the excalidraw `dist/` is
   committed, so the first bundled extension is already served compressed.
6. `immutable` caching for hashed app assets (§5.1).

**Phase 2.5 — shipped with this phase**
- `suwu.static` may name a `.zip`; `pkg/extension/static.go` resolves either
  source (`StaticKind`, `StaticAsset`), the handler serves both, and
  `pack-static.mjs` + `build.json` make a bundled extension installable as one
  file (§5).

**Phase 3 — optional**
- Hashed-asset `immutable` caching in the static handler.
- `suwu.static` build-stamp check (refuse to install a `dist/` older than
  `src/`).
- Prebuilt release assets if committed `dist/` gets noisy.

---

## 9. Risks & open questions

1. **Vite + a pre-bundled dependency.** `@excalidraw/excalidraw` ships an
   already-bundled `dist/prod/index.js` with its own chunk/worker/locale URLs.
   Vite prebundles it as a dep; locale dynamic imports may be **inlined**
   (+1.7 MB across all languages) or preserved. Either is acceptable, but the
   size must be measured, and locale tree-shaking needs an explicit decision
   (e.g. alias `./dist/prod/locales/*` to a stub to ship English only).
2. **Worker path rewriting** (§4.4) is the most likely silent breakage;
   Excalidraw degrades gracefully, so assert it in the spike rather than
   assume.
3. **Fonts**: 14 MB committed, or a reduced set with fallback fonts. Needs a
   product call.
4. **Repo growth / review noise** — mitigated by `.gitattributes` +
   `check:ext-dist`, not eliminated.
5. **Catalog scale**: ~40–450 extra blobs in `examples/`; watch the GitHub
   tree truncation limit.
6. **Licensing**: bundling third-party code into the repo/extension still
   needs attribution → generate `THIRD_PARTY_NOTICES` in the build (from
   `dependencies`), and ship it in the payload.
7. **gzip oracles**: compressing token-bearing render HTML next to reflected
   input (`?file=`) is a BREACH risk — §5.1 bans it outright. Keep the ban
   when any future page injects secrets.
8. **Two homes for “name” for one release.** The deprecated top-level
   fallback (§3.3) means a stale extension keeps its pretty name, at the cost
   of two code paths until 0.1.18. If a clean cutover is preferred, drop the
   fallback and accept `hn-top-stories`/`eye` showing their ids until
   reinstalled — a visible, self-correcting nudge.

---

## 10. Test plan

- `pkg/extension`: `suwu.static` pointing at a missing directory ⇒ Resolve
  error; pointing at `dist` ⇒ OK; still rejects `"."`/`..`/dotfiles.
- `pkg/extension`: display-field precedence and validation matrix (§3.3),
  and `ReadManifest` used by the catalog returns identical name/description.
- `pkg/server`: `.wasm` served as `application/wasm`; unknown types still 404;
  CSP for a built extension contains **no** CDN origin and still lists the
  static origin in `script-src`/`worker-src`/`connect-src`.
- `pkg/server` gzip (§5.1): `acceptsGzip` parsing matrix (`gzip`, `gzip;
  q=0`, `identity`, missing, uppercase/multi-value); compressible-type set;
  identity when no header **with** `Vary: Accept-Encoding`; `Range` bypass;
  sub-1 KiB files served identity; round trip (gunzip of the response equals
  the on-disk bytes); `Content-Length` equals the cached gzip size; `304`
  still works; `HEAD` sends headers and no body; cache budget evicts; and
  `/gqjs/ext/<id>` (token-bearing) is **never** compressed.
- `pkg/install`: payload rule matrix (include `package.json`/`index.js`/
  `dist/**`; exclude `node_modules`, `src`, lockfiles, configs) applied
  identically by archive, catalog collect and `--local`; `--local --build`
  runs the script and then installs; `--local` without a build script installs
  source-only extensions unchanged.
- `cmd/Suwu`: flag exclusivity for `--local`, `--dry-run` output, exit codes.
- Manual smoke (must-pass): tile renders with the network offline, fonts
  render (not fallback), export downloads a PNG, save writes the file.

---

## Appendix — measured facts & reproduction

```sh
# upstream resolution + payload
npm pack @excalidraw/excalidraw@0.18.1
tar xzf excalidraw-0.18.1.tgz package/package.json
python3 -c "import json;d=json.load(open('package/package.json'));print(d['exports']['default'])"
tar xzf excalidraw-0.18.1.tgz
du -sh package/dist/prod package/dist/prod/{fonts,locales}     # 18M / 14M / 1.7M
ls -S package/dist/prod | head                                  # 1.8M … 432K

# runtime-only references Vite cannot see
grep -o 'woff2\.wasm' package/dist/prod/*.js
grep -o '"\./fonts/[^"]*woff2"' package/dist/prod/*.js | wc -l   # ~230
grep -o 'new Worker([^)]*' package/dist/prod/*.js
grep -o 'EXCALIDRAW_ASSET_PATH' package/dist/prod/*.js | wc -l   # 4
grep -o 'static normalizeBaseUrl[^}]*}' package/dist/prod/*.js

# repo-side facts
grep -n "noisePrefixes\|noiseFile" pkg/install/archive.go        # only __MACOSX/.DS_Store
grep -n "MaxFiles\|MaxFileBytes\|MaxTotalBytes" pkg/install/install.go
grep -n "extensionStaticTypes" -A 22 pkg/server/extension_static.go   # no .wasm
du -sh examples/extension/*                                      # 44K excalidraw today

# what compression buys (numbers quoted in §5.1 are from this repo's own build)
pnpm build:web 2>&1 | grep -E 'gzip:' | sort -t'|' -k2 -h | tail -5

grep -rn gzip --include='*.go' pkg/server cmd/Suwu | grep -v _test   # empty today
sed -n '497,530p' pkg/server/server.go     # serveAsset: no-store + identity
```
