# Extension Metadata v2 + Extension APIs — Feature Plan

> **Status:** Implemented. `package.json` metadata (hard cutover, no
> `meta.json` fallback), `/gqjs/api/<id>/<path>` APIs, and
> `/gqjs/static/<id>/<path>` static assets are built and tested
> (`pkg/extension`, `pkg/server/extension_api.go`, `extension_static.go`).
> **Reference implementation:** `examples/extensions/hn-top-stories/` — an HN
> front-page broadsheet whose `stories.js` does a server-side `fetch`
> (`suwu.net`), whose page polls the API with htmx, and whose styles/app
> split across an ES-module tree under `public/`.
>
> **Goal:** (1) make `package.json` the single metadata file for extensions,
> with npm-style fields at the top level and Suwu specifics under `suwu`;
> (2) let extensions register ordered API routes served from their own
> handler scripts — pure data relay, no script injection.

Companion doc: `docs/EXTENSION_TILE_PLAN.md` (the render/page pipeline).

---

## 1. Metadata: `package.json`

```
<dataDir>/extensions/<id>/
  package.json      # required; replaces meta.json outright
  index.js          # hard-coded render entry (unchanged)
  <handler>.js      # API handler scripts registered in suwu.api
  public/           # static assets declared by suwu.static (served without auth)
```

```json
{
  "name": "Eye",
  "version": "0.1.0",
  "description": "Classic X11-style eye that follows the pointer",
  "suwu": {
    "params": [
      { "key": "size", "label": "Size", "description": "Eye radius in px", "defaultValue": "140" }
    ],
    "static": "public",
    "api": [
      { "route": "/hello",       "handler": "api1.js" },
      { "route": "/hello/world", "handler": "api2.js" },
      { "route": "/note/<id>",   "handler": "note.js" }
    ]
  }
}
```

- **No duplication:** `name`/`description` are read once from the top level,
  never repeated inside `suwu`. Resolution: `name` → directory id fallback;
  `description` → empty; `suwu.params` and `suwu.api` optional.
- **Hard cutover:** `MetaFile`/`readMeta` are gone; a missing or malformed
  `package.json` fails `Resolve` exactly like a missing `index.js`. Unknown
  top-level fields (`version`, `dependencies`, …) are ignored.
- Examples carry the metadata now: `examples/extensions/eye/` (render-only)
  and `examples/extensions/hn-top-stories/` (API + network) ship as plain
  directories — the seed/embed mechanism was removed, so installs are a copy
  into `<dataDir>/extensions/` (see `examples/extensions/README.md`).

---

## 2. API routes

### 2.1 URL scheme

| Prefix | Serves | Script injection |
|---|---|---|
| `/gqjs/ext/<id>` | `index.js` render (the old `/gqjs/<id>` page route, renamed) | relay script only for HTML, unchanged |
| `/gqjs/api/<id>[/<path>]` | registered API handlers | **never** — byte-for-byte data relay |

### 2.2 Registration and matching

`suwu.api` is an array of `{ route, handler }` objects, matched **in
declaration order; the first match wins**. Matching is a **segment-wise
prefix match**:

- every route segment must match the corresponding path segment — a literal
  by equality, `<name>` by binding it — while the path may carry extra
  trailing segments;
- so in the example above `/hello` shortcuts `/hello/world` (api1.js serves
  it, not api2.js), and `/note/<id>` matches `/note/42` and `/note/42/edit`
  with `id=42`;
- `/hello` does **not** match `/helloworld` (segment boundary); trailing
  slashes are trimmed; `/` is the catch-all root (the bare prefix
  `/gqjs/api/<id>` has path `/`);
- no match → 404, `suwu.api` absent/empty → the extension has no API surface
  (404), even if handler files exist.

**Handler files** are validated at `Resolve` time (`.js` suffix, relative
path, no `.`/`..` segments, re-checked against the extension dir including
symlinks) — a malformed registration fails the whole extension so it can
never half-serve. Existence of the handler file is re-checked per request
(missing → 404).

### 2.3 Input contract

The handler runs through the same isolated `suwu gq` child process as page
renders (deadline → 504, concurrency cap 4, `--ro` root, minimal env, **no
`--allow-net`**). Input travels via `--input-file` (not the command line:
bodies can exceed argv limits and a command line would leak payloads into
`ps`):

```jsonc
{
  "action": "api",
  "id": "demo",
  "route": "/note/<id>",          // the matched route pattern
  "path": "/note/42",             // full path after <id>, leading slash
  "pathParams": { "id": "42" },   // bindings from the matched route
  "method": "POST",
  "query": { "page": "2" },       // auth ?token= is stripped
  "headers": { "content-type": "application/json", … },  // lowercased keys
  "body": "…" ,                   // when the payload is valid UTF-8
  "bodyB64": "…"                  // otherwise — exactly one of the two
}
```

