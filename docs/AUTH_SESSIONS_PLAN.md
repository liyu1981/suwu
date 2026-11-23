# Desktop and mobile logins — one token per device, not one token per server

Status: **approved** — decisions locked (§10), `suwu auth ls/rm` added (§8a), build
starts at P1.

Today the server has exactly **one** token. Every device shares it, and whoever
renews it invalidates everyone else. A phone that reopens the PWA therefore logs
the desktop out, and the desktop's next request logs the phone out — the
ping-pong you are seeing. This plan replaces the single token with a small
registry of **login sessions**: one per device (or per browser profile), each with
its own expiry, its own signing key and its own revoke button.

Feasibility: yes, and it is contained. The change lives in `pkg/auth` and the
`/api/token` + `validateRequest` path in `pkg/server`; the token format on the
wire stays an opaque string, so no client migration is needed. A day's work in
four shippable phases (§9).

---

## 1. Why it happens (the mechanism, not a guess)

| Fact | Where |
| --- | --- |
| A token lives **5 minutes** | `auth.TokenTTL = 5 * time.Minute` |
| A request may use an expired token for **30 s** more | `auth.TokenGrace` |
| The server holds exactly **one** token and one signing key | `auth.Config.Token`, `Config.SigningKey` |
| Renewing **rotates** that one token | `Server.handleToken` → `cfg.RotateToken()` |
| Rotation generates a new token **and signing key** | `auth.RotateToken` |
| A new token is minted on **every server start** | `auth.CreateConfig` |
| `/api/token` authenticates with **Basic** (the password) | `auth.ValidateTokenRequest` |
| The browser keeps the token in a **cookie** (`suwu_token`) and sends it as `Bearer` | `lib/api.ts` |
| The password is kept **in memory only**, for the current page | `lib/auth.ts` |

So the sequence is:

1. Phone opens the PWA. Its cookie token is older than 5 minutes, its password is
   not in memory (the page was reloaded), so it asks for the password.
2. The password is right, `/api/token` **rotates** the single token. The phone
   gets the new one.
3. The desktop's next request carries the previous token → `401` → the desktop
   reloads to the login screen, the user types the password, which rotates again.
4. Repeat, forever, at least once every five minutes.

Two separate defects sit behind that loop, and a good plan fixes both:

- **A: one token for everyone.** Rotation cannot be per device because there is
  no per-device identity.
- **B: a device cannot renew itself.** `/api/token` only accepts the *password*.
  A device holding a perfectly good token still has to type the password after a
  reload, which is why the PWA "constantly" asks.

## 2. Goal

- Each device (browser profile / installed PWA) holds its own credential.
  Renewing or rotating it never affects another device.
- A device with a live credential renews **without** the password; the password
  is only for a first login, after an explicit sign-out, or after the session
  expires or is revoked.
- "Sign out this device" and "sign out everywhere" are real operations, and the
  user can see the list.
- Short-lived secrets stay short: a leaked credential must stop working without
  the user doing anything.

## 3. Why the obvious fixes are not enough

- **Raise `TokenTTL`.** The two devices still share one token, so they still
  overwrite each other on every rotation — just less often. It also weakens the
  main defence the 5-minute TTL buys.
- **Give the PWA its own cookie.** The cookie is already per device; the problem
  is on the server, which has nowhere to put a second one.
- **Separate "desktop" and "mobile" tokens.** Two desktop browsers are ordinary,
  and a phone reinstall should not need a new server concept. "One session per
  login" generalises both cases.
- **JWTs with no server state.** They would make rotation painless, but they
  remove the thing that makes the current design safe: the server can revoke a
  credential immediately, and a stolen one dies on its own. Keep server state,
  make it per session.

## 4. The design

### 4.1 A session is the unit of trust

