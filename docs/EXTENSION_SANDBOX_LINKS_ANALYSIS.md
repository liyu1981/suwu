# Extension Sandbox & Link Popups — Root-Cause Analysis

> **Status:** Implemented. Option A and its guard are in place: the tile
> iframe grants `allow-popups-to-escape-sandbox`, and the render response
> carries the matching CSP `sandbox` directive (`extensionSandboxTokens` in
> `pkg/server/extension.go`), so every load of the render route outside the
> tile is forced to an opaque origin. The orthogonal token-scoping fix is also
> in place (`docs/EXTENSION_TOKEN_SCOPING_PLAN.md`). This document remains as
> the root-cause record and the rationale for the guard (§7.4).
> **Trigger:** story links clicked in the `hn-top-stories` extension
> (`examples/extensions/hn-top-stories/public/carousel.js`, which renders
> `<a target="_blank" rel="noopener">`).
> **Companion docs:** `docs/EXTENSION_TILE_PLAN.md` (render/page pipeline),
> `docs/EXTENSION_API_PLAN.md` §2.7 (origin, CSP, CORS, links).

---

## 1. Symptom

Opening any link from an extension tile produces a new tab that loads the
destination but errors while running its own scripts:

```
Uncaught SecurityError: Failed to construct 'Worker':
Script at 'https://bastardica.mitpit.com/_astro/pyodide.worker-aQqhAoII.js'
cannot be accessed from origin 'null'.
    at _ (app.V0J6-zjP.js:1:5031)
    at S (app.V0J6-zjP.js:1:5647)
    at ne (app.V0J6-zjP.js:1:29325)
    at index.astro_astro_type_script_index_0_lang.CJRnBo_u.js:1:39
```

It is not destination-specific: the same failure class hits any site in that
tab that uses workers, storage, credentialed `fetch`, service workers, or
`window.origin`/postMessage origin checks.

---

## 2. Root cause: sandbox flags are copied into popups

The extension is rendered inside a sandboxed iframe in the tile
(`frontend/src/routes/ExtensionPage.tsx`):

```html
<iframe
  src={src}
  sandbox="allow-scripts allow-pointer-lock allow-popups"
  ...
/>
```

The important part is what is **absent**: `allow-popups-to-escape-sandbox`.

Per the HTML spec, when a sandboxed document opens an auxiliary browsing
context (a `target="_blank"` tab, or `window.open`) the opener's **active
sandbox flag set is copied into the new browsing context**. `allow-popups`
is what permits the popup to exist at all; `allow-popups-to-escape-sandbox`
is what decides whether the popup *inherits* that flag set. We lack the
escape flag, so:

1. the extension frame has no `allow-same-origin`, therefore its origin is an
   **opaque origin** (`"null"`);
2. the new tab inherits the sandbox, so it is **also** an opaque-origin
   document;
3. the flags are a property of the browsing context, not of the document, so
   they persist for every navigation in that tab (the URL can change; the
   origin stays `"null"`).

## 3. Why that breaks `new Worker(...)`

`Worker` (classic and module) requires the worker script to be **same-origin
with the document**. An opaque origin can never be same-origin with any
`https://…` URL, so the worker script fetch is rejected outright. The site is
not doing anything wrong — its own worker is unreachable purely because the
document's origin is `"null"`.

Other things that break for the same reason on those tabs:

- `localStorage` / `sessionStorage` / IndexedDB / CacheStorage;
- credentialed `fetch` and cookie-dependent auth flows;
- Service Worker registration;
- `SharedArrayBuffer` / cross-origin isolation;
- `window.origin` checks, COOP/COEP-sensitive embeds, postMessage origin
  checks.

That breadth is why it reproduces for “any HN link”, not just one site.

## 4. Why this is *not* our CSP

- The failing document is the **destination site in a new tab**. Our policies
  (`extensionCSPFor`, `frame-ancestors 'self'`, `Referrer-Policy`,
  `Cache-Control`) apply to `/gqjs/ext/…` responses, not to a foreign origin.
- No CSP directive can cause an opaque origin or produce “cannot be accessed
  from origin 'null'”. That is the sandboxed browsing-context origin check.

