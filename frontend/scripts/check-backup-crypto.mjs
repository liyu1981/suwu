/**
 * Backup crypto round-trip and tamper checks.
 *
 * Runs the browser modules under node (WebCrypto is global there) to prove the
 * container survives a full encrypt → decrypt cycle and that every authenticated
 * field actually fails to verify when it is altered. Mirrors the checks the UI
 * depends on, with no browser in the loop.
 *
 *   node --experimental-strip-types scripts/check-backup-crypto.mjs
 */

import assert from 'node:assert/strict';
import { pack, unpack, toBase64, fromBase64, canonicalJSON, sha256Base64 } from '../src/lib/backup/container.ts';
import {
  encryptPayload,
  decryptPayload,
  initSlotKey,
  clearKeyCache,
  isPassphraseAcceptable,
} from '../src/lib/backup/crypto.ts';
import { PAYLOAD_VERSION } from '../src/lib/backup/types.ts';

const PASSPHRASE = 'correct horse battery staple';
const WRONG = 'not the passphrase';

function samplePayload(createdAt = 1770000000000) {
  return {
    v: PAYLOAD_VERSION,
    deviceId: 'device-under-test',
    createdAt,
    categories: ['settings', 'ext', 'layout'],
    items: [
      { ns: 'ls', path: 'suwu:background', mtime: 1, value: 'ambient' },
      { ns: 'ext', path: 'note/record', mtime: 2, value: { texts: ['hello'] } },
    ],
  };
}

// ── container shape ────────────────────────────────────────────────────
{
  const header = {
    v: 1,
    kdf: { alg: 'PBKDF2-SHA256', iter: 600000, salt: toBase64(new Uint8Array(16)) },
    wrap: { alg: 'AES-256-GCM', wrapNonce: toBase64(new Uint8Array(12)), wrapCt: toBase64(new Uint8Array(32)), iv: toBase64(new Uint8Array(12)) },
    gen: 3,
    createdAt: '2026-01-01T00:00:00Z',
    plaintextSha256: 'x',
  };
  const ct = new Uint8Array([1, 2, 3, 4]);
  const { bytes, headerBytes } = pack(header, ct);
  const magic = new TextDecoder().decode(bytes.subarray(0, 7));
  assert.equal(magic, 'SUWUBK1', 'container magic');
  const back = unpack(bytes);
  assert.deepEqual(back.header, header, 'header round-trip');
  assert.deepEqual([...back.ciphertext], [...ct], 'ciphertext round-trip');
  assert.deepEqual([...back.headerBytes], [...headerBytes], 'headerBytes stable (AAD)');

  // Malformed containers.
  assert.throws(() => unpack(bytes.subarray(0, 4)), /truncated/);
  const badMagic = bytes.slice();
  badMagic[0] = 'X'.charCodeAt(0);
  assert.throws(() => unpack(badMagic), /not a Suwu backup/);
  const lyingLen = bytes.slice();
  lyingLen[7] = 0xff;
  assert.throws(() => unpack(lyingLen), /invalid/);
}

// ── canonical JSON ─────────────────────────────────────────────────────
{
  assert.equal(
    canonicalJSON({ b: 1, a: { d: 2, c: 3 } }),
    canonicalJSON({ a: { c: 3, d: 2 }, b: 1 }),
    'key order must not change the canonical form',
  );
}

// ── base64 ─────────────────────────────────────────────────────────────
{
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual([...fromBase64(toBase64(bytes))], [...bytes], 'base64 round-trip');
}

// ── encrypt → decrypt ──────────────────────────────────────────────────
await initSlotKey(PASSPHRASE);
{
  const payload = samplePayload();
  const { bytes, plaintextSize } = await encryptPayload(payload, { gen: 1 });
  assert.ok(bytes.length > plaintextSize, 'ciphertext is larger than plaintext');

  const { payload: back, header } = await decryptPayload(bytes, PASSPHRASE);
  assert.deepEqual(back, payload, 'payload round-trip');
  assert.equal(header.gen, 1);
  assert.equal(header.plaintextSha256, await sha256Base64(canonicalJSON(payload)), 'recorded hash');

  // pack() must serialize the header identically regardless of ciphertext, or
  // the AAD used at encrypt time would not match the header stored in the file.
  const unpacked = unpack(bytes);
  const rePackedEmpty = pack(unpacked.header, new Uint8Array(0));
  assert.deepEqual(
    [...rePackedEmpty.headerBytes],
    [...unpacked.headerBytes],
    'header bytes are independent of the ciphertext (AAD stays valid)',
  );

  // Every tick produces a different container for the same payload (fresh IV),
  // but decrypts to the same thing.
  const second = await encryptPayload(payload, { gen: 2 });
  assert.notDeepEqual([...second.bytes], [...bytes], 'fresh IV per container');
  const back2 = await decryptPayload(second.bytes, PASSPHRASE);
  assert.deepEqual(back2.payload, payload, 'second container decrypts identically');
}

// ── wrong passphrase ───────────────────────────────────────────────────
{
  const { bytes } = await encryptPayload(samplePayload(), { gen: 1 });
  await assert.rejects(() => decryptPayload(bytes, WRONG), /wrong passphrase, or the backup is damaged/);
}

// ── tamper detection ───────────────────────────────────────────────────
{
  const payload = samplePayload();
  const { bytes } = await encryptPayload(payload, { gen: 5 });
  const view = unpack(bytes);

  // Flip a ciphertext byte.
  const badCt = bytes.slice();
  badCt[badCt.length - 1] ^= 0xff;
  await assert.rejects(() => decryptPayload(badCt, PASSPHRASE), /wrong passphrase, or the backup is damaged/);

  // Rewrite a header field (the generation) without touching the ciphertext:
  // the header is the AAD, so this must fail.
  const mutatedHeader = { ...view.header, gen: 999 };
  const repacked = pack(mutatedHeader, view.ciphertext).bytes;
  await assert.rejects(() => decryptPayload(repacked, PASSPHRASE), /wrong passphrase, or the backup is damaged/);

  // Substitute a different salt (forces a wrong KEK).
  const otherSalt = { ...mutatedHeader, gen: view.header.gen, kdf: { ...view.header.kdf, salt: toBase64(new Uint8Array(16).fill(7)) } };
  await assert.rejects(
    () => decryptPayload(pack(otherSalt, view.ciphertext).bytes, PASSPHRASE),
    /wrong passphrase, or the backup is damaged/,
  );
}

// ── future payload version is refused ──────────────────────────────────
{
  const future = { ...samplePayload(), v: 99 };
  const { bytes } = await encryptPayload(future, { gen: 1 });
  await assert.rejects(() => decryptPayload(bytes, PASSPHRASE), /newer Suwu/);
}

// ── passphrase bar ─────────────────────────────────────────────────────
{
  assert.equal(isPassphraseAcceptable('12345678'), true);
  assert.equal(isPassphraseAcceptable('short'), false);
}

clearKeyCache();
console.log('check-backup-crypto: all assertions passed');