```go
// pkg/auth
type Session struct {
    ID        string    // random, 12 chars, in the token and in the URL
    Secret    []byte    // SHA-256 of the secret half; the token itself is never stored
    SigningKey []byte   // HMAC key for request signatures and extension tokens
    Created   time.Time
    LastSeen  time.Time
    Expires   time.Time // sliding idle expiry
    HardStop  time.Time // absolute expiry, so a phone left open is not eternal
    Label     string    // "iPhone · Safari (standalone)" from the User-Agent
    Legacy    bool      // the token that existed before this change
}
```

`Config` gains `Sessions map[string]*Session` behind a `sync.RWMutex`; `Config.Token`
stays as the *first* session's token so nothing else has to change on day one
(§4.6).

### 4.2 Token format: a session id and a secret

```
suwu1.<sid>.<secret>        sid: 12 base64url chars, secret: 32 random bytes
```

Parsing gives the session in O(1) (map lookup by `sid`), then one constant-time
compare of the secret's hash — no scan over every session, which matters because
every request, every WebSocket connect and every `/api/…` call does this. A token
without the `suwu1.` prefix is treated as the legacy token, so cookies issued
before the upgrade keep working.

### 4.3 Lifecycle

| Event | Effect on sessions |
| --- | --- |
| `POST /api/token` with **Basic** (password) | create a **new** session; return its token. Other sessions untouched. |
| `GET /api/token` with **Bearer/cookie** | renew *that* session (slide `Expires`, `LastSeen = now`), return the same token. No password, no rotation of anyone else. |
| `POST /api/token/rotate` (Bearer) | rotate **that** session's secret and signing key; the caller gets the new token, other devices keep working. |
| `DELETE /api/sessions/<id>` | revoke one session immediately. |
| `POST /api/sessions/revoke-all` | revoke everything **except** the caller (or everything, for "sign out everywhere"). |
| Password change | revoke every other session; the caller's own session is rotated. |
| Idle past `Expires`, or past `HardStop` | session is dropped on first use; that device must log in with the password again. |
| Server start | load the registry from disk (§4.4), so a restart does not log everyone out — which is also a fix for `suwu upgrade` restarting the daemon mid-day. |

**Locked:** idle **30 days**, hard stop **90 days**. Long enough that a PWA never
nags, short enough that a forgotten tablet stops working on its own. Tokens do
**not** rotate on a timer: the session is the credential, rotated on demand
(`POST /api/token/rotate`) and revoked explicitly. The 5-minute cadence goes away
with the single token; nothing else depended on it.

### 4.4 Persistence

`<dataDir>/auth/sessions.json`, mode `0600`, written atomically (temp + rename):

```json
{"schema":1,"sessions":[{"id":"…","secretHash":"…","created":"…","lastSeen":"…",
  "expires":"…","hardStop":"…","label":"…"}]}
```

Only hashes and signing keys are stored — never a usable token. The path sits in
the data directory, so the encrypted settings backup and a `tar` of `~/.suwu`
carry it like any other user data, and `SUWU_VAR` moves it.

### 4.5 Every existing use of the one token becomes "the caller's session"

| Use today | After |
| --- | --- |
| `validateRequest` returns `cfg.Token` | returns the session's token/ID: the rate-limit key (`restLimit`, `livesLimit`, `backupLimit`) becomes per session, which is what those limits actually mean |
| `ValidateAPIRequest(cfg, …)` compares `cfg.Token` | `ValidateAPIRequest(cfg, …)` resolves the token to a session and validates against it; `Bearer`, query token and HMAC all go through the same lookup |
| HMAC request signatures (`SignRequest`, `cfg.SigningKey`) | per session: the client signs with the key derived from its own token; a revoked device's signatures stop verifying |
| Extension tokens (`DeriveExtensionToken`) | derived from the **session's** signing key, so revoking a device also kills the extension tokens that device handed to its frames |
| WebSockets (`/ws`, `/ws/notify`, `/ws/baikal/attach`, `/ws/xdisplay`) | unchanged wire (`?token=…`), resolved against the registry |
| `handleToken` rotation | replaced by §4.3 |

### 4.6 Client

