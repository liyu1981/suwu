/**
 * Note — the postMessage storage bridge to the trusted parent frame.
 *
 * The extension document runs in a sandboxed iframe with an opaque origin,
 * where every web storage API throws SecurityError. So reads and writes go up
 * to the parent (ExtensionPage.tsx), which keeps them in its own IndexedDB
 * under `suwu:ext/note/<key>` (docs/EXTENSION_TILE_PLAN.md §4.8).
 *
 * Public file: never put secrets here (docs/EXTENSION_API_PLAN.md §2.8).
 */

/** The parent always answers within this; a slow parent degrades to memory. */
const REPLY_TIMEOUT = 3000;

/** Returned by `get` when the server has no record under that key yet. */
export const MISSING = Symbol("missing");

/**
 * Request ids are unique across every bridge in the document, not per bridge.
 *
 * A page runs two of them — the local store and the server store — and each
 * listens for `ext-store-result` on the same window. With a per-bridge counter
 * both would start at 1, and a reply for one scope could resolve the other's
 * request: the server read then "returned" the cloud preference object, the
 * document failed to validate, and the note came up blank. One counter, and a
 * reply is only accepted for the scope that asked.
 */
let nextRid = 0;

function namedError(name) {
  const err = new Error(name);
  err.name = name;
  return err;
}

/**
 * @param {Window} parent the trusted parent frame
 * @param {{ scope?: "local" | "server" }} [opts] which record set to read and
 *   write: this browser's IndexedDB (default) or the server's copy
 * @returns {{ get(key): Promise<any>, set(key, value): Promise<void> }}
 */
export function createBridge(parent, opts = {}) {
  const scope = opts.scope === "server" ? "server" : "local";
  const pending = Object.create(null);

  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const d = e.data;
    if (!d || d.type !== "ext-store-result" || typeof d.rid !== "number") return;
    // A host that echoes the scope lets us ignore the other bridge's traffic.
    // The shared counter already prevents the collision; this keeps a stale or
    // hand-written reply from landing in the wrong store.
    if (typeof d.scope === "string" && d.scope !== scope) return;
    const entry = pending[d.rid];
    if (!entry) return;
    delete pending[d.rid];
    clearTimeout(entry.timer);
    if (!d.ok) {
      entry.reject(namedError(typeof d.error === "string" && d.error ? d.error : "StoreFailed"));
      return;
    }
    // `missing` is the server saying "no record under this key yet" — different
    // from an empty value, and what makes a first upload possible.
    entry.resolve(d.missing ? MISSING : d.value);
  });

  function call(op, key, value) {
    return new Promise((resolve, reject) => {
      if (parent === window) {
        // Opened outside the tile page: there is no bridge. Memory only.
        reject(namedError("NoParent"));
        return;
      }
      const rid = ++nextRid;
      const timer = setTimeout(() => {
        delete pending[rid];
        reject(namedError("Timeout"));
      }, REPLY_TIMEOUT);
      pending[rid] = { resolve, reject, timer };
      const msg = { type: "ext-store", op, key, rid, scope };
      if (op === "set") msg.value = value;
      try {
        parent.postMessage(msg, "*");
      } catch (err) {
        clearTimeout(timer);
        delete pending[rid];
        reject(err);
      }
    });
  }

  return {
    get(key) {
      return call("get", key);
    },
    set(key, value) {
      return call("set", key, value);
    },
  };
}
