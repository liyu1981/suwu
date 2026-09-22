/**
 * IndexedDB persistence for the REST Helper tile.
 *
 * Everything the REST Helper stores lives here, client-side: the Go backend is
 * stateless (see docs/REST_HELPER_PLAN.md §5.6). The structure mirrors the
 * IndexedDB layer in inspect-http-proxy's `_jotai/http-res.ts` (openDB
 * singleton, timestamp index, capped FIFO cleanup), generalized to multiple
 * object stores.
 */

export type RestStore = 'history' | 'responses' | 'collections' | 'environments' | 'cookies';

const DB_NAME = 'suwu-rest-helper';
const DB_VERSION = 1;

/** Maximum number of history entries retained (oldest are pruned by timestamp). */
export const MAX_HISTORY = 1000;

interface StoreSpec {
  keyPath: string;
  indexes?: Array<{ name: string; keyPath: string }>;
}

const STORES: Record<RestStore, StoreSpec> = {
  history: { keyPath: 'id', indexes: [{ name: 'timestamp', keyPath: 'timestamp' }] },
  responses: { keyPath: 'id' },
  collections: { keyPath: 'id' },
  environments: { keyPath: 'id' },
  cookies: { keyPath: 'id', indexes: [{ name: 'domain', keyPath: 'domain' }] },
};

let dbPromise: Promise<IDBDatabase> | null = null;

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openRestDB(): Promise<IDBDatabase> {
  if (!hasIndexedDB()) return Promise.reject(new Error('IndexedDB unavailable'));
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, spec] of Object.entries(STORES) as Array<[RestStore, StoreSpec]>) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: spec.keyPath });
          for (const index of spec.indexes ?? []) {
            store.createIndex(index.name, index.keyPath, { unique: false });
          }
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed to open IndexedDB'));
  });

  return dbPromise;
}

function tx<T>(
  store: RestStore,
  mode: IDBTransactionMode,
  fn: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openRestDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = fn(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

export async function restPut<T>(store: RestStore, value: T): Promise<void> {
  try {
    await tx(store, 'readwrite', (s) => s.put(value as unknown as Record<string, unknown>));
  } catch (error) {
    console.error(`[restdb] put ${store} failed`, error);
  }
}

export async function restGet<T>(store: RestStore, key: string): Promise<T | undefined> {
  try {
    return await tx<T | undefined>(
      store,
      'readonly',
      (s) => s.get(key) as IDBRequest<T | undefined>,
    );
  } catch (error) {
    console.error(`[restdb] get ${store} failed`, error);
    return undefined;
  }
}

export async function restGetAll<T>(store: RestStore): Promise<T[]> {
  try {
    return await tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  } catch (error) {
    console.error(`[restdb] getAll ${store} failed`, error);
    return [];
  }
}

export async function restDelete(store: RestStore, key: string): Promise<void> {
  try {
    await tx(store, 'readwrite', (s) => s.delete(key));
  } catch (error) {
    console.error(`[restdb] delete ${store} failed`, error);
  }
}

export async function restClear(store: RestStore): Promise<void> {
  try {
    await tx(store, 'readwrite', (s) => s.clear());
  } catch (error) {
    console.error(`[restdb] clear ${store} failed`, error);
  }
}

export async function restCount(store: RestStore): Promise<number> {
  try {
    return await tx<number>(store, 'readonly', (s) => s.count());
  } catch (error) {
    console.error(`[restdb] count ${store} failed`, error);
    return 0;
  }
}

/**
 * Prune the history store down to MAX_HISTORY entries, deleting the oldest by
 * the `timestamp` index (the same FIFO cleanup the source project uses).
 */
export async function pruneRestHistory(): Promise<void> {
  try {
    const count = await restCount('history');
    if (count <= MAX_HISTORY) return;
    let toDelete = count - MAX_HISTORY;
    const db = await openRestDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('history', 'readwrite');
      const index = transaction.objectStore('history').index('timestamp');
      const cursorRequest = index.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor && toDelete > 0) {
          cursor.delete();
          toDelete -= 1;
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('prune failed'));
    });
  } catch (error) {
    console.error('[restdb] prune history failed', error);
  }
}
