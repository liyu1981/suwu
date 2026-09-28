/**
 * Server-side calls for the mirror: one manifest per pre-flight, then plain
 * file downloads. Everything goes through the shared authenticated fetcher.
 */

import { authFetch } from '../api';
import { isMetaName } from './types';
import type { ManifestMap, ScanResult } from './types';

export type ApiErrorCode = 'unauthorized' | 'not-found' | 'server' | 'network' | 'truncated';

export class SyncApiError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SyncApiError';
    this.code = code;
  }
}

interface ManifestEntry {
  rel?: string;
  isDir?: boolean;
  size?: number;
  mtimeMs?: number;
}

function errorFor(res: Response): SyncApiError {
  if (res.status === 401 || res.status === 403)
    return new SyncApiError('unauthorized', `HTTP ${res.status}`);
  if (res.status === 404) return new SyncApiError('not-found', `HTTP ${res.status}`);
  return new SyncApiError('server', `HTTP ${res.status}`);
}

/** Absolute path of a relative entry inside the synced folder. */
export function joinRemote(root: string, rel: string): string {
  const base = root.replace(/\/+$/, '');
  return base + '/' + rel;
}

/** One recursive request; the root `.suwu-sync.json` is never mirrored. */
export async function fetchManifest(remotePath: string, signal?: AbortSignal): Promise<ScanResult> {
  let res: Response;
  try {
    res = await authFetch(`/api/sync/manifest?path=${encodeURIComponent(remotePath)}`, {
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new SyncApiError('network', err instanceof Error ? err.message : 'network error');
  }
  if (!res.ok) throw errorFor(res);

  const data = (await res.json()) as { entries?: ManifestEntry[]; truncated?: boolean };
  const entries: ManifestMap = new Map();
  for (const entry of data.entries ?? []) {
    const rel = entry.rel ?? '';
    if (!rel || isMetaName(rel)) continue;
    entries.set(rel, {
      rel,
      isDir: entry.isDir === true,
      size: entry.size ?? 0,
      mtimeMs: entry.mtimeMs ?? 0,
    });
  }
  return { entries, truncated: data.truncated === true };
}

/** Downloads one file. Returns the bytes plus the server mtime when sent. */
export async function fetchFile(
  remoteFile: string,
  signal?: AbortSignal,
): Promise<{ bytes: ArrayBuffer; mtimeMs: number | null }> {
  let res: Response;
  try {
    res = await authFetch(`/api/file?path=${encodeURIComponent(remoteFile)}`, {
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new SyncApiError('network', err instanceof Error ? err.message : 'network error');
  }
  if (!res.ok) throw errorFor(res);

  const header = res.headers.get('X-Suwu-Mtime-Ms');
  const parsed = header ? Number(header) : Number.NaN;
  return { bytes: await res.arrayBuffer(), mtimeMs: Number.isFinite(parsed) ? parsed : null };
}

export interface RemoteDirEntry {
  name: string;
  isDir: boolean;
}

/** The backend user's home directory — where the folder browser starts. */
export async function fetchRemoteHome(signal?: AbortSignal): Promise<string> {
  const res = await authFetch('/api/home', { cache: 'no-store', signal });
  if (!res.ok) throw errorFor(res);
  const data = (await res.json()) as { path?: string };
  return data.path && data.path.startsWith('/') ? data.path : '/';
}

/** Directory listing used by the job editor's remote folder browser. */
export async function listRemoteDirs(dir: string, signal?: AbortSignal): Promise<RemoteDirEntry[]> {
  const res = await authFetch(`/api/files?path=${encodeURIComponent(dir)}`, {
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw errorFor(res);
  const data = (await res.json()) as { entries?: Array<{ name?: string; isDir?: boolean }> };
  return (data.entries ?? [])
    .filter((e) => e.isDir === true && e.name && e.name !== '.')
    .map((e) => ({ name: e.name as string, isDir: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