No format change is required: `authFetch` keeps reading the cookie and sending
`Bearer`; on `401` it calls `/api/token` — which now **renews** with the token it
already has when that token is still valid, and only falls back to the password
prompt when it is not. `lib/api.ts` already centralises this (`fetchToken`), and
`lib/auth.ts` already keeps the password in memory for the Basic call.

Two small client additions:

- label the session on first login: a short User-Agent summary plus
  `matchMedia('(display-mode: standalone)')` → "iPhone · Safari (installed)", so
  the session list is readable;
- remember "this device was signed in" so a revoked session produces a single
  "signed out elsewhere" message instead of a bare login form.

## 5. API

```
POST   /api/token                 Basic → new session           { token, session: {id, label, expires} }
GET    /api/token                 Bearer → renew, same token    { token, session: {…} }   (401 → log in)
POST   /api/token/rotate          Bearer → new secret           { token }
GET    /api/sessions              Bearer → list                 { sessions: [{id,label,created,lastSeen,current}] }
DELETE /api/sessions/<id>         Bearer → revoke one           { ok }
POST   /api/sessions/revoke-all   Bearer → revoke others         { revoked: n }
```

Status codes: `401` unknown/expired credential, `403` bad host/origin (unchanged),
`409` when revoking the session you are using (or allow it and rotate instead),
`429` from a rate limit on the Basic path — `/api/token` is the one endpoint where
a password can be guessed, so it gets its own tight budget (§6).

## 6. Security

- **At rest:** only `SHA-256(secret)` and the signing key. A copy of
  `sessions.json` cannot be replayed as a token (it can forge HMAC signatures,
  so the file is `0600` and the backup treats it as a secret).
- **Revocation is immediate** for HTTP, WebSockets and extension tokens, because
  every one of them resolves a session.
- **Sliding expiry** means an active device never needs the password, and an idle
  one stops working — the property the 5-minute TTL was reaching for, without the
  cliff.
- **Cap the registry** (default 32 sessions, evict the oldest by `LastSeen`) so a
  script holding the password cannot grow it without bound.
- **Rate-limit** the Basic path (`/api/token`): a few attempts per minute per IP,
  then back off. Today nothing stops a fast password guess there.
- **Password change** revokes everything else. There is no "remember this device"
  token that outlives the password.
- **`Secure`/`SameSite` cookies** stay as they are; moving to `HttpOnly` cookies
  for the API is a separate, larger change (it needs a CSRF story, and the token
  is also used in WebSocket query strings), and this plan does not depend on it.

## 7. Blast radius

| Area | Change |
| --- | --- |
| `pkg/auth/auth.go` | session types, registry, token parse/mint, `ValidateAPIRequest`, `ValidateTokenRequest`, `RotateToken` → `RotateSession`; ~450 lines, the biggest piece |
| `pkg/server/server.go` | `handleToken`, `validateRequest` (return the session, not `cfg.Token`), the three rate limiters keyed by session, HMAC validation |
| `pkg/server/sessions.go` (new) | the four session endpoints |
| `pkg/server/backup.go`, `rest`, `lives2d` | rate-limit keys |
| `pkg/herdr` / extension tokens | derive from the session's key (no API change, one parameter) |
| `frontend/src/lib/api.ts` | renew before prompting; keep the cookie as the credential |
| `frontend/src/lib/auth.ts` | label the session, remember "signed in here" |
| `frontend/src/components/dialogs/` | the device list (§8) |
| `docs/` | `security` page + this plan's §10 "what shipped" |

`grep -c cfg.Token` in `pkg cmd` is 17 today; most become `session.Token` or
`session.ID`. No route, payload or cookie name changes, so an old client keeps
working against a new server (it gets a session on its next `/api/token`).

## 8a. `suwu auth ls` and `suwu auth rm` (approved)

A locked-out device needs a way back that does not require being logged in. The
CLI talks to the running server over the **notify Unix socket** — the same
`Command`/`CommandResponse` channel `suwu forward` and `suwu static-serve` use, so
there is no token, no password and no new port: the socket is `0700` and only the
account that owns the server can open it.

