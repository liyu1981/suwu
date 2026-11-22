#!/usr/bin/env node
/**
 * Formatting helpers; run with Node 22+ type stripping.
 *
 * `formatSize` used to exist three times (a file list, the upload dialog, the
 * settings view) with three rounding rules and two ideas of what a zero-byte
 * file looks like. It is one function now, with `zero` as the only difference a
 * caller may have, so the cases are pinned here rather than in three places.
 */
import assert from 'node:assert/strict'
import { formatSize, isLocalHost, relativeTime } from '../src/lib/format.ts'
import { joinPath, normalizePath, parentPath, splitPrefix } from '../src/lib/paths.ts'

// ── sizes ────────────────────────────────────────────────────────────────
assert.equal(formatSize(0), '', 'a file list hides a zero-byte size')
assert.equal(formatSize(0, '0 B'), '0 B', 'a settings row says it out loud')
assert.equal(formatSize(1), '1 B', 'bytes are not fractional')
assert.equal(formatSize(1023), '1023 B')
assert.equal(formatSize(1024), '1.0 KB', 'one decimal from KB up')
assert.equal(formatSize(1536), '1.5 KB')
assert.equal(formatSize(1024 * 1024), '1.0 MB')
assert.equal(formatSize(1024 ** 3 * 2.5), '2.5 GB')
assert.equal(formatSize(1024 ** 4 * 3), '3.0 TB', 'TB is the ceiling')
assert.equal(formatSize(1024 ** 5), '1024.0 TB', 'past the ceiling it keeps scaling')

// ── relative time (needs the caller's translator) ────────────────────────
const t = (key, opts) => (opts?.count === undefined ? key : `${key}:${opts.count}`)
const now = Date.now()
assert.equal(relativeTime(now, t), 'notifications.justNow')
assert.equal(relativeTime(now - 90_000, t), 'notifications.minutesAgo:1')
assert.equal(relativeTime(now - 3 * 3600_000, t), 'notifications.hoursAgo:3')
assert.equal(relativeTime(now - 50 * 3600_000, t), 'notifications.daysAgo:2')
assert.equal(
  relativeTime(new Date(now - 7200_000).toISOString(), t),
  'notifications.hoursAgo:2',
  'an ISO string and an epoch number are both accepted',
)

// ── hosts ────────────────────────────────────────────────────────────────
assert.equal(isLocalHost(''), true)
assert.equal(isLocalHost('localhost'), true)
assert.equal(isLocalHost('127.0.0.1'), true)
assert.equal(isLocalHost('::1'), true)
assert.equal(isLocalHost('example.com'), false)

// ── POSIX paths (also covered by check-folder-prefix; normalise is new here) ─
assert.equal(normalizePath('/a//b/./c'), '/a/b/c')
assert.equal(normalizePath('/a/b/../c'), '/a/c', '.. pops a segment')
assert.equal(normalizePath('/../..'), '/', '.. cannot climb above the root')
assert.equal(normalizePath('a/b'), '/a/b', 'always absolute')
assert.equal(normalizePath(''), '/')
assert.equal(joinPath('/home//', 'x'), '/home/x')
assert.equal(parentPath('/home'), '/')
assert.deepEqual(splitPrefix('/home/yli/sing'), { dir: '/home/yli', prefix: 'sing' })
assert.deepEqual(splitPrefix('/home/'), { dir: '/home/', prefix: '' })

console.log('check-format: ok')
