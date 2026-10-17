import { authFetch } from '../../../lib/api';
import { fallbackWallpaperFilename, filenameFromContentDisposition } from './filename';
import { storeLiveStream } from './storage';
import type {
  BackgroundLiveWallpaperPage,
  BackgroundLiveWallpaperProvider,
  BackgroundLiveWallpaperResult,
} from '../types';

/**
 * Browser side of the live-wallpaper providers.
 *
 * It is deliberately provider-agnostic: the server owns the provider registry
 * and the site-specific parsing, and this module only maps its JSON to the
 * background-parameter types. A cached provider list keeps the Settings panel
 * from re-fetching on every open.
 */

const BASE = '/api/lives2d';

/** Reads the error body the server sends on a failed request. */
async function errorMessage(res: Response): Promise<string> {
  const text = (await res.text().catch(() => '')).trim();
  return text || `Request failed with HTTP ${res.status}`;
}

let providersCache: Promise<BackgroundLiveWallpaperProvider[]> | null = null;

/** The registered providers, fetched once per session. */
export function listLiveWallpaperProviders(): Promise<BackgroundLiveWallpaperProvider[]> {
  if (!providersCache) {
    providersCache = fetchProviders().catch((error) => {
      providersCache = null;
      throw error;
    });
  }
  return providersCache;
}

async function fetchProviders(): Promise<BackgroundLiveWallpaperProvider[]> {
  const res = await authFetch(`${BASE}/providers`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await errorMessage(res));
  const body = (await res.json()) as { providers?: BackgroundLiveWallpaperProvider[] };
  return Array.isArray(body.providers) ? body.providers : [];
}

/** Search one provider for one page (1-based). */
export async function searchLiveWallpapers(
  provider: string,
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<BackgroundLiveWallpaperPage> {
  const params = new URLSearchParams({
    provider,
    q: query,
    page: String(page),
  });
  const res = await authFetch(`${BASE}/search?${params}`, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(await errorMessage(res));
  const body = (await res.json()) as Partial<BackgroundLiveWallpaperPage>;
  return {
    items: Array.isArray(body.items) ? body.items : [],
    page: typeof body.page === 'number' ? body.page : page,
    hasMore: body.hasMore === true,
  };
}

/** Download a result and persist it in the shared video OPFS library. */
export async function downloadLiveWallpaper(
  provider: string,
  result: BackgroundLiveWallpaperResult,
): Promise<string> {
  const params = new URLSearchParams({ provider, id: result.id });
  const res = await authFetch(`${BASE}/media?${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await errorMessage(res));

  const filename =
    filenameFromContentDisposition(res.headers.get('Content-Disposition')) ??
    fallbackWallpaperFilename(result);
  const type = res.headers.get('Content-Type') || 'video/mp4';

  // Stream straight into the wallpaper OPFS library so a 4K wallpaper never
  // has to fit in memory (and never lands in the Video clip library).
  if (res.body) return storeLiveStream(res.body, filename, type);
  const blob = await res.blob();
  return storeLiveStream(blob.stream(), filename, blob.type || type);
}
