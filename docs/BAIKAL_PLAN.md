# Baikal — a herdr-core client as a Suwu tile

Status: **shipped — phases 1–4 done.** Usage lives in `docs/BAIKAL.md`; §13
records what landed and where it differs from this plan.
Owner area: new tile `baikal` (plugin, route, panel), a `suwu hc` subcommand, an
embedded herdr-core binary in every release, and a Go client for herdr-core's
framed API.
Sources: https://herdr.dev/core/, `herdrdev/herdr-core` (Apache-2.0) —
`README.md`, `docs/commands.md`, `docs/security.md`, `schema/README.md`,
`schema/hc.openrpc.json` (v0.1.21), `releases.herdr.dev/core/latest.json`.

---

## 1. What baikal is

`hc` (herdr-core) runs programs in **terminals that live in a daemon**, not in a
window: they keep running when the viewer disconnects, and any client can attach
to any of them. Herdr's own app is one such client; the API is open.

Baikal is that client inside a Suwu tile:

```
+----------------------+---------------------------------------------+
| ‹ work/suwu-dev   3  | [ suwu-dev zsh ] [ suwu-dev claude ] [ + ]  |
|   ● claude   working | +-----------------------------------------+ |
|   ✓ tests    done    | |                                         | |
| ‹ home            1  | |      the attached terminal (xterm)      | |
|   ○ zsh              | |                                         | |
+----------------------+---------------------------------------------+ |
```

Left: **spaces**, each with a stable id and a name derived from its identity
terminal's directory (§5.1). The name follows the user's `cd` — and becomes the
repo's name inside a git repository — while membership is a `space=<id>` label, so
a terminal does **not** jump groups when the directory changes. A terminal shows
the program's own status word (OSC 7501) when it has one; a plain shell has none.
Right: tabs, one attached terminal each, plus “+”.

Closing a tab **detaches**; the program keeps running. That is the whole point of
herdr, and the tile must never conflate detach with kill.

Non-goals for v1: creating agents (the user starts them in a shell, §5.3),
splits inside a tab, templates, remote cores (`machine/t7`), and drawing a herdr
TUI in the tile — baikal is a native web UI over the same core.

## 2. What herdr-core gives us (findings)

**Entities.** *Terminals* (address `t7`, name, labels, `parent`, `cwd`, `argv`,
`foreground {pid,name,argv,cwd}`, `status`, `title`, `state`, `exit_code`) and
*machines* (other cores over ssh). **There is no “space” in core** — spaces are a
Herdr-app concept, so baikal mirrors how the app models them (§5).

**How the Herdr app models a space** (from `herdrdev/herdr`, `src/workspace.rs`
and `src/workspace/git/discovery.rs`) — this is the model baikal copies:

```rust
struct Workspace {
    id: String,                  // stable, order-independent ("w1", "w2", …)
    custom_name: Option<String>, // user override; while set, auto naming stops
    identity_cwd: PathBuf,       // fallback name source
    cached_auto_label: String,   // derive_label_from_cwd(identity_cwd)
    // + tabs, git branch/ahead-behind, status cache
}
display_name = custom_name ?? automatic_display_name_for_cwd(identity_cwd)
              // identity cwd = the workspace's FIRST TAB's root pane cwd
derive_label_from_cwd(cwd) =
    in a git repo ? repo_root.file_name()      // the repo name
                  : fallback_label_from_cwd(cwd)  // HOME -> "~", else cwd.file_name()
```

So: **the id is stable, the name is derived from one designated terminal's cwd**,
and a user rename pins it. That is exactly the split baikal needs.

**Live facts.** `events.subscribe` pushes typed events with a monotonic `seq`, a
`heartbeat` every 15 s, and a `missed` snapshot when a subscriber falls behind.
The events we need exist:

| event | payload | use |
|---|---|---|
| `created`, `restarted`, `removed`, `finished`, `lost` | whole record / reason | list membership |
| `status` | `{status, records, reported}` | agent word: `idle/working/done/blocked/error`, `title`, `msg`, `progress`, `app`, `kind` |
| **`foreground`** | `{pid,name,argv,cwd}` or null — **“read about twice a second”** | **the space** (see §5) and “what is running in it” |
| `title`, `size`, `labels`, `turn`, `keep` | as named | UI details |
| `doc` | `{name, version}` | not used in v1 |

