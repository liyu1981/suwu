/**
 * `.suwu-sync.json` — the sync journal stored at the root of the local folder.
 *
 * It records what has already been mirrored so a 5 s loop knows to skip. The
 * File System Access API cannot set `lastModified`, so a local copy never
 * matches the server mtime; without this file every cycle would re-download
 * the whole folder.
 *
 * The sync algorithm never mirrors this file: it is stripped from both the
 * local scan and the remote manifest (root-only), never deleted by
 * `removeExtra`, and deleting it by hand is the supported way to reset a job.
 */

import { isNotFoundError } from './fs-access';
import {
  isMetaName,
  META_NAME,
  META_PLUGIN,
  META_VERSION,
  type FileMetaEntry,
  type SyncMeta,
} from './types';

export { isMetaName, META_NAME, META_VERSION, META_PLUGIN };

/** Refuse to parse an absurd meta file rather than blowing up the engine. */
const MAX_META_BYTES = 64 * 1024 * 1024;

export function emptyMeta(remotePath: string): SyncMeta {
  return { version: META_VERSION, plugin: META_PLUGIN, remotePath, files: {} };
}

export type MetaStatus = 'ok' | 'missing' | 'invalid';

export interface MetaLookup {
  meta: SyncMeta | null;
  status: MetaStatus;
}

export async function readMeta(dir: FileSystemDirectoryHandle): Promise<MetaLookup> {
  let file: File;
  try {
    const handle = await dir.getFileHandle(META_NAME);
    file = await handle.getFile();
  } catch (err) {
    if (isNotFoundError(err)) return { meta: null, status: 'missing' };
    return { meta: null, status: 'invalid' };
  }
  if (file.size > MAX_META_BYTES) return { meta: null, status: 'invalid' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return { meta: null, status: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object') return { meta: null, status: 'invalid' };
  const candidate = parsed as Partial<SyncMeta>;
  if (
    candidate.version !== META_VERSION ||
    typeof candidate.remotePath !== 'string' ||
    !candidate.files ||
    typeof candidate.files !== 'object'
  ) {
    return { meta: null, status: 'invalid' };
  }
  return {
    meta: {
      version: META_VERSION,
      plugin: META_PLUGIN,
      remotePath: candidate.remotePath,
      lastCycleAt: typeof candidate.lastCycleAt === 'number' ? candidate.lastCycleAt : undefined,
      files: candidate.files as Record<string, FileMetaEntry>,
    },
    status: 'ok',
  };
}

/**
 * Writes the journal. `createWritable()` stages into a swap file and `close()`
 * commits atomically, so a crash can never leave a half-written journal.
 */
export async function writeMeta(dir: FileSystemDirectoryHandle, meta: SyncMeta): Promise<void> {
  const handle = await dir.getFileHandle(META_NAME, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(JSON.stringify(meta));
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
}
