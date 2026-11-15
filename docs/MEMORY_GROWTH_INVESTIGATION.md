# Production memory growth (3.7 GiB on ARM) — investigation notes

Status: **analysis only, nothing fixed.** Findings for the 0.1.16 instance that
reached 3.70 GiB RSS after 6 d 06 h (`/home/ubuntu/.local/bin/suwu serve`,
PID 1074707, 11 OS threads), versus ~200 MB on a dev box running the same
version.

> **Tier-0 readings changed the conclusion. Read §2 first, then §6.**
> The box reports **2 child shells** and **2234 open fds**, not ~330 sessions.
> Sessions are therefore *not* what is holding the 3.7 GiB; the estimates in §1
> divided memory by the per-terminal price, which assumed sessions were the
> occupant. They are not. §2's leak paths are real bugs and still worth fixing,
> but they did not cause this. §6 is the live hypothesis.

The dev box is not the control it looks like: `air` restarts it constantly, so a
slow accumulation never gets the chance to show up. Six days of uptime is the
whole variable.

---

## 1. The arithmetic that explains it

Measured for **this** codebase (0.1.16's `libghostty-go` binding, `vtScrollback`
1000, 80×24, 50 screens of output each), 200 terminals in one process, RSS read
from `/proc/self/status`:

| Terminals | RSS | Per terminal |
|---|---|---|
| 1 | +24.8 MiB (one-off wasm runtime) | — |
| 50 | +553 MiB | 11.07 MiB |
| 100 | +1106 MiB | 11.06 MiB |
| 200 | +2206 MiB | 11.03 MiB |

So **each live server-side terminal costs ~11 MiB RSS** (Go heap, wazero linear
memory, plus a shell process, two goroutines, one fd — the shell and goroutines
are not in that number).

That price is what a session costs *if* sessions are what is heavy. It is not a
measurement of how many sessions exist — Tier 0 (§6) shows there are 2, costing
~22 MiB together.

## 2. How sessions can accumulate (latent bugs, not this incident)

A session is supposed to be cleaned up when its shell exits (`finish`) or `TTL`
after its last client detaches (`expire`). `DefaultTTL` is **24 h**
(`pkg/session/session.go`), overridable with `SESSION_TTL` — so even the healthy
path keeps a closed pane's shell and emulator resident for a day. That alone
gives a steady state of "panes opened in the last 24 h × 11 MiB".

On top of that there are three ways a session becomes **immortal** — it keeps its
`*session` in `Manager.sessions`, its shell, its wasm terminal, its two
goroutines and its fd until the process exits, whatever the TTL says. All three
come from `expire` only ever being scheduled by `detachLocked`:

```go
func (m *Manager) detachLocked(s *session) {
	m.revokeLocked(s)
	if s.timer == nil && !s.closed {
		s.timer = time.AfterFunc(m.ttl, func() { m.expire(s) })
	}
}

func (m *Manager) revokeLocked(s *session) {   // ← does NOT arm a timer
	c := s.client
	if c == nil { return }
	s.client = nil
	if c.active { c.active = false; c.ready = false; close(c.ch) }
}
```

**(a) Slow-client revoke — the likely one in production.**
`broadcast` drops a client that is 256 frames behind (`subBuffer`) and revokes
it, without arming the TTL:

```go
select {
case c.ch <- cp:
default:
	m.revokeLocked(s)      // s.client = nil, s.timer stays nil
}
```

The websocket handler then returns (`Frames()` was closed → the writer closes the
connection → `conn.Read` errors) and its `defer client.Detach()` runs… but
`Detach` bails out because the client is no longer the session's client:

```go
func (c *Client) Detach() {
	...
	if c.s.closed || c.s.client != c { return }   // ← already revoked: no timer
	m.detachLocked(c.s)
}
```

`expire` is never scheduled. A browser tab that sleeps, a phone that changes
network, or just a `pnpm build` printing faster than the link can carry is enough
to trigger it. Note the frames are *not* lost silently — the client is supposed to
reattach — which is exactly why nobody notices the orphan.

**(b) Attach failure after revoke.** `Attach` revokes the previous attachment,
then dumps the screen. If `DumpVT`/`DumpScreen` fails (out-of-memory, wasm trap),
it returns an error with `s.client == nil` and no timer. The session is now
unreachable *and* immortal.

**(c) The expired-timer race.** `expire` early-returns when a client is attached:

```go
if s.closed || s.client != nil { return }   // s.timer is left non-nil, already fired
```

`Attach` stops and nils the timer before re-registering a client, so this needs
the callback to be already running (waiting on `m.mu`) while `Attach` stops it.
Rare, but the result is the same: a later `Detach` sees `s.timer != nil` and
never re-arms, so the session outlives its client forever.