Status is the *program's own* claim over the open Program Status Protocol
(OSC 7501). A program that does not speak it — bash, zsh, vim — has **no status**,
which is exactly the distinction the user wants: shells are terminals, agents are
terminals that announce themselves.

**Commands.** `hc run [--bg --name --cwd --label k=v --on]` (with no program it
starts the machine's shell — `$SHELL`), `ls --json`, `get`, `read --json`
(`{text, how: screen|history|stitched, complete, why}`), `send`, `keys`, `wait`,
`interrupt`, `kill`, `rm`, `label`, `events --json`, `server start|stop|status`,
`schema`, `connect`.

**API.** JSON-RPC 2.0, two modes (`schema/README.md`):

- **plain**: one JSON message per line, over the Unix socket or `hc connect` on
  stdio. Everything except attach.
- **framed**: `hello {framed:true}` switches the connection; each frame is
  `[channel u32 LE][kind u8][len u32 LE][payload]` (≤16 MiB), kinds: `DATA`,
  `CREDIT`, `CLOSE`, `RESIZE`, `FOCUS`, `FACTS`, `AUTOMATIC_INPUT`.

`terminal.attach` returns a `channel`; on it the core sends the **first paint**
(screen, optional history, latest status and title, and `CSI ?9001h|l` for
win32-input-mode) then the program's raw output. The viewer sends keys as `DATA`,
`RESIZE`/`FOCUS`/`FACTS` as things change, and `CREDIT` as it consumes bytes
(256 KiB to start; a viewer more than 4 MiB behind gets a fresh repaint instead of
a backlog). `observe: true` makes a read-only viewer that never types or resizes;
`resize_notifications: true` makes the core send RESIZE before a replacement
paint, which is far easier to render than tracking size separately. `CLOSE`
detaches; the core replies `CLOSE`, or sends `CLOSE {reason: "exited"| "killed"|
"server_stop"|…}` when the program ends.

**Process model.** `hc` starts a background core on demand; `hc connect` speaks
the protocol over stdio and does the same. A server-side client therefore does not
need to know the socket path — it runs `hc connect` (one child) and speaks JSON-RPC
over its pipes.

**Security.** The core listens on a local Unix socket (mode 0700) with **no API
password**: “anyone who can run a client as your account can run commands, read
files and control terminals”. The browser must never talk to core. Suwu is the only
client and already has `AUTH_PASS`, the host allow-list and same-origin WS checks.

**Sessions.** `HC_SESSION` selects a separate core + state dir (`default`). baikal
uses the default session so it sees the same terminals as `hc` in the user's
shell; `?session=` overrides it (a view filter, not a security boundary).

**Releases.** `releases.herdr.dev/core/latest.json` (version + per-target
`url`/`sha256`). 0.1.21 today; `herdr-core-<os>-<arch>.tar.gz` containing a binary
named **`herdr-core`** (the installer only *symlinks* `hc`, because some window
managers own that name). Tarball sizes: linux-x64 **3.1 MiB**, linux-arm64 **2.8**,
macos-arm64 **5.0**, macos-x64 **5.6**. Apache-2.0; `hc --licenses` lists bundled
licences.

## 3. Transport: framed API only

The first draft considered hosting `hc attach` in a PTY (reuse `/ws` + xterm
verbatim). **Rejected in favour of the framed API**, per the decision:

| | PTY + `hc attach` | **framed API (chosen)** |
|---|---|---|
| processes | one child per open tab | **one** `hc connect` child for the whole tile |
| fidelity | exact, but opaque | exact: same DATA stream, plus RESIZE/FOCUS/CREDIT |
| extras | — | `observe` read-only tabs, `terminal.read` previews, structured errors |
| resize | PTY → hc → core | explicit RESIZE frames, `resize_notifications` paints |
| risk | — | must implement framing/credit correctly — specified, and testable |

The cost is a real but bounded Go client (§4). The benefit is that the tile owns
the data: the same connection also feeds the event stream for the list, and a
detached tab is a `CLOSE` frame rather than a killed process.

## 4. Architecture

### 4.1 Server (Go)

New package `pkg/herdr`:

- **`bin`** — resolve/verify/extract the `herdr-core` binary (§6).
- **`rpc`** — JSON-RPC 2.0 over `hc connect` stdio: `hello`, `terminal.list`,
  `terminal.run`, `terminal.label`, `terminal.kill`, `terminal.read`,
  `terminal.send`, `terminal.keys`, `events.subscribe`, `rpc.discover`.
- **`frame`** — the framed codec: encode/decode `[channel][kind][len][payload]`,
  credit bookkeeping, `CLOSE` reasons.
- **`naming`** — the app's rules, in Go: `DeriveLabel(cwd)` (git repo name, `~`,
  else basename), `DisplayName(customName, identityCwd)`, and the space id
  generator. Pure, and unit-tested against the cases the app documents.