CSP is only adjacent to this story: the extension page runs under
`script-src 'unsafe-inline' …`, which is why the focus/key relay has to be
injected server-side (`injectExtensionRelay`) rather than shipped by the
extension.

## 5. Fundamental cause and prior intent

The isolation requirement (“extension content must never touch Suwu's
origin”) was implemented as `sandbox` **without** `allow-same-origin`. That
is correct for the tile, but popup inheritance means the isolation leaks into
every tab the extension opens. The omission was deliberate —
`docs/EXTENSION_API_PLAN.md` §2.7 item 4 originally read:

> **Links:** `allow-popups` lets `target="_blank"` open a new tab that
> *inherits* the sandbox; `allow-popups-to-escape-sandbox` is deliberately
> absent, so a popup to our own origin stays sandboxed too.

So the bug was the price of that design decision: a normal web tab is
incompatible with inheriting both `sandbox` and an opaque origin. §6 option A
plus the §7.4 guard resolves it — popups escape the *inherited* sandbox, while
the render response's `sandbox` header keeps every render document opaque.

---

## 6. Options

### A. Add `allow-popups-to-escape-sandbox` (chosen, implemented)

```html
sandbox="allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox"
```

Smallest change; popups become ordinary tabs with their real origin, so
workers/storage/fetch all work. `target="_blank"` from the child keeps its
user activation, so popup blockers are not a problem.

The cost is the body of §7: the extension can also force an **unsandboxed
document on our own origin**. That is what the §7.4 guard removes — pair this
flag with a `sandbox` directive on the render response header.

### B. Relay link clicks to the trusted parent (`postMessage` → `window.open`)

Keep the strict sandbox; have the injected relay intercept `click` on
`a[target=_blank]`, `preventDefault`, and post `{type:'ext-open', url}`; the
tile page (unsandboxed, same-origin) validates the URL and opens the tab.

**Why it probably fails:** popup blocking. The click's **user activation is
in the child frame and is not transferred through `postMessage`**, so the
parent's `window.open` is an unsolicited popup and Chrome blocks it (returns
`null`). It only works by accident if the parent happens to have its own
recent activation. It also needs its own URL policy (do not open the render
route) and still misses `window.open` calls made directly by the extension.

### C. Give extensions their own real origin

Serve extension render/static content from a *different origin* than the app
(e.g. app on `localhost`, extensions on `127.0.0.1`, or a separate port) and
drop `sandbox` entirely. Same-origin policy then provides the isolation
properly, popups are completely normal, and the extension even gets working
storage inside the tile.

Auth already supports the `?token=` fallback on the render route (session
token only), so this is feasible, but it revisits every opaque-origin
assumption baked into `authorizeExtensionRequest` (render),
`extensionCSPFor`, the `Access-Control-Allow-Origin: null` grants, and the
relay. Significantly larger change.

### D. Keep as-is

Only defensible if extension links are meant to be read inside the
extension's own sandbox, which they are not. Not a real answer for
`target="_blank"` links to the wider web.

---

## 7. Detailed cost of Option A

One-line version: **`allow-popups-to-escape-sandbox` turns the sandbox from a
browser-security boundary into a UI-isolation nicety.** After the change,
extension-authored code can obtain *same-origin* execution in the Suwu web
app, and from there reach things that were previously unreachable by design.

### 7.1 Framing: what is and isn't new

It helps to separate two trust domains.

**Server-side power is now scoped (fixed).** Extensions no longer receive the
app-shell session token: `buildExtensionInput` hands the render script
`auth.DeriveExtensionToken(cfg, ext.ID)`, and `/gqjs/api/<id>/*` accepts only
that extension's token — the session token is rejected there, and an extension
token is rejected on `/api/*` and the WebSockets. See
`docs/EXTENSION_TOKEN_SCOPING_PLAN.md` (implemented). Extension handlers still
run extension code server-side via the `suwu gq` runner under the `--ro` /
`suwu.net` gates, but they can no longer act as the user against the main API,
the WebSockets, or another extension.

**Browser-side isolation is what the sandbox exists for.** From
`ExtensionPage.tsx`:

> Deliberately no `allow-same-origin`: the extension runs in an opaque
> origin, so it cannot read Suwu storage or escape upward.

