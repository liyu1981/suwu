# Example extensions

These are the extensions the **catalog** offers. Install them from a terminal:

```sh
suwu install --github eye note hn-top-stories excalidraw
```

`suwu install` with no arguments opens a picker instead, and `--list` prints
the catalog without installing anything. Everything lands in
`$SUWU_VAR/extension/<id>/` (default `~/.suwu/extension/`) and the server
reads that directory per request, so nothing needs a restart. The tab picks it
up the next time you open System Settings, which re-reads the list.

To install from a local checkout instead — the normal dev loop — point
`--local` at the directory. It stages `package.json`, `index.js` and the built
asset tree, skipping build inputs (`node_modules/`, `src/`, lockfiles,
`*.config.*`), so a working tree installs cleanly. `--build` runs the item's own
build script first (pnpm when `pnpm-lock.yaml` is present, else npm):

```sh
suwu install --local examples/extension/excalidraw --build --force
suwu install --local examples/extension/eye --force      # no build step
```

A zip works too (`suwu install --extension <file.zip>` expects
`extension/<id>/…` inside it) and follows the same payload rule. Extensions with
a build are ordinary JS projects:

```sh
pnpm -C examples/extension install      # once, for the whole workspace
pnpm -C examples/extension build        # every extension that has a build script
```

Then enable the **extension** plugin in App Menu settings (it is off by
default) and add an Extension tile whose `id` is the directory name
(`eye`, `hn-top-stories`, `excalidraw`).

> The data directory used to be called `extensions/`. It is still read when it
> holds extensions, but `suwu install` only ever writes `extension/`; move it
> yourself when you are ready.

## Three packaging patterns

Pick the lightest one that fits:

| Pattern | `suwu.static` | When |
|---|---|---|
| **Plain folder, no build** | `"public"` | A few hand-written files with no dependencies. Nothing to compile. |
| **Built, one bundle** | `"dist"` | The client is several modules or needs minification, but has no dynamic imports or workers — `inlineDynamicImports` gives exactly one JS file. A directory keeps it inspectable and lets the render stub read Vite's manifest off disk. |
| **Built archive** | `"dist.zip"` | Code splitting is worth keeping (many lazy chunks) or the font/asset tree is large. `pack-static.mjs` packs it into one blob, so ~160 chunks cost one file in git, in the install payload and in the catalog. |

## What each example demonstrates

| Example | Pattern | Demonstrates |
|---|---|---|
| `eye` | plain folder, no build | `suwu.static` with a **classic** script; server-rendered config passed via `data-size` |
| `note` | built, one bundle (`dist/`) | `index.js` (render stub) · `src/{main.js,model.js,commands.js,render.js,store.js,bridge.js,format.js,style.css}` · `test/*.test.mjs` | A **pure client-side** app: nine numbered slots kept in the browser's IndexedDB **via the parent-frame storage bridge** (the sandboxed page has no storage of its own; no API, no `suwu.net`); a flat 3M Post-it over a chip strip on a transparent document; an **Apple Notes-style editor** — checklists (tappable boxes, nesting, auto-continue, per-chip progress), bold/italic/underline/strikethrough/monospace over a selection, a floating glass format bar, and a live "Saved 2 min ago" line. A transparent `<textarea>` stays the only input surface while a painted clone renders the structure, so there is no dependency and no build step. `pnpm test:ext` covers the DOM-free modules (`model`, `commands`, `store`, `format`) |
| `hn-top-stories` | built, one bundle (`dist/`) | `index.js` (render stub) · `stories.js` (API) · `src/{main.js,carousel.js,stories-cache.js,style.css}` | `suwu.api` route registration, `suwu.net` server-side `fetch` of the Hacker News API, `suwu.static` with an **ES-module** tree (relative imports), and a local `fetch` poll — no CDN, no htmx |
| `bento` | plain folder (vendored shell) | `index.js` (render stub) · `save.js` (API) · `dist/{shell.html,suwu-host.js}` · `vendor.mjs` + `shell.lock.json` | Bento Slides decks: **the file is the application**, so the tile serves the document (shell + spliced `#bento-doc`) and a **host shim** polyfills `showSaveFilePicker` so Bento's own ⌘S saves to the Suwu server. Chunked upload (the API body cap is 4 MiB), atomic `renameSync` write, `data-bento-transient` injections that the app strips on save, `allow-modals` for PDF export |
| `excalidraw` | built archive (`dist.zip`) | `index.js` (render stub) · `save.js` (API) · `src/{main.js,style.css}` · `vite.config.ts` · `pack-static.mjs` · `dist.zip` + `build.json` (committed) | A **built** extension: Vite bundles React + `@excalidraw/excalidraw` from npm into `dist/`, so the tile has no CDN dependency at all (contrast with the old esm.sh version). Shows `suwu.fs` file access (`/fs` = the opened document's directory, `/ext-data` = extension storage), `suwu.fileExtensions` claiming `.excalidraw`, a custom burger menu (Save / Auto save), a scene load that survives Excalidraw's async init, and an in-memory `localStorage` fallback for the opaque sandbox |

## ⚠ Static files are public

`public/` is served **unauthenticated** under `/gqjs/static/<id>/` because
ES-module fetches from the sandboxed page carry neither cookies nor tokens
(a module's relative imports cannot carry `?token=`). **Never put secrets in
a static file** — no tokens, passwords, or API keys anywhere under `public/`.

Credentials travel through the **authenticated render HTML** only (an inline
*classic* script or a `data-*` attribute) and are read by static code at
runtime; `hn-top-stories`'s `data-api="…?token=…"` is the canonical pattern.
That value is an **extension-scoped token**, not the app-shell session token:
it only opens this extension's own `/gqjs/api/<id>/*`. Extensions must not call
the main `/api/*` or WebSockets — the session token is never issued to them
(`docs/EXTENSION_TOKEN_SCOPING_PLAN.md`).

Background: `docs/EXTENSION_TILE_PLAN.md` (render pipeline) and
`docs/EXTENSION_API_PLAN.md` (metadata + API + static contract).
