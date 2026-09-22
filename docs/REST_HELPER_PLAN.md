# REST Helper Tile — Feature Plan

> **Status:** Plan only. No code has been written.
> **Goal:** A Postman-like tile plugin for investigating HTTP/REST endpoints. The
> request is executed **by the Suwu backend** (so CORS, CSP `connect-src 'self'`,
> and private-network reachability are non-issues), and the response is shown in
> Plain text, Raw body, JSON, and an **LLM-optimized** view.

This plan borrows heavily from the existing implementation in
`/home/yli/inspect-http-proxy` (a Next.js + Jotai + Go proxy-inspector). Section
§10 maps each borrowed idea to the Suwu file that will host it.

---

## 1. Why this fits Suwu

Suwu's tile architecture is designed for exactly this: **a durable, isolatable
app surface** rendered in an iframe, communicating with a Go backend over the
authenticated `/api/*` surface. The DB Browser (`docs/DB_BROWSER_PLAN.md`) is the
closest existing precedent — a developer tool with a request builder, an editor,
and a result surface. The REST Helper is the same shape with an HTTP client
instead of a database driver.

The browser iframe **cannot** fetch arbitrary external URLs:

- CSP is `connect-src 'self' ws: wss: blob:` (see `pkg/server/server.go:csp`).
- Even without CSP, CORS would block cross-origin reads.

So the backend must perform the outbound request. This is not a workaround — it
is a feature: the helper can reach `localhost`, LAN hosts, and services behind
auth, which is precisely what a remote-shell user wants.

---

## 2. Scope

### In scope (MVP)

- Methods: `GET POST PUT PATCH DELETE HEAD OPTIONS`
- URL + collapsible auto-synced query-parameter table
- Headers table (enable/disable, key/value, **duplicate keys preserved**)
- Body: `none` / `json` / `raw` / `form-data` (text + base64 file) /
  `x-www-form-urlencoded`
- **User-Agent modes**: backend default / replicate browser / custom
- Send (`Ctrl/Cmd+Enter`) and cancel (abort `fetch` → cancels the outbound
  request via `r.Context()`)
- Response views: **Plain text**, **Raw**, **JSON (pretty)**, **LLM**, plus
  Status, Response Headers, and Request Details tabs
- Copy response, copy for LLM, download response
- History + Collections, persisted **client-side in IndexedDB** (backend is stateless)
- Cookie jar (client-side, IndexedDB) with auto-capture/auto-attach, plus
  best-effort import of the current browser's cookies

### Out of scope (later phases, §9)

- WebSocket / gRPC / GraphQL-specific tooling
- OAuth2 flows / interactive auth

---

## 3. Borrowed design (from `inspect-http-proxy`)

| Idea | Source file | How Suwu adopts it |
|------|-------------|--------------------|
| Request data model (`method/url/headers[]/body/bodyType/formDataEntries/timestamp`) | `frontend/src/app/_jotai/http-req.ts` | `frontend/src/store/resthelper.ts` (Jotai atoms) |
| Response model (`status/statusText/headers/body/duration`) | `frontend/src/app/_jotai/http-res.ts` | `pkg/server/resthelper.go` + `store/resthelper.ts` |
| Backend executes the request, returns raw body | `pkg/web/api/api_httpreq.go` | `pkg/server/resthelper.go` (improved: multi-value headers, explicit base64, size cap) |
| Body renderer registry (`match` + `priority`) | `_components/body-renderers/registry.tsx` | `components/resthelper/renderers/registry.ts` |
| JSON renderer | `body-renderers/json-renderer.tsx` | Monaco read-only JSON view (Monaco already bundled) |
| LLM markdown generator | `lib/llm-data-gen-util.ts` | `frontend/src/lib/llm-format.ts` |
| cURL generator | `lib/curl-gen-util.ts` | `frontend/src/lib/curl-format.ts` (Phase 2) |
| Response tab layout (Body / Status / Headers / Request) | `_components/http-response-viewer.tsx` | `components/resthelper/ResponseViewer.tsx` |
| Request builder layout | `_components/http-req-builder.tsx` | `components/resthelper/RequestBuilder.tsx` |
| Per-request response cache + IndexedDB persistence pattern | `_jotai/http-res.ts` (IndexedDB) | **Adopted directly** into `frontend/src/lib/restdb.ts`; all plugin data is client-side |

