#!/usr/bin/env node
/**
 * Guards the login-avatar helpers in src/lib/avatar.ts:
 *   - the hand-rolled MD5 (used to build Gravatar hashes) matches Node's
 *     crypto implementation, including padded/unicode inputs
 *   - the Gravatar URL normalizes the email and requests no default image
 *     (d=404) so a missing avatar falls back to a built-in picture
 *   - the built-in catalog is well formed and every file really ships in
 *     frontend/public/avatars (embedded into the Go binary by the vite build)
 *   - a user name maps to a stable, in-range built-in avatar
 *   - resolveAvatarSrc falls back to a built-in avatar whenever the chosen
 *     source has nothing to show — the Suwu logo is never a user picture
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  AVATAR_FALLBACK_SRC,
  AVATAR_MAX_DATA_URL,
  AVATAR_UPLOAD_MAX,
  BUILTIN_AVATARS,
  DEFAULT_AVATAR_SETTINGS,
  builtinAvatarIdFor,
  builtinAvatarSrc,
  builtinAvatarSrcFor,
  gravatarUrl,
  isBuiltinAvatarId,
  md5,
  normalizeAvatarSettings,
  resolveAvatarSrc,
} from '../src/lib/avatar.ts'

// RFC 1321 test vectors.
assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e')
assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72')
assert.equal(md5('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0')
assert.equal(md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6')

// Node's crypto as the oracle: block boundaries (55/56/64 bytes), emails, unicode.
for (
  const input of [
    'user@example.com',
    'a'.repeat(55),
    'b'.repeat(56),
    'c'.repeat(64),
    'd'.repeat(119),
    'suwu 登录头像',
  ]
) {
  assert.equal(md5(input), createHash('md5').update(input).digest('hex'), JSON.stringify(input))
}

// Gravatar URL: normalized (trim + lowercase), size clamped, d=404 fallback.
assert.equal(
  gravatarUrl('  User@Example.COM  ', 384),
  `https://www.gravatar.com/avatar/${md5('user@example.com')}?s=384&d=404`,
)
assert.equal(gravatarUrl('   ', 192), null)
assert.equal(gravatarUrl('user@example.com', 5000), `https://www.gravatar.com/avatar/${md5('user@example.com')}?s=512&d=404`)
assert.equal(gravatarUrl('user@example.com', 0), `https://www.gravatar.com/avatar/${md5('user@example.com')}?s=1&d=404`)

// Built-in catalog: unique ids/sources, valid paths, and real files on disk.
assert.ok(BUILTIN_AVATARS.length >= 2, 'need at least two built-in avatars')
assert.equal(new Set(BUILTIN_AVATARS.map((a) => a.id)).size, BUILTIN_AVATARS.length)
assert.equal(new Set(BUILTIN_AVATARS.map((a) => a.src)).size, BUILTIN_AVATARS.length)
const publicDir = fileURLToPath(new URL('../public/avatars/', import.meta.url))
const shipped = new Set(readdirSync(publicDir))
for (const avatar of BUILTIN_AVATARS) {
  assert.match(avatar.id, /^[a-z0-9-]+$/, avatar.id)
  assert.match(avatar.src, /^\/avatars\/[a-z0-9-]+\.webp$/, avatar.src)
  assert.ok(avatar.label, `${avatar.id} needs a label`)
  assert.ok(shipped.has(`${avatar.id}.webp`), `${avatar.src} is missing from frontend/public/avatars`)
}
// Every shipped picture is offered; no orphaned files.
assert.deepEqual(
  [...shipped].sort(),
  BUILTIN_AVATARS.map((a) => `${a.id}.webp`).sort(),
)

// Ids: only catalog members validate, and lookups are exact.
for (const avatar of BUILTIN_AVATARS) assert.equal(builtinAvatarSrc(avatar.id), avatar.src)
assert.equal(builtinAvatarSrc('logo'), null)
assert.ok(isBuiltinAvatarId('penguin'))
assert.ok(!isBuiltinAvatarId('logo'))
assert.ok(!isBuiltinAvatarId(''))
assert.ok(!isBuiltinAvatarId(undefined))

// The last-resort picture is itself a built-in avatar — never /logo.svg.
assert.notEqual(AVATAR_FALLBACK_SRC, '/logo.svg')
assert.ok(BUILTIN_AVATARS.some((a) => a.src === AVATAR_FALLBACK_SRC))

// Name → avatar: deterministic (golden values pin the mapping), normalized,
// and always inside the catalog.
assert.equal(builtinAvatarIdFor('Sassy Otter'), 'samoyed')
assert.equal(builtinAvatarIdFor('suwu'), 'whale')
assert.equal(builtinAvatarIdFor(''), 'otter')
assert.equal(builtinAvatarIdFor('  SASSY OTTER  '), builtinAvatarIdFor('sassy otter'))
assert.equal(builtinAvatarIdFor('sassy otter'), builtinAvatarIdFor('sassy otter'.normalize('NFC')))
for (const name of ['Sassy Otter', 'Neon Penguin', 'Turbo Robot', '', '登录头像', 'x'.repeat(300)]) {
  assert.ok(isBuiltinAvatarId(builtinAvatarIdFor(name)), JSON.stringify(name))
}

// Resolution: every empty/unavailable source degrades to a built-in avatar.
const base = { source: 'builtin', builtinId: '', email: '', image: '' }
assert.equal(resolveAvatarSrc(base, 192, 'Sassy Otter'), '/avatars/samoyed.webp')
// An explicit pick beats the name.
assert.equal(resolveAvatarSrc({ ...base, builtinId: 'otter' }, 192, 'Sassy Otter'), '/avatars/otter.webp')
// An id that no longer exists degrades to the name-derived picture.
assert.equal(resolveAvatarSrc({ ...base, builtinId: 'retired' }, 192, 'Sassy Otter'), '/avatars/samoyed.webp')
// Gravatar.
assert.equal(resolveAvatarSrc({ ...base, source: 'gravatar', email: '' }, 192, 'Sassy Otter'), '/avatars/samoyed.webp')
assert.equal(
  resolveAvatarSrc({ ...base, source: 'gravatar', email: 'User@Example.com' }, 192, 'Sassy Otter'),
  `https://www.gravatar.com/avatar/${md5('user@example.com')}?s=384&d=404`,
)
// Upload.
assert.equal(resolveAvatarSrc({ ...base, source: 'upload' }, 192, 'Sassy Otter'), '/avatars/samoyed.webp')
const uploaded = 'data:image/webp;base64,UklGRg=='
assert.equal(resolveAvatarSrc({ ...base, source: 'upload', image: uploaded }, 192, 'Sassy Otter'), uploaded)
// An uploaded picture stays put even while Gravatar is the active source.
assert.equal(
  resolveAvatarSrc({ ...base, source: 'gravatar', email: '', image: uploaded }, 192, 'Sassy Otter'),
  '/avatars/samoyed.webp',
)

// Settings stored by older releases are upgraded on read — no version field,
// just shape: the dropped `logo` source, missing fields, dead ids, garbage.
assert.deepEqual(normalizeAvatarSettings({ source: 'logo', email: 'a@b.c', image: '' }), {
  source: 'builtin',
  builtinId: '',
  email: 'a@b.c',
  image: '',
})
assert.deepEqual(normalizeAvatarSettings({}), DEFAULT_AVATAR_SETTINGS)
assert.deepEqual(normalizeAvatarSettings(null), DEFAULT_AVATAR_SETTINGS)
assert.deepEqual(normalizeAvatarSettings('logo'), DEFAULT_AVATAR_SETTINGS)
assert.deepEqual(normalizeAvatarSettings({ source: 'nonsense' }), DEFAULT_AVATAR_SETTINGS)
assert.deepEqual(normalizeAvatarSettings({ source: 'gravatar' }), {
  source: 'gravatar',
  builtinId: '',
  email: '',
  image: '',
})
const uploadedAvatar = 'data:image/webp;base64,UklGRg=='
assert.deepEqual(
  normalizeAvatarSettings({ source: 'builtin', builtinId: 'otter', email: 'x', image: uploadedAvatar }),
  { source: 'builtin', builtinId: 'otter', email: 'x', image: uploadedAvatar },
)
// An id that no longer exists is dropped rather than kept dangling.
assert.deepEqual(normalizeAvatarSettings({ source: 'builtin', builtinId: 'retired' }), {
  source: 'builtin',
  builtinId: '',
  email: '',
  image: '',
})
assert.deepEqual(normalizeAvatarSettings({ source: 'upload', image: 42 }), {
  source: 'upload',
  builtinId: '',
  email: '',
  image: '',
})

// Nothing resolves to the app logo any more (legacy `logo` source included).
for (const source of ['logo', 'builtin', 'gravatar', 'upload', 'nonsense']) {
  for (const name of ['', 'Sassy Otter']) {
    const src = resolveAvatarSrc({ ...base, source }, 192, name)
    assert.notEqual(src, '/logo.svg', `${source}/${name}`)
    assert.ok(src.startsWith('/avatars/') || src.startsWith('https://'), src)
  }
}

// Upload bounds that keep the data URL inside the localStorage quota.
assert.ok(AVATAR_MAX_DATA_URL < 5_000_000)
assert.equal(AVATAR_UPLOAD_MAX, 512)

console.log('Avatar check passed.')
