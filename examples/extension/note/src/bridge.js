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
  let seq = 0;
  const pending = Object.create(null);

  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const d = e.data;
    if (!d || d.type !== "ext-store-result" || typeof d.rid !== "number") return;
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
      const rid = ++seq;
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
