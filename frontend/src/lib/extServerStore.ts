/**
 * Server side of the extension storage bridge.
 *
 * An extension frame has an opaque origin, so it stores through the page; that
 * makes a record live in one browser. A record kept on the server is the same
 * value on every device, which is what an extension opts into with the "server"
 * scope (docs/EXTENSION_TILE_PLAN.md §4.8).
 *
 * Same key grammar and size cap as the browser store, so a value can be moved
 * from one side to the other without changing meaning. Every call is
 * authenticated by the page's own token: a frame never holds a credential.
 */
import { authFetch } from './api';
import { EXT_KEY_RE, EXT_VALUE_MAX } from './extStore';

export { EXT_KEY_RE, EXT_VALUE_MAX };

/** A named failure, so an extension can branch on `err.name` like the bridge. */
function namedError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

export interface ServerRecord {
  /** False when the server has no record under this key yet. */
  found: boolean;
  value?: unknown;
}

function recordURL(extId: string, key: string): string {
  return `/api/ext/data/${encodeURIComponent(extId)}/${encodeURIComponent(key)}`;
}

/** Read one server-scoped record. */
export async function extServerGet(extId: string, key: string): Promise<ServerRecord> {
  if (!EXT_KEY_RE.test(key)) throw namedError('InvalidKey');
  let res: Response;
  try {
    res = await authFetch(recordURL(extId, key), { cache: 'no-store' });
  } catch {
    throw namedError('ServerUnreachable');
  }
  if (res.status === 404) return { found: false };
  if (!res.ok) throw namedError('ServerError');
  const payload = (await res.json().catch(() => null)) as { value?: unknown } | null;
  return { found: true, value: payload?.value };
}

/** Write one server-scoped record. */
export async function extServerSet(extId: string, key: string, value: unknown): Promise<void> {
  if (!EXT_KEY_RE.test(key)) throw namedError('InvalidKey');
  let body: string;
  try {
    body = JSON.stringify({ value: value ?? null });
  } catch {
    throw namedError('NotSerializable');
  }
  if (body.length > EXT_VALUE_MAX + 64) throw namedError('QuotaExceededError');
  let res: Response;
  try {
    res = await authFetch(recordURL(extId, key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body,
    });
  } catch {
    throw namedError('ServerUnreachable');
  }
  if (res.status === 413) throw namedError('QuotaExceededError');
  if (!res.ok) throw namedError('ServerError');
}
