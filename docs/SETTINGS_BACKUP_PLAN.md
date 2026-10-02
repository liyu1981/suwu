# Settings & Extension Data Backup — Feature Plan

> **Status:** Implemented. The four server endpoints (`pkg/backup`,
> `pkg/server/backup.go`), the browser modules (`frontend/src/lib/backup/`), the
> System Settings → **Backup** tab, the `suwu upgrade` backup line, and the
> three `check-backup-*.mjs` guards are built and tested.
>
> **Review decisions** (folded in below): passphrase-based zero knowledge;
> **all three categories ship in v1** (settings, extension data, layout);
> notifications history backs up with the settings; the autosave is
> **periodic (default 5 min, user-selectable, per-device and never itself
> synced)**; **10 generations** retained; `suwu upgrade` **reports the backup**.
>
> **Goal:** let the browser back up **user settings** (the `suwu:*` / `suwu.*`
> localStorage surface) and **local extension data** (the per-extension
> `ext-store` records in IndexedDB) to the Suwu server, so a new browser, a new
> machine, or a cleared profile comes back exactly as it was — with the server
> unable to read any of it.
>
> Companions: `docs/EXTENSION_TILE_PLAN.md` §4.8 (the `ext-store` bridge),
> `docs/FOLDER_SYNC_PLAN.md` (the one-way-sync discipline this plan reuses),
> `docs/EXTENSION_TOKEN_SCOPING_PLAN.md` (stateless, domain-separated tokens).

---

## 1. What is actually being backed up

Everything the user configures today lives in the **browser**, not on the
server. Two stores:

| Store | Contents | Written by |
|---|---|---|
| `localStorage` | settings, appearance, zooms, app-menu config, notifications, WM layout/session state | `atomWithStorage` atoms across `frontend/src/store/*` and `frontend/src/wm/atoms.ts` |
| IndexedDB `suwu-extension-ext` / store `kv` | one record per extension KV pair, keyed `suwu:ext/<id>/<key>` | `ExtensionPage.tsx`, on behalf of a sandboxed extension frame |

The server already holds everything *it* owns — extensions and backgrounds under
`<dataDir>/extension/`, `<dataDir>/background/` (`pkg/install`) — so those are
**out of scope**: they are not local data and they already survive a new
browser.

### 1.1 Backup categories (the checkbox list)

| # | Category | Keys | Default |
|---|---|---|---|
| 1 | **Settings & appearance** | `suwu:auto-resolve`, `suwu:header-position`, `suwu:background`, `suwu:background-params`, `suwu:webgpu-background`, `suwu:avatar`, `suwu:username`, `suwu:spaces-idle`, `suwu:notifications`, `suwu:max-entries`, `suwu.term-*`, `suwu.filebrowser-bg`, `suwu.diff-font-family`, `suwu.*-zoom`, `suwu.xdisplay-fps`, `suwu.code-editor-settings`, `suwu:app-menu`, `suwu:rest-options`, `suwu:folder-sync`, `suwu:external-backgrounds`, `suwu_db_saved_connections` | on |
| 2 | **Extension data** | every `suwu:ext/<id>/<key>` record in IndexedDB | on |
| 3 | **Layout & panes** | `tiling-spaces`, `tiling-active-space`, `tiling-session-state`, `suwu-session-states` | on (ships in v1) |

### 1.2 Explicitly never backed up

- **Debug flag** `suwu.bg` (a developer toggle, meaningless elsewhere).
- **Per-tab UI state** under the WM's session-state keys when category 3 is
  off — deliberately opt-in, because a restored layout can reference pane ids
  whose PTY sessions no longer exist (§7).
- Anything not in the registry. Backup is an **allowlist**, never a blanket
  dump of `localStorage` — so a future key that happens to hold something
  sensitive cannot leak by default.
