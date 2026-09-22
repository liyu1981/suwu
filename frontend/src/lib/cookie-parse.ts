/** Parsing helpers for `Set-Cookie` response headers and `Cookie` strings. */

export type SameSite = 'Strict' | 'Lax' | 'None';

export interface ParsedSetCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number; // epoch ms
  maxAge?: number; // seconds
  secure: boolean;
  httpOnly: boolean;
  sameSite?: SameSite;
}

export interface CookiePair {
  name: string;
  value: string;
}

/**
 * Parse a single `Set-Cookie` header value. Returns null when the header is
 * malformed (no `=`).
 */
export function parseSetCookie(header: string): ParsedSetCookie | null {
  const segments = header.split(';');
  const [pair, ...attrs] = segments;
  const eq = pair.indexOf('=');
  if (eq < 0) return null;

  const name = pair.slice(0, eq).trim();
  if (!name) return null;
  const value = pair.slice(eq + 1).trim();

  const cookie: ParsedSetCookie = { name, value, secure: false, httpOnly: false };

  for (const attr of attrs) {
    const trimmed = attr.trim();
    if (!trimmed) continue;
    const attrEq = trimmed.indexOf('=');
    const key = (attrEq < 0 ? trimmed : trimmed.slice(0, attrEq)).trim().toLowerCase();
    const attrValue = attrEq < 0 ? '' : trimmed.slice(attrEq + 1).trim();

    switch (key) {
      case 'domain':
        cookie.domain = attrValue.replace(/^\./, '').toLowerCase();
        break;
      case 'path':
        cookie.path = attrValue || undefined;
        break;
      case 'expires': {
        const ts = Date.parse(attrValue);
        if (!Number.isNaN(ts)) cookie.expires = ts;
        break;
      }
      case 'max-age': {
        const seconds = Number.parseInt(attrValue, 10);
        if (!Number.isNaN(seconds)) cookie.maxAge = seconds;
        break;
      }
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite': {
        const normalized = attrValue.toLowerCase();
        if (normalized === 'strict') cookie.sameSite = 'Strict';
        else if (normalized === 'lax') cookie.sameSite = 'Lax';
        else if (normalized === 'none') cookie.sameSite = 'None';
        break;
      }
      default:
        break;
    }
  }

  return cookie;
}

/**
 * Parse a `Cookie:` header value or a `document.cookie` string
 * (`a=1; b=2`) into name/value pairs.
 */
export function parseCookieString(raw: string): CookiePair[] {
  const pairs: CookiePair[] = [];
  for (const segment of raw.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed || trimmed.startsWith('$')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name) pairs.push({ name, value });
  }
  return pairs;
}
