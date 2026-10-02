/**
 * Backup — collecting the local data.
 *
 * Reads the categories the user selected into a flat item list: one entry per
 * backed-up `localStorage` key, plus one per extension record in IndexedDB.
 * Extension data is read here (the shell document is same-origin and owns the
 * store); a pane's ExtensionPage only signals that something changed.
 *
 * Two caps apply: the per-item cap inherited from the ext-store bridge
 * (512 KB) and a total plaintext cap. When the total is exceeded the *largest*
 * items are dropped and reported by name, so the status line can say what did
 * not fit rather than truncating silently.
 *
 * ## Why mtimes are tracked here
 *
 * `localStorage` records no modification time, and merge decisions need one
 * (§apply.ts), while the change-detection dedup needs the payload to be
 * byte-identical when nothing changed (§client.ts). Stamping `Date.now()` on
 * every run would satisfy neither. So the collector keeps a shadow map
 * (`suwu:backup-mtimes`) of `path -> {mtime, fingerprint}`: a value whose
 * fingerprint is unchanged keeps its old mtime, and a value that actually
 * changed is stamped now. That map is backup bookkeeping and is itself never
 * backed up (see DENY in registry.ts).
 */

import { extStoreKeysAsync, extStoreGetAsync } from '../extStore.ts';
import { categoryForKey, EXT_KEY_PREFIX } from './registry.ts';
import type { Category, Item } from './types.ts';
import { canonicalJSON } from './container.ts';

/** Per-item cap, matching the ext-store bridge (docs §4.8). */
export const ITEM_MAX = 512_000;
/** Whole-plaintext cap before the largest items start being dropped. */
export const TOTAL_MAX = 8 * 1024 * 1024;

/** localStorage key holding the mtime/fingerprint shadow map. Never backed up. */
export const MTIME_KEY = 'suwu:backup-mtimes';

/** What a collection run produced, including anything it had to leave out. */
export interface Collected {
  items: Item[];
  /** Paths dropped for exceeding ITEM_MAX. */
  droppedOversize: string[];
  /** Paths dropped to fit TOTAL_MAX (largest first). */
  droppedForTotal: string[];
  /** How many items carry each category. */
  counts: Record<Category, number>;
}

/**
 * FNV-1a over the canonical JSON. Not cryptographic: a collision here would at
 * worst keep an old mtime for a changed value, and the value itself is what
 * gets restored. Cheap, stable, and small enough to store for every key.
 */
function fingerprint(value: unknown): string {
  const text = canonicalJSON(value ?? null);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Approximate serialized size of an item's value. */
function valueSize(value: unknown): number {
  try {
    return canonicalJSON(value ?? null).length;
  } catch {
    return 0;
  }
}

interface Stamp {
  mtime: number;
  fingerprint: string;
}

function readStamps(): Record<string, Stamp> {
  try {
    const raw = localStorage.getItem(MTIME_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, Stamp>;
  } catch {
    return {};
  }
}

/**
 * Assigns each item an mtime: the remembered one when the value is unchanged,
 * now when it changed, and "now" for anything seen for the first time.
 * Returns the stamps to persist and the live paths (for pruning).
 */
function stampItems(items: Item[], stamps: Record<string, Stamp>, now: number): Map<string, Stamp> {
  const next = new Map<string, Stamp>();
  for (const item of items) {
    const key = `${item.ns}|${item.path}`;
    const print = fingerprint(item.value);
    const prev = stamps[key];
    item.mtime = prev && prev.fingerprint === print ? prev.mtime : now;
    next.set(key, { mtime: item.mtime, fingerprint: print });
  }
  return next;
}

function persistStamps(next: Map<string, Stamp>): void {
  try {
    localStorage.setItem(MTIME_KEY, JSON.stringify(Object.fromEntries(next)));
  } catch {
    // Quota or private mode: mtimes fall back to "now" next run. Harmless.
  }
}

/** Reads every backed-up localStorage key for the selected categories. */
function collectLocalStorage(categories: Set<Category>): Item[] {
  const items: Item[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const category = categoryForKey(key);
      if (!category || !categories.has(category)) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        // A non-JSON value is stored as text; back it up verbatim.
        value = raw;
      }
      items.push({ ns: 'ls', path: key, mtime: 0, value });
    }
  } catch {
    // localStorage can throw in private modes; an empty snapshot is fine.
  }
  return items;
}

/**
 * Reads every extension record currently in IndexedDB. Each record key looks
 * like `suwu:ext/<id>/<key>`; the payload path becomes `<id>/<key>`.
 */
async function collectExtensionData(): Promise<{ items: Item[]; dropped: string[] }> {
  const items: Item[] = [];
  const dropped: string[] = [];
  let keys: string[];
  try {
    keys = await extStoreKeysAsync();
  } catch {
    // No store (private mode, or nothing ever wrote): nothing to back up.
    return { items, dropped };
  }
  for (const fullKey of keys) {
    if (!fullKey.startsWith(EXT_KEY_PREFIX)) continue;
    const rel = fullKey.slice(EXT_KEY_PREFIX.length); // `<id>/<key>`
    if (!rel.includes('/')) continue;
    let value: unknown;
    try {
      value = await extStoreGetAsync(fullKey);
    } catch {
      continue;
    }
    if (value === undefined) continue;
    if (valueSize(value) > ITEM_MAX) {
      dropped.push(rel);
      continue;
    }
    items.push({ ns: 'ext', path: rel, mtime: 0, value });
  }
  return { items, dropped };
}

/**
 * Builds the item list for the selected categories, applying the size caps and
 * the mtime shadow map. Side effect: refreshes `suwu:backup-mtimes`.
 */
export async function collect(categories: Category[]): Promise<Collected> {
  const set = new Set(categories);
  const items: Item[] = [];
  const droppedOversize: string[] = [];

  if (set.has('settings') || set.has('layout')) {
    for (const item of collectLocalStorage(set)) {
      if (valueSize(item.value) > ITEM_MAX) {
        droppedOversize.push(item.path);
        continue;
      }
      items.push(item);
    }
  }
  if (set.has('ext')) {
    const ext = await collectExtensionData();
    items.push(...ext.items);
    droppedOversize.push(...ext.dropped);
  }

  const stamps = stampItems(items, readStamps(), Date.now());
  persistStamps(stamps);

  // Enforce the whole-plaintext cap by dropping the largest items first, so the
  // settings that matter (small) always survive and a giant note does not
  // crowd them out.
  const droppedForTotal: string[] = [];
  let total = items.reduce((sum, item) => sum + valueSize(item.value), 0);
  if (total > TOTAL_MAX) {
    const bySize = [...items].sort((a, b) => valueSize(b.value) - valueSize(a.value));
    const drop = new Set<string>();
    for (const item of bySize) {
      if (total <= TOTAL_MAX) break;
      const key = `${item.ns}|${item.path}`;
      drop.add(key);
      total -= valueSize(item.value);
      droppedForTotal.push(item.path);
      stamps.delete(key);
    }
    for (let i = items.length - 1; i >= 0; i--) {
      if (drop.has(`${items[i].ns}|${items[i].path}`)) items.splice(i, 1);
    }
    persistStamps(stamps);
  }

  const counts: Record<Category, number> = { settings: 0, ext: 0, layout: 0 };
  for (const item of items) {
    if (item.ns === 'ext') counts.ext++;
    else counts[categoryForKey(item.path) ?? 'settings']++;
  }

  return { items, droppedOversize, droppedForTotal, counts };
}