```sh
suwu auth ls                 # id, label, created, last seen, expires, current?
suwu auth rm <id>            # revoke one session
suwu auth rm --all           # revoke everything except the CLI's own… (no session)
suwu auth ls --json          # for scripts
```

Two new socket actions, `sessions-list` and `sessions-revoke`, handled by the
server where the registry lives (so the in-memory registry and the file cannot
disagree); `suwu auth rm` prints the label it revoked, and the device's next
request gets a 401 and a "signed out elsewhere" message.

## 8b. The UI (v1: minimal)

System Settings → Account already exists. Add a "Devices" block:

```
This device   iPhone · Safari (installed) · active now        [Sign out]
              Desktop · Chrome · 2 hours ago                  [Sign out]
              Pixel · Chrome · 3 days ago                     [Sign out]
              [Sign out everywhere else]
```

Rows come from `GET /api/sessions`; the current session is marked and cannot be
revoked without a confirmation. This is the piece that turns "I keep getting
logged out" into something the user can explain to themselves.

## 9. Delivery phases

| Phase | Work | Done when |
| --- | --- | --- |
| P1 — registry + renewal | session type, token format, `ValidateAPIRequest`/`validateRequest` by session, `/api/token` mints and renews, HMAC per session, rate limits keyed by session | two browsers log in with the same password and both stay logged in; renewing one leaves the other alone; tests cover every lifecycle row in §4.3 |
| P2 — persistence + revocation | `sessions.json`, the four `/api/sessions` endpoints, password-change semantics, registry cap | a server restart keeps every device signed in; revoking a device kills its HTTP, WebSocket and extension tokens on the next request |
| P3 — client | renew-before-prompt, session labelling, "signed out elsewhere" message | a PWA left alone for a day reopens without asking for the password; a revoked device says why |
| P2b — `suwu auth` | `sessions-list` / `sessions-revoke` socket actions, `suwu auth ls\|rm` | `suwu auth ls` matches the Account list; `rm <id>` kills that device's next request |
| P4 — UI + docs | Devices list in Account, security page, release note | the list matches reality; docs describe sessions instead of "the token" |

P1 alone fixes the ping-pong (the two devices stop sharing a token). P2 is what
makes it survive restarts and upgrades, so it should follow quickly.

## 10. Decisions to confirm

All eight are **confirmed**; the table records them.

| # | Decision | Locked |
| --- | --- | --- |
| D1 | Idle / hard expiry | 30 days idle, 90 days absolute |
| D2 | Rotation on a timer? | No — the session is the credential; rotate on demand, revoke explicitly |
| D3 | Where sessions persist | `<dataDir>/auth/sessions.json`, `0600`, hashes only |
| D4 | Session cap | 32, evict the least recently used |
| D5 | `/api/token` with a *valid* Bearer | Renew, don't mint: one endpoint, two meanings, no new client path |
| D6 | Revoking the session you are using | Allowed, and it re-mints for the caller |
| D7 | Label content | User-Agent summary + installed-PWA flag, computed server-side |
| D8 | Old tokens survive the upgrade | Yes: the startup token becomes a `Legacy` session |
| D9 | CLI | `suwu auth ls` / `suwu auth rm <id>\|--all`, over the notify socket (§8a), confirmed |

## 11. Open questions

1. **Does anything else assume one token?** The WebSocket layer and the `clients`
   gate key off `RemoteAddr`, not the token, so they are fine; `/api/token`'s
   Basic path is the only place a password is accepted, which is where the rate
   limit belongs.
2. **Do extension frames need their own session?** No: an extension token is
   derived from the *page's* session, so revoking the device revokes its
   extensions. That is the current behaviour, kept.
3. **Does the PWA need a "stay signed in" toggle?** Not with sliding expiry; if
   you later want a device to expire at a fixed time regardless of use, that is
   the `HardStop` field.
4. **CLI** — confirmed and specified in §8a; it ships in P2b, immediately after the
   registry is on disk, because a locked-out device is the case it exists for.
