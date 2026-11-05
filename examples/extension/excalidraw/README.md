# Excalidraw extension

An [Excalidraw](https://excalidraw.com) whiteboard running inside a Suwu
extension tile. The Excalidraw React app is loaded from the upstream npm
package on esm.sh at runtime; no Excalidraw/React sources are vendored here.

## Install

From this repository:

```sh
cp -r examples/extension/excalidraw ~/.suwu/extension/
```

Or via `suwu install --github excalidraw`. Then enable the **Extension** plugin
in App Menu settings and add an Extension tile with `id` = `excalidraw`.

The tile needs network access to `esm.sh` when it opens.

## How it works

- `index.js` returns the HTML shell: esm.sh CSS, the in-memory localStorage
  fallback, `EXCALIDRAW_ASSET_PATH`, and `/gqjs/static/excalidraw/app.js`.
- `public/app.js` imports React, ReactDOM, and `@excalidraw/excalidraw@0.18.1`
  from esm.sh, mounts the editor, and persists the scene
  through the parent tile's scoped ext-store bridge.
- `public/page.css` only sets page dimensions and the WM corner clearance.
- `package.json` declares the CSP sources esm.sh needs and the
  `allow-downloads` sandbox token so export works.

## Capability review

```json
"suwu": {
  "csp": {
    "script-src": ["https://esm.sh", "'unsafe-eval'"],
    "style-src": ["https://esm.sh"],
    "font-src": ["https://esm.sh"],
    "img-src": ["https://esm.sh"],
    "worker-src": ["https://esm.sh", "blob:", "data:"],
    "connect-src": ["https://esm.sh"]
  },
  "sandbox": ["allow-downloads"]
}
```

`'unsafe-eval'` is for Excalidraw's optional Mermaid path; the worker sources
cover its font-subsetting/image-resize workers; `allow-downloads` lets the
export actions save files. The core extension CSP still scopes everything else
to this extension's own static/API trees.

## Static files

`public/` is served unauthenticated. Never put secrets there.
