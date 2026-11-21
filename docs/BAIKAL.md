# Baikal — the herdr-core tile

Baikal is a Suwu tile that is a client of **herdr-core** (`hc`), the daemon that
runs programs in terminals which outlive the viewer. Agents keep working when you
close the tab; you attach again where you left them.

![spaces on the left, one attached terminal per tab on the right]

```
+----------------------+---------------------------------------------+
| ‹ suwu-dev        2  | [ suwu-dev bash ] [ suwu-dev claude ] [ + ] |
|   ● claude  working  | +-----------------------------------------+ |
|   ○ bash             | |                                         | |
| ‹ tmp             1  | |        the attached terminal (xterm)    | |
|   ○ bash             | |                                         | |
+----------------------+---------------------------------------------+
```

## Spaces

A **space** is a group of terminals. Membership is a label, `space=<id>`, that
Baikal writes when it starts a shell; the **name** is not stored, it is derived
from the space's *first tab* — the terminal it opened first — and follows that
shell's directory as it changes, so `cd` renames the space. A later terminal in
the same space never renames it. The derivation follows the Herdr app's rules:

- inside a git repository: the repository's name;
- in the home directory: `~`;
- otherwise: the directory's name.

Renaming a space pins a custom name; clearing it goes back to that directory.

A terminal started outside Baikal (`hc run --bg claude` from a shell) has no
label: it appears under **Unassigned**, grouped by its directory, and can be moved
into a space from its ⋯ menu.

Spaces are listed in **creation order** — the oldest first, new ones appended —
and renaming never moves one. They are coloured from a hash of their id (`⋯` →
colour), so a space keeps its colour regardless of its name. The **+** beside the filter box opens a shell in a
**new** space, in the current space's directory.

Selecting a space (its name, not the ▾) switches the tab strip to that space's
terminals, the way Herdr's TUI switches tabs with the workspace. Terminals of the
other spaces stay attached — switching away only hides them.

The panel is split in two, the way Herdr's TUI is: **Spaces** on top and
**Agents** below, each labelled and each with its own scroll area. The divider
between them is dragged (or focused and nudged with the arrow keys, `Enter` back
to half); the position is remembered per tile.

**Agents** are the terminals that announced themselves over OSC 7501, most
actionable first (blocked, error, working, then the rest). A row shows the
program's own status word and message, and tapping it switches to that agent's
space and tab. A terminal that never reported, or whose program has ended, is not
an agent.

The panel is live: herdr-core reports a directory change within 500 ms and Suwu
forwards it over `/api/baikal/events` (server-sent events), so a space renames as
soon as its shell's `cd` completes instead of on the next poll. The poll remains as
a fallback for a dropped stream.

Font family and line height come from Appearance (the same settings the terminal
tile uses), and the pane's font size comes from the tile menu — a baikal terminal
is sized exactly like a `/term` pane.

## Tabs

A tab is one attached terminal. Opening one twice is impossible: the second open
activates the existing tab.

- **Closing a tab ends its program.** The × is the deliberate "stop this": it
  kills the terminal and drops the tab. Hiding is what *switching spaces* does —
  the attachment stays, the program keeps running, and coming back shows it again
  without a reattach. Use the terminal's ⋯ → **Peek** if you only want to look at a
  terminal that is running elsewhere.
- **Open read-only** attaches as an observer (`observe`): it never types and never
  changes the terminal's size, so you can watch an agent without disturbing it.
- **Peek** shows the last 200 lines of the screen as text, without attaching at
  all.
- If the connection drops (tunnel, server, core restart) the pane reattaches with
  backoff (2 s → 15 s) and says so; a program that exited stops the retrying.

`Ctrl`/`Cmd` + `Alt` + `←`/`→` moves between the active space's tabs.

The terminal's status bar carries the same tools as the shell tile — key chords,
frequent inputs, selection mode and reset — because an attached shell is a shell.
The scrollbar is hidden: the wheel and the keyboard reach the scrollback, and a
bar down the edge of a full-tile terminal is noise.

## Terminal and space actions

Terminal ⋯: open, open read-only, peek, move to another space, end program
(confirmed), remove a finished record.

Space ⋯: rename, colour, forget. Forgetting drops only the name and colour;
terminals keep running, and a space with no live terminal stops being listed.

## `suwu hc`

Baikal needs `herdr-core`. Suwu resolves it, in order:

1. `$SUWU_HC_BIN`
2. `~/.suwu/bin/herdr-core` (the managed copy)
3. `herdr-core`, then `hc`, on `PATH`
4. the archive **embedded in release builds** (extracted to `~/.suwu/bin`,
   sha256-verified against `pkg/herdr/herdr-core-lock.json`)
5. the same pinned release, downloaded and verified

Then it execs it, so the whole CLI works through Suwu:

```sh
suwu hc --version
suwu hc server start
suwu hc ls --json
suwu hc run --bg --name claude --cwd ~/src/app claude
suwu hc attach claude        # hand the terminal to this shell
```

The managed copy lives in `$SUWU_VAR/bin` (default `~/.suwu/bin`) and is upgraded
in place when a release pins a new version.

## Core sessions

`?session=<name>` on the tile (or `HC_SESSION` in the server's environment)
selects a core session: separate terminals and state, useful for tests and for
keeping a set of work apart. Sessions are not a security boundary.

## Security

herdr-core listens on a local Unix socket with **no API password**: anyone who can
run a client as your account can run programs and read files. Suwu is that client
— the browser never talks to the socket. The ticket's endpoints
(`/api/baikal/*`, `/ws/baikal/attach`) are behind Suwu's own session auth and
same-origin WebSocket checks, and terminal/session names are validated before they
reach core. Running core is equivalent to the shell Suwu already gives you.

## Troubleshooting

| Symptom | What it means |
|---|---|
| "herdr-core is not available" | No binary resolved and no embedded/downloadable release. Install `hc` (https://herdr.dev/core/) or set `SUWU_HC_BIN`. |
| A space renamed itself | Its identity terminal changed directory. Rename the space to pin a name. |
| Closing a tab did not stop the program | That is the design. Use ⋯ → **End program**. |
| "Reconnecting in Ns" | The line or the core went away; the pane retries with backoff. A core restart without `--keep` ends its programs, so those tabs close instead. |
| A terminal is missing from the list | It finished. `hc ls --all` still shows it; Baikal lists live terminals. |
| Peek is empty | The terminal is running a full-screen app; core only snapshots the screen for those in some states. |
