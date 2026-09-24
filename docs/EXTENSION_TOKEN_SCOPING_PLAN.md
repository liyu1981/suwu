# Extension Token Scoping — Feature Plan

> **Status:** Implemented. Landed in `pkg/auth` (`DeriveExtensionToken`,
> `ValidateExtensionToken`, `ValidateExtensionAPIRequest`),
> `pkg/server/extension.go` (render issues scoped tokens, scoped API authorizer)
> and `pkg/server/extension_api.go` (id-first scoped auth, credential-header
> stripping). Covered by tests in `pkg/auth/auth_test.go`,
> `pkg/server/extension_test.go`, `pkg/server/extension_api_test.go`.
> **Goal:** extensions never receive the app-shell **session token**. Each render
> gets a **per-extension token** that authorizes only that extension's own
> `/gqjs/api/<id>/*` surface, so a leaked or malicious extension cannot call the
> main REST API, open WebSockets, or impersonate the app.
>
> **Contract: extensions are not permitted to call the main REST API.**
> `/api/*` and the WebSockets are app-shell surfaces only; an extension that
> needs server-side data does it in its own API handler. This is documented as
> policy, not merely enforced by the token split.
>
> **Related:** `docs/EXTENSION_SANDBOX_LINKS_ANALYSIS.md` — the sandbox/popup
> problem is a separate, orthogonal issue; token scoping does **not** fix it
> (see §5.2) and should not be sold as such.

---

## 1. Problem

Today extension code is handed the **same session token** the app shell uses:

`pkg/server/extension.go` — `buildExtensionInput`:
```go
// token is the caller's validated session token. The render page has an
// opaque origin, so it cannot authenticate to its own API with the cookie;
// it embeds this token in its API URLs instead. Exposing it to the script is
// deliberate: extensions are user-installed and network-gated (suwu.net).
"token": token,
```

`authorizeExtensionRequest` returns `validated` straight from
`auth.ValidateAPIRequest`, which is a constant-time compare against
`cfg.Token` — i.e. the session token. `hn-top-stories/index.js` then bakes it
into the page:

```js
const token = encodeURIComponent(input.token || "");
const api = "/gqjs/api/" + ... + "/stories?token=" + token;
...
data-api="${api}" hx-get="${api}" hx-trigger="load, every 300s"
```

That token is emitted into HTML, into `?token=` URLs, and into `input.token`
for the extension's server-side script. It is exactly the credential the app
shell uses as `Authorization: Bearer …` for the full API, and the credential
that gates the WebSockets.

## 2. Current token model (as built)

| Surface | Auth accepted | Where |
|---|---|---|
| `/api/token` | host + origin match; Basic password if `PasswordHash` set | `handleToken` → `auth.ValidateTokenRequest` |
| `/api/*` (REST) | HMAC signature, or query token / `Authorization: Bearer` equal to `cfg.Token` | `validateRequest` → `auth.ValidateAPIRequest` |
| `/ws`, `/ws/notify`, `/ws/xdisplay` | origin required + token equal to `cfg.Token` | `auth.ValidateWebSocketRequest` |
| `/gqjs/ext/<id>` (render) | cookie `suwu_token` or `?token=`, both equal to `cfg.Token` | `authorizeExtensionRequest` |
| `/gqjs/api/<id>/<path>` | same as render | `handleExtensionAPI` → `authorizeExtensionRequest` |
| `/gqjs/static/<id>/<path>` | **none, by design** | `docs/EXTENSION_API_PLAN.md` §2.8 |

Relevant properties of `pkg/auth`:

- `cfg.Token` is a 256-bit random token; `SigningKey = SHA256("suwu-hmac-key:" + token)`.
- `TokenTTL = 5m`, `TokenGrace = 30s`; rotation is **lazy** — it only happens in
  `handleToken` when `!TokenValid()`, so a token in active use effectively stays
  valid until something calls `/api/token` again.
- `ValidateExtension`-style scoping does not exist. Every accepted token is the
  one session token.
- The session token in the cookie is set from JS and is **not `HttpOnly`**
  (`frontend/src/lib/api.ts`), so anything that gets same-origin execution can
  read it (see §5.2).

## 3. Design

### 3.1 Derived per-extension token (recommended)

Add a stateless, domain-separated derivation to `pkg/auth`:

