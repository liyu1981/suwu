# Suwu

A browser terminal emulator backed by a real shell. Suwu pairs a Go server
that bridges xterm.js panes to actual PTYs over WebSocket with a tiling
window-manager frontend — split, move, focus, and resize terminal tiles by
keyboard or hover tools, and pick up your session where you left off after a
refresh.

```
┌──────────────────────────────────────────────┐
│ Suwu                                    ☰    │
├───────────────────────┬──────────────────────┤
│ $ go version          │ $ tail -f var/*.log  │
│ go version go1.25 …   │ …                    │
│                       ├──────────────────────┤
│                       │ $ htop               │
└───────────────────────┴──────────────────────┘
```

## Features

- **Real shell sessions** — the Go server spawns actual PTYs (`creack/pty`)
  and forwards them to xterm.js panes over WebSocket; everything you run is
  running in your shell.
- **Session restore** — server-side terminal state is kept by
  [libghostty-vt](https://github.com/shintaoku/libghostty-go) (Ghostty's VT
  engine compiled to WASM, run in-process via wazero). A page refresh or
  dropped socket reattaches to the same shell and replays the current screen
  before live output resumes.
- **Tiling workspace** — a flat, absolutely-positioned pane tree driven by a
  pure layout module: splits, closes, and moves only mutate inline styles, so
  iframe DOM nodes are never recreated and their PTY sessions survive every
  layout change.
- **Per-pane terminals** — every tile is an isolated xterm.js instance with
  its own shell and WebSocket session.
- **Appearance settings** — shared font family/size and theme colors
  (including background alpha for glassy tiles), synced live to every open
  pane via `localStorage` storage events.
- **Thoughtful terminal behavior** — WebGL rendering with fallback, selection
  auto-copy, `Ctrl+Shift+C` / `Cmd+C` copy, status bar with connection state
  and a reconnect countdown that never pollutes the scrollback.

## Requirements