None of these are visible in logs at the default level: `session expire` and
`session start` are `slog.Debug` and `logging.Init()` sets the level to **error**.

## 3. Candidates checked and ruled out

| Area | Verdict |
|---|---|
| `gzipCache` (`pkg/server/compress.go`) | Bounded: `gzipCacheBytes = 32 MiB` with insertion-order eviction, `gzipChunkMax = 8 MiB` streams larger files instead of caching. |
| Backup (`pkg/backup`) | `MaxUploadBytes = 16 MiB`, slots bounded by `MaxSlotBytes`; generations are pruned. |
| Extension renders | `processRunner` runs `suwu gq` in a **child process** per render, concurrency 4 — not in suwu's RSS (a process leak would be, but `defaultExtensionConcurrency` + timeouts bound it). |
| File download (`/api/file`) | `http.ServeFile` → `sendfile`, no heap buffer. |
| SFTP upload | `io.Copy` streams through `http.MaxBytesReader` (2 GiB cap), no full-body buffer. |
| Backup/REST/extension bodies | All `io.LimitReader`/`MaxBytesReader` capped (4–16 MiB). |
| `RateLimiter` / `clientGate` | Pruned; `limit = 1024`. |
| DB browser sessions | `StartCleanupLoop` + `CloseAll`. |
| SFTP sessions | `StartCleanupLoop` every minute. |
| Notify / xdisplay websockets | Subscribe/Unsubscribe + `conns` map cleanup in `defer`s. |
| `session.Manager.sessions` leaks on shell exit | No: `finish` deletes the entry. |

What is **not** ruled out, because there is no instrumentation to see it: a
one-off large allocation whose arena Go never returned (`MADV_FREE` keeps RSS
until memory pressure). `VmHWM` on the box decides whether that is even in play —
see §4.

## 4. Tier 0 result from the ARM box (2026-11-10)

```
VmHWM:   8155084 kB        ← peaked at 7.78 GiB
VmRSS:   3886264 kB        ← 3.70 GiB now
RssAnon: 3857160 kB        ← 3.68 GiB anonymous, all of it
Threads: 11
LazyFree: 0 kB             ← nothing was lazily freed: this is live memory
child shells:              2   (both 6 d 06 h old)
open fds:               2234
TCP sockets owned:         3
```

Three facts, and what each rules out:

1. **2 shells ⇒ ~2 sessions ⇒ ~22 MiB of terminal state.** The session
   accumulation story is dead for this box. (Two 6-day-old `bash` processes mean
   two panes that were never closed — a 24 h TTL would have reaped them, so
   something is attached or re-attaching. Not the memory story.)
2. **2234 fds with 3 TCP sockets and 2 ptys.** ~2220 descriptors belong to
   *something else*. A leak of that size is almost always paired with leaked
   goroutines and their buffers, which is a plausible route to gigabytes.
   It is now the loudest clue on the box.
3. **`LazyFree: 0` and `VmHWM` ≈ 2 × `VmRSS`.** Go's `GOGC=100` grows the heap to
   ~2× live before collecting, so a peak of 7.78 GiB is exactly the signature of
   a live heap of ~3.7–3.9 GiB. Nothing was freed-and-kept (which would show as
   `LazyFree`), so ~3.7 GiB is **held**, not fragmentation.

So: something in the process holds ~3.7 GiB *and* ~2200 descriptors. That
combination points at a per-operation leak (a connection or a child process's
pipes that is never closed, together with the goroutine and buffer behind it),
not at a single oversized buffer.

### Spike candidates that fit a 7.78 GiB peak

`VmHWM` is a *peak*, and Go's scavenger is lazy: a one-off burst can leave
gigabytes of free-but-unscavenged spans in RSS for hours, which would look
exactly like this (high HWM, `LazyFree: 0`, RSS that never comes back down).
The paths in this codebase that can allocate gigabytes in one request:

| Path | Cap | Can it reach GBs? |
|---|---|---|
| DB browser query (`pkg/db/db.go`) | `MaxRows = 10000` **rows, no byte cap** | **Yes.** A `SELECT *` over a table with large blobs builds `[][]any` *and* then a JSON encoding of it — 10 000 × 1 MiB blobs ≈ 10 GB live, twice over during encoding. The strongest spike candidate. |
| `/api/lives2d/media` (`pkg/server/lives2d.go`) | `maxMediaBytes = 256 MiB` | 256 MiB per download, streamed to the client; concurrent downloads add up. |
| SFTP upload (`pkg/server/sftp.go`) | `maxSftpUploadBytes = 2 GiB` | Streamed via `io.Copy`, so not retained — unless the writer buffers. |
| Git compare (`git_compare.go`) | `compareLimit = 4 MiB` | No. |
| File search (`file_search.go`) | output limit | No. |
| File write (`file_write.go`) | 10 MiB | No. |

