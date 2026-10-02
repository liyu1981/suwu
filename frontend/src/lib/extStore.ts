/**
 * Backup + extension bridge — the shared extension IndexedDB store.
 *
 * Extension frames run with an opaque origin, where every web storage API
 * throws SecurityError. Their records therefore live in *this* document's
 * IndexedDB, under `suwu:ext/<id>/<key>` — the naming is forced by
 * ExtensionPage.tsx (§4.8 of docs/EXTENSION_TILE_PLAN.md). The same database
 * backs the backup feature, so the store lives here as a single module the
 * bridge and the collector both use; they cannot drift on the database name,
 * the store name, or the size cap.
 */

export const EXT_STORE_DB = 'suwu-extension-ext';
export const EXT_STORE = 'kv';
/** Charset for the suffix an extension may choose. */
export const EXT_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** JSON-serialized size cap per record (see §4.8). */
export const EXT_VALUE_MAX = 512_000;

let extStoreDb: IDBDatabase | null = null;

export function withExtStore(cb: (err: Error | null, db: IDBDatabase | null) => void): void {
  if (extStoreDb) {
    cb(null, extStoreDb);
    return;
  }
  let req: IDBOpenDBRequest;
  try {
    req = indexedDB.open(EXT_STORE_DB, 1);
  } catch (e) {
    cb(e instanceof Error ? e : new Error(String(e)), null);
    return;
  }
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(EXT_STORE)) db.createObjectStore(EXT_STORE);
  };
  req.onsuccess = () => {
    const db = req.result;
    db.onclose = () => {
      extStoreDb = null;
    };
    db.onversionchange = () => {
      extStoreDb = null;
      db.close();
    };
    extStoreDb = db;
    cb(null, db);
  };
  req.onerror = () => cb(req.error ?? new Error('extension store open failed'), null);
}

export function extStoreGet(key: string, cb: (err: Error | null, value?: unknown) => void): void {
  withExtStore((err, db) => {
    if (err || !db) {
      cb(err ?? new Error('extension store unavailable'));
      return;
    }
    try {
      const tx = db.transaction(EXT_STORE, 'readonly');
      const rq = tx.objectStore(EXT_STORE).get(key);
      rq.onsuccess = () => cb(null, rq.result);
      rq.onerror = () => cb(rq.error ?? new Error('extension store read failed'));
    } catch (e) {
      cb(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export function extStoreSet(key: string, value: unknown, cb: (err: Error | null) => void): void {
  withExtStore((err, db) => {
    if (err || !db) {
      cb(err ?? new Error('extension store unavailable'));
      return;
    }
    try {
      const tx = db.transaction(EXT_STORE, 'readwrite');
      tx.objectStore(EXT_STORE).put(value, key);
      tx.oncomplete = () => cb(null);
      tx.onerror = () => cb(tx.error ?? new Error('extension store write failed'));
      tx.onabort = () => cb(tx.error ?? new Error('extension store write aborted'));
    } catch (e) {
      cb(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Promise form of extStoreGet, for the collector. */
export function extStoreGetAsync(key: string): Promise<unknown | undefined> {
  return new Promise((resolve, reject) => {
    extStoreGet(key, (err, value) => (err ? reject(err) : resolve(value)));
  });
}

/** Every key currently in the extension store, as a flat array. */
export function extStoreKeysAsync(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    withExtStore((err, db) => {
      if (err || !db) {
        reject(err ?? new Error('extension store unavailable'));
        return;
      }
      try {
        const tx = db.transaction(EXT_STORE, 'readonly');
        const rq = tx.objectStore(EXT_STORE).getAllKeys();
        rq.onsuccess = () => resolve(rq.result.map(String));
        rq.onerror = () => reject(rq.error ?? new Error('extension store key scan failed'));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

/**
 * Reads one extension's full record set as `<key> -> value`. Used by the backup
 * collector to snapshot one extension at a time.
 */
export async function extStoreReadAllForExtension(
  extId: string,
): Promise<Array<[string, unknown]>> {
  const prefix = `suwu:ext/${extId}/`;
  const keys = await extStoreKeysAsync();
  const mine = keys.filter((k) => k.startsWith(prefix));
  const out: Array<[string, unknown]> = [];
  for (const fullKey of mine) {
    const value = await extStoreGetAsync(fullKey);
    if (value !== undefined) out.push([fullKey.slice(prefix.length), value]);
  }
  return out;
}

/** Writes one extension record back (used when applying a restored backup). */
export function extStoreWrite(extId: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!EXT_KEY_RE.test(key)) {
      reject(new Error('invalid extension key'));
      return;
    }
    extStoreSet(`suwu:ext/${extId}/${key}`, value, (err) => (err ? reject(err) : resolve()));
  });
}

/** Deletes one extension record (replace-mode removal when restoring). */
export function extStoreDelete(extId: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!EXT_KEY_RE.test(key) || !extId) {
      reject(new Error('invalid extension key'));
      return;
    }
    withExtStore((err, db) => {
      if (err || !db) {
        reject(err ?? new Error('extension store unavailable'));
        return;
      }
      try {
        const tx = db.transaction(EXT_STORE, 'readwrite');
        tx.objectStore(EXT_STORE).delete(`suwu:ext/${extId}/${key}`);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('extension store delete failed'));
        tx.onabort = () => reject(tx.error ?? new Error('extension store delete aborted'));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}