- `sessionStorage` entirely (Cloudflare Access markers `suwu:cf-*`), and the
  session token / cookie, which the browser holds outside `localStorage`
  (`frontend/src/lib/auth.ts`, `POST /api/token`).

> **Guardrail:** `frontend/scripts/check-backup-registry.mjs` fails CI when a
> `suwu*` key appears in `frontend/src` that is neither in the registry nor on
> the deny list. This follows the existing `check-*.mjs` pattern (registry
> refresh, typography, code ranges) so new settings must consciously opt in.

---

## 2. Threat model — "secure way", stated honestly

Suwu is a single-user, password-authenticated server. Two facts shape the
design:

1. **A valid session token already implies full filesystem read** (`/api/file`,
   `handleFile`). So client-side encryption does **not** protect against someone
   who is logged in — it protects the blob *at rest*, on disk, in
   `<dataDir>/backup/`, from anyone who can read the data dir but not decrypt
   (a stolen backup, a shared host, a leaked archive, an accidental commit of
   the data dir, an offline attacker with a disk image).
2. The browser is the only party that ever sees the plaintext. The browser is
   also the party being backed up, which is the point.

Therefore:

| Adversary | Defence |
|---|---|
| Read the server's data dir / a copied backup archive | **AES-256-GCM** with a key the server never has |
| Tamper with a stored blob | **GCM auth tag** + header bound as **AAD** → decryption fails, restore refuses |
| Roll back to an older generation | Plaintext `gen` + `deviceId` inside the ciphertext; the client shows what it is restoring and refuses a generation older than one it has already applied, unless the user forces |
| Network (if TLS is misconfigured) | Server mode defaults to HTTPS (`SERVER_MODE=https`); payloads are ciphertext anyway |
| A logged-in attacker | Out of scope by construction (§2, fact 1) — but a **local file export** (§6.4) is the user's escape hatch |

**The passphrase never leaves the browser.** No recovery email, no server-side
reset, no hint. Forgetting it means the data is gone — the UI says so, once,
at the moment it is set, and refuses to let the user enable backup without one.

Rejected alternatives:

- **Key derived from the session token / server signing key.** No passphrase to
  forget, but the server (and anyone with `AUTH_PASS`) can decrypt, and the
  5-minute token rotation would force re-encryption of every generation.
- **Per-extension HMAC tokens as the key.** Rejected: those are handed to
  *untrusted* extension code (`DeriveExtensionToken`); using one as backup key
  material would let every installed extension decrypt the user's backup.
- **Plain JSON blob with a server-side ACL.** No: the data dir is copied around
  by `suwu upgrade`, systemd backups, and rsync far more often than the API is
  abused.

---

## 3. Container format

One file, one self-describing container. Layout:

```
offset 0   magic       "SUWUBK1"           (7 bytes)
offset 7   hdrLen      uint32 BE
offset 11  header      hdrLen bytes of JSON
           ciphertext  AES-256-GCM(key, nonce, plaintext), remaining bytes
```

```jsonc
// header — unencrypted on purpose: everything here is metadata the server and
// the UI need before a key exists. Nothing sensitive may ever be added here.
{
  "v": 1,
  "kdf": { "alg": "PBKDF2-SHA256", "iter": 600000, "salt": "<b64, 16B>" },
  "wrap": { "alg": "AES-256-GCM", "nonce": "<b64, 12B>" },   // ct in plaintext header
  "gen": 7,
  "createdAt": "2026-02-11T09:31:04Z",
  "plaintextSha256": "<b64>"   // self-check after decrypt; not a secret
}
```

Key schedule:

- **Passphrase → KEK**: `PBKDF2-SHA256(passphrase, salt, 600000)` → 256-bit.
  600k is the OWASP floor and costs ~0.5 s once per session; the derived KEK is
  held in a module-level variable, so it is paid on enable, on restore, and on
  the first autosave after a reload — not on every keystroke.