- **`docs`** — read/write the `baikal` document (`doc.get`/`doc.set`, version
  conflict → re-read and retry once): space ids, identity terminals, custom
  names, colours, order. Optional: if `doc.*` is unavailable the tile keeps the
  same shape in session state.
- **`core`** — one long-lived connection per session:
  - starts `hc connect` (`exec.CommandContext`, restarted with backoff if it
    dies), does `hello {framed:true, generation:1, features:[…]}`,
  - keeps the terminal snapshot from `events.subscribe` (channel) applied
    per the event table in §2, so the HTTP snapshot is cheap,
  - hands out attach channels (`terminal.attach`) with a per-channel ring buffer
    and CREDIT accounting, and closes them with `CLOSE` on tab close,
  - handles `heartbeat` (reconnect if silent), `missed` (re-snapshot), and
    `version`/`features` for the UI's “core 0.1.21” line.

New endpoints (existing session auth, same-origin WS checks):

| route | purpose |
|---|---|
| `GET /api/baikal/snapshot?session=` | version, terminals, machines — from the maintained snapshot |
| `POST /api/baikal/run` | start a **shell** terminal: `cwd`, optional name, session |
| `POST /api/baikal/action` | `kill`, `rm`, `label`, `send`, `keys` — allow-listed argv, never a shell line |
| `GET /api/baikal/read?terminal=&lines=` | text preview (cards, read-only peek) |
| `GET /ws/baikal/attach?terminal=&observe=0|1&session=` | one attach channel: binary DATA both ways, JSON control for resize/focus/close |

The attach WS mirrors the existing terminal protocol’s shape (control messages +
binary output), so `usePtySession` can be reused with a `{ path, params }` option
rather than a second client; the difference is that input is *DATA frames* on a
channel instead of PTY bytes (identical bytes, actually — `usePtySession` already
sends strings/binary as the daemon expects).

Rejected alternative: a single multiplexed WS carrying every tab. One WS per tab
matches `/ws` per tile (one iframe, one socket), keeps backpressure and closing
local, and is simpler to reason about.

### 4.2 Frontend

- `wm/plugins/baikal.tsx` → iframe `/baikal?pane=…&session=…`; `defaultHidden: true`
  until enabled in App Menu settings (like `extension`); icon in `wm/appIcons.ts`;
  registered from `wm/registerPlugins.ts`.
- `routes/BaikalPage.tsx` → `setPageTransparent()` + `CommonTileContainer`.
- `components/baikal/BaikalPanel.tsx` — layout, snapshot query, WS fan-out.
- `components/baikal/SpaceList.tsx` — the collapsible left panel: spaces
  (directories) with their terminals, status dot/word, `foreground.name`,
  filter box. Collapse via **`useSidebarCollapse('baikal')`** — the same hook and
  520 px rule the REST helper and DB browser use.
- `components/baikal/TabBar.tsx` + `components/baikal/tabs.ts` +
  `useBaikalTabs` — tab model modelled on `gitgraph/useRepoTabs`, persisted with
  `useReportTileState` (survives reloads and focus-mode iframe recreation). Tab =
  terminal address; the same terminal cannot be open twice; the active tab is
  restored.
