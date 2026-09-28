/**
 * Pre-flight diff: remote manifest + local manifest + `.suwu-sync.json` → the
 * ordered plan the sync phase executes.
 *
 * Remote is the source of truth (one-way mirror), so "content differs" always
 * means "pull". The journal is what keeps that from happening every cycle: the
 * local copy's `lastModified` can never equal the server's, so the only way to
 * tell "already mirrored" from "user edited it" is what we recorded last time.
 */

import {
  isMetaName,
  MAX_SYNC_FILE_BYTES,
  type FileMetaEntry,
  type ManifestMap,
  type Plan,
  type PlanAction,
  type PullReason,
  type SkippedEntry,
  type SyncMeta,
} from './types.ts';

/** SHA-256 of both sides of one file — used only by the first-run probe. */
export type HashProbe = (rel: string) => Promise<{ local: string; remote: string }>;

function depthOf(rel: string): number {
  return rel.split('/').length;
}

export async function buildPlan(
  remote: ManifestMap,
  local: ManifestMap,
  meta: SyncMeta,
  removeExtra: boolean,
  probe: HashProbe,
): Promise<Plan> {
  const obstacles: PlanAction[] = [];
  const mkdirs: PlanAction[] = [];
  const pulls: PlanAction[] = [];
  const deletes: PlanAction[] = [];
  const rmdirs: PlanAction[] = [];
  const skipped: SkippedEntry[] = [];
  const seeds: Record<string, FileMetaEntry> = {};
  let checked = 0;
  let extrasIgnored = 0;

  const queuePull = (rel: string, size: number, mtimeMs: number, reason: PullReason) => {
    if (size > MAX_SYNC_FILE_BYTES) {
      skipped.push({ rel, reason: 'too-large' });
      return;
    }
    pulls.push({ kind: 'pull', rel, size, mtimeMs, reason });
  };

  // Every directory the server still holds content in. A directory that is
  // local-only is only removable when nothing on the server lives under it —
  // with a consistent manifest that is implied, but never delete on trust.
  const serverDirs = new Set<string>();
  for (const rel of remote.keys()) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      serverDirs.add(parts.slice(0, i).join('/'));
    }
  }

  for (const rel of new Set([...remote.keys(), ...local.keys()])) {
    // The journal file is invisible to the algorithm on both sides.
    if (isMetaName(rel)) continue;
    checked += 1;

    const r = remote.get(rel);
    const l = local.get(rel);

    // Type mismatch (server has a dir, we have a file, or the reverse):
    // clear the way, then mirror the server's shape.
    if (r && l && r.isDir !== l.isDir) {
      obstacles.push({ kind: 'remove-obstacle', rel, isDir: l.isDir });
      if (r.isDir) {
        mkdirs.push({ kind: 'mkdir-local', rel });
      } else {
        queuePull(rel, r.size, r.mtimeMs, 'remote-changed');
      }
      continue;
    }

    // Server only.
    if (r && !l) {
      if (r.isDir) mkdirs.push({ kind: 'mkdir-local', rel });
      else queuePull(rel, r.size, r.mtimeMs, 'new');
      continue;
    }

    // Local only — a local extra. Removed only when the job asks for a mirror.
    if (!r && l) {
      if (!removeExtra) {
        extrasIgnored += 1;
        continue;
      }
      if (l.isDir) {
        if (!serverDirs.has(rel)) rmdirs.push({ kind: 'rmdir-local', rel });
      } else {
        deletes.push({ kind: 'delete-local', rel });
      }
      continue;
    }

    if (!r || !l) continue;

    // Both, both directories: nothing to do.
    if (r.isDir) continue;

    const entry = meta.files[rel];

    // Journal hit — the cheap, common path.
    if (entry && entry.size === r.size && entry.remoteMtimeMs === r.mtimeMs) {
      if (l.size === entry.size && l.mtimeMs === entry.localMtimeMs) continue; // already mirrored
      queuePull(rel, r.size, r.mtimeMs, 'local-diverged'); // local edited → server wins
      continue;
    }
    if (entry && l.size === entry.size && l.mtimeMs === entry.localMtimeMs) {
      queuePull(rel, r.size, r.mtimeMs, 'remote-changed');
      continue;
    }

    // No journal entry, or both sides moved since the last cycle.
    if (l.size === r.size && l.mtimeMs === r.mtimeMs) {
      seeds[rel] = { size: r.size, remoteMtimeMs: r.mtimeMs, localMtimeMs: l.mtimeMs };
      continue; // byte-for-byte the same shape — nothing to transfer
    }
    if (!entry && l.size === r.size && l.size <= MAX_SYNC_FILE_BYTES) {
      const { local: localHash, remote: remoteHash } = await probe(rel);
      if (localHash === remoteHash) {
        seeds[rel] = { size: r.size, remoteMtimeMs: r.mtimeMs, localMtimeMs: l.mtimeMs };
        continue;
      }
      queuePull(rel, r.size, r.mtimeMs, 'first-run');
      continue;
    }
    queuePull(rel, r.size, r.mtimeMs, entry ? 'remote-changed' : 'first-run');
  }

  mkdirs.sort((a, b) => depthOf(a.rel) - depthOf(b.rel));
  rmdirs.sort((a, b) => depthOf(b.rel) - depthOf(a.rel));

  return {
    actions: [...obstacles, ...mkdirs, ...pulls, ...deletes, ...rmdirs],
    skipped,
    seeds,
    checked,
    extrasIgnored,
  };
}