Server gates before exec: session auth (cookie / query token /
`Authorization`) → method allowlist (`GET HEAD POST PUT PATCH DELETE
OPTIONS`, else 405) → route match (else 404) → body cap 4 MiB (else 413).

### 2.4 Result contract (relayed)

```jsonc
{ "status": 200,                    // default 200; 0 with empty body → 204
  "contentType": "…",               // default application/json; charset=utf-8
  "headers": { "x-count": "3" },
  "body": "…"                       // or "bodyB64" for raw bytes
}
```

- A bare string is the body; empty/null result → **204 No Content**; invalid
  JSON → 500 (JSON error, never a stack trace).
- Response = relayed headers **minus the denylist**, plus `nosniff`,
  `no-store`, `no-referrer` and `Content-Security-Policy: default-src 'none';
  style-src 'unsafe-inline'; frame-ancestors 'self'`.
- **Denylist** (a handler can never set these): hop-by-hop/protocol headers
  (`Content-Length`, `Content-Encoding`, `Transfer-Encoding`, `Connection`,
  `Keep-Alive`, `Trailer`, `Upgrade`), `Set-Cookie` (an extension must never
  overwrite `suwu_token`), the headers the relay sets itself
  (`Content-Type` → use `contentType`, `Content-Security-Policy`,
  `Cache-Control`, `X-Content-Type-Options`, `Referrer-Policy`), and any
  `Access-Control-*` (same-origin only; `OPTIONS` reaches the handler but no
  preflight grant is ever emitted).
- **No relay script** — the focus/key injection stays HTML-only on
  `/gqjs/ext/`.

### 2.5 Discovery

`GET /api/extensions` includes `"api": [{route, handler} …]`, `"net"` and
`"static"` so
clients can see an extension's surface (`frontend/src/lib/extensions.ts`
types it).

### 2.6 `suwu.net` — the network opt-in

`"suwu": { "net": true }` marks the extension as allowed to use the network.
The flag reaches the child as `suwu gq --allow-net` for every exec of that
extension (render and API handlers alike, built by `processRunner.gqArgs`);
without it, gqjs `fetch()` rejects with "network access is disabled".
`--allow-private` is **never** passed, so even a networked extension cannot
reach loopback, private, or link-local (cloud metadata) addresses — the gqjs
SSRF dial-time guard stays in force.

### 2.7 How the sandboxed page calls its own API

The render page runs in `sandbox="allow-scripts allow-pointer-lock
allow-popups"` — an **opaque origin**, which breaks the two assumptions a
same-origin page would enjoy:

1. **Auth:** no cookie-credentials ride along, so the render script is handed
   an **extension-scoped token** (`input.token`) and embeds it in the page's
   API URLs (`?token=`). It is derived per extension from the signing key
   (`auth.DeriveExtensionToken`), never the app-shell session token, and it is
   stripped from `input.query`/`params`. `/gqjs/api/<id>/*` accepts **only**
   that extension's derived token — the session token is rejected there, and an
   extension token is rejected everywhere in `/api/*`. See
   `docs/EXTENSION_TOKEN_SCOPING_PLAN.md`. The render navigation itself still
   authenticates on the `suwu_token` cookie. The literal `Origin: null` is
   treated as "no comparable origin" in the extension authorizers — an opaque
   origin can never match the Host (it used to fail origin parsing and 400
   every call), while real foreign origins still fail the match.
2. **CSP:** `connect-src 'self'` is unreliable for an opaque origin, so
   rendered pages get `extensionCSPFor(r)`, which names the request origin
   explicitly and allows the pinned htmx CDN in `script-src` (error documents
   keep the strict `extensionCSP`).
3. **CORS:** API responses grant `Access-Control-Allow-Origin: null` when —
   and only when — the request carries `Origin: null`, **without** credentials;
   CORS preflight (`OPTIONS` + `Access-Control-Request-Method`) is answered
   before auth and never reaches the handler, reflecting the browser's own
   `Access-Control-Request-Headers` list (htmx polls carry `HX-*` headers such
   as `HX-Trigger`, so a fixed allow-list would reject them) and acknowledging
   Chrome's private-network preflight. A foreign origin, or a null-origin page
   without the token, gets nothing usable.
4. **Links:** `allow-popups` lets `target="_blank"` open a new tab that
   *inherits* the sandbox; `allow-popups-to-escape-sandbox` is deliberately
   absent, so a popup to our own origin stays sandboxed too. **Cost:** those
   tabs are opaque-origin documents and break on workers/storage/credentialed
   fetch; see `docs/EXTENSION_SANDBOX_LINKS_ANALYSIS.md` for the root cause and
   what relaxing it would cost.
5. **Contract — extensions do not use the app-shell API.** `/api/*` and the
   WebSockets are for the app shell; an extension reaches server-side data only
   through its own `/gqjs/api/<id>/*` handlers. `/api/*` calls carrying an
   extension token are rejected by design, and extension code is never issued
   the session token.

---

### 2.8 Static assets — `/gqjs/static/<id>/<path>`