```go
// ExtTokenDomain separates extension tokens from any other HMAC use.
const ExtTokenDomain = "suwu-extension-token:"

// DeriveExtensionToken returns the token scoped to one extension id.
func DeriveExtensionToken(cfg *Config, id string) string {
    mac := hmac.New(sha256.New, cfg.SigningKey)
    mac.Write([]byte(ExtTokenDomain + id))
    return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// ValidateExtensionToken compares in constant time.
func ValidateExtensionToken(cfg *Config, id, token string) bool {
    return safeTokenEquals(DeriveExtensionToken(cfg, id), token)
}
```

Properties:

- **Stateless**: no map to keep, rotate, or leak; computed on demand.
- **One-way**: an extension holding its own token cannot recover the session
  token or the signing key.
- **Per-extension**: the token for `eye` is different from the token for
  `hn-top-stories`; presenting A's token to B's route fails.
- **Domain-separated**: the prefix keeps the HMAC output from ever colliding
  with any other value derived from the signing key.
- **Rotates with the session key**: consistent with today's behavior — a session
  rotation already invalidates embedded tokens, so this is not a regression
  (§6.3).

### 3.2 Authorization rules after the change

| Surface | Accepts | Rejects |
|---|---|---|
| `/gqjs/ext/<id>` (render) | session token (cookie / `?token=`) — unchanged route gate | — |
| `/gqjs/api/<id>/<path>` | `DeriveExtensionToken(cfg, <id>)` only | session token, other extensions' tokens |
| `/api/*` | session token (or HMAC) — **unchanged** | extension tokens (they are not equal to `cfg.Token`) |
| `/ws*`, `/ws/notify`, `/ws/xdisplay` | session token — unchanged | extension tokens |
| `/api/token` | unchanged | — |
| `/gqjs/static/*` | none — unchanged | — |

Two deliberate choices:

1. **Render keeps the session gate.** The iframe is a same-origin navigation
   carrying the `suwu_token` cookie; that is what authenticates the request. The
   server then **downgrades** the credential it hands into the page: the render
   script receives the derived extension token, never `cfg.Token`.
2. **Extension API accepts only extension tokens.** This keeps the rule crisp
   ("the session token is never needed to talk to an extension surface") and
   means an extension that somehow holds the session token still cannot use it
   on `/gqjs/api/*` either. It is also the cheapest way to catch scope bugs in
   tests.

### 3.3 Why derived, not a random map or signed capability

| Approach | Pros | Cons |
|---|---|---|
| **Derived (3.1)** | stateless; per-extension; no storage/cleanup; trivially constant-time | lifetime tied to the signing key |
| Random `map[id]token` in `Config` | independent lifetime; revocable | state, rotation, cleanup, concurrency |
| Signed capability (`{id, exp, scopes}` + HMAC) | explicit expiry and future per-route scopes | most code; overkill for a single-extension scope |

Start with the derived token. If per-extension **permissions** (read-only API,
network scope, expiry) are wanted later, promote to the signed-capability form;
the call sites (`authorizeExtensionRequest`, `buildExtensionInput`) do not change
shape.

## 4. Required changes

### 4.1 `pkg/auth`

- Add `ExtTokenDomain`, `DeriveExtensionToken`, `ValidateExtensionToken`.
- Tests: determinism, per-id distinctness, constant compare, a derived token is
  not equal to `cfg.Token`, and derivation changes when the signing key rotates.

### 4.2 `pkg/server/extension.go`

- Split `authorizeExtensionRequest` into two paths (or add a mode argument):
  - `authorizeExtensionRenderRequest` — existing session auth (cookie / query).
  - `authorizeExtensionAPIRequest(id)` — extension-token auth for one id.
- `handleExtension`: keep the session gate; change
  `buildExtensionInput(..., validated)` to
  `buildExtensionInput(..., auth.DeriveExtensionToken(s.cfg, ext.ID))`.
- `buildExtensionInput`: strip `token` from the `query` map it hands to the
  render script (mirroring `buildExtensionAPIInput`), so a `?token=` render
  navigation cannot bounce the credential back through `input.query`.

### 4.3 `pkg/server/extension_api.go`

- `handleExtensionAPI`: parse `<ext_id>` **before** authorization (the token
  check needs the id), then validate with
  `auth.ValidateExtensionToken(s.cfg, id, token)` after the host/origin checks.
  Keep the fail-closed ordering: bad host/origin → 400/403 as today; unknown or
  malformed id → 404; missing/invalid token → 401.
- Pass through the existing opaque-origin CORS grant and preflight
  short-circuit unchanged.
