#!/usr/bin/env node
/**
 * End-to-end smoke test: the real browser crypto code against a real Go server.
 *
 * Encrypts a payload with the production container/crypto modules, POSTs it to
 * a live `suwu serve`, downloads the generation back, and decrypts it — proving
 * the two implementations agree on the container format (magic, header length,
 * header JSON) and that the opaque round-trip preserves the bytes.
 *
 * Requires a running server. Skips cleanly when SUWU_E2E_URL is unset, so it
 * never runs in CI by accident.
 *
 *   SUWU_E2E_URL=http://127.0.0.1:8181 SUWU_E2E_PASS=secret \
 *     node --experimental-strip-types scripts/check-backup-e2e.mjs
 */

import assert from 'node:assert/strict';
import { initSlotKey, encryptPayload, decryptPayload } from '../src/lib/backup/crypto.ts';
import { PAYLOAD_VERSION } from '../src/lib/backup/types.ts';

const base = process.env.SUWU_E2E_URL;
const password = process.env.SUWU_E2E_PASS;
if (!base || !password) {
  console.log('check-backup-e2e: skipped (set SUWU_E2E_URL and SUWU_E2E_PASS)');
  process.exit(0);
}

// Authenticate exactly like the browser does: Basic → /api/token → Bearer.
const tokenRes = await fetch(`${base}/api/token`, {
  headers: { Authorization: `Basic ${Buffer.from(`suwu:${password}`).toString('base64')}` },
});
if (!tokenRes.ok) throw new Error(`/api/token returned HTTP ${tokenRes.status}`);
const { token } = await tokenRes.json();

// A 26-char slot id from the same alphabet the client uses.
const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
const bytes = crypto.getRandomValues(new Uint8Array(26));
let slotId = '';
for (let i = 0; i < 26; i++) slotId += alphabet[bytes[i] % alphabet.length];

await initSlotKey('integration-test-passphrase');
const payload = {
  v: PAYLOAD_VERSION,
  deviceId: 'e2e',
  createdAt: Date.now(),
  categories: ['settings', 'ext', 'layout'],
  items: [
    { ns: 'ls', path: 'suwu:background', mtime: 1, value: 'ambient' },
    { ns: 'ext', path: 'note/record', mtime: 2, value: { texts: ['from e2e'] } },
  ],
};

const { bytes: container } = await encryptPayload(payload, { gen: 1 });
assert.equal(new TextDecoder().decode(container.subarray(0, 7)), 'SUWUBK1', 'container magic');

// The server must accept it as a valid container (not 400 "not a container").
const put = await fetch(`${base}/api/backup`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'X-Suwu-Slot': slotId,
    'Content-Type': 'application/octet-stream',
  },
  body: container,
});
if (put.status !== 200) throw new Error(`PUT returned HTTP ${put.status}: ${await put.text()}`);
const putBody = await put.json();
assert.equal(putBody.gen, 1, 'first generation is 1');

const meta = await fetch(`${base}/api/backup/meta?slot=${slotId}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const metaBody = await meta.json();
assert.equal(metaBody.generations.length, 1, 'one generation indexed');
assert.equal(metaBody.generations[0].size, container.length, 'indexed size matches');

const blob = await fetch(`${base}/api/backup/blob?slot=${slotId}&gen=1`, {
  headers: { Authorization: `Bearer ${token}` },
});
const downloaded = new Uint8Array(await blob.arrayBuffer());
assert.deepEqual([...downloaded], [...container], 'downloaded bytes are byte-identical');

// Decrypt what came back through the server.
const { payload: back } = await decryptPayload(downloaded, 'integration-test-passphrase');
assert.deepEqual(back.items, payload.items, 'payload survives the server round-trip');

// Clean up the test slot.
await fetch(`${base}/api/backup?slot=${slotId}&confirm=${slotId}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${token}` },
});

console.log('check-backup-e2e: full encrypt → server → download → decrypt round-trip passed');