**Deliberate improvements over the source:**

1. **Headers are an ordered array**, not `map[string]string`, so duplicates
   (`Set-Cookie`, multiple `Accept`, repeated custom headers) survive.
2. **Response headers are `map[string][]string`**, not collapsed to the first
   value.
3. **Body is an explicit `bodyB64` field** with `bodySize` + `truncated`,
   instead of relying on `[]byte` JSON base64 + fragile frontend heuristics.
4. **Transport errors are a normal 200 envelope** with `status: 0` + `error` +
   `errorKind` (DNS/timeout/TLS/refused), so the UI has one response shape. An
   HTTP 4xx/5xx is a *valid response*, exactly like Postman.
5. **`User-Agent` modes** are first-class (the source has no UA handling).
6. **TLS verification can be disabled** and **redirects controlled** — required
   for a local-dev tool.

---

## 4. Backend design

### 4.1 New file: `pkg/server/resthelper.go`

Handlers:

```go
// handleRESTHelper routes /api/rest/* requests.
func (s *Server) handleRESTHelper(w http.ResponseWriter, r *http.Request)
// handleRESTRequest executes an outbound HTTP request.
func (s *Server) handleRESTRequest(w http.ResponseWriter, r *http.Request)
```

Route registration in `pkg/server/server.go` (`route()`), next to the DB block:

```go
if strings.HasPrefix(r.URL.Path, "/api/rest/") {
    s.handleRESTHelper(w, r)
    return
}
```

Endpoint table:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/rest/request` | Execute an HTTP request server-side, return the envelope |

All endpoints call `s.validateRequest(w, r)` first (HMAC/token, same as DB/forward).

**The backend is stateless.** It executes the request and returns the envelope;
it never stores requests, responses, history, or collections, and it exposes no
such read endpoints. All persistence lives in the browser (§5.6).

### 4.2 Request payload

```go
type restHeader struct {
    Key     string `json:"key"`
    Value   string `json:"value"`
    Enabled bool   `json:"enabled"`
}

type restFormEntry struct {
    Key         string `json:"key"`
    Value       string `json:"value"`       // text value
    Type        string `json:"type"`        // "text" | "file"
    Filename    string `json:"filename"`    // when type == "file"
    ContentB64  string `json:"contentB64"`  // when type == "file"
    Enabled     bool   `json:"enabled"`
    ContentType string `json:"contentType"`
}