- Go 1.25+
- Node.js + [pnpm](https://pnpm.io) (frontend build)
- [air](https://github.com/air-verse/air) (optional, for hot-reload dev)

## Quick start

```sh
pnpm install && pnpm --dir frontend install
pnpm start            # build web assets + server, then run on :8080
```

Or build and run manually:

```sh
pnpm build:web        # vite build -> pkg/assets/web (embedded via go:embed)
pnpm build            # go build -o suwu ./cmd/Suwu
./suwu serve          # production: http://127.0.0.1:8080
```

The web assets are always embedded in the binary — a single `suwu` binary is
all you need to deploy.

### Configuration

Copy `.env.example` to `.env` and adjust. Shell environment variables take
precedence over `.env`.

| Variable                | Default            | Description                                                        |
| ----------------------- | ------------------ | ------------------------------------------------------------------ |
| `SUWU_DEV`              | `false`            | Dev mode: air hot-reload defaults (port 8000, dev banner in `serve`). |
| `HOST`                  | `127.0.0.1`        | Bind address. `0.0.0.0` exposes on all interfaces.                 |
| `PORT`                  | `8080`             | HTTP/WebSocket port.                                               |
| `DEMO_PORT`             | `8000`             | Port the Vite dev server proxies `/api` and `/ws` to.               |
| `TLS_CERT_FILE`         | —                  | TLS certificate (enables `https://`). `suwu gencerts` writes both paths into `~/.config/suwu/.env`. |
| `TLS_KEY_FILE`          | —                  | TLS private key. Must be set together with `TLS_CERT_FILE`.        |

Browser-visible hostnames need no configuration: loopback names plus the
machine's own hostname and interface addresses are always accepted, so the
terminal works via `localhost`, the LAN IP, or the hostname out of the box.

### Configuration locations

`suwu serve` loads, in order of precedence: shell environment → `./.env`
(project) → `~/.config/suwu/.env` (user-global, created by `suwu gencerts`).

## HTTPS certificates

Browsers only expose clipboard APIs (terminal paste) on secure contexts, so
non-localhost HTTP access cannot paste into the terminal. To enable HTTPS:

```sh
suwu gencerts        # interactive: pick hosts (auto-detected) and output dir
suwu serve           # now serves https://, certs picked up automatically
```

`gencerts` creates a persistent local CA under `~/.config/suwu/CA/` and signs
a server certificate for the hosts you select (default
`~/.config/suwu/tls-cert.pem` + `tls-key.pem`). Client devices only need to
trust the CA once (`~/.config/suwu/CA/rootCA.pem`). Flags allow non-interactive
use: `--hosts a.com,192.168.0.5 --out <dir> --no-env --force`.

## Development

```sh
./serve-dev.sh start   # hot-reload dev server (air): web + go rebuild on change
./serve-dev.sh status  # resolved URL mirrors what the server actually binds
./serve-dev.sh logs    # tail the log
./serve-dev.sh stop
```

`serve-dev.sh` wraps `pnpm dev` (air), which rebuilds the web tree, rebuilds
the server into `tmp/`, and restarts on any source change. Logs and the PID
file live in `var/`.

For frontend-only iteration you can also run the Vite dev server directly —
it proxies API and WebSocket traffic to the Go server:

```sh
pnpm dev:web           # Vite on :5173, proxying /api and /ws to DEMO_PORT
```

### Tests

```sh
pnpm test              # go test ./...
pnpm vet               # go vet ./...
pnpm typecheck         # tsc --noEmit (frontend)
```

## Architecture

```
cmd/Suwu/            entry point: flags, .env loading, graceful shutdown, banner
pkg/
  assets/            go:embed of the built frontend (pkg/assets/web)
  auth/              per-run same-origin token + host/origin validation
  envfile/           minimal .env loader (first occurrence of a key wins)
  pty/               shell PTY sessions (creack/pty)
  session/           keyed PTY sessions with libghostty-vt screen state
  server/            HTTP + WebSocket endpoints
  assets/web/        built frontend (vite output, embedded into the binary)
frontend/            Vite + React + TypeScript + Tailwind v4
  src/routes/        AppShell (header + content), TermPage (pane iframe)
  src/wm/            tiling window manager: layout tree, shortcuts, tools
  src/components/    FullTerminal, PTY session bridge, dialogs, hooks
  src/store/         Jotai atoms (font, appearance, connection), shared
                     with pane iframes via localStorage storage events
```

### How the pieces fit

- **Auth**: the server mints a fresh random token on every start. Browsers
  fetch it from `/api/token` before each connection attempt; WebSocket
  upgrades require the token plus a same-origin `Host`/`Origin` check, so
  cross-origin WebSockets are rejected. This server provides shell access —
  bind to loopback unless you understand the exposure.
- **Session reattach**: each pane connects with a stable `session` key (the
  tiling pane id, persisted across reloads). The server keeps the shell and a
  libghostty-vt screen model alive for a TTL (10 min) after the last client
  detaches; reconnecting replays `DumpVTFull` before live output. Scrollback
  is intentionally not restored — only the visible screen.
- **Tiling**: the layout is a tree of leaves (terminals) and split nodes with
  flex weights, persisted in `localStorage`. Panes render as same-origin
  iframes loading `/term?pane=<id>`, positioned absolutely from pixel rects
  computed by a pure `computeTiling()` function. Shortcuts work both on the
  parent window and inside a focused pane (relayed via `postMessage`).

## Keyboard shortcuts

| Action              | Keys                                    |
| ------------------- | --------------------------------------- |
| Split right         | `Alt` `⏎`                               |
| Split below         | `Alt` `⇧` `⏎`                           |
| Close focused tile  | `Alt` `Q`                               |
| Focus next / prev   | `Alt` `J` / `Alt` `K`                   |
| Move tile           | `Alt` `←` `→` `↑` `↓`                   |
| Open the menu       | `Alt` `/`                               |
| Open shortcuts list | `Alt` `⇧` `/`                           |
| Copy selection      | select to auto-copy, or `Ctrl+Shift+C` / `Cmd+C` |

Every binding is chosen to avoid clashing with common shell/readline keys.
The menu (☰) also exposes splits, settings, shortcuts, and about screens.

## Security notes

- Suwu grants **shell access** to anyone who can reach the server and obtain
  the per-run token. It is designed for local development.
- Cross-origin WebSocket connections are rejected; browser-visible hosts are
  limited to loopback and the machine's own hostname/interface addresses.
- Binding beyond loopback exposes the shell to everyone who can reach the
  machine's network.
- Only run Suwu on networks and machines you trust.
