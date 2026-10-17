import type { BackgroundLiveWallpaperResult } from '../types';

/**
 * Pure filename helpers for downloaded wallpapers. Kept free of any imports so
 * the Node regression check (`scripts/check-lives2d.mjs`) can load them without
 * a bundler or DOM.
 */

/**
 * Extract a filename from a Content-Disposition header. Handles both the plain
 * `filename="…"` form and the RFC 5987 `filename*=UTF-8''…` form, preferring
 * the latter. Returns null when the header carries no filename.
 */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (extended) {
    // e.g. UTF-8''naruto-blue-sky-moewalls-com.mp4
    const value = extended[1].trim().replace(/^["']|["']$/g, '');
    const parts = value.split("''");
    const encoded = parts.length > 1 ? parts.slice(1).join("''") : value;
    try {
      const decoded = decodeURIComponent(encoded).trim();
      if (decoded) return decoded;
    } catch {
      // Malformed encoding: fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(header);
  if (plain) {
    const value = (plain[2] ?? plain[3] ?? '').trim().replace(/^["']|["']$/g, '');
    if (value) return value;
  }
  return null;
}

/** A `.mp4` name derived from a result title, used when the origin omits one. */
export function fallbackWallpaperFilename(
  result: Pick<BackgroundLiveWallpaperResult, 'title'>,
): string {
  const base = result.title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || 'wallpaper'}.mp4`;
}
