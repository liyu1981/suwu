import { clamp } from '../../../lib/utils';
import type { AmbientBlobPalette, AmbientBlobParams, BlobSeed, RenderBlob } from './types';

/** Candidate hues for blob generation. */
const HUES = [200, 260, 320, 170, 30, 355];

const LIGHT = { sat: 95, light: 74, alpha: 0.45, count: 12 };
const DARK = { sat: 95, light: 60, alpha: 0.55, count: 12 };

/** The gradient's solid core, as a fraction of the blob radius. */
export const BLOB_CORE_STOP = 0.6;

/** Defaults applied when a caller does not override them. */
export const AMBIENT_BLOB_DEFAULTS: AmbientBlobParams = { palette: 'auto' };

/** Deterministic PRNG (mulberry32) so tests can reproduce blob fields. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isDarkDocument(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

function resolvePalette(palette: AmbientBlobPalette): {
  sat: number;
  light: number;
  alpha: number;
  count: number;
} {
  const dark = palette === 'dark' || (palette === 'auto' && isDarkDocument());
  return dark ? DARK : LIGHT;
}

/** Build the random blob seeds for a palette. */
export function makeBlobs(
  palette: AmbientBlobPalette,
  reducedTransparency: boolean,
  random: () => number = Math.random,
): BlobSeed[] {
  const base = resolvePalette(palette);
  const alpha = reducedTransparency ? base.alpha * 0.55 : base.alpha;
  return Array.from({ length: base.count }, () => {
    const hue = HUES[Math.floor(random() * HUES.length)] + (random() * 24 - 12);
    return {
      rx: random(),
      ry: random(),
      radius: 0.07 + random() * 0.18,
      hue: ((hue % 360) + 360) % 360,
      sat: clamp(base.sat + (random() * 12 - 6), 0, 100),
      light: clamp(base.light + (random() * 10 - 5), 0, 100),
      alpha: Math.max(0.08, alpha + (random() * 0.12 - 0.06)),
      vx: (random() * 2 - 1) * 16,
      vy: (random() * 2 - 1) * 16,
      ampX: 20 + random() * 50,
      ampY: 20 + random() * 50,
      phase: random() * Math.PI * 2,
      freq: 0.04 + random() * 0.1,
    };
  });
}

function wrap(value: number, min: number, max: number): number {
  const range = max - min;
  return ((((value - min) % range) + range) % range) + min;
}

/** Standard HSL -> sRGB (all channels in [0, 1]). */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  if (sat === 0) return [light, light, light];
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}

/**
 * Advance every blob to time `t` (seconds) for a viewport `width` x `height`.
 * Both the CPU and GPU backends consume this so they stay in lockstep.
 */
export function computeBlobFrame(
  blobs: readonly BlobSeed[],
  t: number,
  width: number,
  height: number,
): RenderBlob[] {
  const base = Math.min(width, height);
  return blobs.map((blob) => {
    const x = wrap(
      blob.rx * width + blob.ampX * Math.sin(t * blob.freq + blob.phase) + blob.vx * t,
      -200,
      width + 200,
    );
    const y = wrap(
      blob.ry * height + blob.ampY * Math.cos(t * blob.freq * 0.8 + blob.phase * 1.3) + blob.vy * t,
      -200,
      height + 200,
    );
    const radius = blob.radius * base * (1 + 0.08 * Math.sin(t * 0.3 + blob.phase));
    const hue = (blob.hue + t * 1.2) % 360;
    return { x, y, radius, color: hslToRgb(hue, blob.sat, blob.light), alpha: blob.alpha };
  });
}

/** Read typed ambient-blob params out of the opaque subsystem params bag. */
export function resolveParams(params?: Record<string, unknown>): AmbientBlobParams {
  const palette = params?.palette;
  return {
    palette:
      palette === 'light' || palette === 'dark' || palette === 'auto'
        ? palette
        : AMBIENT_BLOB_DEFAULTS.palette,
  };
}

/** Whether the user prefers reduced transparency (frostier materials). */
export function prefersReducedTransparency(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-transparency: reduce)').matches
  );
}