That invariant is what A breaks. With the server-side over-grant already
removed by token scoping, the cost of A is **purely browser-side**: the
extension can obtain *same-origin* execution in the Suwu web app and from
there own the **browser origin** — `localStorage`, IndexedDB, the live DOM,
service workers, and the session token itself via the non-`HttpOnly` cookie —
**persistently**. Token scoping does not touch any of that.

### 7.2 The pivot: getting extension code to run at Suwu's origin

Escape alone is not enough: an escaped popup pointing at `/` runs *Suwu's*
code, not the extension's. The extension needs a document **it authored**
running at the real origin, and it has one — the render route it controls.

`handleExtension` still authenticates on the **session** credential, which for
an iframe/navigation is the `suwu_token` **cookie** (`?token=` also works, but
the render route is session-only and rejects the scoped token). The extension
does not need to *hold* that token: a top-level navigation to
`/gqjs/ext/<id>` carries the cookie automatically (`SameSite=Lax` still sends
it on a top-level GET), so once the popup escapes the sandbox,

```js
window.open('/gqjs/ext/<id>')
```

yields a normal, unsandboxed tab whose HTML is the extension's own render
output, executing with `https://<suwu-host>` as its origin. It is now
same-origin with the app, so it recovers the session token from
`document.cookie` even though the render input only carried the scoped token.
There is no framing/top-level check on `handleExtension`, and
`frame-ancestors` does not apply to a top-level navigation, so nothing stops
it.

(Separately: this is already reachable **today** by a user opening a render
URL directly. Today the *extension itself* cannot trigger it; §8 closes the
hole.)

### 7.3 What a same-origin document can then do

