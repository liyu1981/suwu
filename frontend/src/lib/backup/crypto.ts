/**
 * Backup — client-side encryption.
 *
 * Zero-knowledge by construction: the server stores ciphertext and never holds
 * a key. The schedule is
 *
 *   passphrase --PBKDF2-SHA256(salt, iter)-->  KEK (256-bit)
 *   random DEK (256-bit, minted once per slot) --AES-GCM(KEK)--> wrap
 *   plaintext --AES-GCM(DEK, iv, aad=header)--> ciphertext
 *
 * So the passphrase wraps a stable data key: changing the passphrase re-wraps
 * the small DEK instead of re-uploading history. `wrap` and `iv` live in the
 * clear header of every container, and the header bytes are the AES-GCM
 * additional authenticated data — so the server cannot tamper with the KDF
 * parameters, the wrapped key, the IV, or the timestamps without the content
 * tag failing to verify.
 */

import {
  fromBase64,
  pack,
  serializePayload,
  sha256Base64,
  toBase64,
  unpack,
  type Header,
  type HeaderKdf,
  type HeaderWrap,
} from './container.ts';
import { BackupDecryptError, BackupFormatError, CONTAINER_VERSION, type Payload } from './types.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** OWASP's floor for PBKDF2-HMAC-SHA256; ~0.5 s, paid once per session. */
const KDF_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

/** Derives the key-encryption key from the passphrase. */
async function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** The in-memory per-session key material. Never written to storage. */
interface SlotKey {
  dek: CryptoKey;
  salt: Uint8Array;
  iterations: number;
  wrapNonce: Uint8Array;
  wrapCt: Uint8Array;
}

let cachedKey: SlotKey | null = null;

/** Drops the in-memory data key (on disable, logout, or passphrase change). */
export function clearKeyCache(): void {
  cachedKey = null;
}

/** Whether an upload can be encrypted right now. */
export function hasKey(): boolean {
  return cachedKey !== null;
}

/**
 * Mints fresh slot key material for a passphrase: a random DEK wrapped under
 * the passphrase-derived KEK. The wrap pieces go into the clear header of every
 * container; the DEK stays in memory (and, wrapped, on the server).
 *
 * Called when backup is enabled or the passphrase changes.
 */
export async function initSlotKey(
  passphrase: string,
): Promise<{ kdf: HeaderKdf; wrap: HeaderWrap }> {
  const salt = randomBytes(SALT_BYTES);
  const kek = await deriveKek(passphrase, salt, KDF_ITERATIONS);
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: KEY_BITS }, true, [
    'encrypt',
    'decrypt',
  ]);
  const wrapNonce = randomBytes(IV_BYTES);
  // The DEK is exported only to be wrapped by the KEK; it is never stored raw.
  const rawDek = new Uint8Array(await crypto.subtle.exportKey('raw', dek));
  const wrapCt = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapNonce as BufferSource }, kek, rawDek),
  );
  cachedKey = { dek, salt, iterations: KDF_ITERATIONS, wrapNonce, wrapCt };
  return {
    kdf: { alg: 'PBKDF2-SHA256', iter: KDF_ITERATIONS, salt: toBase64(salt) },
    wrap: {
      alg: 'AES-256-GCM',
      wrapNonce: toBase64(wrapNonce),
      wrapCt: toBase64(wrapCt),
      iv: toBase64(randomBytes(IV_BYTES)), // replaced per upload; placeholder keeps the shape
    },
  };
}

/**
 * Re-wraps the *existing* DEK under a new passphrase, without touching the
 * data. The plaintext history is unaffected because it is encrypted under the
 * DEK, not the passphrase. Returns the new header pieces.
 */
export async function rewrapForNewPassphrase(
  newPassphrase: string,
): Promise<{ kdf: HeaderKdf; wrap: HeaderWrap }> {
  if (!cachedKey) {
    throw new BackupFormatError('no key to re-wrap; enable backup first');
  }
  const dek = cachedKey.dek;
  const salt = randomBytes(SALT_BYTES);
  const kek = await deriveKek(newPassphrase, salt, KDF_ITERATIONS);
  const rawDek = new Uint8Array(await crypto.subtle.exportKey('raw', dek));
  const wrapNonce = randomBytes(IV_BYTES);
  const wrapCt = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapNonce as BufferSource }, kek, rawDek),
  );
  cachedKey = { dek, salt, iterations: KDF_ITERATIONS, wrapNonce, wrapCt };
  return {
    kdf: { alg: 'PBKDF2-SHA256', iter: KDF_ITERATIONS, salt: toBase64(salt) },
    wrap: {
      alg: 'AES-256-GCM',
      wrapNonce: toBase64(wrapNonce),
      wrapCt: toBase64(wrapCt),
      iv: toBase64(randomBytes(IV_BYTES)),
    },
  };
}

