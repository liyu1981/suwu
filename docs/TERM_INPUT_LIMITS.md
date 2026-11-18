# Terminal input frame limits

Status: **fixed** (2026-11-18).
Owner area: `pkg/server/websocket.go`, `frontend/src/lib/wsChunks.ts`,
`frontend/src/components/hooks/usePtySession.ts`.

## The bug

Pasting a 92,535-byte log into a terminal pane dropped the connection: the
browser reported it lost, reattached to the same shell, and the paste was gone.

A paste reaches xterm as a **single `onData` event**, so the pane sent the whole
payload as one WebSocket frame:

```ts
const onData = term.onData((data) => { …; ws.send(data); });
```

`github.com/coder/websocket` refuses a frame larger than its **32 KiB default
read limit** (`defaultReadLimit = 32768`) by closing the connection:

```
received close frame: status = StatusMessageTooBig and reason = "read limited at 32769 bytes"
```

`handleWS` then returns, the session detaches, the browser reconnects after its
back-off and replays the snapshot — exactly the reported symptom. It was never
app-specific: any paste above ~32 KiB did it, whether it went to a shell or to a
TUI like herdr.

## The second cause, found while testing the first

Raising the frame limit was not enough: with the frame accepted, a large paste
could **wedge the whole session** instead of closing it, and the browser then
reconnected because its keepalive pings stopped being answered.

`Client.Write` wrote to the PTY inline **while holding the manager lock**:

```go
m.mu.Lock()
defer m.mu.Unlock()
…
_, _ = c.s.pty.Write(data)   // blocks when the tty input buffer is full
```

A PTY write blocks once the tty's input buffer (64 KiB) is full, which is exactly
what happens when the application is writing output instead of reading its input
— a TUI redrawing a paste. Draining that output needs the same `m.mu`
(`readLoop` → `broadcast`), so the application never gets back to reading and the
write never returns. Because the lock is manager-wide, every other session froze
with it.

## A third limit, on the way back

Fixing the two above exposed why a big paste can *also* drop the connection when
the app echoes it: an interactive shell answers a 40 KB line with **megabytes of
readline redraw**. The server queues PTY output per attachment (`subBuffer = 256`
frames of up to 32 KiB) and, by design, drops a client that falls ~8 MiB behind
so the shell keeps running; the browser then reattaches. That is a deliberate
policy, not a bug — but it used to be invisible, so it now logs:

```
WARN session client dropped key=… attachment=1 reason="slow client" queued=256 cap=256
```

Every revoke carries a reason (`slow client`, `new attachment`, `detached`,
`shell exited`, `shutdown`) and abnormal WebSocket ends log at Warn. A paste into
a TUI that does not echo (herdr) stays far below that budget; the input frame was
the problem there.

## The fix, on both sides

- `pkg/server/websocket.go`: the terminal socket now calls `SetReadLimit`
  (`maxInputFrame = 4 MiB`) instead of accepting the library default. That is the
  ceiling on what one attachment may ask the server to buffer.
- `frontend/src/lib/wsChunks.ts`: input is sent in frames of at most
  `INPUT_CHUNK` (16 KiB), *on both paths* — `term.onData` and the raw sender used
  by snippets and key chords. Chunking never splits a surrogate pair: a JS string
  is UTF-16, and cutting an emoji or a CJK pair across frames would arrive as two
  invalid halves. `scripts/check-ws-chunks.mjs` asserts the round trip, the frame
  ceiling and well-formedness, using the failing 92 KB payload as its fixture.

Chunking is not only about the limit: while the server still wrote inline under
the manager lock, small frames reduced but did not remove the deadlock window.

- `pkg/session`: input no longer reaches the PTY from the WebSocket goroutine.
  Each session has a small queue (`inputQueue = 32` frames) and one writer
  goroutine (`writeLoop`) that holds no lock while writing. Order is preserved
  because there is a single queue and a single writer; a full queue blocks the
  WebSocket read loop instead of dropping bytes, which is the backpressure we
  want; the payload is copied because the read buffer is reused. The attachment
  check still happens under the lock, before the copy.

## What still bounds input

| Bound | Value | Consequence past it |
|---|---|---|
| `maxInputFrame` | 4 MiB | the frame is refused (1009) and the connection closes |
| client `INPUT_CHUNK` | 16 KiB | nothing — frames are just smaller |
| `inputQueue` | 32 frames | the writer — and behind it the WebSocket read loop — waits; no bytes are dropped |
| PTY write | blocking | a slow app applies backpressure; the writer waits without holding a lock |

Output is a separate path (`subBuffer = 256` frames of up to 32 KiB); a client
that falls ~8 MiB behind is dropped and left to reattach, which is deliberate.

## Tests

- `pkg/server/large_paste_test.go`: sends a 96 KiB paste in one frame followed by
  a marker command, and requires the echo — it fails with
  `StatusMessageTooBig` against the old limit.
- `pkg/session` `TestLargeInputWhileAppFloodsOutput`: starts an app that floods
  the PTY and does not read input, then sends 200 KB of input, an interrupt and a
  marker. Against the inline write it hangs in `Client.Write` (the deadlock);
  with the writer goroutine the marker comes back in ~2 s.

The server test runs the shell with `stty -echo`: without that, bash answers the
40 KB line with a redraw storm that fills the *output* queue and the case fails
for an unrelated reason — which is how the third limit above was found.
- `frontend/scripts/check-ws-chunks.mjs` (in `pnpm check`): reassembly, frame
  size, surrogate-pair safety, degenerate chunk sizes.