- Harden `buildExtensionAPIInput`: drop `authorization` and `cookie` from the
  relayed `headers` (today only the `token` query is stripped). A caller's
  session credential must never be relayed into extension code.

### 4.4 Docs and examples

- `docs/EXTENSION_API_PLAN.md` §2.7 / §2.8 / §3: the canonical `data-api`
  pattern should say **extension-scoped token**, not session token; update the
  "session auth on every API request" wording and cross-reference this plan.
- `docs/EXTENSION_API_PLAN.md` (and the extension authoring notes): state the
  contract that **extensions must not call the main REST API or WebSockets**.
  `/api/*` is the app shell's surface; extension data goes through the
  extension's own `/gqjs/api/<id>/*` handlers. Document that `/api/*` calls
  with an extension token are rejected by design, not by accident.
- `examples/extensions/hn-top-stories/index.js`: header comment says "session
  token" — change to "extension-scoped token". No code change; `input.token`
  keeps working, it is just a different value.
- Add a line to `docs/EXTENSION_SANDBOX_LINKS_ANALYSIS.md` §9 noting the
  separate token-scoping fix.

### 4.5 Tests

- `pkg/auth`: derivation/validation unit tests (above).
- `pkg/server` (existing `extension_test.go` asserts `input.token == cfg.Token`
  — must flip): render input token equals `DeriveExtensionToken(cfg, id)` and
  **not** `cfg.Token`; the same for a second extension id.
- Extension API: its own token → 200; session token → 401; another extension's
  token → 401; missing token → 401; wrong host/origin still fails first.
- Main API regression: `DeriveExtensionToken(...)` against any `/api/*` route →
  401.
- Handler-input regression: `authorization` / `cookie` headers do not reach
  `input.headers`; the `token` query is still stripped.
- Existing end-to-end render tests keep working because the render route gate is
  unchanged.

## 5. Impact

### 5.1 What this blocks

- The extension's server-side handler and browser-side script no longer hold a
  full-authority credential. A malicious or compromised extension cannot:
  call `/api/file*`, `/api/dropbox*`, DB sessions, port forwards, etc. as the
  user; open `/ws` (terminal), `/ws/notify`, or `/ws/xdisplay`; or use HMAC
  signing (the key is not derivable from the scoped token).
- Credential leakage radius shrinks. The token is in HTML and in `?token=`
  URLs — browser devtools, screenshots, copy-paste, logs, and any future
  `Referer`-bearing path. Now the leaked value is scoped to one extension's own
  API instead of the whole app.
- Cross-extension access is removed: `?token=` from extension A is not accepted
  on extension B's routes.
- The documented "extensions get the session token on purpose" decision is
  reversed, which is a prerequisite for ever treating extensions as
  lower-trust than the app shell.

### 5.2 What this does **not** block

- **The sandbox / popup problem.** The extension still runs in an opaque-origin
  sandbox; links opened from it still inherit the sandbox and break workers and
  storage. That is `docs/EXTENSION_SANDBOX_LINKS_ANALYSIS.md`.
- **Option A's browser-side escalation.** If `allow-popups-to-escape-sandbox` is
  ever added (or the existing direct-tab hole is used), extension code can run
  same-origin with the app, read `document.cookie`, and recover the session
  token regardless of what the render input carried. Token scoping is orthogonal
  to that, and `suwu_token` should separately be considered for `HttpOnly` +
  header-only API auth. Token scoping is still worth doing first: it removes the
  *server-side* over-grant and is cheap.
- **A password-less `/api/token`.** With no `PasswordHash`, `ValidateTokenRequest`
  returns a session token to any caller with a matching host and empty/
  same-origin `Origin`. It is not reachable from the sandboxed page (an opaque
  origin sends `Origin: null`, which `parseOriginHeader` rejects → 400), but it
  means the local threat model already trusts the host; token scoping is about
  least privilege for extensions, not about hardening `/api/token`.
- **Extension's own API surface** — extensions can still call their own routes,
  still run child processes with `--ro`/`suwu.net` gating, and still render.
- **The direct-tab render hole.** Extension HTML opened as an unsandboxed tab
  still executes on the app origin; it will now only hold a scoped token *in its
  HTML*, but as a same-origin document it can still read the cookie. Close this
  with the render-page guard, not with token scoping.

### 5.3 Compatibility and rotation

- **No extension API change.** `input.token` remains the field name and the
  `?token=` query remains the transport; only the value changes. Extensions that
  use it only against their own `/gqjs/api/<id>/*` (the documented pattern) keep
  working unchanged.
