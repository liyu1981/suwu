import { getDefaultStore } from 'jotai';
import { atom } from 'jotai';
import { authFetch } from '../../lib/api';
import { registerBackground } from './registry';
import type {
  BackgroundCredit,
  BackgroundEngine,
  BackgroundModule,
  BackgroundParam,
} from './types';

/**
 * External WebGPU backgrounds: directories served by the backend from the data
 * dir (plus the embedded builtin, which arrives through the same list — the
 * frontend never special-cases it).
 *
 * Lifecycle: hydrate from the localStorage cache synchronously before the
 * first render (so a stored selection resolves with no flash), then revalidate
 * against GET /api/backgrounds after mount and bump `backgroundsRevisionAtom`
 * so consumers re-resolve the synchronous registry.
 *
 * A background's implementation is imported lazily, only when it starts: its
 * `scene.js` exports `create(api)` and receives the shared engine + vgpu, so a
 * data-dir module never needs a bare specifier the browser cannot resolve.
 */

/** Bumped when the external background list changes. */
export const backgroundsRevisionAtom = atom(0);

const CACHE_KEY = 'suwu:external-backgrounds';
const LIST_URL = '/api/backgrounds';
const BASE = '/backgrounds/webgpu/';

interface ExternalOption {
  value: string;
  label?: string;
}

interface ExternalParam {
  kind: string;
  key: string;
  label?: string;
  hint?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  /** JSON stand-in for the in-bundle `format` callback. */
  decimals?: number;
  suffix?: string;
  options?: ExternalOption[];
  placeholder?: string;
  maxLength?: number;
}

interface ExternalCredit {
  author?: string;
  url?: string;
  license?: string;
}

export interface ExternalManifest {
  id: string;
  label?: string;
  engine?: string;
  credit?: ExternalCredit;
  params?: ExternalParam[];
}

/** The API passed to a background's `create(api)`. */
type SceneFactory = (api: Record<string, unknown>) => BackgroundModule | Promise<BackgroundModule>;

/** Builds the numeric slider formatter from the JSON decimals/suffix fields. */
function makeFormat(decimals?: number, suffix?: string): ((value: number) => string) | undefined {
  if (decimals === undefined && !suffix) return undefined;
  return (value: number) =>
    `${decimals === undefined ? String(value) : value.toFixed(decimals)}${suffix ?? ''}`;
}

/** Converts one manifest parameter; null when it does not fit the schema. */
function toParam(p: ExternalParam): BackgroundParam | null {
  if (!p || typeof p.key !== 'string' || p.key === '') return null;
  const base = { key: p.key, label: p.label || p.key, hint: p.hint || undefined };
  switch (p.kind) {
    case 'number': {
      if (typeof p.default !== 'number' || typeof p.min !== 'number' || typeof p.max !== 'number') {
        return null;
      }
      return {
        ...base,
        kind: 'number',
        default: p.default,
        min: p.min,
        max: p.max,
        step: p.step,
        format: makeFormat(p.decimals, p.suffix),
      };
    }
    case 'boolean':
      if (typeof p.default !== 'boolean') return null;
      return { ...base, kind: 'boolean', default: p.default };
    case 'select':
      if (typeof p.default !== 'string' || !Array.isArray(p.options) || p.options.length === 0) {
        return null;
      }
      return {
        ...base,
        kind: 'select',
        default: p.default,
        options: p.options.map((o) => ({
          value: String(o.value),
          label: String(o.label ?? o.value),
        })),
      };
    case 'text':
      if (typeof p.default !== 'string') return null;
      return {
        ...base,
        kind: 'text',
        default: p.default,
        placeholder: p.placeholder || undefined,
        maxLength: p.maxLength,
      };
    case 'color':
      if (typeof p.default !== 'string') return null;
      return { ...base, kind: 'color', default: p.default };
    default:
      // fileList and friends need JS callbacks; the server rejects them too.
      return null;
  }
}

function registerFromManifest(m: ExternalManifest): void {
  if (!m || typeof m.id !== 'string' || m.id === '') return;
  const params = (m.params ?? []).map(toParam).filter((p): p is BackgroundParam => p !== null);
  const credit: BackgroundCredit | undefined =
    m.credit && m.credit.author
      ? { author: m.credit.author, url: m.credit.url, license: m.credit.license }
      : undefined;
  registerBackground({
    id: m.id,
    label: m.label || m.id,
    engine: m.engine as BackgroundEngine | undefined,
    credit,
    params,
    gpu: () => loadExternalScene(m.id),
  });
}

/** Bumps the revision outside React (the default jotai store). */
function bumpRevision(): void {
  getDefaultStore().set(backgroundsRevisionAtom, (n) => n + 1);
}

/** Imports a background's scene.js and runs its factory with the engine API. */
async function loadExternalScene(id: string): Promise<BackgroundModule> {
  const [engine, vgpu] = await Promise.all([
    import('./webgpu/webgpu-render-engine'),
    import('vgpu'),
  ]);
  const mod = (await import(/* @vite-ignore */ `${BASE}${id}/scene.js`)) as {
    default?: SceneFactory;
    create?: SceneFactory;
  };
  const factory = mod.default ?? mod.create;
  if (typeof factory !== 'function') {
    throw new Error(`background "${id}": scene.js has no default export`);
  }
  return await factory({ ...engine, vgpu });
}

function readCache(): ExternalManifest[] {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ExternalManifest[]) : [];
  } catch {
    // Missing or corrupt cache: treat as empty.
    return [];
  }
}

/**
 * Synchronous hydration from the localStorage cache. Call before the first
 * render so a stored external background resolves without a fallback flash.
 * Failures are ignored — the background stays the default.
 */
export function hydrateExternalBackgrounds(): void {
  const items = readCache();
  for (const m of items) registerFromManifest(m);
}

/**
 * Fetches the authoritative list, registers every background, caches it, and
 * bumps the revision. Never throws: a failed fetch keeps the cached set and
 * leaves the default background working.
 *
 * Concurrent calls share one request — the shell already fetches on mount, and
 * the settings screen re-fetches when it opens.
 */
let inflight: Promise<void> | null = null;

export function loadExternalBackgrounds(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchExternalBackgrounds().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function fetchExternalBackgrounds(): Promise<void> {
  try {
    const res = await authFetch(LIST_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { backgrounds?: ExternalManifest[] };
    const items = Array.isArray(data.backgrounds) ? data.backgrounds : [];
    for (const m of items) registerFromManifest(m);
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(items));
    } catch {
      // localStorage unavailable (private mode): revalidation still works.
    }
    bumpRevision();
  } catch (error) {
    console.warn('[background] external background list unavailable', error);
    return;
  }
}
