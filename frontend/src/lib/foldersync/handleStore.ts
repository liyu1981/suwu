/**
 * Persistence for local directory handles.
 *
 * A `FileSystemDirectoryHandle` is structured-cloneable, so it lives in
 * IndexedDB; its *permission* is not, and is re-requested when the user starts
 * a job (see engine.start). This is the only IndexedDB store the feature uses —
 * the sync journal travels inside the folder as `.suwu-sync.json`.
 */

const DB_NAME = 'suwu-folder-sync';
const DB_VERSION = 1;
const STORE = 'dirs';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    let req: IDBRequest<T>;
    try {
      req = fn(db.transaction(STORE, mode).objectStore(STORE));
    } catch {
      resolve(null);
      return;
    }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

/** Random id for a newly picked folder. */
export function newHandleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    // Chromium caps showDirectoryPicker's `id` option at 32 characters, and a
    // raw UUID is 36 — so hand out a short, dash-free id.
    return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export async function saveHandle(id: string, handle: FileSystemDirectoryHandle): Promise<boolean> {
  const res = await withStore('readwrite', (store) => store.put(handle, id) as IDBRequest<unknown>);
  return res !== null;
}

export async function loadHandle(id: string): Promise<FileSystemDirectoryHandle | null> {
  if (!id) return null;
  const handle = await withStore<FileSystemDirectoryHandle>('readonly', (store) => store.get(id));
  return handle && handle.kind === 'directory' ? handle : null;
}

export async function deleteHandle(id: string): Promise<void> {
  if (!id) return;
  await withStore('readwrite', (store) => store.delete(id) as unknown as IDBRequest<undefined>);
}
