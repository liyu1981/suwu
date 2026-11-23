import { adoptToken, authFetch, fetchJson, getCurrentSession } from './api';

/**
 * The devices signed in to this server.
 *
 * One session per device means a phone and a desktop stop evicting each other;
 * this is the list that makes that visible, and the place to sign a lost phone
 * out. docs/AUTH_SESSIONS_PLAN.md §4.3.
 */
export interface LoginSession {
  id: string;
  label: string;
  created: string;
  lastSeen: string;
  expires: string;
  current: boolean;
  legacy?: boolean;
}

export function fetchSessions(): Promise<{ sessions: LoginSession[] }> {
  return fetchJson<{ sessions: LoginSession[] }>('/api/sessions');
}

/** Revokes one session. If it was this browser's, the answer carries a new token. */
export async function revokeSession(id: string): Promise<void> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
  if (!res.ok) throw new Error(body?.error || `revoke failed (${res.status})`);
  if (body?.token) adoptToken(body.token);
}

/**
 * Signs out every other device. With `keepCurrent` false the caller is signed out
 * too, and the server hands back a fresh session so the page stays usable.
 */
export async function revokeOtherSessions(keepCurrent = true): Promise<number> {
  const res = await authFetch('/api/sessions/revoke-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ keepCurrent }),
  });
  const body = (await res.json().catch(() => null)) as {
    revoked?: number;
    token?: string;
    error?: string;
  } | null;
  if (!res.ok) throw new Error(body?.error || `sign out failed (${res.status})`);
  if (body?.token) adoptToken(body.token);
  return body?.revoked ?? 0;
}

/** The session this browser is using, when it is known. */
export { getCurrentSession };

/** "2 hours ago" / "in 29 days", in the reader's locale. */
export function relativeStamp(stamp: string, now = Date.now()): string {
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return '—';
  const diff = t - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return 'now';
  if (abs < hour) return rtf.format(Math.round(diff / minute), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  return rtf.format(Math.round(diff / day), 'day');
}
