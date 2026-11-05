# Static Serve Plan

Status: implemented.

## Goal

Preview a local folder of static web assets from the running Suwu server:

```bash
suwu static-serve ./website
# -> /staticserve/website/
```

The folder id is the last path element, lowercased and slugified. A second
folder with the same basename gets `website1`, then `website2`, and so on.
Re-running the same directory reuses its entry and asks the browser to open the
Static Browser tile again. The registry is memory-only; restarting Suwu forgets
every serve.

## Command surface

```bash
suwu static-serve <dir>
suwu static-serve --list
suwu static-serve --pause <id>
suwu static-serve --resume <id>
suwu static-serve --remove <id>
suwu static-serve --new <dir>     # allow a duplicate of the same directory
suwu static-serve --sock <path>
suwu static-serve --json
```

The command is a client of the running server through the existing Unix notify
socket. `suwu serve` remains the server command and is unchanged.

## Registry and routes

`pkg/staticserve` owns an in-memory `Manager` of entries:

- `ID`, absolute `Dir`, `Prefix`, status (`running` / `paused`), `CreatedAt`
- an `*os.Root` handle per entry, closed on remove/shutdown
- ID allocation is atomic; same-directory reuse is the default

Relevant routes:

| Route | Auth | Purpose |
| --- | --- | --- |
| `/staticserve/<id>/...` | Host + client IP | Preview files |
| `/api/staticserve/start` | token/HMAC | Create/reuse entry |
| `/api/staticserve/list` | token/HMAC | List entries |
| `/api/staticserve/pause` | token/HMAC | Pause entry |
| `/api/staticserve/resume` | token/HMAC | Resume entry |
| `/api/staticserve/remove` | token/HMAC | Remove entry |

## Preview serving

- `GET`, `HEAD`, `OPTIONS` only.
- `os.Root` prevents `..` and symlink escapes from the served directory.
- Directories serve `index.html` when present, otherwise a directory listing.
- Explicit MIME map for web assets.
- `Cache-Control: no-cache`, `X-Content-Type-Options: nosniff`.
- No token in the URL, so relative CSS/JS/image URLs work.
- `Access-Control-Allow-Origin: null` is granted only to opaque-origin loads whose
  Referer is under `/staticserve/`, so the preview's module/font/fetch requests
  work without exposing the files to unrelated websites.
- No `X-Frame-Options`; the preview is meant to be embedded.

## Sandbox and access control

The preview route is unauthenticated, but restricted:

1. The `Host` header must be in Suwu's existing allow-list.
2. The client IP must be loopback or a client that recently authenticated
   against Suwu. Static requests refresh that client's entry.
3. Every previewed document gets `Content-Security-Policy: sandbox ...` without
   `allow-same-origin`. It cannot reach the parent Suwu app, its APIs, or
   top-level navigation.

The Static Browser tile also uses a sandboxed inner iframe.

### Root-absolute URL guard

A previewed page may request `/static/app.js`. That resolver hits the Suwu
origin root, not `/staticserve/<id>/`. The server returns 404 for such requests
when the request is identifiable as preview traffic:

- `Origin: null`, or
- a same-origin `Referer` whose path starts with `/staticserve/`.

`/gqjs/` and `/backgrounds/` are exempt because extension and background pages
legitimately use opaque origins. Preview responses set
`Referrer-Policy: unsafe-url` so the guard can see the full preview URL.

A page that deliberately sets `no-referrer` can hide the Referer, but it still
cannot read Suwu API responses or escape the sandbox. A future optional strict
CSP mode could scope scripts/styles/images to the preview prefix, at the cost of
blocking external CDNs.

## Browser UI

- **Static Serve** tile (`staticserve`): visible in the app menu. Lists folder,
  endpoint, created time, status; actions are open, pause/resume, copy URL, and
  delete.
- **Static Browser** tile (`staticbrowse`): `defaultHidden: true`. Address bar,
  reload button, sandboxed iframe. An injected bridge reports internal
  navigation back to the address bar and handles reload requests.

`suwu static-serve` broadcasts an action notification. The frontend opens (or
focuses) the Static Browser tile for that serve. Existing stored settings treat
a missing `staticserve` auto-resolve key as enabled.

## Tests

- `pkg/staticserve`: id allocation, slugging, reuse, pause/resume/remove,
  MIME, HTML bridge injection, sandbox headers, traversal/symlink rejection.
- `pkg/server`: unauthenticated GET, Host allow-list, client-IP gate, pause API,
  root-path guard, root redirect.
- Frontend: `pnpm --dir frontend typecheck` and `pnpm --dir frontend check`.
