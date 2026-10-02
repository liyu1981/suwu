/**
 * Backup — the on-the-wire container.
 *
 * A backup file is a magic string, a big-endian uint32 header length, a JSON
 * header, and the AES-GCM ciphertext. The header is unencrypted on purpose:
 * everything in it (version, KDF parameters, timestamps) is metadata the UI
 * and the server need before a key exists, and nothing sensitive ever goes
 * there. The header bytes are passed to AES-GCM as additional authenticated
 * data, so tampering with any of them invalidates the tag (see crypto.ts).
 *
 * The server reads only the magic and the header length to reject garbage; it
 * never parses the rest. Layout mirrors pkg/backup/backup.go.
 */

import { CONTAINER_VERSION, BackupFormatError, type Payload } from './types.ts';

const MAGIC = 'SUWUBK1';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);

/** KDF and wrapping parameters, stored in the clear header. */
export interface HeaderKdf {
  alg: 'PBKDF2-SHA256';
  iter: number;
  /** base64, 16 bytes. */
  salt: string;
}

export interface HeaderWrap {
  /** The wrapped data key: AES-GCM(DEK) under the passphrase-derived key. */
  alg: 'AES-256-GCM';
  /** base64, 12 bytes — IV used to wrap the DEK. */
  wrapNonce: string;
  /** base64 — the data key wrapped under the KEK. */
  wrapCt: string;
  /** base64, 12 bytes — IV used to encrypt this container's payload. */
  iv: string;
}

export interface Header {
  v: number;
  kdf: HeaderKdf;
  wrap: HeaderWrap;
  /** Generation number, informational; the server assigns its own. */
  gen: number;
  /** ISO timestamp of when this container was produced. */
  createdAt: string;
  /** base64 SHA-256 of the plaintext, checked after decrypt. */
  plaintextSha256: string;
}

const HEADER_LIMIT = 64 * 1024;

/**
 * Builds the binary container from a header and the already-encrypted
 * ciphertext. The header is serialized once and returned so the caller can use
 * the identical bytes as AAD.
 */
export function pack(
  header: Header,
  ciphertext: Uint8Array,
): { bytes: Uint8Array; headerBytes: Uint8Array } {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.length > HEADER_LIMIT) {
    throw new BackupFormatError('backup header too large');
  }
  const out = new Uint8Array(MAGIC_BYTES.length + 4 + headerBytes.length + ciphertext.length);
  out.set(MAGIC_BYTES, 0);
  new DataView(out.buffer).setUint32(MAGIC_BYTES.length, headerBytes.length, false);
  out.set(headerBytes, MAGIC_BYTES.length + 4);
  out.set(ciphertext, MAGIC_BYTES.length + 4 + headerBytes.length);
  return { bytes: out, headerBytes };
}

/** The parsed result of a container. */
export interface Unpacked {
  header: Header;
  headerBytes: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Parses a container back into its header and ciphertext, validating the
 * prologue and header shape. Throws BackupFormatError on anything malformed.
 */
export function unpack(bytes: Uint8Array): Unpacked {
  const minLen = MAGIC_BYTES.length + 4;
  if (bytes.length < minLen) {
    throw new BackupFormatError('backup is truncated');
  }
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) {
      throw new BackupFormatError('not a Suwu backup file');
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(MAGIC_BYTES.length, false);
  if (headerLen === 0 || headerLen > HEADER_LIMIT || minLen + headerLen > bytes.length) {
    throw new BackupFormatError('backup header length is invalid');
  }
  const headerStart = minLen;
  let header: Header;
  try {
    const json = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLen));
    header = JSON.parse(json) as Header;
  } catch {
    throw new BackupFormatError('backup header is not valid JSON');
  }
  if (header.v !== CONTAINER_VERSION) {
    throw new BackupFormatError(`this backup was made by a newer Suwu (container v${header.v})`);
  }
  return {
    header,
    headerBytes: bytes.slice(headerStart, headerStart + headerLen),
    ciphertext: bytes.slice(headerStart + headerLen),
  };
}

/** base64 helper. btoa/atob exist in browsers and modern Node (used by the check scripts). */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Inverse of toBase64. */
export function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64 SHA-256 of a UTF-8 string, via WebCrypto. */
export async function sha256Base64(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toBase64(new Uint8Array(digest));
}

/**
 * Canonical JSON: object keys sorted recursively so that an unchanged payload
 * always serializes to the same bytes (and therefore the same hash). Without
 * this, key insertion order would make two identical backups differ and defeat
 * the change-detection dedup.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortValue(src[key]);
    return out;
  }
  return value;
}

/** Serializes a payload canonically and returns its text and hash. */
export async function serializePayload(payload: Payload): Promise<{ text: string; hash: string }> {
  const text = canonicalJSON(payload);
  return { text, hash: await sha256Base64(text) };
}
