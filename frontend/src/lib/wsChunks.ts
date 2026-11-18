/**
 * WebSocket input chunking for the terminal pane.
 *
 * xterm emits one `onData` event per paste, so a pasted log file lands in a
 * single WebSocket frame. The server used to refuse anything past its 32 KiB
 * read limit by closing the connection with `StatusMessageTooBig`: the browser
 * then reattached and the paste was gone. The server's limit is larger now
 * (`maxInputFrame` in pkg/server/websocket.go), but chunking here is the other
 * half of the contract:
 *
 *   - it keeps every frame small, so an older server (or a proxy with its own
 *     frame ceiling) does not have to buffer megabytes;
 *   - the server writes each frame to the PTY under its session lock, so smaller
 *     frames let other panes interleave instead of waiting behind one 92 KB
 *     write;
 *   - a big paste no longer depends on one oversized frame surviving the wire.
 *
 * Splitting happens on **code-point boundaries**: a JS string is UTF-16, and a
 * surrogate pair (an emoji, or the CJK from a log file) split across two frames
 * would be encoded as two invalid halves.
 *
 * Pure module (no DOM, no WebSocket) so `scripts/check-ws-chunks.mjs` can
 * exercise it under Node type stripping.
 */

/** Largest input frame the client sends. Kept well under the 32 KiB a server used to assume. */
export const INPUT_CHUNK = 16 * 1024;

/**
 * Split `data` into frames of at most `size` UTF-16 code units without breaking
 * a surrogate pair. Chunks concatenate back to the original string exactly.
 */
export function chunkInput(data: string, size: number = INPUT_CHUNK): string[] {
  if (data === '') return [];
  const limit = Math.max(2, Math.floor(size));
  if (data.length <= limit) return [data];

  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + limit, data.length);
    if (end < data.length) {
      // Never end a chunk on a high surrogate: the low half belongs to it.
      const code = data.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      // A limit of 2 could land exactly on the pair start; take the pair whole
      // rather than emit an empty chunk forever.
      if (end === start) end = Math.min(start + 2, data.length);
    }
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}
