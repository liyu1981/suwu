# Bento Slides extension

[Bento Slides](https://github.com/nyblnet/bento) decks — `.bento.html` files —
opened and saved through Suwu.

Bento is unusual: **the file is the application.** A `.bento.html` carries the
deck, the editor, the presenter and every font and image the deck uses, all in
one HTML file, and saving rewrites that file. So this tile does not load a
document into an app — it serves the document, which brings its own app.

## Install

```sh
suwu install --local examples/extension/bento --force
# or, from the catalog:  suwu install --github bento
```

Then open a deck: `suwu open Q3.bento.html` (or double-click it in the file
browser). `package.json` claims the `.bento.html` suffix, so the notification
resolver sends it to this tile and plain `.html` still opens the viewer.

## Making a new deck

A pristine Bento shell — the official download, or the copy this extension
ships — **is** a new deck: its `#bento-doc` block is present but empty, which
upstream calls "a pristine New shell" (open it and you get the editor on a blank
deck; the first save writes the document in).

```sh
suwu ext-run bento new ~/decks/new.bento.html   # or: cd ~/decks && suwu ext-run bento new new.bento.html
suwu open ~/decks/new.bento.html                # editor on a blank deck
# …edit…  ⌘S writes the document into that file
```

(`suwu ext-run bento new` copies the vendored shell for you; copying
`dist/shell.html` by hand does the same thing.)

Opening the tile **without** a file also gives a blank deck, but with no
directory of its own: there ⌘S hands you a download (`Untitled.bento.html`)
instead of writing back. Save it into a folder and open it in Suwu to get the
server-side save.

## How it works

Three small pieces, no fork of Bento:

| Piece | Role |
|---|---|
| `index.js` | Render stub. Reads the vendored shell from `dist/shell.html` and the deck from `/fs`, splices the deck's `#bento-doc` JSON into the shell, and injects `window.__SUWU` + the host shim — both marked `data-bento-transient` |
| `dist/suwu-host.js` | The Bento "host". Polyfills `window.showSaveFilePicker` so Bento's own ⌘S / Save button / write-back go to the Suwu API instead of a file picker |
| `save.js` | `POST /gqjs/api/bento/save` — assembles the upload and swaps the file in atomically |

Nothing in the page needs a network, a CDN or a third-party script: the released
shell has zero external references, which is why the tile's CSP needs no
`'unsafe-eval'`, no `worker-src` and no CDN origin.

### Why the shim, and not a bigger integration

Bento's file I/O keys off exactly one thing — `typeof window.showSaveFilePicker
=== 'function'` — and it hands that picker `{ id }` where the id is the *intent*:
`bento-doc` (in-place ⌘S), `bento-copy` ("Save a copy…"), `bento-share` /
`bento-backup` (exports). The shim routes in-place saves to the server, copies to
a sibling file, and exports to a download. That is the whole integration: Bento's
save UI, dirty indicator and shortcuts keep working, unmodified.

Upstream also strips any injected node carrying `data-bento-transient` when it
serializes a document, so the file written back is a pristine standalone
`.bento.html`. `save.js` strips our nodes again before writing — a token must
never end up inside a user's document.

### Uploads are chunked, writes are atomic

The extension API caps one request body at 4 MiB and a deck with images passes
that quickly, so the shim uploads in 512 KiB parts and the handler assembles
them. The assembled file is written to a temp name in the same directory and
`renameSync`d over the target: a half-written `.bento.html` would be a broken
*application*, not just a broken document.

## Vendoring the shell

`dist/shell.html` is the upstream single-file build, pinned by hash:

```sh
node vendor.mjs                     # fetch the pinned release, verify sha256
node vendor.mjs --from-source ../bento   # build from a local checkout instead
```

`shell.lock.json` records the version, size and sha256; `vendor.mjs` refuses to
write a shell that does not match, so an upstream change has to be an explicit
lock update in the same commit. Licensing travels with it: `dist/LICENSE` and
`dist/THIRD_PARTY_NOTICES.md` are upstream's.

## Capabilities

```json
"suwu": {
  "fs": true,
  "api": [{ "route": "/save", "handler": "save.js" }],
  "fileExtensions": [".bento.html"],
  "sandbox": ["allow-downloads", "allow-modals"],
  "csp": { "img-src": ["blob:"], "media-src": ["blob:", "data:"] }
}
```

- `suwu.fs` mounts the deck's own directory at `/fs` — read to open, written to
  save. The handler can only ever touch that directory.
- `allow-modals` is what makes `window.print()` work in a sandboxed frame
  (Bento's PDF export) and what a password prompt needs.
- `allow-downloads` covers the export/share paths that hand the browser a file.

## Deliberately not enabled

- **Self-update**: Bento can fetch a signed release and rewrite itself. The tile
  ships one pinned shell (`net: false`), so a deck keeps the shell it was created
  with — which is exactly Bento's own "one file, forever" promise.
- **Live collaboration**: Bento's relay is a Cloudflare worker. Decks keep their
  collab keys (they live in the file), but live sessions are not offered here.

## Known limits

- Crash recovery and the collab member key live in `localStorage`/IndexedDB,
  which a sandboxed tile does not have: the shim substitutes an in-memory store,
  so recovery survives edits but not a reload. Wiring Bento's documented
  `__bento_tray__` DocStore protocol to the tile's storage bridge is the planned
  follow-up.
- The page is shell + deck per open (721 KB + the deck). Fine on a LAN; a very
  large deck would want the shell served from static and the document loaded over
  the API instead.

## Test

```sh
node --test examples/extension/bento/test/host-shim.test.mjs
```
