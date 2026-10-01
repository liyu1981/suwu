# Example extensions

These are the extensions the **catalog** offers. Install them from a terminal:

```sh
suwu install --github eye note hn-top-stories
```

`suwu install` with no arguments opens a picker instead, and `--list` prints
the catalog without installing anything. Everything lands in
`$SUWU_VAR/extension/<id>/` (default `~/.suwu/extension/`) and the server
reads that directory per request, so nothing needs a restart. The tab picks it
up the next time you open System Settings, which re-reads the list.

To install from a local checkout instead, zip one example (`suwu install
--extension <file.zip>` expects `extension/<id>/…` inside the zip) or copy it
by hand:

```sh
cp -r examples/extension/eye ~/.suwu/extension/
```

Then enable the **extension** plugin in App Menu settings (it is off by
default) and add an Extension tile whose `id` is the directory name
(`eye`, `hn-top-stories`).

> The data directory used to be called `extensions/`. It is still read when it
> holds extensions, but `suwu install` only ever writes `extension/`; move it
> yourself when you are ready.

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

Credentials travel through the **authenticated render HTML** only (an inline
*classic* script or a `data-*` attribute) and are read by static code at
runtime; `hn-top-stories`'s `data-api="…?token=…"` is the canonical pattern.
That value is an **extension-scoped token**, not the app-shell session token:
it only opens this extension's own `/gqjs/api/<id>/*`. Extensions must not call
the main `/api/*` or WebSockets — the session token is never issued to them
(`docs/EXTENSION_TOKEN_SCOPING_PLAN.md`).

Background: `docs/EXTENSION_TILE_PLAN.md` (render pipeline) and
`docs/EXTENSION_API_PLAN.md` (metadata + API + static contract).