- **KEK → DEK**: a 256-bit data-encryption key generated with `crypto.getRandomValues`
  when backup is enabled and stored **only** wrapped: `wrap.ct = AES-GCM(KEK, nonce, DEK)`.
- **Each generation** re-encrypts the plaintext under a fresh nonce with the
  **same DEK**. Rotating the passphrase re-wraps the DEK (one small header
  change, no re-upload of the history).
- **AAD = the exact header bytes**, so an attacker cannot rewrite `iter`, `salt`
  or `gen` without invalidating the tag.

Plaintext (v1):

```jsonc
{
  "v": 1,
  "deviceId": "b3f1…",           // random uuid, minted on first backup
  "createdAt": 1770800464000,
  "categories": ["settings", "ext", "layout"],
  "items": [
    { "ns": "ls",   "path": "suwu:background",          "mtime": 1770800000000, "value": "ambient" },
    { "ns": "ls",   "path": "tiling-spaces",            "mtime": 1770799000000, "value": { /* … */ } },
    { "ns": "ext",  "path": "note/record",              "mtime": 1770798000000, "value": { /* … */ } }
  ]
}
```

Per-item `mtime` is what makes a **merge** possible (§6.3) without a
server-side diff. Item count and sizes are visible in the plaintext size only —
the server learns *that* something changed and when, never what.

---

## 4. Server side

### 4.1 New package `pkg/backup`

A deliberately dumb, opaque blob store — the same shape as `pkg/dropbox`, minus
the filename uniquing.

```
<dataDir>/backup/<slotID>/meta.json      # server-written plaintext metadata
<dataDir>/backup/<slotID>/g00000007.bin  # one file per generation
```

`meta.json` (0600, dir 0700) holds only: slot id, per-generation
`{gen, size, sha256Ciphertext, mtime}`, plus `quota {generations, bytes}`. It
never contains plaintext and is not sensitive — but it is still inside the data
dir, so the same permissions apply.

```go
// pkg/backup/backup.go
type Generation struct {
    Gen   int       `json:"gen"`
    Size  int64     `json:"size"`
    SHA256 string   `json:"sha256"`   // of the ciphertext, for transfer integrity
    MTime time.Time `json:"mtime"`
}
type Meta struct {
    Slot        string       `json:"slot"`
    Generations []Generation `json:"generations"`
}
```

Invariants (all unit-tested):

- **Slot ids are opaque.** `^[a-z2-7]{26}$` (130 bits, Crockford base32) and
  nothing else. A slot id is the *recovery code*; it is a bearer-ish secret
  only in the weak sense of §2 — possession plus passphrase opens the blob.
- **Path construction is validate-then-join**: match the regex, `strconv.Atoi`
  the generation, then `filepath.Join`. `filepath.Clean` never sees user input.
- **No symlink following.** Every write opens with
  `O_CREATE|O_EXCL|O_NOFOLLOW` on a `<gen>.tmp` file inside a `Lstat`-verified
  real directory, `fsync`s, then `rename`s into place. Reads `Lstat` the target
  and refuse a symlink — the same discipline `handleSyncManifest` uses.
- **Quota**: 10 generations, 64 MiB per slot, 16 MiB per upload
  (`http.MaxBytesReader` at the handler *and* `io.LimitReader` in the store).
  Exceeding it prunes the oldest generations; an oversized single upload is a
  413 and never partially written.
- **Garbage rejection**: the store parses only the 11-byte prologue and the
  header, and rejects `magic != "SUWUBK1"` or `v > 1`. It does not look at
  anything else — no base64-decoding of user fields it does not need.
- **Bounded by the caller**: one slot directory per request; the server holds
  no in-memory state, so `suwu upgrade`/restart is a non-event.

### 4.2 Endpoints (`pkg/server/backup.go`)

