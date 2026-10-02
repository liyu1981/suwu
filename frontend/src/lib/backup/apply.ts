/**
 * Backup — applying a restored payload.
 *
 * Restores are one of two kinds, and the destructive one is opt-in:
 *
 *   merge   (default) — per item, the newer `mtime` wins; nothing is ever
 *                       deleted. The safe default: a restore can add or update,
 *                       never quietly remove something the user has here.
 *   replace           — the backup is the truth. A local key that the backup
 *                       does not carry is removed, so the device ends up
 *                       exactly as the backup left it.
 *
 * Items are applied in a fixed order — extension data first, then settings,
 * then layout — so a restored note is on disk before anything that might read
 * it, and layout lands last because it references everything else.
 */

import { extStoreDelete, extStoreWrite } from '../extStore.ts';
import { categoryForKey } from './registry.ts';
import { canonicalJSON } from './container.ts';
import { MTIME_KEY } from './collect.ts';
import type { Category, Item, Payload } from './types.ts';

export type RestoreMode = 'merge' | 'replace';

/** What a restore did, for the summary the UI shows afterwards. */
export interface ApplyReport {
  /** Items written to this device. */
  applied: number;
  /** Items skipped because the local copy was newer (merge only). */
  skippedLocalNewer: number;
  /** Items removed because the backup did not carry them (replace only). */
  removed: number;
  /** Paths removed, for the summary line. */
  removedPaths: string[];
  /** Extensions whose records were written. */
  extensionsTouched: string[];
  /** Keys the backup carried but this build does not recognise. */
  unknownPaths: string[];
  errors: string[];
}

function writeLocal(path: string, value: unknown): void {
  localStorage.setItem(path, JSON.stringify(value));
}

/** Reads the current mtime for an item, using the collector's shadow map. */
function localMtime(ns: 'ls' | 'ext', path: string): number | null {
  // The shadow map is maintained by collect.ts; the backup module reads it so
  // a merge can tell which side is newer without re-scanning everything.
  try {
    const raw = localStorage.getItem(MTIME_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, { mtime?: number }>;
    const stamp = map[`${ns}|${path}`];
    return typeof stamp?.mtime === 'number' ? stamp.mtime : null;
  } catch {
    return null;
  }
}

/** Validates an item's shape and namespace agreement with the registry. */
function validateItem(item: Item): boolean {
  if (!item || (item.ns !== 'ls' && item.ns !== 'ext')) return false;
  if (typeof item.path !== 'string' || item.path.length === 0) return false;
  if (typeof item.mtime !== 'number') return false;
  if (item.ns === 'ls') {
    // Only keys the registry still backs up are accepted. A backup taken on a
    // newer build may carry keys this build has dropped; those are reported,
    // never written blind.
    return categoryForKey(item.path) !== null;
  }
  // ext: `<id>/<key>`
  const slash = item.path.indexOf('/');
  return slash > 0 && slash < item.path.length - 1;
}

/**
 * Applies a validated payload's items to this device.
 *
 * `currentItems` is the freshly-collected local snapshot used for the merge
 * comparison and for the replace-mode removal set. Passing it in avoids a
 * second scan and guarantees both sides were read at the same moment.
 */
export async function apply(
  payload: Payload,
  mode: RestoreMode,
  currentItems: Item[],
): Promise<ApplyReport> {
  const report: ApplyReport = {
    applied: 0,
    skippedLocalNewer: 0,
    removed: 0,
    removedPaths: [],
    extensionsTouched: [],
    unknownPaths: [],
    errors: [],
  };

  const valid: Item[] = [];
  for (const item of payload.items ?? []) {
    if (validateItem(item)) {
      valid.push(item);
    } else {
      report.unknownPaths.push(`${item?.ns ?? '?'}:${item?.path ?? '?'}`);
    }
  }

  // A map of what this device currently holds, for the comparison.
  const local = new Map<string, Item>();
  for (const item of currentItems) local.set(`${item.ns}|${item.path}`, item);

  // Apply extension data first (it may be referenced by other state), then
  // settings, then layout (which references everything).
  const order: Array<['ext' | 'ls', Category]> = [
    ['ext', 'ext'],
    ['ls', 'settings'],
    ['ls', 'layout'],
  ];
  const extensionsTouched = new Set<string>();

  for (const [ns, category] of order) {
    for (const item of valid) {
      if (item.ns !== ns) continue;
      if (ns === 'ls' && categoryForKey(item.path) !== category) continue;

      if (mode === 'merge') {
        const localItem = local.get(`${item.ns}|${item.path}`);
        const thisTime = localItem ? (localMtime(item.ns, item.path) ?? localItem.mtime) : null;
        // If this device's copy is strictly newer, keep it.
        if (thisTime !== null && thisTime > item.mtime) {
          report.skippedLocalNewer++;
          continue;
        }
      }

      try {
        if (item.ns === 'ext') {
          const slash = item.path.indexOf('/');
          const extId = item.path.slice(0, slash);
          const key = item.path.slice(slash + 1);
          await extStoreWrite(extId, key, item.value);
          extensionsTouched.add(extId);
        } else {
          writeLocal(item.path, item.value);
        }
        report.applied++;
      } catch (error) {
        report.errors.push(
          `${item.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  report.extensionsTouched = [...extensionsTouched];

  if (mode === 'replace') {
    // Remove anything local that the backup did not carry, so the device
    // mirrors the backup exactly.
    const incoming = new Set(valid.map((item) => `${item.ns}|${item.path}`));
    for (const item of currentItems) {
      const key = `${item.ns}|${item.path}`;
      if (incoming.has(key)) continue;
      try {
        if (item.ns === 'ext') {
          const slash = item.path.indexOf('/');
          const extId = item.path.slice(0, slash);
          const extKey = item.path.slice(slash + 1);
          await extStoreDelete(extId, extKey);
          extensionsTouched.add(extId);
        } else {
          localStorage.removeItem(item.path);
        }
        report.removed++;
        report.removedPaths.push(item.path);
      } catch (error) {
        report.errors.push(
          `${item.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return report;
}

/**
 * Computes a human-readable summary of what a restore would change, without
 * applying it. Drives the confirm step before anything is written.
 */
/** A restore summary: counts and the extensions involved. */
export interface RestorePreview {
  settings: number;
  extensions: string[];
  layout: number;
  changed: number;
  localOnly: number;
}

/** What a restore would change, without writing anything. */
export function preview(payload: Payload, currentItems: Item[], mode: RestoreMode): RestorePreview {
  const local = new Map<string, Item>();
  for (const item of currentItems) local.set(`${item.ns}|${item.path}`, item);

  const valid = (payload.items ?? []).filter(validateItem);
  const incoming = new Set(valid.map((item) => `${item.ns}|${item.path}`));

  let settings = 0;
  let layout = 0;
  let changed = 0;
  const extensions = new Set<string>();
  for (const item of valid) {
    if (item.ns === 'ext') {
      extensions.add(item.path.slice(0, item.path.indexOf('/')));
      changed++;
      continue;
    }
    const category = categoryForKey(item.path);
    if (category === 'layout') layout++;
    else settings++;
    const existing = local.get(`${item.ns}|${item.path}`);
    if (!existing || canonicalJSON(existing.value) !== canonicalJSON(item.value)) changed++;
  }

  const localOnly =
    mode === 'replace'
      ? currentItems.filter((item) => !incoming.has(`${item.ns}|${item.path}`)).length
      : 0;

  return { settings, extensions: [...extensions], layout, changed, localOnly };
}
