# Excalidraw extension

An [Excalidraw](https://excalidraw.com) whiteboard running as a Suwu tile, that
opens and saves `.excalidraw` files on the server.

Everything third-party is a normal npm dependency bundled at build time, so the
served extension has **no CDN dependency**: no esm.sh, no import map, no network
beyond this tile's own API.

## Build

```sh
pnpm -C examples/extension install     # once, for the whole examples workspace
pnpm -C examples/extension/excalidraw build    # or: suwu install --local <dir> --build
```

`package.json` declares `"type": "module"` so Vite loads this ESM config without
the CommonJS warning; nothing in the payload is executed by Node, so it only
affects the build.

That runs Vite into `dist/`, then packs it into **`dist.zip`** (committed, so
`suwu install --github excalidraw` works without a toolchain) and writes
`build.json` with the hashed entry name. The unpacked `dist/` is a build
artifact and is removed by the pack step; it is also gitignored. Rebuild after
changing `src/`.

`suwu.static` points at the archive, so the tile installs as **6 files** instead
of ~400, and the backend serves each asset out of the zip with the same
`/gqjs/static/excalidraw/<path>` URLs as a directory would.

## Install

```sh
# from a checkout — builds, stages, validates, swaps in atomically
suwu install --local examples/extension/excalidraw --build --force

# from the GitHub catalog (uses the committed dist/)
suwu install --github excalidraw
```

Then enable the **Extension** plugin in App Menu settings and add an Extension
tile with `id` = `excalidraw`. Opening a `.excalidraw` file — `suwu open
my.excalidraw`, or the file browser — opens this tile on it, because
`package.json` claims the suffix:

```json
"suwu": { "fileExtensions": [".excalidraw"] }
```

## How it works

- `src/main.js` is the whole client: it mounts the upstream component, loads the
  document injected by the render stub, and adds two burger-menu entries —
  **Save to &lt;file&gt;** and **Auto save to &lt;file&gt;: On/Off** (on by
  default, debounced, skips unchanged payloads). Both are hidden when the tile
  was opened without a file.
- `index.js` is the only server-side piece. It reads the Vite manifest out of
  `dist/.vite/manifest.json` (through the read-only `/ext` mount), emits the HTML
  shell with the hashed entry chunk, and injects `window.__SUWU_FILE__`,
  `window.__SUWU_SCENE__` and `window.__SUWU_TOKEN__`.
- `save.js` is the `/gqjs/api/excalidraw/save` handler: it writes the posted
  scene to the document's own directory, which the runner mounts at `/fs`
  because the manifest declares `suwu.fs`.
- `index.js` sets `window.EXCALIDRAW_ASSET_PATH` in an inline `<script>` before
  the bundle loads (absolute, resolved from `document.location.href`, because a
  sandboxed page's `location.origin` is `"null"`), and `src/main.js` re-derives
  it from `import.meta.url` as a fallback. **Both matter:** Excalidraw appends a
  hardcoded CDN candidate to every font's URL list and falls back to it whenever
  the local URL fails — which is exactly what happened while the base resolved
  one directory too deep (`.../assets/fonts/…` → 404 → esm.sh → CSP block). Do
  not use `new URL("../", import.meta.url)` in the entry: Rolldown rewrites that
  idiom into a sibling-file reference.
- `vite.config.ts` copies upstream's runtime `fonts/` tree into `dist/fonts/` —
  Excalidraw builds those URLs from string literals at runtime, so no bundler can
  see them. Code splitting is left on: Excalidraw lazy-loads its i18n tables and
  the mermaid machinery, so first paint is the entry chunk only (**0.45 MB
  gzipped** instead of 2.5 MB), and the ~160 extra chunks cost nothing because
  `dist.zip` ships them as one blob.

## Capability review

```json
"suwu": {
  "fs": true,
  "csp": {
    "script-src": ["'wasm-unsafe-eval'"],
    "worker-src": ["blob:", "data:"]
  },
  "sandbox": ["allow-downloads"]
}
```

`suwu.fs` is what lets the tile read and write the document (`/fs` = the file's
directory, `/ext-data` = the extension's own storage). `'wasm-unsafe-eval'`
covers the woff2 subsetter that Excalidraw compiles on export; `worker-src`
covers its module worker. `allow-downloads` lets Export save files. The core
extension CSP still scopes everything else to this extension's own static and
API trees.

## Notes

- `dist/` is committed but is a build artifact: run
  `pnpm -C examples/extension build` (and commit) after editing `src/`.
- The tile needs `suwu.fs` to open and save documents. Without a file it still
  works as a scratch whiteboard, but nothing is written back.
