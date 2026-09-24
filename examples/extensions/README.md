# Example extensions

Suwu never installs extensions automatically — copy an example into your
extensions directory (`$SUWU_VAR/extensions`, default `~/.suwu/extensions`):

```sh
cp -r examples/extensions/eye ~/.suwu/extensions/
cp -r examples/extensions/note ~/.suwu/extensions/
cp -r examples/extensions/hn-top-stories ~/.suwu/extensions/
```

Then enable the **extension** plugin in App Menu settings (it is off by
default) and add an Extension tile whose `id` is the directory name
(`eye`, `hn-top-stories`).

## What each example demonstrates

| Example | Files | Demonstrates |
|---|---|---|
| `eye` | `index.js` (render stub) · `public/{style.css,eye.js}` | `suwu.static` with a **classic** script; server-rendered config passed via `data-size` |
| `note` | `index.js` (render stub) · `public/{style.css,note.js}` | A **pure client-side** app: seven numbered slots kept in the browser's IndexedDB **via the parent-frame storage bridge** (the sandboxed page has no storage of its own; no API, no `suwu.net`); a flat 3M Post-it over a chip strip on a transparent document |
| `hn-top-stories` | `index.js` (render stub) · `stories.js` (API) · `public/{style.css,app.js,carousel.js,stories-cache.js}` | `suwu.api` route registration, `suwu.net` server-side `fetch`, `suwu.static` with an **ES-module** tree (relative imports), htmx polling of the extension's own API |

## ⚠ Static files are public

`public/` is served **unauthenticated** under `/gqjs/static/<id>/` because
ES-module fetches from the sandboxed page carry neither cookies nor tokens
(a module's relative imports cannot carry `?token=`). **Never put secrets in
a static file** — no tokens, passwords, or API keys anywhere under `public/`.

Secrets travel through the **authenticated render HTML** only (an inline
*classic* script or a `data-*` attribute) and are read by static code at
runtime; `hn-top-stories`'s `data-api="…?token=…"` is the canonical pattern.

Background: `docs/EXTENSION_TILE_PLAN.md` (render pipeline) and
`docs/EXTENSION_API_PLAN.md` (metadata + API + static contract).