| Route | Method | Body / query | Returns |
|---|---|---|---|
| `/api/backup` | `POST` | raw container bytes; `X-Suwu-Slot: <26 chars>`; optional `?base=<gen>` | `{gen, mtime, generations, bytes}` |
| `/api/backup/meta` | `GET` | `?slot=` | `Meta` + quota |
| `/api/backup/blob` | `GET` | `?slot=&gen=` | raw bytes |
| `/api/backup` | `DELETE` | `?slot=&confirm=<slot>` | 204 |

Every handler goes through the existing `validateRequest` (HMAC → query token →
`Authorization`, with the Host/Origin pairing check), so the endpoints inherit
CSRF protection and the short-lived token model. Extra hardening:

- **New dedicated rate limiter** `/api/backup/` — `POST` 6/min, reads 60/min.
  This is the one endpoint an autosave loop can legitimately hammer, and it
  must not eat the destructive-op budget in `validateRequestRateLimit`
  (which is why `/api/backup/` is *not* added to that prefix list).
- `POST` uses optimistic concurrency: `?base=<gen>` must equal the slot's
  current generation, else **409 Conflict**. A second device that pushes blind
  therefore cannot silently clobber a newer backup; the client turns 409 into
  a prompt (§6.3). Omitting `base` is allowed only for the first write.