If the plateau is *live* rather than scavenged-free, the occupants are leaked
objects — and the fd count says there are ~2200 of *something*.

### 4.1 The fd scan: 2233 sockets, none of them TCP

```
2233 socket:[N]
   2 anon_inode:[pidfd]      ← exec.Cmd children (transient)
   2 /dev/ptmx               ← the 2 sessions
   1 anon_inode:[eventpoll], 1 anon_inode:[eventfd], 1 /dev/null
```

No `pipe:[N]` at all, so no leaked child stdout/stderr. `ss -tnp | grep pid=`
reported **3** TCP sockets, so the 2233 are a socket family `ss -t` does not
print: unix (X11, notify, a DB over a unix socket), UDP (port forwards), or
netlink. `ss -xap` / `ss -uap` name them in one line.

`ss -xap` (test 3) came back clean — only three unix fds are accounted for:

```
u_str ESTAB  ... fd=1,fd=2   ← stdout/stderr as one journald socketpair
u_str LISTEN /home/ubuntu/.suwu/suwu.sock fd=3   ← the notify listener
```

So the ~2227 remaining sockets are **neither unix nor TCP**. That leaves UDP
(the only family this code dials: `pkg/forward`'s `net.Dial("udp")` per client
address, or the resolver behind any outbound HTTP) or netlink (nothing in this
tree opens netlink directly). Two commands settle it:

```sh
PID=$(pgrep -f "suwu serve" | head -1)
sudo ss -ap | grep "pid=$PID" | awk '{print $1}' | sort | uniq -c | sort -rn
```

and, definitive and lsof-free, classify every socket fd by protocol family:

```sh
PID=$(pgrep -f "suwu serve" | head -1)
tmp=$(mktemp)
for f in /proc/$PID/fd/*; do
  t=$(readlink "$f" 2>/dev/null) || continue
  case "$t" in socket:*) printf '%s\n' "${t#socket:[}" | tr -d ']' >> "$tmp" ;; esac
done
echo "socket fds: $(wc -l < "$tmp"), unique: $(sort -u "$tmp" | wc -l)"
for tbl in tcp tcp6 udp udp6 unix netlink raw packet; do
  [ -r "/proc/$PID/net/$tbl" ] || continue
  printf '%-8s %s\n' "$tbl" "$(grep -c -F -f "$tmp" "/proc/$PID/net/$tbl")"
done
rm -f "$tmp"
```

(`/proc/$PID/net/*` is the process's own network namespace, so this also works
if the service is sandboxed.) Whichever row is non-zero names the subsystem;
then `ss -uap | grep pid=$PID | head` shows the peers (e.g. a resolver address),
which identifies the caller.

### 4.2 Cloudflare Tunnel in front: a real hazard for sessions

The deployment sits behind a Cloudflare Tunnel, which makes **abandoned
websockets** a live risk in this code, because nothing detects them:

- `handleWS` reads with `conn.Read(ctx)` where `ctx = r.Context()`. For a
  hijacked WebSocket that context is cancelled when the *handler returns*, not
  when the peer goes away.
