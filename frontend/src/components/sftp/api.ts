import { authFetch, fetchToken } from '../../lib/api';
import * as bfs from './browserFs';

/**
 * Pane endpoints for the SFTP tile.
 *
 * Each of the two panes is independently one of:
 *   suwu    — the Suwu host's own filesystem
 *   remote  — an SFTP session (the Suwu host dials the remote machine)
 *   browser — a folder picked from this browser (File System Access API)
 *
 * A pane exposes a uniform `list/mkdir/rename/remove` surface plus `read` for
 * downloads and `upload` for uploads, so the panel can copy between any two
 * panes. Transfers that involve only Suwu and/or remote endpoints are streamed
 * server-side (`transfer`); anything touching the browser is done in the page.
 */

export type EndpointKind = 'suwu' | 'remote' | 'browser';

/** One directory-listing row. */
export interface PaneItem {
  name: string;
  isDir: boolean;
  size: number;
  modTime: string;
}

export type SftpAuthMode = 'password' | 'key';

export interface ConnectParams {
  host: string;
  port?: number;
  user: string;
  auth: SftpAuthMode;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface RemoteConnection {
  sessionId: string;
  host: string;
  user: string;
  home: string;
  hostKey: string;
}

interface ListResponse {
  path: string;
  entries: PaneItem[];
}

async function errorFrom(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // fall through
  }
  return `HTTP ${res.status}`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await authFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorFrom(res));
  return (await res.json().catch(() => ({}))) as T;
}

/** Called as bytes move, for the transfer panel. */
export type ProgressFn = (loaded: number, total: number) => void;

/** Read a response body, reporting progress when the size is known. */
async function blobWithProgress(res: Response, onProgress?: ProgressFn): Promise<Blob> {
  const total = Number(res.headers.get('Content-Length') || 0);
  if (!onProgress || !res.body) return res.blob();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total || loaded);
    }
  }
  return new Blob(chunks as BlobPart[]);
}

/** Upload with an Authorization header and upload-progress events (XHR). */
async function xhrUpload(
  url: string,
  body: Blob | FormData,
  onProgress?: ProgressFn,
): Promise<void> {
  const { token } = await fetchToken();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      let message = `HTTP ${xhr.status}`;
      try {
        const parsed = JSON.parse(xhr.responseText) as { error?: string };
        if (parsed?.error) message = parsed.error;
      } catch {
        // keep the status
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(body);
  });
}

// ── Connection ─────────────────────────────────────────────────────────