- `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `Content-Disposition: attachment` on blob reads; `Content-Type:
  application/octet-stream`.
- `DELETE` is rate-limited like a destructive op and requires `confirm` to
  echo the slot id — a mistyped slot in the URL should not wipe a backup.

### 4.3 Storage layout tests

`pkg/backup/backup_test.go` covers: slot/gen validation and traversal attempts
(`../`, absolute, symlinked slot dir, non-base32 chars), quota pruning order,
atomic-write-under-concurrent-POST, corrupt/short/oversized uploads, mode
bits (0700/0600), and a round-trip through an `httptest` server asserting the
bytes returned by `GET /blob` are byte-identical to what `POST` received.

---

## 5. Client architecture

### 5.1 New module `frontend/src/lib/backup/`

| File | Responsibility |
|---|---|
| `registry.ts` | the allowlist (§1.1) — key patterns → category. Single source of truth shared by export, import and the CI check |
| `container.ts` | magic/header encode+decode, `pack()` / `unpack()`, AAD handling, `v` check |
| `crypto.ts` | `deriveKek`, `newDek`, `wrapDek`/`unwrapDek`, `encrypt`/`decrypt`, passphrase strength check |
| `collect.ts` | read the selected categories → `Item[]` (localStorage + IndexedDB read) |
| `apply.ts` | validate `Item[]`, then write them in a safe order; returns an applied/skipped report |
| `client.ts` | the autosave state machine: the timer, dedup, 409 handling, status |
| `types.ts` | `Item`, `Payload`, `Meta`, `Category`, `BackupStatus` |

`ExtensionPage.tsx` already owns the IndexedDB handle; `collect.ts` reuses the
same `withExtStore` open logic (extracted into `extStore.ts` and shared, so the
bridge and the backup cannot drift on DB name, store name, or the 512 KB cap).

### 5.2 The autosave timer

The backup runs on a **timer**, not on every keystroke (review decision):
a change event is far too chatty for encryption plus a network round-trip, and
a daily backup is useless if the browser is only open for an hour.

| Trigger | Behaviour |
|---|---|
| timer (default **5 min**, user-selectable 1/5/15/30/60) | collect → canonicalize → encrypt → `POST`, but only if the payload changed |
| `notifyBackupDirty()` from the extension bridge | a hook point only; under a periodic schedule the next tick picks the change up on its own, so it never uploads by itself |
| `Back up now` | runs a pass immediately |
| restore / passphrase change | clears the change-hash so the next pass re-uploads under the new state |

**Dedup**: the SHA-256 of the canonical payload is compared against the last
uploaded one. An idle tab uploads nothing and burns no generations. `createdAt`
is zeroed before hashing, since it changes every run and would otherwise make
two identical snapshots differ. The data key lives only in memory, so a reload
leaves the timer idle until the passphrase is re-entered (via Restore or
Change) — which is also how a **new browser** acquires a key and starts its
own cadence.

### 5.3 Opt-in, not opt-out

Backup starts **disabled** with no slot and no passphrase. The user turns it on
in System Settings → Backup, picks a passphrase, and from then on the timer
runs on their chosen cadence. Nothing is uploaded before the user asks for it —
a feature that phones home by default would be a surprise in a security tool.

### 5.4 Client tests

`frontend/scripts/check-backup-*.mjs` (`node --experimental-strip-types`), in
the existing house style:

- `check-backup-crypto.mjs` — pack/unpack round-trip, tamper detection on every
  header field, wrong-passphrase failure, `iter`/`salt` substitution rejected
  by AAD, DEK re-wrap without re-encryption.
- `check-backup-collect.mjs` — every registry key is collected; category
  filtering works; the 512 KB per-item cap and the 8 MiB plaintext cap drop the
  largest items and report them.
- `check-backup-merge.mjs` — per-item `mtime` merge, replace vs merge, unknown
  future `v` refused, a value from a newer client schema left untouched.
- `check-backup-registry.mjs` — the §1.2 guardrail.

---

## 6. User experience

### 6.1 System Settings → new **Backup** tab

Sits after *Account*, before *Language* (state before locale). Sections follow
the existing `rounded-[6px] border border-white/10 bg-black/20 p-3` +
`text-xs` label + `text-[11px]` hint pattern already used throughout
`SettingsView.tsx`; type sizes stay inside the §11 scale of
`.opencode/skills/suwu-tile-plugin-design/SKILL.md`. All strings through
`t('settings.backup*')` in **both** `en.json` and `zh_CN.json`.

**Disabled state** (the default):

> **Backup** — Keep your settings and extension data on this server, encrypted
> with a passphrase only you know.
> `[ Enable backup ]` · *Nothing is uploaded until you turn this on.*

**Enabled state** (`BackupTab.tsx`):

| Row | Content |
|---|---|
| Status | `Backed up 2 min ago · generation 7 · 84 KB` (re-rendered on every tick) or `Backing up…` / the failure message / the conflict notice |
| Actions | `Back up now` · `Export file` |
| Recovery code | masked `abcd·····wxyz`, `Show`/`Hide`, `Copy` |
| Passphrase | `Change` → re-wraps the key, no history re-upload |
| Categories | three switches (settings / extension data / layout), all on by default |
| How often | a select: every 1 / 5 / 15 / 30 / 60 min |
| Restore | generation picker, merge/replace switch, passphrase, `Restore` |
| Forget this backup | two-step confirm that also deletes the slot server-side |

### 6.2 Restore

1. **Where from?** — a generation on this server (the picker lists them
   newest-first with their size).
2. **Passphrase** — typed into the restore form; a wrong one fails with
   "wrong passphrase, or the backup is damaged", because the two are
   cryptographically indistinguishable and the UI will not pretend otherwise.
3. **Mode** — `Merge` (default; per item the newer `mtime` wins, nothing is
   ever deleted) or `Replace` (the backup is the truth: local keys it does not
   carry are removed). Merge is the default because the destructive direction
   should be opt-in.
4. **Preview + confirm** — a summary of settings / extensions / layout counts
   and how many items change, which the user must accept.
5. **Apply**, then a `Reload` prompt — the layout and the store atoms are read
   at boot, and a reload is more honest than half-applying state and faking
   it.

Failure modes are explicit, never silent: wrong passphrase, a backup from a
newer Suwu (`payload v…`), and keys this build no longer recognises are each
reported by name rather than dropped.

### 6.3 Multi-device

Each browser mints a random `deviceId`; every generation carries it. Pushing
from a second device with a stale view gets 409 and two explicit buttons —
**Overwrite with mine** / **Restore theirs** — never a silent overwrite.

### 6.4 Export

`Export file` downloads the newest generation as `suwu-backup-g<gen>.bin`. It
is the user's own copy: it works with the server down, and it is the only
answer to "what if the server disk dies". Importing a file is not in the UI
today (the container is the same bytes, so it is a small follow-up).

---

## 7. Deliberate limits and open trade-offs

- **Layout & panes is best-effort.** `tiling-spaces` references PTY
  session ids; the server keeps sessions for `SESSION_TTL` (24 h default). A
  restored layout more than a day old restores its *tiles* — file browser,
  note, git graph — but a dead terminal tile comes back empty. Restoring layout
  is about the arrangement, not about resurrecting shells.
- **Blob size.** An uploaded avatar (`suwu:avatar` holds a data URL) plus
  notification history plus a `note` document puts a realistic backup at
  50–500 KB. The 8 MiB plaintext cap is generous; when it is hit, the largest
  items are dropped **and named** in the status line rather than silently
  truncated.
- **No cross-server sync CLI.** One backup lives on one Suwu server. The
  container format already supports moving a backup between servers (the export
  file is the same bytes), so `suwu import-backup` remains a natural v2.
- **No per-item history.** Ten whole generations, not per-key history. Undo
  granularity is "go back a few saves", which matches how these settings change.
- **Quota is per slot, and slots are unbounded.** A user can create many slots;
  a hard cap would need a server-side registry, which is more state than this
  feature earns. Documented as a known limit.

---

## 8. Phases — all shipped

| Phase | Work | Status |
|---|---|---|
| **0** | `pkg/backup` store + tests; the four endpoints + rate limiter + CSRF/limits | done — `pkg/backup/backup.go`, `pkg/server/backup.go`, both fully tested |
| **1** | `container.ts` / `crypto.ts` / `registry.ts` / `collect.ts` / `apply.ts` + node checks | done — plus `lib/extStore.ts`, shared with the bridge so they cannot drift |
| **2** | `client.ts` autosave, slot + passphrase onboarding, `/api/backup*` round-trip, status line, 409 flow | done — the autosave is a **timer**, not a debounce (review decision) |
| **3** | `ext-store` dirty hook, layout category, multi-slot UI | done — the dirty hook is a no-op under a periodic schedule and is kept as the single hook point |
| **4** | `check-backup-*.mjs` in `pnpm check`; README; `suwu upgrade` backup line | done |

Verification: `pkg/backup` unit tests, `pkg/server` handler tests (auth, limits,
conflict, traversal, pruning, permissions), three browser-side guard scripts in
`pnpm check`, and an opt-in end-to-end script (`check:backup-e2e`) that runs
the real crypto against a live server and asserts the bytes round-trip. The
end-to-end run confirmed the TS and Go container formats agree, pruning to 10,
and 0700/0600 modes.

---

## 9. Review questions — answered

1. **Passphrase vs. server-held key.** Passphrase (zero-knowledge): confirmed.
   The server never holds a key; forgetting the passphrase loses the data, and
   the UI says so once, at the moment it is set.
2. **Category 3 (layout & panes) in v1?** Shipped in v1. It is best-effort — a
   restored layout restores the *arrangement*; a PTY tile whose session expired
   comes back empty — and that is stated in the restore hint.
3. **Notifications history inside category 1?** Yes, backed up with the rest of
   the settings; no separate toggle.
4. **Auto-upload cadence.** A **timer**, default 5 min, selectable in Settings
   (1/5/15/30/60). Only uploads when the canonical payload actually changed.
   The interval is per-device and is on the deny list — it is never backed up.
5. **Generation retention.** 10.
6. **`suwu upgrade`.** It now prints a one-line backup summary (generations,
   slots, bytes, latest time) on every path, including `--check` and the
   dev-build short-circuit. The backup lives beside the data, not inside the
   executable, so replacing the binary never touches it — the line confirms
   that rather than assuming it.
