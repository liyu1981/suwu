# Extension Sandbox & Link Popups — Root-Cause Analysis

> **Status:** Analysis only. No code change has been made. This document exists
> to explain why links opened from an extension tile arrive broken, and to lay
> out the cost of the obvious fix before anyone commits to it.
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
every tab the extension opens. The omission is deliberate and documented —
`docs/EXTENSION_API_PLAN.md` §2.7, item 4:

> **Links:** `allow-popups` lets `target="_blank"` open a new tab that
> *inherits* the sandbox; `allow-popups-to-escape-sandbox` is deliberately
> absent, so a popup to our own origin stays sandboxed too.

So the bug is the price of that design decision: a normal web tab is
incompatible with inheriting both `sandbox` and an opaque origin.

---

## 6. Options

### A. Add `allow-popups-to-escape-sandbox`

```html
sandbox="allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox"
```

Smallest change; popups become ordinary tabs with their real origin, so
workers/storage/fetch all work. `target="_blank"` from the child keeps its
user activation, so popup blockers are not a problem.

The cost is the body of §7: the extension can also force an **unsandboxed
document on our own origin**.

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

Auth already supports the `?token=` fallback, so this is feasible, but it
revisits every opaque-origin assumption baked into
`authorizeExtensionRequest`, `extensionCSPFor`, the
`Access-Control-Allow-Origin: null` grants, and the relay. Significantly
larger change.

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

**Server-side power is already fully granted.** `buildExtensionInput`
(`pkg/server/extension.go`) hands the extension the validated **session
token** — the same token the app uses as `Bearer` for its REST API:

```go
// token is the caller's validated session token. ...
// Exposing it to the script is deliberate: extensions are
// user-installed and network-gated (suwu.net).
"token": token,
```

Extension API handlers also run extension code server-side via the
`suwu gq` runner. A hostile extension therefore already has user-level API
access and server-side code execution.

**Browser-side isolation is what the sandbox exists for.** From
`ExtensionPage.tsx`:

> Deliberately no `allow-same-origin`: the extension runs in an opaque
> origin, so it cannot read Suwu storage or escape upward.

That invariant is what A breaks. The cost is not “the extension can own the
server”; it is “the extension can own the **browser origin**” —
`localStorage`, IndexedDB, cookies, the live DOM, service workers —
**persistently**.

### 7.2 The pivot: getting extension code to run at Suwu's origin

Escape alone is not enough: an escaped popup pointing at `/` runs *Suwu's*
code, not the extension's. The extension needs a document **it authored**
running at the real origin, and it has one — the render route it controls.

`authorizeExtensionRequest` accepts the session token from either the cookie
**or `?token=`**:

```go
if token == "" {
    token = r.URL.Query().Get("token")
}
...
return validated, 0, ""
```

So `window.open('/gqjs/ext/<id>?token=<session-token>')` yields a normal,
unsandboxed tab whose HTML is the extension's own render output, executing
with `https://<suwu-host>` as its origin. There is no framing/top-level check
on `handleExtension`, and `frame-ancestors` does not apply to a top-level
navigation, so nothing stops it.

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
- **Read the session token directly.** `suwu_token` is set from JS
  (`frontend/src/lib/api.ts`):
  ```js
  document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Lax${secure}`;
  ```
  No `HttpOnly`, so `document.cookie` exposes it. Not new *knowledge* for the
  extension (it parses the token from its render input), but it removes the
  last step.
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

### 7.4 What a guard buys — and what it doesn't

A head-injected guard can neutralize §7.2: if `location.origin !== 'null'`
(i.e. the page is *not* in our sandbox), insert a CSP meta into `<head>`:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'">
```

This mirrors the existing inert-document policy in `extensionStaticInertCSP`
(`pkg/server/extension_static.go`). Verified on Chromium (headless,
virtual-time): a **runtime-inserted** meta policy blocks all subsequent
parser scripts, so an unsandboxed load executes nothing, while the sandboxed
load (`origin === 'null'`) is untouched.

Limits:

- **Browser dependency.** The technique relies on dynamically inserted meta
  CSP being honored. Verified on Chromium; not something to assume
  identically across engines. If an engine ignores it, the guard silently
  reverts to full escalation.
- **Injection-position sensitivity.** The guard only works if it executes
  before any extension script and the meta lands in `<head>`. Malformed
  extension HTML with a decoy `>` after `<head` (e.g. `<head title=">">`)
  could push injected bytes into an attribute/comment. The injector must be
  written for that or the guard is bypassable.
