<p align="center">
  <img src="https://raw.githubusercontent.com/liyu1981/suwu/refs/heads/master/assets/logo.svg" alt="Suwu logo" width="128" height="128" />
</p>

<h1 align="center">Suwu</h1>

<p align="center"><strong>Make the remote shell enjoyable in agentic AI time.</strong></p>

Your real shell, in a browser tab. Suwu gives agents and humans alike a
tiling terminal that keeps running when you don't — refresh, disconnect,
come back tomorrow, pick up where you left off.

## Features

1. **A tile-based window manager, by keyboard or mouse** — Split, focus, move,
   and swap tiles with fast key bindings or a click and drag — whichever fits
   the moment. Your sessions live in the layout: refresh the page, drop the
   connection, even restart the server, and every tile comes back exactly as you
   left it.

2. **Full-featured terminals, perfect for agents** — Real shells with selection,
   copy/paste, scrollback, and notifications — comfortable for you, and a solid
   target for agent orchestrators like `opencode`, `pi`, and `herdr` that drive
   many terminals at once.

3. **Convenient apps for everyday dev work** — A file browser with download, a
   file viewer with auto-refresh, and a TCP/UDP port forwarder — the small tools
   you'd otherwise reach for a second terminal or a GUI client, right in the
   grid next to your shells.

4. **From terminal to web, with suwu commands** — `suwu send` posts a
   notification to your screen from any script — pipe stdin, set a title.
   `suwu forward` opens a port-forwarding tile, `suwu open` resolves links and
   actions on the remote machine. Long builds finish? You'll know.

5. **Reachable, but only by you** — Access works out of the box on localhost,
   your LAN, or over the internet behind a reverse proxy — with password
   authentication, per-run tokens, and one-command HTTPS.

6. **Yours to tune** — Pick your font family and size, theme the colors, dial
   in a glassy background alpha. The interface speaks English and Chinese out of
   the box.

7. **Install once, stay current** — Onboarding sets up your dev environment step
   by step, and `suwu update` keeps the binary fresh. No config files to
   babysit.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/liyu1981/suwu/refs/heads/master/install.sh | sh
```

This downloads the latest release binary to `~/.local/bin/suwu` and runs
`suwu onboard`.

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

## Security notes

- Suwu grants **shell access** to anyone who can reach the server and obtain
  the per-run token. It is designed for local development.
- Cross-origin WebSocket connections are rejected; browser-visible hosts are
  limited to loopback and the machine's own hostname/interface addresses.
- Binding beyond loopback exposes the shell to everyone who can reach the
  machine's network.
- Only run Suwu on networks and machines you trust.

## License

[Apache License 2.0](LICENSE)
