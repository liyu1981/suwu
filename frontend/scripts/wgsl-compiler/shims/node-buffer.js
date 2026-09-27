// `node:buffer` shim: only `isUtf8` is imported, and only on the unreachable
// filesystem read path (shader-graph-files). Assume valid UTF-8.

export function isUtf8() {
  return true;
}
