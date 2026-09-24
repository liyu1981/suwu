/**
 * Login-avatar helpers.
 *
 * The avatar is resolved client-side from the System Settings choice: a
 * Gravatar fetched from the MD5 hash of the user's email, an image the user
 * uploaded (downscaled to a data URL kept in localStorage), or — the default
 * and the fallback for every failure mode — the Suwu logo.
 */

import type { AvatarSettings } from '../store/settings';

/** Fallback image when nothing is configured or the chosen source fails to load. */
export const AVATAR_FALLBACK_SRC = '/logo.svg';

/** Longest edge of an uploaded avatar in px — keeps the localStorage payload small. */
export const AVATAR_UPLOAD_MAX = 512;

/** Upper bound on the stored data URL, well inside the ~5MB localStorage quota. */
export const AVATAR_MAX_DATA_URL = 3_000_000;

/** Why an uploaded picture was rejected; mapped to an i18n key by the caller. */
export type AvatarUploadErrorCode = 'type' | 'decode' | 'encode' | 'quota';

export class AvatarUploadError extends Error {
  readonly code: AvatarUploadErrorCode;

  constructor(code: AvatarUploadErrorCode) {
    super(code);
    this.name = 'AvatarUploadError';
    this.code = code;
  }
}

/**
 * MD5 hex digest — Gravatar identifies avatars by the hash of the normalized
 * email, and Web Crypto deliberately does not offer MD5, so this is the
 * RFC 1321 implementation over the UTF-8 bytes of the input.
 */
export function md5(message: string): string {
  const bytes = new TextEncoder().encode(message);
  // Pad to 64-byte blocks: 0x80 marker plus the 64-bit little-endian bit length.
  const padded = (((bytes.length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(padded);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(padded - 8, bitLength >>> 0, true);
  view.setUint32(padded - 4, Math.floor(bitLength / 0x100000000), true);

  // Per-round left-rotate amounts: S1, S2, S3, S4 of RFC 1321.
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  // K[i] = floor(abs(sin(i + 1)) * 2^32).
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let offset = 0; offset < padded; offset += 64) {
    const m = new Uint32Array(16);
    for (let j = 0; j < 16; j++) m[j] = view.getUint32(offset + j * 4, true);

    let aa = a;
    let bb = b;
    let cc = c;
    let dd = d;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (bb & cc) | (~bb & dd);
        g = i;
      } else if (i < 32) {
        f = (dd & bb) | (~dd & cc);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = bb ^ cc ^ dd;
        g = (3 * i + 5) % 16;
      } else {
        f = cc ^ (bb | ~dd);
        g = (7 * i) % 16;
      }
      const sum = (aa + f + k[i] + m[g]) >>> 0;
      const rotated =
        ((sum << shifts[Math.floor(i / 16) * 4 + (i % 4)]) |
          (sum >>> (32 - shifts[Math.floor(i / 16) * 4 + (i % 4)]))) >>>
        0;
      const carry = dd;
      dd = cc;
      cc = bb;
      bb = (bb + rotated) >>> 0;
      aa = carry;
    }

    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  let out = '';
  for (const word of [a, b, c, d]) {
    for (let i = 0; i < 4; i++) out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Gravatar URL for an email, or null when no email is configured.
 *
 * `d=404` asks Gravatar to fail for unknown emails so the `<img>` fires
 * `onerror` and the caller can swap in the Suwu logo instead of Gravatar's
 * mystery-person placeholder.
 */
export function gravatarUrl(email: string, size: number): string | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const s = Math.max(1, Math.min(512, Math.round(size)));
  return `https://www.gravatar.com/avatar/${md5(normalized)}?s=${s}&d=404`;
}

/**
 * Resolve the stored settings to an image source for an avatar of `size` CSS
 * pixels (Gravatar is fetched at 2×, capped at 512px, for sharpness on
 * retina displays). Anything unset or unavailable falls back to the logo.
 */
export function resolveAvatarSrc(settings: AvatarSettings, size: number): string {
  if (settings.source === 'upload') return settings.image || AVATAR_FALLBACK_SRC;
  if (settings.source === 'gravatar')
    return gravatarUrl(settings.email, size * 2) ?? AVATAR_FALLBACK_SRC;
  return AVATAR_FALLBACK_SRC;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new AvatarUploadError('decode'));
    image.src = src;
  });
}

/**
 * Decode an uploaded picture, downscale it to at most `AVATAR_UPLOAD_MAX` on
 * its longest edge, and return a data URL sized to survive a localStorage
 * round-trip. WebP when the browser can encode it, PNG otherwise.
 */
export async function readAvatarImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new AvatarUploadError('type');
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const scale = Math.min(
      1,
      AVATAR_UPLOAD_MAX / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new AvatarUploadError('encode');
    ctx.drawImage(image, 0, 0, width, height);
    const webp = canvas.toDataURL('image/webp', 0.92);
    const dataUrl = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
    if (dataUrl.length > AVATAR_MAX_DATA_URL) throw new AvatarUploadError('quota');
    return dataUrl;
  } catch (error) {
    throw error instanceof AvatarUploadError ? error : new AvatarUploadError('decode');
  } finally {
    URL.revokeObjectURL(url);
  }
}
