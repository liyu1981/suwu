import { useEffect, useMemo, useRef } from 'react';
import { CommonTileContainer } from '../components/CommonTileContainer';
import { extensionZoomAtom } from '../store/zoom';
import { setPageTransparent } from '../lib/constants';
import i18n from '../i18n';

// Scoped storage bridge for the sandboxed extension frame.
//
// The inner iframe has an opaque origin, which browsers forbid from every
// web storage API (localStorage and IndexedDB both throw SecurityError
// there). Instead the extension posts {type:'ext-store', op, key, rid}
// requests up here and this trusted frame reads/writes its own IndexedDB.
// Keys are FORCED under `suwu:ext/<id from this pane's own URL>/` with a
// strict charset, so a request can never touch another extension's keys,
// app settings, or the session — the child only ever chooses the suffix.
// See docs/EXTENSION_TILE_PLAN.md §4.8.
const EXT_STORE_DB = 'suwu-extension-ext';
const EXT_STORE = 'kv';
const EXT_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const EXT_VALUE_MAX = 512_000; // JSON-serialized size cap per record

let extStoreDb: IDBDatabase | null = null;

function withExtStore(cb: (err: Error | null, db: IDBDatabase | null) => void): void {
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

function extStoreGet(key: string, cb: (err: Error | null, value?: unknown) => void): void {
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

function extStoreSet(key: string, value: unknown, cb: (err: Error | null) => void): void {
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

/**
 * Full-space extension page loaded inside each tiling pane's iframe.
 *
 * Two layers on purpose: this page is a trusted Suwu document wrapped in
 * CommonTileContainer (session state, focus, shortcut relay, background, zoom),
 * and it hosts the gqjs-rendered extension in a sandboxed inner iframe so
 * untrusted extension markup cannot touch Suwu's DOM.
 *
 * There is no in-tile extension picker: the id is chosen on the App Menu
 * config tile (supportedParams -> `id`).
 *
 * Because the extension document is sandboxed and one frame deeper, focus and
 * key events inside it never reach this page natively. The server injects a
 * postMessage relay into the served HTML and this page forwards it to the
 * shell under its own message vocabulary (see the relay effect below).
 */
export default function ExtensionPage() {
  useEffect(() => {
    setPageTransparent();
  }, []);

  const { paneId, id, query } = useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    const pane = sp.get('pane') ?? '';
    const ext = sp.get('id') ?? '';
    sp.delete('pane');
    sp.delete('id');
    return { paneId: pane, id: ext, query: sp.toString() };
  }, []);

  const src = useMemo(() => {
    if (!id) return null;
    const p = new URLSearchParams(query);
    if (paneId) p.set('pane', paneId);
    const qs = p.toString();
    return `/gqjs/ext/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`;
  }, [id, paneId, query]);

  const innerRef = useRef<HTMLIFrameElement>(null);

  // Tile-page hop of the extension focus/key relay and the ext-store bridge.
  //
  // Ancestor frames do not re-fire `focus` when focus descends into a nested
  // frame, and key events stop at document boundaries — so without this the
  // WM would never learn the tile is focused and Alt/Ctrl shortcuts would be
  // swallowed. Messages are accepted only from *our* inner frame, and are
  // re-stated as this pane's own focus/keys: the extension never gets to name
  // the pane or the action. The same source check gates the storage bridge:
  // keys are namespaced under this pane's extension id (§4.8).
  useEffect(() => {
    if (!src || !paneId) return;
    const onMsg = (e: MessageEvent) => {
      const inner = innerRef.current;
      if (!inner || e.source !== inner.contentWindow) return;
      const d = e.data as
        | {
            type?: string;
            key?: string;
            op?: string;
            rid?: number;
            value?: unknown;
            altKey?: boolean;
            ctrlKey?: boolean;
            shiftKey?: boolean;
            metaKey?: boolean;
          }
        | undefined;
      if (d?.type === 'ext-store' && typeof d.rid === 'number') {
        const reply = (ok: boolean, value?: unknown, error?: string) => {
          innerRef.current?.contentWindow?.postMessage(
            { type: 'ext-store-result', rid: d.rid, ok, value, error },
            '*',
          );
        };
        const key = typeof d.key === 'string' ? d.key : '';
        // Namespace from THIS pane's extension id (taken from its own URL —
        // the child cannot influence it) with a strict charset: a request
        // can only ever address suwu:ext/<id>/<key>.
        if (!EXT_KEY_RE.test(key)) {
          reply(false);
          return;
        }
        const fullKey = `suwu:ext/${id}/${key}`;
        if (d.op === 'get') {
          extStoreGet(fullKey, (err, value) => (err ? reply(false) : reply(true, value)));
        } else if (d.op === 'set') {
          let size = 0;
          try {
            size = JSON.stringify(d.value ?? null).length;
          } catch {
            reply(false);
            return;
          }
          if (size > EXT_VALUE_MAX) {
            reply(false);
            return;
          }
          extStoreSet(fullKey, d.value, (err) =>
            err ? reply(false, undefined, err.name) : reply(true),
          );
        } else {
          reply(false);
        }
        return;
      }
      if (d?.type === 'ext-focus') {
        window.parent?.postMessage({ type: 'pane-focus', pane: paneId }, '*');
        return;
      }
      if (d?.type === 'ext-key' && typeof d.key === 'string') {
        window.parent?.postMessage(
          {
            type: 'wm-key',
            key: d.key,
            altKey: !!d.altKey,
            ctrlKey: !!d.ctrlKey,
            shiftKey: !!d.shiftKey,
            metaKey: !!d.metaKey,
          },
          '*',
        );
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [src, paneId, id]);

  return (
    <CommonTileContainer zoomAtom={extensionZoomAtom} noPadding>
      {src ? (
        <iframe
          key={src}
          ref={innerRef}
          src={src}
          title={`extension-${id}`}
          // Deliberately no `allow-same-origin`: the extension runs in an
          // opaque origin, so it cannot read Suwu storage or escape upward.
          // `allow-popups` lets story links open in a new tab that *inherits*
          // this sandbox — without it target=_blank is silently blocked; with
          // it (and no allow-popups-to-escape-sandbox) a popup to our own
          // origin stays sandboxed too.
          sandbox="allow-scripts allow-pointer-lock allow-popups"
          className="h-full w-full border-0 bg-transparent"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-6 text-center">
          <p className="max-w-md text-sm text-white/60">{i18n.t('extension.configure')}</p>
        </div>
      )}
    </CommonTileContainer>
  );
}