export async function connectRemote(params: ConnectParams): Promise<RemoteConnection> {
  const res = await authFetch('/api/sftp/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(await errorFrom(res));
  return (await res.json()) as RemoteConnection;
}

export async function disconnectRemote(sessionId: string): Promise<void> {
  await postJson('/api/sftp/disconnect', { session: sessionId }).catch(() => undefined);
}

// ── Suwu host ──────────────────────────────────────────────────────────

export async function suwuHome(): Promise<string> {
  const res = await authFetch('/api/home', { cache: 'no-store' });
  if (!res.ok) throw new Error(await errorFrom(res));
  const body = (await res.json()) as { path?: string };
  return body.path || '/';
}

async function suwuList(path: string): Promise<ListResponse> {
  const res = await authFetch(`/api/files?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await errorFrom(res));
  return (await res.json()) as ListResponse;
}

async function suwuMkdir(path: string): Promise<void> {
  await postJson('/api/file/mkdir', { path });
}

async function suwuRename(path: string, newName: string): Promise<void> {
  await postJson('/api/file/rename', { path, newName });
}

async function suwuDelete(path: string): Promise<void> {
  await postJson('/api/file/delete', { path });
}

async function suwuRead(path: string, onProgress?: ProgressFn): Promise<Blob> {
  const res = await authFetch(`/api/file?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await errorFrom(res));
  return blobWithProgress(res, onProgress);
}

async function suwuUpload(
  dir: string,
  name: string,
  body: Blob,
  onProgress?: ProgressFn,
): Promise<void> {
  const form = new FormData();
  form.append('path', dir);
  form.append('file', body, name);
  await xhrUpload('/api/file/upload', form, onProgress);
}

// ── Remote (SFTP) ──────────────────────────────────────────────────────

async function remoteList(sessionId: string, path: string): Promise<ListResponse> {
  const params = new URLSearchParams({ session: sessionId });
  if (path) params.set('path', path);
  const res = await authFetch(`/api/sftp/list?${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await errorFrom(res));
  return (await res.json()) as ListResponse;
}

async function remoteMkdir(sessionId: string, path: string): Promise<void> {
  await postJson('/api/sftp/mkdir', { session: sessionId, path });
}

async function remoteRename(sessionId: string, path: string, newName: string): Promise<void> {
  await postJson('/api/sftp/rename', { session: sessionId, path, newName });
}

async function remoteDelete(sessionId: string, path: string): Promise<void> {
  await postJson('/api/sftp/delete', { session: sessionId, path });
}

async function remoteRead(sessionId: string, path: string, onProgress?: ProgressFn): Promise<Blob> {
  const params = new URLSearchParams({ session: sessionId, path });
  const res = await authFetch(`/api/sftp/download?${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await errorFrom(res));
  return blobWithProgress(res, onProgress);
}

async function remoteUpload(
  sessionId: string,
  dir: string,
  relPath: string,
  body: Blob,
  onProgress?: ProgressFn,
): Promise<void> {
  const params = new URLSearchParams({ session: sessionId, dir, path: relPath });
  await xhrUpload(`/api/sftp/upload?${params}`, body, onProgress);
}

// ── Generic pane endpoint ──────────────────────────────────────────────

/** A pane's data source. `path` is the current directory it shows. */
export interface PaneEndpoint {
  kind: EndpointKind;
  /** SFTP session id (remote only). */
  sessionId?: string;
  list(path: string): Promise<ListResponse>;
  mkdir(path: string): Promise<void>;
  rename(path: string, newName: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Read one file (used when a browser endpoint is on the other side). */
  read(path: string, onProgress?: ProgressFn): Promise<Blob>;
  /** Write one file into `dir` under `relPath`. */
  upload(dir: string, relPath: string, body: Blob, onProgress?: ProgressFn): Promise<void>;
}

/** Build the endpoint for one of the three pane kinds. */
export function paneEndpoint(kind: EndpointKind, sessionId?: string): PaneEndpoint {
  if (kind === 'remote') {
    if (!sessionId) throw new Error('a remote pane needs a session');
    return {
      kind,
      sessionId,
      list: (path) => remoteList(sessionId, path),
      mkdir: (path) => remoteMkdir(sessionId, path),
      rename: (path, newName) => remoteRename(sessionId, path, newName),
      remove: (path) => remoteDelete(sessionId, path),
      read: (path, onProgress) => remoteRead(sessionId, path, onProgress),
      upload: (dir, relPath, body, onProgress) =>
        remoteUpload(sessionId, dir, relPath, body, onProgress),
    };
  }
  return {
    kind: 'suwu',
    list: suwuList,
    mkdir: suwuMkdir,
    rename: suwuRename,
    remove: suwuDelete,
    read: suwuRead,
    upload: suwuUpload,
  };
}

// ── Server-side transfer (Suwu ↔ remote) ───────────────────────────────

export async function serverTransfer(params: {
  sourceKind: EndpointKind;
  sourceSession?: string;
  sourcePath: string;
  destinationKind: EndpointKind;
  destSession?: string;
  destinationPath: string;
  recursive: boolean;
  overwrite?: boolean;
}): Promise<void> {
  await postJson('/api/sftp/transfer', {
    sourceKind: params.sourceKind,
    sourceSession: params.sourceSession,
    sourcePath: params.sourcePath,
    destinationKind: params.destinationKind,
    destSession: params.destSession,
    destinationPath: params.destinationPath,
    recursive: params.recursive,
    overwrite: params.overwrite === true,
  });
}

// ── Browser endpoint helpers ───────────────────────────────────────────

/** Copy a browser entry (recursively) into a pane endpoint. */
export async function copyBrowserToEndpoint(
  parent: FileSystemDirectoryHandle,
  item: PaneItem,
  dest: PaneEndpoint,
  destDir: string,
  onProgress?: ProgressFn,
): Promise<void> {
  if (item.isDir) {
    const sub = await parent.getDirectoryHandle(item.name);
    const target = joinPath(destDir, item.name);
    await dest.mkdir(target);
    for await (const [name, entry] of sub.entries()) {
      const childItem: PaneItem = { name, isDir: entry.kind === 'directory', size: 0, modTime: '' };
      if (entry.kind === 'directory') {
        await copyBrowserToEndpoint(sub, childItem, dest, target, onProgress);
      } else {
        const file = await (entry as FileSystemFileHandle).getFile();
        await dest.upload(target, name, file, onProgress);
      }
    }
    return;
  }
  const file = await bfs.getBrowserFile(parent, item.name);
  await dest.upload(destDir, item.name, file, onProgress);
}

/** Copy an endpoint entry (recursively) into a browser directory. */
export async function copyEndpointToBrowser(
  src: PaneEndpoint,
  srcPath: string,
  item: PaneItem,
  dirHandle: FileSystemDirectoryHandle,
  onProgress?: ProgressFn,
): Promise<void> {
  if (item.isDir) {
    const sub = await dirHandle.getDirectoryHandle(item.name, { create: true });
    const { entries } = await src.list(srcPath);
    for (const child of entries) {
      await copyEndpointToBrowser(src, joinPath(srcPath, child.name), child, sub, onProgress);
    }
    return;
  }
  await bfs.writeBrowserFile(dirHandle, item.name, await src.read(srcPath, onProgress));
}

// ── Path helpers (POSIX; used for both remotes and Suwu) ───────────────

/** Join a POSIX-style parent path and a name. */
export function joinPath(parent: string, name: string): string {
  if (parent === '' || parent === '/') return `/${name}`;
  return `${parent.replace(/\/+$/, '')}/${name}`;
}

/** The parent of a POSIX-style path (root stays root). */
export function parentPath(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  if (idx <= 0) return '/';
  return clean.slice(0, idx);
}
