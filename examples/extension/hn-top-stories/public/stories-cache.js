/**
 * The in-memory edition: at most MAX stories — fresh front-page entries
 * first, still-present older entries after them, and the oldest kept entries
 * retired when the cache overflows.
 *
 * Public file: never put secrets here (docs/EXTENSION_API_PLAN.md §2.8).
 */

export const MAX = 30;

let items = [];
let rev = 0;

/** Merge a fresh front page; returns true when the edition changed. */
export function merge(fresh) {
  const seen = new Set();
  const merged = [];
  for (const s of fresh) {
    if (s && s.id && !seen.has(s.id)) {
      seen.add(s.id);
      merged.push(s);
    }
  }
  for (const s of items) {
    if (merged.length >= MAX) break;
    if (!seen.has(s.id)) {
      seen.add(s.id);
      merged.push(s);
    }
  }
  const next = merged.slice(0, MAX);
  const changed = next.length !== items.length || next.some((s, i) => s !== items[i]);
  items = next;
  if (changed) rev++;
  return changed;
}

export function entries() {
  return items;
}

/** Bumped whenever merge() changes the edition; the carousel re-renders on it. */
export function revision() {
  return rev;
}

/** HTML-escape anything interpolated into markup. */
export function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

/** Only http(s) may reach an href; anything else falls back to HN. */
export function safeURL(u, fallback) {
  return /^https?:\/\//i.test(String(u || "")) ? u : fallback;
}

/** Relative age for the byline, computed against the client clock. */
export function ago(iso) {
  if (!iso) return "";
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (isNaN(secs) || secs < 0) return "";
  const units = [
    [31536000, "year"],
    [2592000, "month"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [unit, name] of units) {
    if (secs >= unit) {
      const n = Math.floor(secs / unit);
      return n + " " + name + (n === 1 ? "" : "s") + " ago";
    }
  }
  return "moments ago";
}