- **Deliberate break:** an extension that used `input.token` against `/api/*`
  stops working. Today none of the shipped examples do (only `hn-top-stories`
  consumes `input.token`, against its own API), so this is a contract fix, not a
  migration.
- **Rotation.** Derived tokens change when `cfg.SigningKey` changes. Today a
  session rotation already invalidates any open extension page that embedded the
  token, and rotation is lazy (only on `/api/token` after expiry), so this is
  behavior-preserving. If long-lived extension pages become a goal, switch the
  derivation source to a separate, longer-lived extension signing key generated
  at startup — an isolated follow-up, not required for the first fix.

## 6. Pros and cons

**Pros**

- Least privilege: extension code gets exactly one extension's API scope.
- Small, stateless, no migration for well-behaved extensions.
- Removes the largest documented over-grant without touching the sandbox.
- Makes scope bugs testable ("session token must never work on `/gqjs/*`").
- A foundation for future per-extension permissions (scopes, expiry, net).

**Cons**

- A second token type and a scope check — one more place to get authorization
  wrong; mitigated by explicit negative tests at every surface.
- Does not address the actual popup bug or same-origin escalation, so it can
  look like progress while the user-visible symptom remains.
- Requires flipping an existing test and updating docs that currently present
  the session-token grant as intentional.
- Ties extension-token lifetime to session rotation unless a separate signing
  key is introduced.
- The credential still travels in URLs/HTML (now scoped); a header-based or
  postMessage-based API for module code would be a further improvement.

## 7. Decisions (locked)

1. **`handleExtensionAPI` accepts extension tokens only.** The session token is
   rejected on `/gqjs/api/*`, including for the extension's own routes. Enforced
   by `ValidateExtensionToken` and covered by negative tests.
2. **Render stays session-only.** `/gqjs/ext/<id>` continues to authenticate on
   the `suwu_token` cookie / `?token=`; it is not extended to accept extension
   tokens for re-render.
3. **Derive now.** Extension tokens are derived from the session signing key
   (`DeriveExtensionToken`, §3.1). No separate extension signing key and no
   per-extension token storage in this fix. Revisit only if long-lived extension
   pages make the rotation coupling a problem.
4. **No extension uses the main REST API.** This is policy, not an open
   question: extensions must not call `/api/*` or the WebSockets, and this is
   documented (see §4.4). If a future need arises it gets an explicit,
   separately-scoped grant — never the session token.
5. **`HttpOnly` on `suwu_token` is a follow-up, out of scope.** Notes for later:
   it forces header-only auth plus a separate read path for the shell, and is
   part of closing the same-origin/direct-tab exposure described in
   `docs/EXTENSION_SANDBOX_LINKS_ANALYSIS.md` §7–§8.

## 8. Rollout and test plan

1. `pkg/auth`: derivation + validation (+ unit tests).
2. `pkg/server/extension.go`: render path issues scoped tokens (+ update
   `input.token` assertion; add "is not the session token" assertion).
3. `pkg/server/extension_api.go`: id-first, scoped authorization, header
   stripping (+ negative tests across ids and against `/api/*`).
4. Docs + example comment; cross-reference from the sandbox analysis.
5. `go test ./pkg/auth ./pkg/server ./pkg/extension`; manually render
   `hn-top-stories` and confirm the htmx/`data-api` poll still returns stories.

## 9. References

- `pkg/auth/auth.go` — `Config`, `SigningKey`, `ValidateAPIRequest`,
  `ValidateWebSocketRequest`, `ValidateTokenRequest`, `TokenTTL`.
- `pkg/server/extension.go` — `handleExtension`, `authorizeExtensionRequest`,
  `buildExtensionInput`.
- `pkg/server/extension_api.go` — `handleExtensionAPI`,
  `buildExtensionAPIInput`, `grantOpaqueOriginCORS`.
- `pkg/server/server.go` — `validateRequest`, `handleToken`,
  `validateRequestRateLimit`.
- `frontend/src/lib/api.ts` — `suwu_token` cookie (non-`HttpOnly`).
- `examples/extensions/hn-top-stories/index.js` — `data-api="…?token=…"`.
- `docs/EXTENSION_API_PLAN.md` — §2.7 origin/CSP/CORS, §2.8 static assets,
  §3 security summary.
- `docs/EXTENSION_SANDBOX_LINKS_ANALYSIS.md` — sandbox/popup root cause and the
  cost of relaxing it.
