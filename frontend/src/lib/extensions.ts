import { useCallback, useEffect, useState } from 'react';
import { authFetch } from './api';

/** One launch parameter documented by an extension's meta.json. */
export interface ExtensionParam {
  key: string;
  label?: string;
  description?: string;
  defaultValue?: string;
}

/** A registered gqjs extension. */
export interface Extension {
  id: string;
  name: string;
  description?: string;
  params?: ExtensionParam[];
}

async function fetchExtensions(): Promise<Extension[]> {
  const res = await authFetch('/api/extensions', { cache: 'no-store' });
  if (!res.ok) throw new Error(`extensions list failed with HTTP ${res.status}`);
  const data = (await res.json()) as { extensions?: Extension[] };
  return data.extensions ?? [];
}

let cached: Extension[] | null = null;
let inflight: Promise<Extension[]> | null = null;

function loadExtensions(): Promise<Extension[]> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetchExtensions()
      .then((list) => {
        cached = list;
        return list;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Read-only list of registered extensions, fetched once per session.
 *
 * Used by the App Menu config editor to populate the extension `id` selector —
 * never by the tile itself. On failure `failed` is set so callers can fall
 * back to a plain text input.
 */
export function useExtensions(): { items: Extension[]; failed: boolean } {
  const [items, setItems] = useState<Extension[]>(cached ?? []);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    loadExtensions()
      .then((list) => {
        if (alive) setItems(list);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const reload = useCallback(() => {
    cached = null;
    inflight = null;
    loadExtensions()
      .then((list) => setItems(list))
      .catch(() => setFailed(true));
  }, []);

  return { items, failed, reload } as { items: Extension[]; failed: boolean };
}