- **It guards one page, not the origin.** It protects `/gqjs/ext/*`. Any
  future Suwu page that renders extension-influenced content, any endpoint
  that trusts same-origin messages/popups, or any CSP/meta regression reopens
  §7.3. Safety moves from “the browser’s sandbox” to “an invariant that must be
  re-verified per page”.
- **Residual, guard-proof costs.** The extension can still open arbitrary
  unsandboxed tabs on the app origin (spam/DoS, opening `/`) and still reach
  the app via `postMessage`; today’s defenses there are per-handler
  (`isDirectTileFrame`, origin checks), not structural.

### 7.5 Cost summary

| Capability | Today (sandbox, no escape) | After A, no guard | After A + guard |
|---|---|---|---|
| Server API as user | already yes (token in render input) | yes | yes |
| Same-origin code at app origin | no (only via direct-tab hole) | **yes, self-service** | inert (meta CSP) |
| Read/write app `localStorage` | no | **yes** | no (via that route) |
| Cross-extension IndexedDB | no (namespaced in tile) | **yes, bypass** | no |
| REST-helper history/cookies | no | **yes** | no |
| `document.cookie` (session token) | no | **yes** | no |
| Persistent Service Worker | no | **yes** | no |
| Script the live app UI | no | **yes** (same-origin iframe) | no |
| Popups inherit sandbox | yes (the bug) | no (fixed) | no (fixed) |

The honest trade of A: **give up the sandbox as a real security boundary in
exchange for “the sandbox plus a hand-rolled, browser-dependent,
position-sensitive guard”.** Because extensions already hold the session
token, the marginal *server* risk is small; the marginal **browser-side** risk
(persistent same-origin execution, cross-extension data, in-app UI control,
service workers) is precisely the class of threat the sandbox was introduced
to prevent, and it would now be enforced by app-level checks rather than by
the browser.

---

## 8. Existing hole exposed by this analysis

`handleExtension` (`GET /gqjs/ext/<id>`) authenticates from the
`suwu_token` **cookie** or a `?token=` fallback, and there is no framing or
top-level check. So **today** any user who opens a render URL directly as a
normal tab — or follows a cross-site link to it, given the `SameSite=Lax`
cookie — gets extension JS running unsandboxed on the Suwu origin. The guard
in §7.4 would close that hole as a side effect, independently of the popup
fix.

A server-side distinguisher is tempting but imperfect: a sandboxed
tile-iframe load is initiated by our-origin tile (`Sec-Fetch-Site:
same-origin`), while an escape-sandbox popup initiated by an opaque origin
looks `cross-site`; but legitimate extension self-navigations to the render
route also look cross-site, older browsers omit `Sec-Fetch-*`, and
`frame-ancestors` does not cover top-level navigations. Treat any such header
check as defense-in-depth, not the primary control.

---

## 9. Recommendation

**Independent, orthogonal first fix (done):** stop handing extensions the
app-shell **session token**. Extensions now receive a per-extension token
scoped to their own `/gqjs/api/<id>/*` surface — see
`docs/EXTENSION_TOKEN_SCOPING_PLAN.md` (implemented). That removes the
server-side over-grant but does **not** fix the popup bug or same-origin
escalation, so it is not a substitute for the work below.

If the popup behavior is to be fixed, prefer **A + the §7.4 guard**, and
regard the guard as load-bearing security code that needs:

- explicit tests for placement (before any extension script, inside
  `<head>`), idempotence, and malformed-HTML inputs;
- a browser note in `docs/EXTENSION_API_PLAN.md` §2.7 item 4 recording that
  the “popups stay sandboxed” guarantee is replaced by “unsandboxed render
  loads are inert”;
- a follow-up decision on option C (real separate origin), which is the only
  variant that keeps a browser-enforced boundary *and* normal tabs.

Until then, the current behavior — an opaque-origin tab that silently breaks
on many sites — is the documented, deliberate cost of the existing sandbox.

---

## 10. References

- `frontend/src/routes/ExtensionPage.tsx` — sandbox attribute, ext-store
  bridge, `suwu:ext/<id>/` namespacing.
- `pkg/server/extension.go` — `handleExtension`, `authorizeExtensionRequest`,
  `buildExtensionInput`, `injectExtensionRelay`, `extensionCSPFor`.
- `pkg/server/extension_static.go` — `extensionStaticInertCSP`.
- `frontend/src/lib/api.ts` — `suwu_token` cookie (non-HttpOnly).
- `frontend/src/lib/restdb.ts` — `suwu-rest-helper` IndexedDB stores.
- `docs/EXTENSION_API_PLAN.md` §2.7 — origin, CSP, CORS, links.
- `docs/EXTENSION_TILE_PLAN.md` §4.8 — extension storage bridge.
