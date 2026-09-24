#!/usr/bin/env node
/**
 * Guards the login-avatar helpers in src/lib/avatar.ts:
 *   - the hand-rolled MD5 (used to build Gravatar hashes) matches Node's
 *     crypto implementation, including padded/unicode inputs
 *   - the Gravatar URL normalizes the email and requests no default image
 *     (d=404) so a missing avatar falls back to the Suwu logo
 *   - resolveAvatarSrc falls back to the logo whenever the chosen source
 *     has nothing to show
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  AVATAR_FALLBACK_SRC,
  AVATAR_MAX_DATA_URL,
  AVATAR_UPLOAD_MAX,
  gravatarUrl,
  md5,
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

// Resolution: the logo is the fallback for every empty/unavailable source.
const base = { source: 'logo', email: '', image: '' }
assert.equal(AVATAR_FALLBACK_SRC, '/logo.svg')
assert.equal(resolveAvatarSrc(base, 192), AVATAR_FALLBACK_SRC)
assert.equal(resolveAvatarSrc({ ...base, source: 'gravatar', email: '' }, 192), AVATAR_FALLBACK_SRC)
assert.equal(
  resolveAvatarSrc({ ...base, source: 'gravatar', email: 'User@Example.com' }, 192),
  `https://www.gravatar.com/avatar/${md5('user@example.com')}?s=384&d=404`,
)
assert.equal(resolveAvatarSrc({ ...base, source: 'upload' }, 192), AVATAR_FALLBACK_SRC)
const uploaded = 'data:image/webp;base64,UklGRg=='
assert.equal(resolveAvatarSrc({ ...base, source: 'upload', image: uploaded }, 192), uploaded)
// An uploaded picture stays put even while Gravatar is the active source.
assert.equal(resolveAvatarSrc({ ...base, source: 'gravatar', email: '', image: uploaded }, 192), AVATAR_FALLBACK_SRC)

// Upload bounds that keep the data URL inside the localStorage quota.
assert.ok(AVATAR_MAX_DATA_URL < 5_000_000)
assert.equal(AVATAR_UPLOAD_MAX, 512)

console.log('Avatar check passed.')