- There is no `SetReadDeadline`, no server-side ping timeout, and no watchdog
  (the server only *replies* to the client's `{"type":"ping"}`).
- Through a tunnel the origin socket stays ESTABLISHED as long as `cloudflared`
  holds it, so a closed tab, a sleeping laptop or an edge timeout can leave
  `handleWS` blocked in `conn.Read` **forever**.

Consequences, in order of likelihood:

1. The session never detaches, so the 24 h TTL never starts: the PTY, the VT
   emulator, two goroutines and the socket live until the process exits. The two
   6-day-old `bash` processes are consistent with exactly that (assuming nothing
   is attached to them today — `ss -tnp` + the pane ids settle it).
2. When the tunnel does eventually stop accepting writes, `broadcast` fills the
   256-frame queue (~8 MiB worst case), then revokes the client — and §2's bug
   makes that session immortal too.

That is a *session* leak, not a 3.7 GiB leak: at 11 MiB per terminal you would
need ~330 of them, and there are 2 shells. So the tunnel explains abandoned
sessions and part of the socket count, **not** the memory plateau.

## 5. Root cause found on the box (2026-11-14, read-only session)

Access: `ssh ubuntu@140.238.196.232`. Nothing was changed — no signals, no
restart, no writes (one `/tmp` file from a classifier loop, removed immediately).
Process: PID 1074707, `SERVER_MODE=http`, listening `127.0.0.1:8181`, up
**6 d 07 h**, 11 threads, RSS 3.70 GiB, `VmHWM` 7.78 GiB.

### 5.1 The 2244 fds are leaked loopback connections from cloudflared

Every earlier count disagreed because these sockets are **invisible to `ss`**:
of 2244 socket fds only 5–7 inodes appear in any `/proc/<pid>/net/*` table, while
`sockstat` says `TCP: inuse 26 ... alloc 2271`. ~2240 TCP sockets exist in a
non-hashed state, which is why `ss -t`, `ss -x` and `ss -u` all came up short.

Watching `/proc/<pid>/fd` for new descriptors caught the lifecycle in the act:

```
14:20:03 newfd=2257 ino=9735936
  /proc/net/tcp: 0100007F:1FF5 0100007F:8CEA 01 ...  ino 9735936
                 = 127.0.0.1:8181 <- 127.0.0.1:36074, ESTABLISHED
  ss -tanp: 127.0.0.1:36074 ... users:(("cloudflared",pid=1280555,fd=11))
```

and, minutes later, the same server side with no reader left:

```
CLOSE-WAIT  127.0.0.1:8181 <- 127.0.0.1:46278  users:(("suwu",fd=2258))
FIN-WAIT-2  127.0.0.1:46278 -> 127.0.0.1:8181  (cloudflared side, already gone)
```

So each leaked fd is a **connection accepted from `cloudflared`** that the peer
closed while suwu's handler never noticed. Once the peer's socket is destroyed
the socket is reset out of the hash tables — invisible to `ss` forever, but the
fd stays open. Rate: 2244 ÷ 6.3 days ≈ one every 4 minutes, and the fd count
still climbs (+1 while this session was measuring).

### 5.2 Why the handler never notices: `/ws/notify` parks on a channel

`pkg/server/websocket_notify.go` only touches the socket when a notification
arrives:

```go
ch := s.notify.Subscribe()
defer s.notify.Unsubscribe(ch)

for n := range ch {                                   // ← parks here, forever
    data, _ := json.Marshal(n)
    if werr := conn.Write(ctx, websocket.MessageText, data); werr != nil { return }
}
```

Between notifications the goroutine blocks on the channel. A peer FIN or RST is
therefore invisible: the loop never wakes, the deferred `conn.Close` and
`Unsubscribe` never run, and the accepted socket leaks. Two more consequences:
`l.subs` holds 2244 dead subscribers (every notification is copied to all of
them, and `Close()` iterates them), and each leak keeps its goroutine.

The churn that feeds it is on both sides:

- `frontend/src/routes/hooks/useNotifications.ts` reconnects **every 3 s** after
  a close (`RECONNECT_DELAY_MS`), and the endpoint sends nothing while idle.
- An idle WebSocket through Cloudflare is reaped by the edge (no heartbeat from
  either side), so every reap leaves an orphan on the origin.

The other two WebSocket handlers are fine: `/ws` and `/ws/xdisplay` both read in
a loop, so they see EOF and return.

### 5.3 The fix

Three changes, all in the "a hijacked connection needs its own liveness" class:

1. `/ws/notify` now has a **reader goroutine** (`conn.Read` in a loop) and a
   **30 s ping ticker**, and writes through a **bounded context**. The reader is
   what makes a peer FIN/RST visible: `Read` returns an error, the request-scoped
   context is cancelled, and the handler returns through its deferred
   `Unsubscribe` + `Close`. The ping also stops Cloudflare reaping an idle
   socket every few minutes, which is what fed the churn.
2. `writeWS` (`pkg/server/websocket.go`) bounds every WebSocket write with
   `wsWriteTimeout` (15 s). A hijacked connection's request context is never
   cancelled, so an unbounded `Write` was a second way to park a handler — for
   the terminal socket too, not just the notify one. Used by `/ws` (attach
   prefix + frame writer), `/ws/notify` and `/ws/xdisplay`
   (`writeStream` in `pkg/xdisplay/stream.go`).
3. `notify.Listener.SubscriberCount()` exists so a growing subscriber set is
   observable (and assertable in tests) instead of invisible.

`pkg/server/websocket_notify_test.go` pins it: a client that closes must release
its subscriber slot, notifications must still be delivered with the reader
running, and two clients must be counted and released independently. Against the
old handler the first test fails — and it fails *by hanging the client's own
`Close` for 5 s*, because the server never read the close frame: a direct
demonstration of why the browser could never tell the socket was dead.

### 5.4 What this does and does not explain

- **Fds: yes.** ~2244 leaked connections, each with a parked goroutine and an
  entry in the notify subscriber set.
- **Memory: not on its own.** Per leaked connection the retained state is tens
  of KB (bufio buffers, `http.Request`/context, `websocket.Conn`, 8 KB stack,
  channel) — roughly 100–200 MiB for the whole pile, not 3.5 GiB. Compression is
  off (`AcceptOptions.CompressionMode` defaults to disabled), so no deflate
  state is held either.
- The heap itself is a single merged 7.75 GiB arena mapping with 3.66 GiB
  resident, all of it anonymous and dirty, and it was **flat** across 25 minutes
  of watching (3,886,26x kB) while fds grew. `rchar` is only **221 MB** across
  the whole 6 days, so no multi-gigabyte transfer ever passed through this
  process: the 3.5 GiB was *computed*, not read.

So the memory is a second, still-unattributed problem: either live data we
cannot see without a heap profile, or heap Go cannot release because it is
fragmented by 2244 long-lived connection objects interleaved with churn. The
`VmHWM` of 7.78 GiB ≈ 2 × `VmRSS` is Go's `GOGC=100` doing its normal
doubling, not a leak of its own.

### 5.5 Post-fix verification (2026-11-15, 4 h run with snapshots)

A build with the fix and `--pprof` ran for 4 hours with two shells. The four
snapshots (2 h apart) are unambiguous:

| time (UTC) | goroutines | heap alloc | heap inuse | heap idle | released | objects | GCs | GC pause total |
|---|---|---|---|---|---|---|---|---|
| 23:14 (startup) | 2 | 45.0 MiB | 48.0 | 11.6 | 9.7 | 40 799 | 7 | 0.8 ms |
| 01:14 | 13 | 13.4 | 15.3 | 64.2 | 63.5 | 15 837 | 77 | 15.4 ms |
| 03:14 | 13 | 13.6 | 15.5 | 64.0 | 63.5 | 16 775 | 136 | 27.0 ms |
| 05:14 | 13 | 13.4 | 15.2 | 64.2 | 63.5 | 16 033 | 196 | 37.5 ms |

- **`inuse_space` diff between 01:14 and 05:14 is exactly 0 bytes.** Nothing is
  accumulating: live heap 13.4 MiB, 16 k objects, flat.
- **Goroutines flat at 13**, and every one is accounted for: 2 `session.readLoop`
  and 2 `session.statePoller` (the two shells), 3 accept loops (HTTP, pprof,
  notify socket), 2 cleanup loops (db, sftp), `main.run`, two signal goroutines
  and the snapshot writer itself. **No `handleWS` and no `handleNotifyWS`** — on
  the ARM box this is exactly where 2244 parked handlers and their fds would
  have been visible, so the leak is gone.
- Startup's 45 MiB is wazero's compiler (module compilation); the profile shows
  the wazevo pools at 20 MiB and they are gone by the next snapshot.
  `HeapReleased` 63.5 MiB confirms Go hands the idle spans back, which is why RSS
  (~50 MiB) is well below `Sys` (86 MiB).
- The 13.2 MiB of live heap: **5.0 MiB gzip cache** (compressed static assets,
  bounded at 32 MiB by design), **4.6 MiB wazero `MemoryInstance.Grow`** (the two
  terminal emulators — the 1.2-1.4 MiB/terminal predicted by the libghostty-vt 1.0
  upgrade), and ~3.5 MiB of one-off package/runtime tables (xgbutil keybind maps,
  x/text language map, hpack, wazero data segments, regexp).

### 5.6 Follow-up applied: the session state poller was the top allocator

The run also showed where the remaining garbage comes from: **28 % of all 247 MiB
allocated in 4 h (69.6 MiB) was the session state poller** —
`session.statePoller` → `pty.GetSessionState` → `foregroundPgid` →
`os.ReadFile` + `strings.Fields`: four `/proc` reads per session every 2 s,
*including while nothing was attached*. That is why GC ran every ~2 min (0.2 ms
each, 37.5 ms total for the run).

Measured and fixed:

| | before | after |
|---|---|---|
| bytes allocated per `GetSessionState` | 5 278 | **826** |
| allocations per call | 25 | 17 |
| calls while detached | 1 800/h per session | **0** |
| steady garbage, 2 idle shells | ~19 MiB/h | **0** |
| steady garbage, 2 attached shells | ~19 MiB/h | ~1.2 MiB/h |

- `pkg/session`: the interval is 5 s instead of 2 s, `pollState` returns before
  touching `/proc` when no client is attached (nobody can observe the state), and
  `Attach` refreshes it once through a goroutine — so reattaching still gets a
  current cwd and foreground command, without reading `/proc` under the manager
  lock. `Manager.pollInterval` is a field so tests can drive it at 20 ms.
- `pkg/pty`: the `/proc` reads go through a `sync.Pool` of `bytes.Buffer`s
  (capped at 64 KiB per buffer, so a huge `cmdline` is not pinned), and the
  `tpgid` field is parsed by walking the bytes instead of `strings.Fields`, which
  had allocated more than the read itself.

Pinned by tests: `TestParseTpgid` (including a `comm` containing spaces and
parentheses), `TestGetSessionStateAllocations` (a ceiling on bytes allocated per
call, which is the property that mattered), and
`TestStatePollingSkipsDetachedSessions` (a sentinel state survives while
detached, and a reattach replaces it immediately).

Still open from §2 (latent, not observed here): a session whose client is revoked
by `broadcast` never arms its TTL, `Attach` can leave one clientless without a
timer, and a fired-timer race can leave `s.timer` non-nil. None fired on this
run — the two shells had simply been left open — but they are one slow client
away from pinning a shell forever.

### 5.7 Follow-up fixed: the notify socket could be stolen, and lost for good

`suwu open` started failing on the dev box with

```
notify: connect /home/yli/.suwu/suwu.sock: dial unix …: connect: no such file
or directory
hint: is the suwu server running?
```

while the server *was* running. On that box:

```
$ ls -l ~/.suwu/suwu.sock           → No such file or directory
$ pgrep -a suwu                     → 1556792 /home/yli/.local/bin/suwu serve
$ ss -xlp | grep suwu               → u_str LISTEN … /home/yli/.suwu/suwu.sock
                                      users:(("suwu",pid=1556792,fd=3))
```

The listener was alive; only the *name* was gone. Two bugs did that:

1. `notify.NewListener` ran `os.Remove(socketPath)` unconditionally before
   binding ("remove stale socket from an unclean shutdown"). It could not tell a
   stale file from a **live** one, so a dev `suwu serve` (air, on 8000/8001,
   while production kept 8181) unlinked the production socket and bound its own.
2. `Close()` removed the path by name — and so does `net.UnixListener` by
   default. When the dev instance stopped (air restarts on every change) the path
   was deleted again, this time outright, while production kept accepting on an
   inode that no longer had a name.

Nothing could repair that from outside: a socket inode cannot be given a name
back (the only handle is the path, and `connect` via `/proc/<pid>/fd/<n>` does
not work), and binding a new socket at the path would answer on a *different*
listener and silently swallow the CLI's messages. Hence: restart required, and
PTY sessions lost. Worth recording, because it is the kind of failure that looks
like "the server is down" when it is not.

Three fixes:

- **Probe before bind** (`prepareSocketPath`): an existing path is probed with a
  250 ms `connect`. A live listener means *refuse to start*, with an error that
  names the conflict and `SUWU_SOCK_PATH` as the way out; `ECONNREFUSED`/`ENOENT`
  means the previous server died, so the file is replaced. A non-socket at the
  path is never deleted.
- **Remove by identity** (`removeOwnSocket`): the listener stat'ed its own entry
  right after binding and deletes it on close only while `os.SameFile` still
  matches. `SetUnlinkOnClose(false)` turns off the library's remove-by-name.
- **Per-instance path** (`SocketPath`): `$SUWU_SOCK_PATH` (verbatim, absolute) →
  `<data dir>/suwu.sock` where the data dir is `$SUWU_VAR` or `~/.suwu` →
  `suwu-dev.sock` instead when `SUWU_DEV=true`. The installed service keeps
  `~/.suwu/suwu.sock` (its unit sets `SUWU_VAR`), and a dev server under air no
  longer shares it. Note `SocketPath` previously ignored `SUWU_VAR` entirely, so
  even separate data dirs collided.

Tests come in two layers.

`pkg/notify` (unit): a live socket is refused *and still answers afterwards*, a
stale file is replaced, closing an old listener leaves a replacement's socket
alone (both of these fail against the old code), a regular file is never
deleted, and the path resolution matrix.

`cmd/Suwu/serve_sock_test.go` (end to end, bounded): the real binary is built and
run in a temp `SUWU_VAR`/`HOME`/`SUWU_CONFIG_DIR` with `--env-file /dev/null`, so
nothing from the developer's shell or config leaks in. Every child goes through
`exec.CommandContext` with a deadline and every "must fail" case asserts it exits
*within* that deadline — a run that instead starts serving fails the test rather
than hanging it (which is exactly how the first hand-written version of this
check wedged a shell twice). It covers: a second instance on a live socket exits
non-zero with a message naming the conflict and `SUWU_SOCK_PATH`, and the running
server still answers `notify send`; `SUWU_DEV=true` gets `suwu-dev.sock` and both
instances answer their own socket; stopping one removes only its own file; and
the fatal-error path prints why it failed. Against the old `notify.go` the first
case fails after 22 s (the second instance bound over the first), which is the
regression this pins.

The CLI hint now mentions the `-dev` socket so "no such file" points at the right
instance.

One thing for operators: on Linux a *hard link* to a socket inode is allowed, so
taking `ln ~/.suwu/suwu.sock ~/.suwu/suwu.sock.bak` right after start makes the
socket repairable without a restart (`ln .bak .sock` restores the same listener).
That is a workaround, not a design: the probing bind above removes the need.

## 6. Classify descriptors by hand (kept for reference)

```sh
PID=$(pgrep -f "suwu serve" | head -1)
ls -l /proc/$PID/fd | awk -F' -> ' '/->/ {print $2}' \
  | sed -E 's/[0-9]+/N/g' | sort | uniq -c | sort -rn | head -20
```

What each answer means:

| If the top entry is | Then the leak is | Where to look |
|---|---|---|
| `socket:[N]` (unix) | one of four dial sites: notify (`~/.suwu/suwu.sock`), X11 (`/tmp/.X11-unix/X<n>` via `xgb`), a DB over a unix socket, or the SSH agent | `ss -xap \| grep "pid=$PID" \| head` prints the peer path — that names the subsystem |
| `socket:[N]` (UDP) | `pkg/forward` UDP mappings (`net.Dial("udp")` per client address) | `ss -uap \| grep "pid=$PID" \| head` |
| `socket:[N]` (TCP) | stale websockets behind the tunnel (§4.2), or CLOSE_WAIT | `ss -tanp \| grep $PID`, look for `CLOSE_WAIT`/`FIN_WAIT` |
| `pipe:[N]` | leaked child stdout/stderr | count / 2–3 ≈ leaked execs: `git` (`pkg/server/git*.go`, `git_compare.go`), ripgrep (`file_search.go`), `suwu gq` renders (`extension.go`), `xwd`/`ffmpeg` (`pkg/xdisplay`), `diff`/`chown` (`server.go`) |
| `/dev/pts/N`, `/dev/ptmx` | pty masters | contradicts the 2-shell count; unlikely |
| `anon_inode:[eventfd\|eventpoll\|timerfd]` | leaked pollers | one netpoll per leaked net.Conn |
| a path (`/tmp/suwu-ext-*`, `/home/…`) | leaked files | extension temp files, code editor, backups |

Then bisect empirically, one feature at a time, watching both counters — this
needs no rebuild and pinpoints the subsystem in minutes:

```sh
count() { echo "$(ls /proc/$PID/fd | wc -l) fds, $(awk '/VmRSS/{print $2" kB"}' /proc/$PID/status)"; }
count   # then: run a file search from the UI, re-run count
```

Do that for: file search (ripgrep), git graph/compare, an extension tile,
SFTP connect + a few transfers, a DB query, an X display stream, a port
forward. The feature whose fd count only ever goes up is the leak.

## 7. Snapshot the heap from a running server (hidden flags)

The binary now carries an opt-in introspection switch. It is **not** in
`suwu serve -h`; the flags are stripped before the flag package parses, so they
have to be known to be used (`cmd/Suwu/debug_flags.go`):

```sh
# loopback pprof on :6060 + a heap/goroutine/memstats snapshot every 2 h
suwu serve --pprof

# a different loopback port, a snapshot every 30 min, keep the last 6
suwu serve --pprof=127.0.0.1:6100 --heap-dump-interval=30m --heap-dump-keep=6
```

| Flag | Meaning |
|---|---|
| `--pprof[=ADDR]` | enable the pprof listener (`--pprof` uses `127.0.0.1:6060`); also enables snapshots |
| `--pprof-addr=ADDR` | set the address, implies `--pprof` |
| `--heap-dump-interval=2h` | snapshot period, minimum 1m |
| `--heap-dump-keep=12` | how many snapshots to retain (negative keeps all) |

What you get:

- `http://127.0.0.1:6060/debug/pprof/{heap,goroutine,allocs,block,mutex,threadcreate,profile,trace}`
  — the standard pprof endpoints, live.
- `$SUWU_VAR/debug/` (`~/.suwu/debug/`), one set every interval, `0600`:
  - `heap-<ts>.pprof` — gzipped protobuf heap profile (`inuse_space`);
  - `goroutine-<ts>.txt` — `debug=1` grouped stacks, i.e. "how many goroutines
    are parked where", which is how the 2244-handler leak would have been
    obvious at a glance;
  - `memstats-<ts>.json` — `runtime.MemStats` plus `numGoroutine` and
    heap-alloc/inuse/idle/sys in MiB.

The very first snapshot is written at startup, so a process that is already
bloated has a baseline before anyone uses it.

Analysing a snapshot (no running process needed):

```sh
go tool pprof -top -symbolize=none ~/.suwu/debug/heap-20261114T150113Z.pprof
go tool pprof -http 127.0.0.1:0 ~/.suwu/debug/heap-*.pprof    # flame graph, source view
grep -c "^[0-9]* @" ~/.suwu/debug/goroutine-*.txt             # distinct stacks
jq .heapAllocMiB ~/.suwu/debug/memstats-*.json                # trend, one per line
```

The listener refuses anything but a loopback address (`checkLoopback`), because a
heap profile names every type and stack in the process.

On the ARM box this answers the remaining question directly: if `inuse_space` is
~3.5 GiB, the profile names the type that holds it; if it is a few hundred MiB
while RSS is 3.7 GiB, the difference is heap Go cannot release and the fix is a
memory limit (or fewer live objects), not a leak hunt.

## 8. Getting more debug info from that box

### Tier 0 (done, see §4)

```sh
PID=$(pgrep -f "suwu serve" | head -1)

# 1. Is 3.7 G the current heap or a peak it never gave back?
grep -E 'VmRSS|VmHWM|RssAnon|Threads' /proc/$PID/status
cat /proc/$PID/smaps_rollup

# 2. How many sessions are alive? One shell child and one ptmx fd each.
ps --ppid $PID -o pid=,etime=,cmd= | wc -l
ps --ppid $PID -o pid=,etime=,cmd= | head -20        # idle bash prompts = orphans
ls /proc/$PID/fd | wc -l                             # ≈ sessions + ~10

# 3. How many are actually attached? (sessions ≫ websockets = the leak)
ss -tnp 2>/dev/null | grep -c "pid=$PID"
```

Reading it:

- **~330 child shells, ~340 fds, ~2 websockets** → this document's §2: orphaned
  sessions. Confirmed without touching the process.
- **Few shells, 3.7 G** → not sessions; then it is a retained-arena story and
  `VmHWM` will show a peak followed by a plateau. Look for the workload that ran
  before the plateau (a 2 GiB SFTP upload, a backup, a big `git` diff).

Do **not** `kill -QUIT` the process to count goroutines: Go dumps and then exits.
`dlv attach` (symbols are in the release binary? `-s -w` strips them — so no) or
`gcore` (a 3.7 GiB core) are the only ways, and neither is worth it when
`ps --ppid` already counts sessions.

### Tier 1 — a diagnostics build (**implemented**, see §7)

Ordered by value per line of code:

1. ✅ **pprof listener** (loopback-only, hidden flag) — `heap` (inuse_space),
   `goroutine`, `allocs`. A 5-second heap profile attributes the 3.4 GiB
   immediately (wazero instances vs buffers vs a leaked slice), and
   `goroutine?debug=1` counts parked handlers directly.
2. `SIGUSR1` → the same three files on demand. Still worth adding: the timer
   only covers the cases where nobody is watching at the right moment, and it
   works when the HTTP surface is unreachable.
3. ✅ **Periodic snapshots** (`--heap-dump-interval`, default 2 h): heap profile,
   grouped goroutine dump and `MemStats` JSON under `$SUWU_VAR/debug/`, pruned to
   `--heap-dump-keep` (default 12). The first one is written at startup.
4. **Session lifecycle counters** (created / expired / finished / revoked /
   `len(sessions)` gauge) — a session revoked by `broadcast` should be logged at
   **Warn**, not `Debug`: it is a client being dropped, and today it is invisible.
5. **`GOMEMLIMIT` awareness**: Go honours the env var already, so
   `GOMEMLIMIT=1GiB` is a containment lever (GC works harder instead of growing);
   `GODEBUG=madvdontneed=1` makes freed memory return to the OS promptly instead of
   lingering in RSS. Both are worth documenting in the service unit.

### Tier 2 — containment while the fix is pending

```sh
SESSION_TTL=10m          # stop the healthy 24 h tail from accumulating
GOMEMLIMIT=1GiB          # keep the heap honest; GC gets aggressive instead of ballooning
GODEBUG=madvdontneed=1   # return freed pages eagerly, so RSS tracks live heap
SUWU_LOG_LEVEL=info      # keep session lifecycle lines (they are Debug today; see §2)
```

Restart, then watch `ps --ppid $PID | wc -l` and `VmRSS` daily. If RSS climbs
~11 MiB per extra child shell, §2 is confirmed and the fix is in `pkg/session`
(arm the TTL wherever a client is revoked; make `expire` re-arm or delete rather
than leave a fired timer; consider a hard ceiling on `len(sessions)` and a
per-session idle timeout independent of attachment).

## 9. What the upgrade already changes

The unreleased `pkg/vt` work (see `docs/LIBGHOSTTY_VT_1_0_UPGRADE_PLAN.md`)
replaces the binding that costs 11 MiB per terminal with the official
libghostty-vt 1.0.0 module, measured at **~1.2–1.4 MiB per terminal** — an 8×
reduction in the per-session price. It does not fix the accumulation: 330
orphaned sessions would still be ~400 MiB instead of 3.4 GiB, and the shells,
goroutines and fds would still be there. Both changes are needed; they are
independent.
