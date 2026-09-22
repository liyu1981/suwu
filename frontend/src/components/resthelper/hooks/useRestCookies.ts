import { useCallback, useEffect, useRef, useState } from 'react';
import { restClear, restDelete, restGetAll, restPut } from '../../../lib/restdb';
import {
  applySetCookies,
  buildCookieHeader,
  importCookieString,
  readDocumentCookie,
  type JarCookie,
} from '../../../lib/cookie-jar';
import type { RestResponseData } from '../../../store/resthelper';

/** IndexedDB-backed cookie jar (client-side only). */
export function useRestCookies() {
  const [cookies, setCookies] = useState<JarCookie[]>([]);
  const [ready, setReady] = useState(false);
  const cookiesRef = useRef<JarCookie[]>([]);
  const prevRef = useRef<Map<string, JarCookie>>(new Map());

  const persist = useCallback(async (next: JarCookie[]) => {
    const prev = prevRef.current;
    const nextMap = new Map(next.map((cookie) => [cookie.id, cookie]));
    const work: Array<Promise<void>> = [];
    for (const id of prev.keys()) {
      if (!nextMap.has(id)) work.push(restDelete('cookies', id));
    }
    for (const cookie of next) {
      const old = prev.get(cookie.id);
      if (!old || JSON.stringify(old) !== JSON.stringify(cookie))
        work.push(restPut('cookies', cookie));
    }
    await Promise.all(work);
    prevRef.current = nextMap;
    cookiesRef.current = next;
    setCookies(next);
  }, []);

  const reload = useCallback(async () => {
    const rows = await restGetAll<JarCookie>('cookies');
    prevRef.current = new Map(rows.map((cookie) => [cookie.id, cookie]));
    cookiesRef.current = rows;
    setCookies(rows);
    setReady(true);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Build the Cookie header for a URL from the current jar. */
  const headerFor = useCallback((url: string) => buildCookieHeader(cookiesRef.current, url), []);

  /** Merge any `Set-Cookie` headers from a response into the jar. */
  const capture = useCallback(
    (url: string, response: RestResponseData) => {
      const setCookie = response.headers['Set-Cookie'] ?? response.headers['set-cookie'] ?? [];
      if (setCookie.length === 0) return;
      void persist(applySetCookies(cookiesRef.current, url, setCookie));
    },
    [persist],
  );

  /** Import the current browser's cookies (readable same-origin only). */
  const importFromBrowser = useCallback(
    async (host: string) => {
      const raw = readDocumentCookie();
      if (!raw) return;
      await persist(importCookieString(cookiesRef.current, host, raw));
    },
    [persist],
  );

  const importString = useCallback(
    async (host: string, raw: string) => {
      await persist(importCookieString(cookiesRef.current, host, raw));
    },
    [persist],
  );

  const upsert = useCallback(
    async (cookie: JarCookie) => {
      const next = cookiesRef.current.filter((existing) => existing.id !== cookie.id);
      next.push(cookie);
      await persist(next);
    },
    [persist],
  );

  const remove = useCallback(
    async (id: string) => {
      await persist(cookiesRef.current.filter((cookie) => cookie.id !== id));
    },
    [persist],
  );

  const clearAll = useCallback(async () => {
    await restClear('cookies');
    prevRef.current = new Map();
    cookiesRef.current = [];
    setCookies([]);
  }, []);

  return {
    cookies,
    ready,
    headerFor,
    capture,
    importFromBrowser,
    importString,
    upsert,
    remove,
    clearAll,
  };
}