- `components/baikal/BaikalTerm.tsx` — lean xterm pane: `useTerminal` +
  `usePtySession({ path: '/ws/baikal/attach', params })`, plus the soft-input bar
  on touch. Not `FullTerminal`: that one is the *shell* tile with snippets,
  chord palette and shell connection atoms.
- Mobile: the tile inherits the phone shell (one full-screen tile, overview sheet,
  two-finger right click, soft-input panel). The space list is the collapsible
  sidebar; the tab bar scrolls horizontally.

## 5. Spaces, agents, tabs

### 5.1 A space has a stable id and a name derived from cwd

Yes — and the Herdr app already does exactly this (§2): a workspace has a stable
`id`, an `identity_cwd`, and `display_name = custom_name ?? derive(identity_cwd)`.
baikal copies that split:

- **Membership** is a label: `space=<id>`, where `id` is a short unique id baikal
  generates (`b1`, `b2`, … — `hc` label values are short strings; a UUID works but
  makes `hc ls` unreadable). `terminal.label` *sets the given keys* and `key=`
  removes one, so adopting a terminal that already has labels (e.g. `role=review`)
  is a single-key write that cannot clobber them.
- **The name is derived, not stored**: from the space's **first tab** (the
  identity terminal) and the directory that shell is in *now* — so `cd` renames
  the space, while a later terminal in the same space never does.
  `repo_root.file_name()` when the directory is inside a git repo, otherwise `~`
  for home, otherwise the directory's name. Renaming pins a custom name.
- **Fallbacks**: identity terminal gone → the space's recorded `identityCwd`;
  recorded cwd also unknown → “workspace”. A terminal with **no** `space` label
  (started with `hc run` from a shell, outside baikal) appears under a synthetic
  space keyed by its cwd (`cwd:/path`), named by the same rule; “assign to
  space…” writes the label to adopt it.
- **Rename** sets `customName`, which pins the name until cleared — the same
  behaviour as `set_custom_name` in the app.
- **Colour/icon** come from a stable hash of the **space id** (not the path, which
  moves), mapped onto the `appIcons`-style palette; a user pick overrides it and
  is stored alongside the rest of the space metadata.

**Where the metadata lives** (id → `{identityTerminal, identityCwd, customName,
colour, order}`): a herdr **document** named `baikal` (`doc.get`/`doc.set`, JSON,
≤1 MiB, version-checked writes, conflict on stale writes — core never interprets
it, which is what documents are for). That makes the space list core-side state:
a second browser, or a future CLI, sees the same spaces. If documents are
unavailable (very old core), fall back to the tile's session state.

Data flow per space, per event:

```
created/foreground/status/finished  →  terminals snapshot (labels, cwd, status)
labels{space:b3}                    →  membership change
foreground{cwd}                     →  identity terminal's cwd → name (derived)
doc "baikal"                        →  custom names, colours, order, identities
```

### 5.2 Agents are discovered, not created

There is no “new agent” form. The tile's `+` starts a **shell** (`terminal.run`
with no argv — core starts `$SHELL`), in the active space's directory. A terminal
becomes an *agent* the moment its program reports a status over OSC 7501
(`claude`, `codex`, a script that prints the protocol), and the list shows it
with that word; shells simply have no status. This matches herdr's own behaviour
and the user's answer #2.

So the write actions in v1 are: `run` (shell), `kill`, `rm`, and send/keys for
the rare case (not needed by the UI, but the endpoint exists for scripts). No
templates, no command forms, no label editing.

### 5.3 Tabs

A tab is an attached terminal (`address`), created from the space list (tap an
agent) or by `+` (new shell in the current space). Tabs persist per tile in
session state: `{ id, terminal, title, observe }`, `activeTabId`. Closing a tab
sends `CLOSE` on its channel and removes it from the list — never `kill`.

## 6. `suwu hc` and the embedded binary

### 6.1 Command

```
suwu hc <hc args…>      # exec the managed herdr-core with these args
suwu hc                 # no args: same as herdr-core (attach picker)
suwu hc --version       # managed binary's version
```

