import { useCallback, useEffect, useState } from 'react';
import { authFetch } from './api';

/** One launch parameter documented by an extension's package.json. */
interface ExtensionParam {
  key: string;
  label?: string;
  description?: string;
  defaultValue?: string;
}

/** One API route an extension registers under /gqjs/api/<id>/. */
interface ExtensionAPIRoute {
  route: string;
  handler: string;
}

/** A registered gqjs extension. */
export interface Extension {
  id: string;
  name: string;
  description?: string;
  params?: ExtensionParam[];
  /** Ordered route registrations; first match wins. Absent when render-only. */
  api?: ExtensionAPIRoute[];
  /** Declared suwu.net — the extension's scripts may use the network. */
  net?: boolean;
  /** Declared suwu.static — directory of assets served under /gqjs/static/<id>/. */
  static?: string;
  /** Declared suwu.csp — extra sources appended to the extension CSP. */
  csp?: Record<string, string[]>;
  /** Declared suwu.sandbox — extra iframe sandbox tokens (allow-downloads). */
  sandbox?: string[];
  /**
   * Declared suwu.fileExtensions — file suffixes this extension claims for
   * the notification resolver (lowercase, dot-prefixed, e.g. ".excalidraw").
   * `suwu open <file>` with a matching suffix opens this extension's tile.
   */
  fileExtensions?: string[];
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
 * Id of the installed extension that claims `path`'s suffix, or null when
 * none does (or the list cannot be fetched — callers then fall back to the
 * generic file handling).
 *
 * Backs the `suwu open <file>` → extension-tile resolution, so the mapping
 * lives in each extension's package.json rather than in this app.
 */
export async function findExtensionForFile(path: string): Promise<string | null> {
  const lower = path.toLowerCase();
  let list: Extension[];
  try {
    list = await loadExtensions();
  } catch {
    return null;
  }
  for (const ext of list) {
    const claimed = ext.fileExtensions ?? [];
    if (claimed.some((suffix) => lower.endsWith(suffix))) return ext.id;
  }
  return null;
}

/**
 * Drop the session cache and fetch the list again.
 *
 * The list is cached for the lifetime of the document, so a background or
 * extension installed from a terminal (`suwu install`) is invisible until
 * something asks for a fresh copy. The settings screen does that when it
 * opens; the App Menu's own reload button shares this path.
 */
export function reloadExtensions(): Promise<Extension[]> {
  cached = null;
  inflight = null;
  return loadExtensions();
}

/**
 * Read-only list of registered extensions, fetched once per session.
 *
 * Used by the App Menu config editor to populate the extension `id` selector —
 * never by the tile itself. On failure `failed` is set so callers can fall
 * back to a plain text input.
 */
export function useExtensions(): {
  items: Extension[];
  failed: boolean;
  loading: boolean;
  reload: () => void;
} {
  const [items, setItems] = useState<Extension[]>(cached ?? []);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(cached === null);

  useEffect(() => {
    let alive = true;
    loadExtensions()
      .then((list) => {
        if (!alive) return;
        setItems(list);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setFailed(true);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    reloadExtensions()
      .then((list) => {
        setItems(list);
        setFailed(false);
        setLoading(false);
      })
      .catch(() => {
        setFailed(true);
        setLoading(false);
      });
  }, []);

  return { items, failed, loading, reload };
}
