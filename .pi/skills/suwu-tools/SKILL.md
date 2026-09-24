---
name: suwu-tools
description: "Drive the running Suwu browser session from the terminal — post notifications, open files and directories, open the Code Explorer with highlighted lines, show side-by-side diffs and git graphs, forward TCP/UDP ports, and run GUI commands on a chosen X display. Use when an agent should surface a file, diff, log, or port forward in the Suwu web UI instead of only printing to stdout."
license: MIT
compatibility: "Requires the suwu CLI and a running Suwu server"
metadata:
  author: suwu
  stack: "suwu CLI"
  tags: "suwu,terminal,notifications,diff,code-explorer,port-forward,x11"
---

# Suwu tools

Suwu is a browser terminal emulator backed by a real shell PTY. The commands
below push work from the terminal into the **running Suwu browser session** —
they open tiles in the web UI rather than launching local windows. Use them
when a human is watching the Suwu tab and you want a file, diff, graph, log,
or port forward to appear there.

## Prerequisites

The Suwu server must be running:

```bash
suwu serve              # foreground
suwu daemon start       # background
```

All commands talk to a Unix socket, default `~/.suwu/suwu.sock` (override
with `--sock <path>` or `$SUWU_SOCK_PATH`). If the server is not running the
command fails with a connection error — start the server first.

## Tools

### `suwu send` — post a notification

Post a message into the Suwu notification panel. With no argument it reads
stdin to EOF and sends the whole input as one message, preserving newlines.
The JSON-encoded notification must not exceed 1 MiB.

```bash
suwu send "build complete"
echo "tests passed" | suwu send
cat build.log | suwu send
```

### `suwu open` — open a file or directory

Open a path in the Suwu file browser/viewer.

```bash
suwu open src/main.go
suwu open ~/Documents/report.pdf
suwu open .
```

### `suwu code` — open files in the Code Explorer

Open one or more files as Code Explorer tabs. Each argument is a path with an
optional `:`-suffix listing line ranges to highlight
(`start[-end][,start[-end]]…`). A single directory argument opens the explorer
rooted there with no file.

```bash
suwu code src/app.ts:10-20 src/util.ts
suwu code README.md:50-55,40-41
suwu code .                 # root the Code Explorer at the cwd
suwu code src               # root it at src/
```

### `suwu diff` — side-by-side diff

Open a side-by-side diff tile for two files.

```bash
suwu diff old.go new.go
suwu diff ~/project/v1.go ~/project/v2.go
```

### `suwu gitgraph` — open the git graph

Open the git graph for a repository directory.

```bash
suwu gitgraph .
suwu gitgraph ~/project
```

### `suwu forward` — TCP/UDP port forwarding

Create, stop and list port forwards through the running server. Useful to
expose a dev server or database to the browser session.

```bash
suwu forward 23000 localhost 3000      # local 23000 -> 3000
suwu forward 23000 192.168.1.10 3000   # to a remote host
suwu forward --proto udp 23000 localhost 3000
suwu forward --list
suwu forward --stop 23000
```

### `suwu use` — run a command on a chosen X display

Show a TUI to pick an available X display, then run the command with
`DISPLAY` set. Use this to launch GUI apps (browsers, editors) on the Suwu
display.

```bash
suwu use xterm
suwu use chromium --new-window https://example.com
```

## Common flags

| Flag | Applies to | Meaning |
|---|---|---|
| `--sock <path>` | send, open, code, diff, gitgraph, forward, use | Notify socket path (default `~/.suwu/suwu.sock`) |
| `--proto <tcp\|udp>` | forward | Protocol (default `tcp`) |
| `--stop <port>` | forward | Stop the forward bound to that local port |
| `--list` | forward | List active forwards |

## Notes

- These commands only notify the browser; they do not block waiting for a
  human to interact.
- Paths are resolved relative to the current working directory and sent to the
  server as absolute paths.
- Prefer `suwu code <file>:<range>` over dumping a whole file when you want a
  human to review a specific hunk.
- Run `suwu help <command>` for the full flag list of any tool.