- **Read/write the app's `localStorage`.** This is the app's client state
  layer, written through `atomWithStorage`: `suwu:app-menu`, `suwu:avatar`
  (includes the user's email), `suwu:spaces-idle`, `suwu:background`,
  `suwu:notifications`, `suwu:auto-resolve`, `suwu:rest-options`, every
  `suwu.*-zoom`/font pref, `suwu_db_saved_connections`, plus the WM
  layout/`spaces` state. Jotai's storage atoms sync on `storage` events, so a
  write from the escaped tab **propagates into already-running app tabs**.
- **Read/write the shared extension store.** `EXT_STORE_DB =
  'suwu-extension-ext'` lives on the app origin and holds **every**
  extension's data. The `suwu:ext/<id>/` namespacing is enforced only in
  `ExtensionPage.tsx`'s message handler:
  ```js
  const fullKey = `suwu:ext/${id}/${key}`;   // ← client-side check
  ```
  A same-origin document just opens the DB directly and reads/overwrites
  `suwu:ext/other-extension/*`. Cross-extension isolation stops existing.
- **Read sensitive request data.** The REST Helper persists `history`,
  `responses`, `collections`, `environments`, and **`cookies`** in IndexedDB
  `suwu-rest-helper` (`frontend/src/lib/restdb.ts`); `RestHeader` explicitly
  models `sensitive` credentials.
- **Read the session token directly — and undo the token scoping.** Extension
  code no longer receives the session token
  (`docs/EXTENSION_TOKEN_SCOPING_PLAN.md`), but a same-origin document reads it
  straight from the cookie (`frontend/src/lib/api.ts`):
  ```js
  document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Lax${secure}`;
  ```
  No `HttpOnly`, so `document.cookie` exposes it. Same-origin execution is the
  join that re-grants the full API and WebSocket authority that token scoping
  just removed. (`HttpOnly` would block *this* read but none of the other
  same-origin powers below; it stays a separate follow-up.)
- **Register a Service Worker at scope `/`.** Localhost is a secure context,
  so the escaped document can install a persistent SW that intercepts and
  rewrites the app's requests. Unlike the ephemeral opaque frame, this
  survives reloads and restarts.
- **Script the real app.** It can drop `<iframe src="/">` (or a same-origin
  popup) and, being same-origin, access `contentDocument` — drive the real UI,
  read state, invoke authenticated actions, or mount convincing in-app
  phishing. No `noopener`/`window.opener`/popup-blocker tricks needed;
  same-origin iframing sidesteps all of that.
- **Persist and coordinate.** CacheStorage, IndexedDB, localStorage,
  BroadcastChannel, storage events. The “opaque origin = ephemeral, walled
  off” property is gone.
- **It is not one-shot.** The extension chooses when to do any of the above;
  nothing requires more than ordinary browsing in the tile.

### 7.4 The guard: a `sandbox` directive on the render response (implemented)

A `<meta>` tag cannot do this job. The `sandbox` directive is honored **only
from the HTTP response header** — verified on Chromium by serving the same
policy both ways to a top-level document:

```
Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; sandbox allow-scripts
```

With the header: `self.origin === "null"` and `localStorage` throws. With the
identical policy in `<meta http-equiv="Content-Security-Policy"
content="sandbox allow-scripts">`: ignored — the origin stays real and storage
works. A script-inserted meta is the wrong tool generally, too: CSP can only
*add* restrictions, so one static payload cannot both allow the tile's scripts
and deny the top-level load's.

The server already rewrites the render body server-side (`injectExtensionRelay`
injects the focus/key relay), so it *could* place markup statically — but the
guard does not need the body at all, and a body/meta policy could not be made
conditional anyway. The guard is a **`sandbox` directive added to the render
response's existing CSP header** (`extensionCSPFor`), mirroring the iframe
token list:

```
Content-Security-Policy: default-src 'none'; script-src …; …
  sandbox allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox
```

It lands as `extensionSandboxTokens` in `pkg/server/extension.go` (appended by
`extensionCSPFor`), mirrored by the tile iframe's `sandbox` attribute in
`frontend/src/routes/ExtensionPage.tsx`, and pinned by
`TestExtensionCSPForSandboxGuard`.

Why this is the robust form:

- **Static and unconditional.** It is a response header, resolved before the
  document exists — the only delivery that can set an opaque origin at
  creation. There is no runtime script, and no need to classify the request
  (tile iframe vs escape-sandbox popup vs direct tab), so it does not depend on
  `Sec-Fetch-*`, parser ordering, or injected markup.
- **It re-sandboxes every load of `/gqjs/ext/<id>`** to an opaque origin with
  scripts allowed — the tile, an escape-sandbox popup, and a directly opened
  tab alike. Extension code still runs, but with no cookies, no origin
  `localStorage`/IndexedDB, no Service Worker, and no same-origin access to the
  app, so every row of §7.3 is closed.
- **It closes the §8 direct-tab hole** as a side effect.

Capabilities are the **intersection** of all sandbox sources, so the iframe
attribute and the CSP `sandbox` token list must agree. Both must list
`allow-popups-to-escape-sandbox` for story links to open as real tabs, and
neither may list `allow-same-origin`.

What the guard does **not** cover:

- **Directive support.** `sandbox` is a standard CSP3 header directive, but this
  analysis verified only Chromium; Firefox and Safari need an explicit check.
  Keep the iframe attribute as the primary sandbox so a browser that ignored
  the header could still not un-sandbox the tile — it would only reopen the
  top-level hole.
- **A regression is silent.** If the directive is dropped or mistyped, a
  top-level render load runs same-origin again. Add a test asserting the render
  header contains the `sandbox` directive and no `allow-same-origin`.
- **Other paths for extension-authored execution.** Both render responses —
  `extensionCSPFor` (page) and `extensionCSP` (error page) — carry the guard.
  Any future Suwu page that executes extension-supplied content needs the same
  header. Extension API responses are script-blocked by `default-src 'none'`
  and left unsandboxed; adding `sandbox` there too is cheap defense in depth.
- **Residual, guard-proof costs.** The extension can still open arbitrary
  unsandboxed tabs on the app origin (spam/DoS, opening `/`) and reach the app
  via `postMessage`; today’s defenses there are per-handler
  (`isDirectTileFrame`, origin checks), not structural — though a guarded
  render document is opaque-origin, so it cannot script those tabs.

### 7.5 Cost summary

| Capability | Today (sandbox, no escape) | After A, no guard | After A + guard |
|---|---|---|---|
| Server API / WebSockets as user | no (scoped token only) | **yes** (session token via `document.cookie`) | no (via that route) |
| Same-origin code at app origin | no (only via direct-tab hole) | **yes, self-service** | no (CSP `sandbox` → opaque origin) |
| Read/write app `localStorage` | no | **yes** | no (via that route) |
| Cross-extension IndexedDB | no (namespaced in tile) | **yes, bypass** | no |
| REST-helper history/cookies | no | **yes** | no |
| `document.cookie` (session token) | no | **yes** | no |
| Persistent Service Worker | no | **yes** | no |
| Script the live app UI | no | **yes** (same-origin iframe) | no |
| Popups inherit sandbox | yes (the bug) | no (fixed) | no (fixed) |

The honest trade of A: **add the escape flag, and rely on the render
response's `sandbox` header (§7.4) to re-sandbox any document loaded at our
origin outside the tile.** Unlike a runtime script guard, that is static and
unconditional — but it is still a single response header away from failure,
and the browser-support check (Firefox/Safari) and the header regression test
are what keep it honest.

---

## 8. Existing hole exposed by this analysis

`handleExtension` (`GET /gqjs/ext/<id>`) authenticates from the
`suwu_token` **cookie** or a `?token=` fallback, and there is no framing or
top-level check. So **today** any user who opens a render URL directly as a
normal tab — or follows a cross-site link to it, given the `SameSite=Lax`
cookie — gets extension JS running unsandboxed on the Suwu origin. Token
scoping does not close this: the unsandboxed document is same-origin, so it
reads the session token from the cookie regardless of what the render input
carried.

The §7.4 `sandbox` header closes this: the directly opened document is
forced to an opaque origin before it runs, so it cannot read the cookie or the
session token. A server-side request distinguisher (e.g. `Sec-Fetch-Dest:
iframe` vs `document`) is not needed for the guard, but remains reasonable
defense in depth: a sandboxed tile-iframe load is initiated by our-origin tile
(`Sec-Fetch-Site: same-origin`), while an escape-sandbox popup or direct tab is
`cross-site`/`none`; extension self-navigations look `cross-site` and older
browsers omit `Sec-Fetch-*`, so treat any such check as secondary.

---

## 9. Recommendation

**Independent, orthogonal first fix (done):** stop handing extensions the
app-shell **session token**. Extensions now receive a per-extension token
scoped to their own `/gqjs/api/<id>/*` surface — see
`docs/EXTENSION_TOKEN_SCOPING_PLAN.md` (implemented). That removes the
server-side over-grant but does **not** fix the popup bug or same-origin
escalation, so it is not a substitute for the work below.

**A + the §7.4 guard is implemented.** It remains load-bearing security code,
so keep these follow-ups honest:

- the `sandbox` token list is pinned to the iframe's by
  `TestExtensionCSPForSandboxGuard`; keep the two identical and never add
  `allow-same-origin` to either;
- **an explicit Firefox and Safari check of the `sandbox` header is still
  pending** (only Chromium is verified here);
- `docs/EXTENSION_API_PLAN.md` §2.7 item 4 now records that the “popups stay
  sandboxed” guarantee is replaced by “every render load is CSP-sandboxed to an
  opaque origin”;
- option C (real separate origin) remains the only variant that keeps a
  browser-enforced boundary *and* normal tabs without relying on a response
  header.

Until then, the current behavior — an opaque-origin tab that silently breaks
on many sites — is the documented, deliberate cost of the existing sandbox.

---

## 10. References

- `frontend/src/routes/ExtensionPage.tsx` — sandbox attribute, ext-store
  bridge, `suwu:ext/<id>/` namespacing.
- `pkg/server/extension.go` — `handleExtension`, `authorizeExtensionRequest`,
  `authorizeExtensionAPIRequest`, `buildExtensionInput`, `injectExtensionRelay`,
  `extensionCSPFor`.
- `pkg/auth/auth.go` — `DeriveExtensionToken`, `ValidateExtensionToken`,
  `ValidateExtensionAPIRequest`.
- `pkg/server/extension_static.go` — `extensionStaticInertCSP`.
- `frontend/src/lib/api.ts` — `suwu_token` cookie (non-HttpOnly).
- `frontend/src/lib/restdb.ts` — `suwu-rest-helper` IndexedDB stores.
- `docs/EXTENSION_API_PLAN.md` §2.7 — origin, CSP, CORS, links.
- `docs/EXTENSION_TOKEN_SCOPING_PLAN.md` — extension-scoped tokens (implemented).
- `docs/EXTENSION_TILE_PLAN.md` §4.8 — extension storage bridge.
