/**
 * SHA-256 of a downloaded buffer, used only by the first-run probe: a fresh
 * job over an already-mirrored folder hashes equal-sized files once so it does
 * not re-download the world. After that `.suwu-sync.json` carries the state
 * and hashing stops entirely.
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