`"suwu": { "static": "public" }` declares a directory of client assets — a
**dedicated subtree, never `.` or the extension root**, so handler source and
`package.json` can never be served. Absent → the whole route 404s.

| Aspect | Behavior |
|---|---|
| Methods | `GET`/`HEAD` only → 405 |
| **Auth** | **None, by design** (see the warning below): module fetches from the opaque page carry no cookies, and a module's relative imports carry no token. Render HTML and APIs stay fully authenticated. |
| Path rules | Non-empty path; `.`/`..`/empty segments and **dotfiles** rejected; directories → 404 (no listings); symlink escape → 404 via `ensureWithin`; extension allow-list only (`.js .mjs .css .json .html .htm .xhtml .svg .png .gif .webp .ico .woff2 .woff .ttf .txt .map` — unknown → 404); 8 MiB cap → 413 |
| Headers | `nosniff` · `Cache-Control: no-cache` + `Last-Modified` so revalidation is a body-less `304` · `ACAO: null` when `Origin: null` (module scripts and fonts are CORS-mode from the opaque page) |
| Document types (`.html/.htm/.xhtml/.svg`) | Served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` so opening one directly as a tab renders it **inert** (no origin-XSS via navigation); as `<img>`/subresources the response CSP is irrelevant and rendering is unaffected |

> **Warning — static files are public.** ES-module fetches carry neither
> cookies nor tokens (relative imports can't), which is why
> `/gqjs/static/` is unauthenticated. **Never put sensitive values in a
> static file** — no tokens, passwords, or API keys under `public/`.
> Credentials travel through the **authenticated render HTML** only (an inline
> *classic* script or a `data-*` attribute) and are read by static code at
> runtime — `hn-top-stories`'s `data-api="…?token=…"` is the canonical
> pattern. That value is the extension-scoped token, so even if it leaks it
> only opens this extension's own API. Use a classic script when the secret must be evaluated directly
> (inline in the stub); everything in `public/` must stay secret-free.

---

## 3. Security summary

1. Session auth on every app-shell API request; extension API requests use
the per-extension scoped token. Auth failures answer JSON.
2. `ValidID` regex + `ensureWithin`/symlink defense for id, path and handler.
3. Fail closed: unregistered extension, unmatched route, missing handler → 404.
4. Method allowlist (405) and 4 MiB body cap (413) before any child starts.
5. Child isolation unchanged: fresh process, deadline, `--ro`, minimal env;
   network only via the explicit `suwu.net` opt-in (and never
   `--allow-private`).
6. Response denylist + nosniff + strict CSP + no-store; no script injection.
7. Static assets are deliberately public (see §2.8) but tightly scoped:
   declared subtree only, no dotfiles/dot segments, no listings, symlink- and
   traversal-proof (`ensureWithin`), extension-type allow-list, and an inert
   CSP on document-family types.

## 4. Tests

- `pkg/extension`: package.json required/malformed/name fallback, legacy
  `meta.json` explicitly rejected, bad registration rejected (empty route,
  bad param syntax, non-`.js`, `..`, absolute), `MatchAPI` order shortcut
  (`/hello` beats `/hello/world`), `<id>` binding incl. deeper paths, segment
  boundary, trailing slash, catch-all root, fail-closed without a root route,
  `HandlerPath` validation, `suwu.net` parsing (default false), no embedded
  seeds.
- `pkg/server`: route order → api1.js, pathParams, root catch-all, fail-closed
  table (404s), 401 JSON, query-token auth + strip, TRACE → 405, 413, input
  payload (text vs base64, headers, query), relay (status, kept/denied
  headers, JSON default), no-injection for HTML results, binary relay, 204
  for empty results, error mapping (504/500), page route renamed to
  `/gqjs/ext/` with entry-script assertions; `gqArgs` net opt-in (and the
  promise that `--allow-private` never appears), `input.token` in render
  input, render CSP (CDN + request origin), opaque-origin CORS grant, the
  null-origin-only rule, preflight short-circuit (handler not invoked), and
  readable 401s under CORS.
- `pkg/extension` static: declaration parsed, rejected roots (`.`, `..`,
  `/abs`, dot segments, hidden dirs, backslashes), `StaticPath` segment +
  dotfile rules.
- `pkg/server` static (`extension_static_test.go`): **200 with zero
  credentials** (documents the policy), content types, inert CSP on
  `.html`/`.svg` and its absence on `.js`, `ACAO: null` only for
  `Origin: null`, 405 + `Allow`, the 404 matrix (unregistered, no static,
  empty path, dotfile, traversal, invalid id, unknown type, missing file),
  symlink escape, `304` via `If-Modified-Since`, 413 cap.
- Manual smoke: `examples/extensions/hn-top-stories/stories.js` executed via
  `suwu gq --allow-net` against the live Algolia API; `index.js` render
  verified for masthead/token/htmx wiring.

Verified: `go vet ./...`, `go test ./...`, `pnpm check`, `pnpm build`.