Resolve, then **exec** (no shell, no re-quoting), inheriting the environment plus
`HC_SESSION` when set; exit code and signals pass through. `suwu hc run …`,
`attach`, `server start`, `update` therefore behave exactly as documented — suwu
adds resolution, not a wrapper. The tile calls `pkg/herdr/bin` directly; the CLI is
for humans and scripts.

### 6.2 Every release embeds it (no max-tools entry)

Per the decision, `herdr-core` ships in **every** release binary, not in the max
bundle (which is being considered for deprecation — untouched by this work).

- **Embed the compressed tarball**, not the binary: +3.1 MiB (linux/x64), +2.8
  (linux/arm64), +5.0 (macos/arm64), +5.6 (macos/x64) per release artifact — the
  same numbers as the download, not the ~9–15 MiB of an uncompressed executable.
- One file per GOOS/GOARCH, selected by build tags:
  `pkg/herdr/assets/embed_linux_amd64.go` (`//go:build linux && amd64`) with
  `//go:embed herdr-core-linux-x86_64.tar.gz`, and three siblings; plus a stub
  (`//go:build !hcbin`) so `go build ./...` and `go test ./...` work in a tree
  without the downloaded assets.
- `scripts/fetch-herdr-core.sh` (or a target in `build-max.sh`'s style) reads the
  **pinned manifest** (`pkg/herdr/herdr-core-lock.json`: version 0.1.21 + per-target
  url/sha256, copied from `latest.json` at pin time), downloads, verifies sha256,
  and writes the tarballs into `pkg/herdr/assets/` (gitignored). `--update-pins`
  refreshes the lock file.
- `release.yml` runs that script before `go build -tags hcbin` for each matrix
  target; `ci.yml` runs it too if the build uses the tag (otherwise the stub path
  is tested). Builds without the tag still work: `suwu hc` then falls back to
  PATH, or downloads on first use with the same sha256 check.
- **Extraction** (first use, or when the stamped version differs): temp file in
  `~/.suwu/bin`, sha256 verify, `chmod 0755`, `rename`, write
  `herdr-core.version`; never overwrite a running binary (rename is atomic on
  Unix; a running process keeps its inode). Ignore the macOS `Herdr Core.app` in
  the tarball — we run the plain `herdr-core` executable, which needs no codesign
  check (`hc` only verifies the bundle).
- **Resolution order**: `$SUWU_HC_BIN` → `~/.suwu/bin/herdr-core` (managed, pinned)
  → `herdr-core`/`hc` on PATH → extract the embedded tarball → download the pinned
  manifest entry → error with the one-line install fix. Version mismatch with the
  daemon is reported in the panel, not enforced (protocol generation 1 is
  additive-only and `released.openrpc.json` guards it).

## 7. Server/frontend contract

```http
GET /api/baikal/snapshot?session=default
→ { "core": {"version":"0.1.21","features":[…]},"session":"default",
    "spaces": [ { "id":"b1", "name":"suwu-dev",          // derived from cwd (git repo name)
                  "customName":null, "identityCwd":"/home/yli/suwu-dev",
                  "identityTerminal":"t7", "colour":"sky",
                  "terminals":[{"address":"t7","name":null,"title":"",
                                "foreground":{"name":"zsh","cwd":"/home/yli/suwu-dev"},
                                "status":{"state":"working","title":"…","msg":"…",
                                          "progress":40,"app":"claude"},
                                "state":"live"}] } ],
    "unassigned": [ … terminals with no `space` label, shown per cwd … ] }
```

The server does the assembly — membership from the `space` label, names from the
`naming` rules, metadata from the `baikal` document — so the browser only renders
(and the same snapshot can feed a future CLI). `GET /ws/baikal/attach?terminal=t7&observe=0`
speaks: JSON messages for control (`ready`, `resize`, `close`), binary frames for
DATA (the same byte stream the terminal would see). Input from xterm is forwarded as DATA; a resize sends `RESIZE`; focus
changes send `FOCUS`; a tab close sends `CLOSE`. Validate `terminal` against
`^[A-Za-z0-9][A-Za-z0-9._-]*$` (local addresses only in v1), `session` against
`^[A-Za-z0-9._-]{1,32}$`.

## 8. Security

- Core's socket has **no auth**; suwu is the only client. The browser talks to suwu
  (session token, same-origin WS checks) and never to core.
- Every action is an **allow-listed argv** built server-side from typed fields; no
  shell lines, no user-supplied flags.
- The managed binary is sha256-verified against the pinned lock before it is run;
  extraction is atomic into a 0700 directory.
- Closing a tab is `CLOSE` (detach). `kill`/`rm` are separate, confirmed actions.
- `HC_SESSION` is a view filter, not a security boundary — say so in the tile's
  help text.

## 9. Testing

- **Go, no daemon:** a fake `herdr-core` (a script) behind `$SUWU_HC_BIN` that
  answers `connect` with scripted JSON-RPC/ frames; assert the RPC client, the
  frame codec (credit, CLOSE, RESIZE), snapshot reduction (events → spaces), and
  the endpoint contracts. Everything bounded by `exec.CommandContext`.
- **Frame codec unit tests:** table-driven encode/decode, partial reads, a frame
  split across reads, an oversized frame rejected, credit arithmetic, channel
  routing.
- **Go integration (opt-in, `SUWU_HC_IT=1`, skipped when `hc` is absent):** scratch
  `XDG_STATE_HOME`/`XDG_CONFIG_HOME` + `HC_SESSION=suwu-it`, `run` a shell, list,
  attach, type, assert screen via `terminal.read`, then `kill`, `rm`,
  `server stop` — all bounded, cleanup verified (AGENTS.md hygiene).
- **`naming` unit tests** (Go): home → `~`; a plain dir → basename; a dir inside a
  git repo → repo name (including a nested dir and a worktree); trailing slashes;
  a deleted cwd → recorded fallback; `customName` always wins.
- **Frontend:** `scripts/check-baikal.mjs` for the pure parts — space id/name
  display, basename collisions (full path as the second line), stable colour from
  the **id**,
  event application (created/foreground/status/finished/removed), tab model
  (dedupe, order, activate, close).
- **Headless E2E (optional):** real core in a scratch session, open the tile, run a
  shell, attach, screenshot.

## 10. Phases

| phase | scope | rough size |
|---|---|---|
| **0** | this document (decisions recorded) | — |
| **1** | `suwu hc` + embed/extract (§6); `pkg/herdr` RPC + frame + naming + `baikal` doc; `/api/baikal/snapshot`, `/ws/baikal/attach`; tile shell with space list (derived names) + tabs + attached terminal (xterm) | ~4–5 days |
| **2** | `run` (new shell in the active space), `kill`/`rm` with confirmation, `observe` tabs (peek), `read` previews, empty/error/degraded states, core version line | ~1–2 days |
| **3** | live event loop polish: `missed` recovery, heartbeat, CREDIT tuning under heavy output, reconnect UX; tab persistence edge cases | ~1 day |
| **4** | space colours/icons and ordering, filter box, keyboard shortcuts, docs page + `suwu-cli` doc, mobile polish | ~1–2 days |

## 11. Risks

| risk | mitigation |
|---|---|
| Protocol is preview (0.x, generation 1) | pin the binary; keep the client thin; the API is additive-only within a generation and `released.openrpc.json` enforces it |
| Framed framing/credit bugs | unit tests for the codec, `resize_notifications` paints, cap the WS buffer and let core repaint a lagging viewer |
| `hc connect` child dies | restart with backoff; re-subscribe and re-snapshot; attach streams reattach (`resumed`) |
| Space churn when a foreground changes constantly (a shell running a build) | group by `foreground.cwd`; it only *moves* when the directory actually changes, and two reads a second is quiet |
| Embedding grows every binary by 2.8–5.6 MiB | embed the compressed tarball; keep the stub build for dev/CI |
| Detach mistaken for kill | tabs `CLOSE`; destructive actions separate and confirmed |
| Basename collisions | key by full path, display basename + path |

## 12. Open questions (small, non-blocking)

1. Space ids: short (`b1`, `b2`, … — readable in `hc ls --label`) or a UUID
   (collision-proof across clients, ugly in the CLI)? Recommend short, namespaced
   `b` + 6 hex characters.
2. Should baikal **adopt** unlabelled terminals automatically (assign the current
   space on first attach), or only on an explicit “assign to space…” action?
   Recommend explicit, so a `hc run` from a shell is never silently re-homed.
3. `observe` (read-only) tabs: a per-tab toggle in v1 or phase 2?
4. When a space's last terminal is gone: keep it while it has a custom name or a
   colour (it is a deliberate object), drop it otherwise? (Recommend keep-if-named,
   with a “remove space” action.)

## 13. What shipped

| phase | scope | commit |
|---|---|---|
| 1 | `suwu hc`, embedded/pinned herdr-core, `pkg/herdr` (JSON-RPC + framed attach + snapshot), `/api/baikal/{snapshot,run}`, `/ws/baikal/attach`, tile with collapsible space list, tabs and inline xterm | `0d7d9e1` |
| 2 | terminal ⋯ (open/read-only/peek/assign/end/remove), space ⋯ (rename/colour/forget), `+ shell` vs `+ space`, `/api/baikal/assign`, error strip | `9b93029` |
| 3 | heartbeat/staleness, `missed` resync, channel-0 events, backoff reattach, tab pruning when a terminal is gone, `core_test.go` (assembly, events, doc conflict, redial) | `1e4c952` |
| 4 | space ordering (explicit order, then name), space badges, `Ctrl/Cmd+Alt+←/→` tab cycling, `docs/BAIKAL.md`, this status | — |

Deviations from the plan, and why:

- **The attach WebSocket has its own tiny protocol** (binary = terminal bytes,
  text = `resize`/`close` control) rather than reusing the PTY session protocol.
  `usePtySession` carries session-restore metadata that a core attachment does not
  have; a 60-line pane hook is clearer than bending that one, and the browser
  still never speaks core's framed protocol.
- **Space metadata lives in a herdr document named `baikal`** (`doc.get`/`doc.set`,
  version-checked, one retry on conflict), so a second browser sees the same
  names and colours. The tile falls back to session state only when documents are
  unavailable. Verified with the fake core; the conflict retry is unit-tested.
- **`terminal.label` merges keys** ("labels to set; `key=` removes one"), so
  adopting a terminal with a `space=` label cannot clobber other labels — the
  "labels replace the whole map" worry in §5.1 was wrong.
- **The name's git lookup is cached** (60 s per directory, `git rev-parse
  --show-toplevel`) rather than recomputed per snapshot.
- **A core restart without `--keep` closes the tabs of the programs it ended**;
  the pane's reattach loop is for lost lines, not for programs that are gone.

Verified against herdr-core 0.1.21 with a scratch session: a shell started in
`/tmp/suwu-baikal-demo` produced the space `suwu-baikal-demo`; typing in the
attached terminal ran commands; `cd /tmp` renamed the space to `tmp` with the same
id; rename/colour/clear-name, assign, peek/read, kill and remove all round-trip;
stopping the core mid-attach showed the backoff countdown and recovered when the
core came back. `go test ./...`, `pnpm check` and the tile review checks are green.

### 13.1 Changes from the first working version

- **Tabs are per space.** The strip shows the selected space's terminals, and
  selecting another space switches it; every tab of every space stays mounted
  (hidden with `display: none`) so hiding an attachment never detaches it.
- **No sidebar buttons.** The tab strip's `+` starts a shell in the active space;
  the `+` beside the filter box starts one in a new space. The footer of the
  space list is gone.
- **The space name comes from the first shell's start directory**, not from its
  live cwd (see §5.1).
- **The terminal's tools are shared**, not copied: `components/term/TermToolbar`
  holds key chords, frequent inputs, selection mode and reset, and both the shell
  tile and baikal's attached shells render it. The baikal terminal hides its
  scrollbar (`baikal-term`), because the wheel and keyboard reach the scrollback
  and a bar down a full-tile terminal is noise.
- **The soft-input panel is shared too.** `components/term/SoftInputPanel` holds
  the panel row, its `0fr → 1fr` growth and the focus delay, and the toggle comes
  in through `TermToolbar`'s `softInput` prop — so a phone gets the same keypad on
  a baikal terminal as on `/term`, and opening it resizes the *core's* grid.
- **The empty panel offers terminals by name *and* address** — `suwu-dev (t12)`
  (`terminalLabel`). Two shells started in the same directory share the name the
  core derives from it, and a bare name cannot say which terminal a click will
  attach to; the address is the identity every action takes.
- **The panel follows the tile type scale.** The header said `text-sm` and the
  whole left panel lived at Caption/Micro (11/10 px), which made the tile read as
  a smaller app beside DBBrowser and the REST helper. It now matches them: header
  title Heading (`text-base font-semibold`), header meta Caption (11), section
  labels Label (`text-xs font-semibold uppercase tracking-wider`), space/agent/tab
  rows Label (12) with Caption (11) secondary lines, menus and inputs Label (12),
  and the Peek dialog drops its `text-sm` override so its title is the standard
  Heading — its mono body moves from 11 to Body (14) like the terminal's cache
  preview.
- **The attach re-sends its grid after `ready`**: the tile iframe gets its final
  size after mount, and attaching at the transient, narrow width left the shell
  wrapping its prompt in a 25-column window.

### 13.2 Hidden tabs must not resize the terminal

Switching tabs back and forth left stacked, wrapped prompts on screen. A hidden
pane is `display: none`, which measures 0×0; the terminal's ResizeObserver fitted
it to nothing, the attachment forwarded that as a one-column resize, and the shell
redrew its prompt at that width — once per switch.

`useTerminal` now refuses to fit a container without a box, and `BaikalTerm` takes
`visible`: it sends no resize while hidden, and on reveal it fits once and sends a
single resize (after the browser has laid the pane out). The grid is also re-sent
once `ready` arrives, because the tile's iframe gets its final size after mount.

Smaller polish in the same commit: the tab content gets a 6 px inset (a terminal
touching the tab border reads as clipped), and the filter row and the tab strip
share a 36 px height with 28 px controls, so the two "+" buttons line up.

### 13.3 Second round of changes

- **Spaces are listed in creation order** (oldest first), not alphabetically; the
  server exposes the space's `createdMs` (its first terminal's start time) and
  `sortSpaces` uses it, falling back to the id for ties.
- **An Agents section** sits above the spaces: terminals that announced a status
  over OSC 7501, sorted blocked → error → working → done → idle. Tapping one
  selects its space and opens (or activates) its tab, which is how Herdr's TUI
  jumps to an agent's workspace.
- **A tab's × ends the session.** It was a detach; the user wants it to stop the
  program, so it kills the terminal (or removes a finished record) and drops the
  tab. Hiding remains what switching spaces does.
- **New shells are created at the viewer's size.** Core's default is 200×120;
  attaching a 30-row viewer scrolled the first prompt above the visible rows, so
  a fresh space looked empty until a keypress. `terminal.run` now receives
  `size {cols, rows}` from the last terminal's grid (or a monospace estimate).
- **A restored tab attaches only when first shown.** A terminal born inside
  `display: none` measures 0×0 and paints its first screen into a one-column grid
  — the first look at a restored tab was empty until you switched away and back.
  Tabs are now mounted on first reveal and stay mounted afterwards.

### 13.4 The panel becomes a real sidebar

- **Spaces and agents are two panes**, not one list with a header: each has a
  section label and a scroll area, the divider is draggable (`role="separator"`,
  arrow keys nudge it, `Enter` resets), and the ratio persists in
  `suwu.baikal.split`.
- **Live updates over SSE** (`/api/baikal/events`). The panel used to re-read the
  snapshot on a 3 s timer, so a `cd` — which core notices within 500 ms and emits
  as a `foreground` event — took up to 3.5 s to rename a space. `Core.Subscribe`
  hands out coalescing change tokens (non-blocking sends, one slot per watcher,
  fanned out outside the core lock), the server streams one event per settle, and
  the tile re-reads the snapshot ~100 ms later. The 5 s poll stays as a fallback
  for a proxy that drops the stream.
- **Typographic parity with the terminal tile**: `BaikalTerm` honours the pane's
  `tile-font-size` (asked for on mount, applied with a refit so the core learns
  the new grid) and the shared font-family/line-height atoms, which reach the
  iframe through `atomWithStorage`'s storage sync.
