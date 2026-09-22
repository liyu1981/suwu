/**
 * A minimal RFC 6265 cookie jar, owned entirely by the frontend.
 *
 * The backend is stateless, so the jar is materialized into a `Cookie` request
 * header at send time and updated from the multi-value `Set-Cookie` response
 * headers. See docs/REST_HELPER_PLAN.md §5.7.
 */

import { parseCookieString, parseSetCookie, type SameSite } from './cookie-parse';

export interface JarCookie {
  /** Stable key: `domain|path|name`. */
  id: string;
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: SameSite;
  hostOnly: boolean;
  createdAt: number;
}

export function cookieKey(cookie: Pick<JarCookie, 'domain' | 'path' | 'name'>): string {
  return `${cookie.domain}|${cookie.path}|${cookie.name}`;
}

/** RFC 6265 §5.1.4 default-path algorithm. */
export function defaultPath(pathname: string): string {
  if (!pathname || !pathname.startsWith('/')) return '/';
  if (pathname === '/') return '/';
  const lastSlash = pathname.lastIndexOf('/');
  if (lastSlash === 0) return '/';
  return pathname.slice(0, lastSlash);
}

function domainMatches(host: string, domain: string, hostOnly: boolean): boolean {
  if (hostOnly) return host === domain;
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith('/')) return true;
  return requestPath.charAt(cookiePath.length) === '/';
}

/** True when the cookie may be sent to `url` at time `now`. */
export function cookieMatchesURL(cookie: JarCookie, url: string, now = Date.now()): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (cookie.secure && parsed.protocol !== 'https:') return false;
  if (cookie.expires !== null && cookie.expires <= now) return false;
  const host = parsed.hostname.toLowerCase();
  if (!domainMatches(host, cookie.domain, cookie.hostOnly)) return false;
  return pathMatches(parsed.pathname || '/', cookie.path || '/');
}

/** Build the outgoing `Cookie` header value for a URL, or "" when none match. */
export function buildCookieHeader(cookies: JarCookie[], url: string, now = Date.now()): string {
  return cookies
    .filter((cookie) => cookieMatchesURL(cookie, url, now))
    .sort((a, b) => {
      const byPath = (b.path?.length ?? 0) - (a.path?.length ?? 0);
      return byPath !== 0 ? byPath : a.createdAt - b.createdAt;
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/**
 * Apply the `Set-Cookie` headers captured from a response to the jar. Returns a
 * new array; expired/`Max-Age<=0` cookies are removed.
 */
export function applySetCookies(
  cookies: JarCookie[],
  url: string,
  setCookieHeaders: string[],
  now = Date.now(),
): JarCookie[] {
  let parsedURL: URL;
  try {
    parsedURL = new URL(url);
  } catch {
    return cookies;
  }
  const host = parsedURL.hostname.toLowerCase();
  const map = new Map(cookies.map((cookie) => [cookie.id, cookie]));

  for (const header of setCookieHeaders) {
    const parsed = parseSetCookie(header);
    if (!parsed) continue;

    // Reject Domain attributes that don't domain-match the request host.
    const hostOnly = !parsed.domain;
    const domain = (parsed.domain ?? host).toLowerCase();
    if (!hostOnly && !domainMatches(host, domain, false)) continue;

    const path = parsed.path || defaultPath(parsedURL.pathname || '/');
    const key = cookieKey({ domain, path, name: parsed.name });

    let expires: number | null = null;
    if (typeof parsed.maxAge === 'number') {
      expires = parsed.maxAge <= 0 ? 0 : now + parsed.maxAge * 1000;
    } else if (typeof parsed.expires === 'number') {
      expires = parsed.expires;
    }

    if (expires !== null && expires <= now) {
      map.delete(key);
      continue;
    }

    const existing = map.get(key);
    map.set(key, {
      id: key,
      name: parsed.name,
      value: parsed.value,
      domain,
      path,
      expires,
      secure: parsed.secure,
      httpOnly: parsed.httpOnly,
      sameSite: parsed.sameSite,
      hostOnly,
      createdAt: existing?.createdAt ?? now,
    });
  }

  return [...map.values()];
}

/** Import a `Cookie`/`document.cookie` string as host-only cookies for `host`. */
export function importCookieString(
  cookies: JarCookie[],
  host: string,
  raw: string,
  now = Date.now(),
): JarCookie[] {
  const normalizedHost = host.toLowerCase();
  const map = new Map(cookies.map((cookie) => [cookie.id, cookie]));
  for (const pair of parseCookieString(raw)) {
    const key = cookieKey({ domain: normalizedHost, path: '/', name: pair.name });
    const existing = map.get(key);
    map.set(key, {
      id: key,
      name: pair.name,
      value: pair.value,
      domain: normalizedHost,
      path: '/',
      expires: null,
      secure: false,
      httpOnly: false,
      hostOnly: true,
      createdAt: existing?.createdAt ?? now,
    });
  }
  return [...map.values()];
}

/** Returns `document.cookie` as a raw string (empty when unavailable). */
export function readDocumentCookie(): string {
  try {
    return typeof document !== 'undefined' ? document.cookie : '';
  } catch {
    return '';
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
