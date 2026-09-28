/**
 * Local folder access (File System Access API) for the mirror engine.
 *
 * The engine never writes a `lastModified` (the API cannot), so every local
 * copy reports "now" — `.suwu-sync.json` is what keeps the loop from
 * re-downloading it forever. See ../meta.ts.
 */

import {
  isNotFoundError,
  pickDirectory,
  queryPermission,
  requestPermission,
  supportsLocalFs,
} from './fs-access';
import { isMetaName } from './types';
import { MAX_SYNC_DEPTH, MAX_SYNC_ENTRIES, type ManifestMap, type ScanResult } from './types';

export { pickDirectory, queryPermission, requestPermission, supportsLocalFs };

function segments(rel: string): string[] {
  return rel.split('/').filter((s) => s.length > 0);
}

function depthOf(rel: string): number {
  return rel.split('/').length;
}

/** Walks (and optionally creates) the directory chain of a relative path. */
async function dirHandleFor(
  root: FileSystemDirectoryHandle,
  rel: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const seg of segments(rel)) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}

async function fileHandleFor(
  root: FileSystemDirectoryHandle,
  rel: string,
): Promise<FileSystemFileHandle> {
  const segs = segments(rel);
  const name = segs.pop();
  if (!name) throw new Error('empty path');
  const dir = await dirHandleFor(root, segs.join('/'), false);
  return dir.getFileHandle(name);
}

/**
 * Recursively lists the local folder. Entry metadata (`size`, `lastModified`)
 * comes from `getFile()` without reading content. The root journal
 * `.suwu-sync.json` is skipped; deeper files that share the name mirror
 * normally.
 */
export async function scanLocal(
  root: FileSystemDirectoryHandle,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const entries: ManifestMap = new Map();
  const stack: Array<{ dir: FileSystemDirectoryHandle; rel: string; depth: number }> = [
    { dir: root, rel: '', depth: 0 },
  ];
  let count = 0;
  let truncated = false;

  while (stack.length > 0) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const current = stack.pop();
    if (!current) break;
    for await (const [name, handle] of current.dir.entries()) {
      const rel = current.rel ? `${current.rel}/${name}` : name;
      if (current.depth === 0 && isMetaName(rel)) continue;

      const depth = current.depth + 1;
      if (depth > MAX_SYNC_DEPTH) {
        truncated = true;
        continue;
      }
      count += 1;
      if (count > MAX_SYNC_ENTRIES) {
        truncated = true;
        stack.length = 0;
        break;
      }

      if (handle.kind === 'directory') {
        entries.set(rel, { rel, isDir: true, size: 0, mtimeMs: 0 });
        stack.push({ dir: handle, rel, depth });
      } else {
        const file = await handle.getFile();
        entries.set(rel, { rel, isDir: false, size: file.size, mtimeMs: file.lastModified });
      }
    }
  }
  return { entries, truncated };
}

export async function readLocalFile(root: FileSystemDirectoryHandle, rel: string): Promise<File> {
  const handle = await fileHandleFor(root, rel);
  return handle.getFile();
}

export async function localStat(
  root: FileSystemDirectoryHandle,
  rel: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const file = await readLocalFile(root, rel);
    return { size: file.size, mtimeMs: file.lastModified };
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

/**
 * Writes one mirrored file, creating parent directories on demand, and returns
 * the resulting `lastModified` for the journal.
 */
export async function writeLocalFile(
  root: FileSystemDirectoryHandle,
  rel: string,
  data: Blob,
): Promise<{ size: number; mtimeMs: number }> {
  const segs = segments(rel);
  const name = segs.pop();
  if (!name) throw new Error('empty path');
  const dir = await dirHandleFor(root, segs.join('/'), true);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
  const file = await handle.getFile();
  return { size: file.size, mtimeMs: file.lastModified };
}

export async function mkdirLocal(root: FileSystemDirectoryHandle, rel: string): Promise<void> {
  await dirHandleFor(root, rel, true);
}

export async function deleteLocalFile(root: FileSystemDirectoryHandle, rel: string): Promise<void> {
  const segs = segments(rel);
  const name = segs.pop();
  if (!name) throw new Error('empty path');
  const dir = await dirHandleFor(root, segs.join('/'), false);
  await dir.removeEntry(name);
}

export async function removeLocalDir(
  root: FileSystemDirectoryHandle,
  rel: string,
  recursive: boolean,
): Promise<void> {
  const segs = segments(rel);
  const name = segs.pop();
  if (!name) throw new Error('empty path');
  const dir = await dirHandleFor(root, segs.join('/'), false);
  await dir.removeEntry(name, { recursive });
}

export { depthOf };