/**
 * Encrypts a payload into a container using the cached slot key.
 *
 * The content IV is fresh per container; the header (which carries it, the
 * wrap, and the KDF parameters) is the AAD, so header and content are bound
 * together. Returns the container bytes and the plaintext size.
 */
export async function encryptPayload(
  payload: Payload,
  opts: { gen: number },
): Promise<{ bytes: Uint8Array; plaintextSize: number }> {
  if (!cachedKey) {
    throw new BackupFormatError('backup key not initialized');
  }
  const { text, hash } = await serializePayload(payload);
  const iv = randomBytes(IV_BYTES);

  const header: Header = {
    v: CONTAINER_VERSION,
    kdf: {
      alg: 'PBKDF2-SHA256',
      iter: cachedKey.iterations,
      salt: toBase64(cachedKey.salt),
    },
    wrap: {
      alg: 'AES-256-GCM',
      wrapNonce: toBase64(cachedKey.wrapNonce),
      wrapCt: toBase64(cachedKey.wrapCt),
      iv: toBase64(iv),
    },
    gen: opts.gen,
    createdAt: new Date().toISOString(),
    plaintextSha256: hash,
  };

  // The AAD is the serialized header bytes. pack() serializes the header
  // independently of the ciphertext, so packing with an empty ciphertext and
  // packing with the real one produce byte-identical headers — one extra
  // serialization, no circular dependency between AAD and payload length.
  const provPack = pack(header, new Uint8Array(0));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
        additionalData: provPack.headerBytes as BufferSource,
      },
      cachedKey.dek,
      enc.encode(text),
    ),
  );
  const finalPack = pack(header, ciphertext);
  return { bytes: finalPack.bytes, plaintextSize: enc.encode(text).length };
}

/**
 * Decrypts a container with a passphrase and adopts its DEK, so the next upload
 * reuses the same data key without the user re-entering anything.
 *
 * Throws BackupDecryptError on a wrong passphrase or damaged bytes — the two
 * are cryptographically indistinguishable, which is exactly the intent.
 */
export async function decryptPayload(
  bytes: Uint8Array,
  passphrase: string,
): Promise<{ payload: Payload; header: Header }> {
  const { header, headerBytes, ciphertext } = unpack(bytes);

  const salt = fromBase64(header.kdf.salt);
  const wrapNonce = fromBase64(header.wrap.wrapNonce);
  const wrapCt = fromBase64(header.wrap.wrapCt);
  const iterations = header.kdf.iter;

  const kek = await deriveKek(passphrase, salt, iterations);
  let rawDek: ArrayBuffer;
  try {
    rawDek = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: wrapNonce as BufferSource }, // wrap uses no AAD
      kek,
      wrapCt as BufferSource,
    );
  } catch {
    throw new BackupDecryptError('wrong passphrase, or the backup is damaged');
  }

  const dek = await crypto.subtle.importKey('raw', rawDek, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ]);

  const iv = fromBase64(header.wrap.iv);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: headerBytes as BufferSource },
      dek,
      ciphertext as BufferSource,
    );
  } catch {
    throw new BackupDecryptError('wrong passphrase, or the backup is damaged');
  }

  const text = dec.decode(plaintext);

  // Authenticated header carries the plaintext hash: verify it as a second
  // line of defence (belt and braces alongside the GCM tag).
  const hash = await sha256Base64(text);
  if (header.plaintextSha256 && header.plaintextSha256 !== hash) {
    throw new BackupDecryptError('backup contents do not match their recorded hash');
  }

  let payload: Payload;
  try {
    payload = JSON.parse(text) as Payload;
  } catch {
    throw new BackupFormatError('backup payload is not valid JSON');
  }
  if (typeof payload.v !== 'number') {
    throw new BackupFormatError('backup payload has no version');
  }
  if (payload.v > CONTAINER_VERSION) {
    throw new BackupFormatError(`this backup was made by a newer Suwu (payload v${payload.v})`);
  }

  // Adopt the slot key so the next upload encrypts under the same DEK.
  cachedKey = { dek, salt, iterations, wrapNonce, wrapCt };
  return { payload, header };
}

/** Minimum bar for a passphrase: 8+ characters. */
export function isPassphraseAcceptable(passphrase: string): boolean {
  return passphrase.trim().length >= 8;
}