type restRequest struct {
    Method           string          `json:"method"`
    URL              string          `json:"url"`
    Headers          []restHeader    `json:"headers"`
    BodyType         string          `json:"bodyType"`   // none|json|raw|form-data|urlencoded
    Body             string          `json:"body"`
    FormData         []restFormEntry `json:"formData"`

    UserAgentMode    string          `json:"userAgentMode"`    // default|browser|custom
    BrowserUserAgent string          `json:"browserUserAgent"` // navigator.userAgent
    CustomUserAgent  string          `json:"customUserAgent"`

    TimeoutMs        int             `json:"timeoutMs"`
    FollowRedirects  *bool           `json:"followRedirects"`  // nil = follow (default)
    InsecureTLS      bool            `json:"insecureTLS"`
    MaxResponseBytes int64           `json:"maxResponseBytes"`
}
```

### 4.3 Response envelope

```go
type restResponse struct {
    Status      int                 `json:"status"`       // 0 when transport failed
    StatusText  string              `json:"statusText"`
    Headers     map[string][]string `json:"headers"`      // multi-value preserved
    BodyB64     string              `json:"bodyB64"`      // always base64
    BodySize    int64               `json:"bodySize"`
    Truncated   bool                `json:"truncated"`
    DurationMs  int64               `json:"durationMs"`
    FinalURL    string              `json:"finalUrl"`
    Redirects   []string            `json:"redirects"`
    InsecureTLS bool                `json:"insecureTLS"`
    Error       string              `json:"error,omitempty"`
    ErrorKind   string              `json:"errorKind,omitempty"` // dns|timeout|tls|refused|invalid-url|other
}
```

Always written with HTTP 200 + `writeJSON`; the UI decides how to render.

### 4.4 Execution rules

- **Auth-required:** `validateRequest` + rate limit (see §4.6).
- **Concurrency:** a package-level buffered semaphore (e.g. 16 slots); return
  HTTP 429 with a JSON error when exhausted, so one pane cannot exhaust the
  server's sockets.
- **Body size:** `http.MaxBytesReader(w, r.Body, 32<<20)` on the inbound
  payload (form-data files are base64 in JSON, so cap accordingly).
- **Timeouts:** default `30_000ms`, clamped to `[1_000, 300_000]`. Applied via
  `context.WithTimeout(r.Context(), ...)` so an abort from the browser cancels
  the outbound call.
- **Response cap:** default `10 << 20` bytes; read with
  `io.LimitReader(resp.Body, max+1)` and set `Truncated` when the extra byte is
  read.
- **Redirects:** default follow (Go default 10). When `followRedirects` is
  false, set `CheckRedirect: http.ErrUseLastResponse`. Record the chain.
- **TLS:** when `insecureTLS`, clone the transport with
  `InsecureSkipVerify: true`. Never global.
- **Hop-by-hop headers:** strip `Connection`, `Keep-Alive`, `Proxy-*`,
  `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade` from the request.
- **Decompression:** do **not** set `Accept-Encoding` automatically; Go's
  transport transparently gzips when the header is absent. If the user sets
  `Accept-Encoding` explicitly, the raw (still-compressed) bytes are returned
  and the frontend shows them as binary — document this.
- **Logging:** never log `Authorization`, `Cookie`, or bodies. Log method +
  host + status + duration only.

### 4.5 User-Agent resolution (precedence)

1. An explicit, enabled `User-Agent` header in the headers table **wins**.
2. Otherwise, per `userAgentMode`:
   - `default` → `SuwuREST/<version>` (version from `pkg/version`), so traffic
     is identifiable.
   - `browser` → the `browserUserAgent` string supplied by the frontend
     (`navigator.userAgent`). Phase 3 can add Client Hints
     (`sec-ch-ua*`, `Accept-Language`) read from the browser for full fidelity.
   - `custom` → `customUserAgent`.
3. If the resolved UA is empty, omit it (Go then sends its default `Go-http-client/1.1`).

The Request Details tab renders the **resolved** UA so the user can see exactly
what was sent.

### 4.6 Security notes

- **SSRF is intentional** (Postman semantics), but it must not be an open
  proxy for a hostile page. Mitigations:
  - The endpoint is behind the existing HMAC/token auth.
  - Add `/api/rest/` to `validateRequestRateLimit`'s `destructive` prefixes, or
    give it a dedicated outbound limiter (e.g. 240 req/min/token).
  - Default-deny link-local metadata (`169.254.0.0/16`, `fd00:ec2::254`) unless
    an env flag `REST_HELPER_ALLOW_LINK_LOCAL=true` is set. Loopback/LAN stay
    allowed by default (dev use case).
  - Optional env `REST_HELPER_BLOCK_HOSTS` / `REST_HELPER_ALLOW_HOSTS`
    (comma-separated) for operators.
- **No secrets persisted:** history/collections store request *definitions*;
  the UI will warn/redact on export. Auth tokens used by the helper are the
  user's own (Bearer/Basic header values) and are stored only if the user saves
  the request — mark such fields and offer a "don't save this" toggle.
- **TLS skip-verify** is per-request only and shown as a warning badge.

---

## 5. Frontend design

### 5.1 Tile plugin contract

New plugin id `resthelper`.

**`frontend/src/wm/plugins/resthelper.tsx`**

```tsx
registerTilePlugin({
  id: 'resthelper',
  get label() { return i18n.t('plugin.resthelper') },
  get description() { return i18n.t('plugin.resthelperDesc') },
  supportedParams: [
    { key: 'url',    label: 'URL',    description: 'Initial request URL' },
    { key: 'method', label: 'Method', description: 'HTTP method (default GET)' },
  ],
  render: (paneId, context) => {
    const p = new URLSearchParams({ pane: paneId })
    if (context?.initialPath) p.set('url', context.initialPath)
    if (context?.params) for (const [k, v] of Object.entries(context.params)) p.set(k, v)
    return <iframe src={`/resthelper?${p}`} title={`resthelper-${paneId}`}
                   data-pane={paneId} className="h-full w-full border-0 bg-transparent" />
  },
})
```

Because `url` is a declared param, users can create App Menu custom apps that
open the helper pre-pointed at a service (no hardcoded presets).

### 5.2 Route + page

- `frontend/src/routes/RestHelperPage.tsx` — calls `setPageTransparent()`, wraps
  in `<CommonTileContainer zoomAtom={resthelperZoomAtom} noPadding>`, reads
  `url`/`method` from `window.location.search`.
- Register under `rootRoute` in `frontend/src/router.tsx` (never `appRoute`).
- Side-effect import in `frontend/src/wm/TilingWM.tsx`.

### 5.3 Component tree

```
RestHelperPanel.tsx                     — layout: left sidebar + builder + response
├── SidebarTabs.tsx                     — History | Collections
│   ├── HistoryList.tsx
│   └── CollectionsTree.tsx             — folders + saved requests
├── RequestBuilder.tsx                  — method + URL + Send/Cancel
│   ├── QueryParamsTable.tsx            — auto-synced with URL
│   ├── KeyValueTable.tsx               — reusable for headers + params + urlencoded
│   ├── AuthEditor.tsx                  — None | Bearer | Basic | API key (Phase 2)
│   ├── BodyEditor.tsx                  — none/json/raw/form-data/urlencoded
│   │   └── Monaco JSON editor (reuse codeexplorer monacoSetup)
│   ├── CookiesPanel.tsx                — jar table + browser import + paste
│   └── RequestOptions.tsx              — UA mode, timeout, redirects, TLS, cookie toggles
├── ResponseViewer.tsx                  — tabs: Body | LLM | Status | Headers | Request
│   └── renderers/registry.ts           — content-type dispatch (JSON/text/image/html/binary)
└── StatusBar.tsx                       — status, time, size, truncated
```

### 5.4 The four requested body views

The response **Body** tab has a view switcher (Postman-style segmented control):

| View | Rendering | Notes |
|------|-----------|-------|
| **Plain text** | `<pre>` with the decoded body, wrapped, selectable | Default for `text/*` |
| **Raw** | The decoded body, unformatted, monospace, no wrapping toggle | Byte-exact for text; for binary shows base64 |
| **JSON** | Pretty-printed, read-only Monaco (JSON language) | Auto-selected for `application/json`; collapsible via editor folding |
| **LLM** | Rendered markdown from `lib/llm-format.ts` + **Copy for LLM** | Token-efficient structured view (§5.5) |

Plus **Auto**: use the renderer registry to pick the best default (JSON, image
preview, HTML preview, binary download) and allow the user to switch to any of
the four manual views. The registry is borrowed from
`body-renderers/registry.tsx` (`match(contentType, body)` + `priority`).

### 5.5 LLM-optimized view (`frontend/src/lib/llm-format.ts`)

Port of `generateLLMMarkdown` (`inspect-http-proxy/frontend/src/lib/llm-data-gen-util.ts`),
adapted to our envelope:

```markdown
# HTTP Request
- **Method:** POST
- **URL:** https://api.example.com/v1/chat
- **Final URL:** https://api.example.com/v1/chat
- **Status:** 200 OK
- **Duration:** 143 ms
- **Size:** 1.2 KB (not truncated)

## Request Headers
```http
Content-Type: application/json
User-Agent: SuwuREST/1.0
```

## Request Body (application/json)
```json
{ "model": "..." }
```

## Response Headers
```http
content-type: application/json
```

## Response Body (application/json)
```json
{ ... }
```
```

Rules carried over from the source:

- Base64-decode text-like bodies before formatting.
- Binary content types (`image|audio|video|zip|pdf|octet-stream`) →
  `[Binary Data: N bytes]`.
- JSON → pretty-print inside a ```json fence; XML/HTML → ```xml; else ```text.
- **Truncate at 10 KB** with `... [Body truncated due to size]` — the whole
  point is a token-friendly payload.
- A **Copy for LLM** button copies the generated markdown (mirrors
  `saved-session-info.tsx` / `session-details.tsx`).

### 5.6 State & persistence — all client-side

**Rule: the REST Helper is stateless on the backend.** `pkg/server/resthelper.go`
executes the request and returns the envelope; it writes nothing to disk, keeps
no session, and exposes no history/collection endpoints. Every user artifact
lives in the browser, persisted in **IndexedDB**.

Persistence split by size and lifetime:

| Data | Store | Lifetime | Notes |
|------|-------|----------|-------|
| Current draft (method/url/headers/body) + active view + selected sidebar item | Tile session state (`RestHelperSessionState`, localStorage via `CommonTileContainer`) | Per server run, restored on reload | Same mechanism as DB Browser; small |
| Options (UA mode, timeout, redirects, TLS toggle) | `atomWithStorage('suwu:rest-options')` | Persistent | Tiny |
| History metadata + request definitions | **IndexedDB** store `history` | Persistent, capped FIFO | Borrowed from `inspect-http-proxy` `http-res.ts` |
| Saved response snapshots (optional) | **IndexedDB** store `responses`, keyed by history id | Persistent, capped | Only when the user saves a response / enables response history |
| Collections (folders + saved requests) | **IndexedDB** store `collections` | Persistent | Better than localStorage for larger trees |
| Environments (`{{var}}` maps) | **IndexedDB** store `environments` | Persistent | Phase 3 |
| Cookie jar | **IndexedDB** store `cookies` | Persistent | Auto-captured + manual (§5.7) |
| Live response cache | In-memory `Map<hash, ResponseState>` (Jotai) | Page session | Fast path; hydrated from IndexedDB on demand |

**`frontend/src/lib/restdb.ts`** — a thin IndexedDB wrapper modeled directly on
`inspect-http-proxy/frontend/src/app/_jotai/http-res.ts`:

- `openDB()` singleton, `DB_NAME = 'suwu-rest-helper'`, `DB_VERSION = 1`.
- Object stores: `history` (keyPath `id`, index `timestamp`), `responses`
  (keyPath `id`), `collections` (keyPath `id`), `environments` (keyPath `id`),
  `cookies` (keyPath `id`, index `domain`).
- `MAX_HISTORY = 1000`; on insert, count and FIFO-delete the oldest entries via
  the `timestamp` index — the source's `checkAndCleanupOldEntries` pattern.
- CRUD: `put`, `get`, `getAll`, `delete`, `clear` per store.
- Jotai atoms hydrate from IndexedDB on mount (`getHistoryAtom`,
  `getCollectionsAtom`, …) and mirror writes back: the in-memory map/atom is the
  reactive source, IndexedDB is durable storage. This mirrors the source's
  `responseMapAtom` + `getResponseStateAtom` + `updateResponseStateAtom` trio.

Notes:

- IndexedDB is per-origin and shared by the tile iframe and the parent window
  (same origin), so collections/history are visible across panes automatically —
  no storage-event juggling. A refreshing pane simply re-reads the stores.
- The draft is mirrored into tile session state so a reload/restart restores the
  builder — same mechanism the DB Browser uses.
- Request definitions containing secrets (`Authorization`, `Cookie`, API keys)
  are stored only when the user saves the request. Add a per-header "sensitive"
  flag / "don't persist" toggle and redact on export.
- Response bodies can be large; cap stored snapshots (e.g. 1 MiB each) and skip
  binary bodies unless the user explicitly saves them.

### 5.7 Cookie jar & browser cookie injection

**Ownership:** the jar lives entirely in the frontend (IndexedDB store
`cookies`) and is materialized into a `Cookie` request header at send time. The
backend stays stateless and simply forwards/receives the header.

**Jar model** (`frontend/src/lib/cookie-jar.ts`):

```ts
interface JarCookie {
  id: string
  name: string
  value: string
  domain: string          // leading dot = domain cookie
  path: string            // default "/"
  expires?: number        // epoch ms; absent = session cookie
  secure: boolean
  httpOnly: boolean       // recorded; only meaningful for captured cookies
  sameSite?: 'Strict' | 'Lax' | 'None'
  hostOnly: boolean
  createdAt: number
}
```

RFC 6265 matching for outgoing requests: domain-match (host-only vs.
`.domain`), path-match, `Secure` only over HTTPS, not expired. Parsing/serializing
`Set-Cookie` lives in `frontend/src/lib/cookie-parse.ts`.

**Behaviors** (each individually toggleable):

- **Auto-capture:** parse every `Set-Cookie` from the response envelope
  (multi-value preserved, §4.3) and upsert into the jar, honoring
  `Max-Age`/`Expires` deletion and attributes.
- **Auto-attach:** when "send cookies" is on and the user did not set an
  explicit `Cookie` header, compute all matching cookies for the target URL and
  send them as one `Cookie` header. An explicit `Cookie` header always wins —
  the same precedence rule as `User-Agent` (§4.5).
- **Manual editor:** searchable table grouped by domain; add/edit/delete, clear
  all, clear per-domain, import/export as JSON.

**Browser cookie injection (best-effort).** JavaScript can only read
`document.cookie` for the **current origin** (the Suwu host) and cannot see
`HttpOnly` cookies or cookies belonging to other domains. So:

- **"Import from browser"** reads `document.cookie`, parses it into name/value
  pairs, and imports them scoped to the current Suwu host (choice of host-only
  vs. domain). Useful when the request target is the Suwu host itself (or a
  service sharing that host).
- **"Use current browser cookies"** writes those same cookies into the outgoing
  `Cookie` header for this request only.
- **For any other target domain** the browser cookies are inaccessible by
  design. The general fallback is **"Paste cookie string"** (accepts `a=1; b=2`
  or a raw `Cookie:` header) or importing a cURL command (`--cookie` /
  `-H 'Cookie: …'`) — both are Phase 2 import paths.
- The UI shows an inline note whenever the target host differs from the Suwu
  host, so the feature never silently under-delivers.

**Backend note:** with `followRedirects` on, `Set-Cookie` from intermediate
redirect hops is not visible in the final response. Phase 1 captures only the
final hop's cookies; Phase 4 can add an ephemeral per-request jar on the backend
(or a `CheckRedirect` hook) to surface the full chain.

### 5.8 URL ↔ query-param sync

- Parse `?a=1&b=2` from the URL into the params table on blur.
- Editing the params table rewrites the URL query string.
- Guard against feedback loops with a single `syncSource` flag / debounce.
- Values are URL-encoded on write and decoded for display.

### 5.9 Keyboard & toolbar

- `Ctrl/Cmd+Enter` — Send; `Esc` — Cancel while in flight.
- `Ctrl/Cmd+S` — Save request to collection.
- Per-plugin zoom atom `resthelperZoomAtom` in `frontend/src/store/zoom.ts`.
- `renderToolbar` (optional): a single "Send" button, using the house `TOOLBAR_BTN` /
  `toolBtn` pattern. Do not duplicate shared move/close controls.

### 5.10 Typography & material (enforced)

Follow `.opencode/skills/suwu-tile-plugin-design/SKILL.md` §11:

- Body 14 (`text-sm`) for primary content (URL input, body text, list rows).
- Label 12 (`text-xs`) for buttons, tabs, table headers, form labels.
- Caption 11 (`text-[11px]`) for hints/errors/secondary meta.
- Micro 10 (`text-[10px]`) for status-bar counts, timestamps, kbd chips.
- No off-scale sizes; `pnpm --dir frontend check:typography` must pass.
- Glass surfaces use the shared `glass-control` / `glass-btn` classes.
- icons come from `appIcons.ts` (add `resthelper`) and shared icon modules.

---

## 6. Files

### New — backend

```
pkg/server/resthelper.go          # handlers, payload/response types, outbound client
pkg/server/resthelper_test.go     # httptest-based tests
```

### New — frontend

```
frontend/src/wm/plugins/resthelper.tsx
frontend/src/routes/RestHelperPage.tsx
frontend/src/components/resthelper/RestHelperPanel.tsx
frontend/src/components/resthelper/RequestBuilder.tsx
frontend/src/components/resthelper/KeyValueTable.tsx
frontend/src/components/resthelper/QueryParamsTable.tsx
frontend/src/components/resthelper/BodyEditor.tsx
frontend/src/components/resthelper/CookiesPanel.tsx
frontend/src/components/resthelper/RequestOptions.tsx
frontend/src/components/resthelper/ResponseViewer.tsx
frontend/src/components/resthelper/StatusBar.tsx
frontend/src/components/resthelper/SidebarTabs.tsx
frontend/src/components/resthelper/HistoryList.tsx
frontend/src/components/resthelper/CollectionsTree.tsx
frontend/src/components/resthelper/renderers/registry.ts
frontend/src/components/resthelper/renderers/{json,text,image,html,binary}-renderer.tsx
frontend/src/components/resthelper/hooks/{useRestRequest,useRestHistory,useRestCollections}.ts
frontend/src/lib/llm-format.ts
frontend/src/lib/curl-format.ts       # Phase 2
frontend/src/lib/cookie-jar.ts        # RFC 6265 matching + jar operations
frontend/src/lib/cookie-parse.ts      # Set-Cookie / Cookie string parsing
frontend/src/lib/restdb.ts            # IndexedDB wrapper (history/collections/responses/cookies)
frontend/src/store/resthelper.ts
```

### Modified

```
pkg/server/server.go                  # route /api/rest/, rate-limit prefix
frontend/src/router.tsx               # /resthelper route
frontend/src/wm/TilingWM.tsx          # import './plugins/resthelper'
frontend/src/wm/appIcons.ts           # resthelper icon entry
frontend/src/store/zoom.ts            # resthelperZoomAtom
frontend/src/wm/sessionState.ts       # RestHelperSessionState
frontend/src/locales/en.json          # plugin.resthelper* + resthelper.* keys
frontend/src/locales/zh_CN.json       # same keys, Chinese
docs/REST_HELPER_PLAN.md              # this document
```

No new Go modules (stdlib `net/http`, `crypto/tls`, `mime/multipart` suffice)
and no new frontend dependencies (Monaco + `@tanstack/react-table` are already
in `frontend/package.json`).

---

## 7. API contract example

**Request**

```http
POST /api/rest/request HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{
  "method": "POST",
  "url": "https://httpbin.org/post",
  "headers": [
    { "key": "Content-Type", "value": "application/json", "enabled": true },
    { "key": "X-Debug",      "value": "1",                "enabled": false }
  ],
  "bodyType": "json",
  "body": "{\"hello\":\"world\"}",
  "formData": [],
  "userAgentMode": "browser",
  "browserUserAgent": "Mozilla/5.0 (X11; Linux x86_64) ...",
  "timeoutMs": 30000,
  "followRedirects": true,
  "insecureTLS": false,
  "maxResponseBytes": 10485760
}
```

**Response (HTTP 200 always)**

```json
{
  "status": 200,
  "statusText": "200 OK",
  "headers": { "Content-Type": ["application/json"], "Set-Cookie": ["a=1", "b=2"] },
  "bodyB64": "eyJoZWxsbyI6IndvcmxkIn0=",
  "bodySize": 17,
  "truncated": false,
  "durationMs": 143,
  "finalUrl": "https://httpbin.org/post",
  "redirects": [],
  "insecureTLS": false
}
```

**Transport failure**

```json
{ "status": 0, "statusText": "", "headers": {}, "bodyB64": "", "bodySize": 0,
  "truncated": false, "durationMs": 5001, "finalUrl": "http://127.0.0.1:9/",
  "redirects": [], "error": "dial tcp 127.0.0.1:9: connect: connection refused",
  "errorKind": "refused" }
```

---

## 8. Testing

### Go (`pkg/server/resthelper_test.go`)

Use `httptest.NewServer` / `httptest.NewTLSServer` as targets. Cover:

- Method/URL/header/body passthrough; duplicate request headers preserved.
- Multi-value response headers returned intact.
- UA modes: default identifies Suwu; browser UA replicated; explicit header
  overrides the mode.
- Redirect chain recorded; `followRedirects=false` returns the 3xx.
- `insecureTLS=true` succeeds against `httptest.NewTLSServer`.
- Response truncation at the cap sets `truncated: true`.
- Timeout produces `errorKind: "timeout"`.
- Connection refused produces `errorKind: "refused"`.
- form-data and urlencoded bodies arrive correctly on the target.
- Auth: missing/invalid token is rejected.
- Concurrency semaphore returns 429 when saturated (table-driven with a
  blocking test server).

### Frontend

- `pnpm --dir frontend typecheck`
- `pnpm --dir frontend check` (biome + typography + existing check scripts)
- Manual QA checklist:
  - Send GET/POST to `httpbin.org` and a local service; verify status/time/size.
  - JSON auto-view + manual Plain/Raw/LLM switching.
  - Copy for LLM produces valid markdown; truncation at 10 KB.
  - Image response renders via `data:` URL (CSP-safe); binary offers download.
  - Cancel mid-flight aborts the backend request.
  - History row restores the builder; collections save/reload.
  - Split/close/swap keeps the iframe and draft alive; reload restores draft.
  - Two panes share collections (storage-event sync) but keep separate drafts.
  - UA modes visible in Request Details and on `httpbin.org/headers`.

---

## 9. Phases

| Phase | Deliverable |
|-------|-------------|
| **1 — Core** | `/api/rest/request`; plugin/route/icon/i18n; method+URL+headers+body; send/cancel; Response Body (Plain/Raw/JSON/LLM), Status, Response Headers, Request Details; copy/download |
| **2 — Postman parity** | Query-param table; form-data file upload; urlencoded; auth helpers (Bearer/Basic/API key); cookie jar + browser cookie import; request options (UA/timeout/redirects/TLS); cURL import/export |
| **3 — Persistence & env** | IndexedDB stores in `restdb.ts` for history + collections + environments; capped FIFO history; environment variables `{{var}}`; code generation (cURL/fetch/Python) |
| **4 — Renderers & scale** | Renderer registry extras (image/HTML preview, SSE/event-stream), response search, virtualized large responses, save-response-to-file-browser integration |
| **5 — Polish** | Monaco theming, keyboard shortcuts, i18n completeness, docs page |

### Open questions to resolve in Phase 1

1. **HTML preview CSP:** `srcdoc` may be blocked by `frame-src 'self'`. Verify;
   if blocked, fall back to a source view or a `blob:` URL (needs a CSP tweak),
   or render sanitized text.
2. **SSE/streaming:** Phase 1 buffers the body (like the source's 30-min read).
   True streaming needs a WebSocket or `ReadableStream` passthrough — defer to
   Phase 4.
3. **History size:** IndexedDB is the store; decide the cap (default 1000) and
   whether to persist response snapshots at all (size vs. replay value).
4. **Link-local block list:** confirm the default-deny list with the user.
5. **Cookie injection scope:** confirm the "current browser cookies" flow is
   limited to the Suwu host (JS cannot read cross-origin/`HttpOnly` cookies);
   decide whether a paste/cURL import is an acceptable fallback for other hosts.

---

## 10. Borrowing map (one glance)

```
inspect-http-proxy                                Suwu
──────────────────────────────────────────────    ────────────────────────────────────────────
pkg/web/api/api_httpreq.go                    →   pkg/server/resthelper.go
frontend/src/app/_jotai/http-req.ts           →   frontend/src/store/resthelper.ts
frontend/src/app/_jotai/http-res.ts           →   frontend/src/lib/restdb.ts + frontend/src/store/resthelper.ts
frontend/src/app/_components/http-req-builder →   components/resthelper/RequestBuilder.tsx
frontend/src/app/_components/http-response-viewer → components/resthelper/ResponseViewer.tsx
frontend/src/app/_components/body-renderers/*  →   components/resthelper/renderers/*
frontend/src/lib/llm-data-gen-util.ts         →   frontend/src/lib/llm-format.ts
frontend/src/lib/curl-gen-util.ts             →   frontend/src/lib/curl-format.ts
frontend/src/app/history/_components/*        →   components/resthelper/HistoryList.tsx
frontend/src/app/saved/_components/*          →   components/resthelper/CollectionsTree.tsx

# New in Suwu (no counterpart in inspect-http-proxy):
#   lib/cookie-jar.ts + lib/cookie-parse.ts + CookiesPanel.tsx  (cookie jar,
#   RFC 6265 matching, browser-cookie import) — inspect-http-proxy has no cookie handling.
```

---

## 11. Acceptance criteria (MVP)

- [ ] A `resthelper` tile opens from the app picker and via a custom app with
      `?url=`/`?method=`.
- [ ] Requests of every HTTP method execute **server-side** and return status,
      time, size, multi-value headers, and body.
- [ ] User-Agent can be the backend default, the browser's UA, or a custom
      string; an explicit `User-Agent` header overrides all three.
- [ ] The response renders in Plain text, Raw, JSON, and LLM views; LLM copy
      produces truncated, fenced markdown.
- [ ] Transport failures render as a clear error (kind + message), distinct
      from HTTP 4xx/5xx responses.
- [ ] Cancel aborts the outbound request.
- [ ] Cookie jar auto-captures `Set-Cookie` and auto-attaches matching cookies;
      an explicit `Cookie` header overrides the jar.
- [ ] "Import from browser" imports `document.cookie` for the Suwu host, and the
      UI clearly states the cross-origin/`HttpOnly` limitation.
- [ ] Draft survives reload; collections/history survive restarts, all stored
      client-side in IndexedDB — **nothing persisted on the backend**.
- [ ] `pnpm --dir frontend check` and Go tests pass; no new dependencies.
