// Pre-flight diff regressions; run with Node 22+ type stripping.
import assert from 'node:assert/strict'
import { buildPlan } from '../src/lib/foldersync/diff.ts'
import { META_NAME, MAX_SYNC_FILE_BYTES } from '../src/lib/foldersync/types.ts'

const file = (rel, { size = 10, mtimeMs = 1000, isDir = false } = {}) => ({
  rel,
  isDir,
  size,
  mtimeMs,
})
const side = (entries) => new Map(entries.map((e) => [e.rel, e]))
const noHash = async () => {
  throw new Error('probe must not run when the journal already covers the file')
}
const meta = (files, remotePath = '/srv/docs') => ({
  version: 1,
  plugin: 'suwu-foldersync',
  remotePath,
  files,
})

// --- A new file on the server is pulled -----------------------------------
{
  const plan = await buildPlan(
    side([file('new.txt', { size: 30, mtimeMs: 5 })]),
    side([]),
    meta({}),
    true,
    noHash,
  )
  assert.deepEqual(plan.actions, [
    { kind: 'pull', rel: 'new.txt', size: 30, mtimeMs: 5, reason: 'new' },
  ])
  assert.equal(plan.checked, 1)
  assert.deepEqual(plan.seeds, {})
}

// --- Steady state: journal hit on both sides → no work, no hashing ---------
{
  const remote = file('a.txt', { size: 10, mtimeMs: 1000 })
  const local = file('a.txt', { size: 10, mtimeMs: 9999 }) // local stamp is "now"
  const plan = await buildPlan(
    side([remote]),
    side([local]),
    meta({ 'a.txt': { size: 10, remoteMtimeMs: 1000, localMtimeMs: 9999 } }),
    true,
    noHash,
  )
  assert.deepEqual(plan.actions, [], 'a mirrored file must not be re-downloaded')
}

// --- A local edit loses: the server is the source of truth ----------------
{
  const plan = await buildPlan(
    side([file('a.txt', { size: 10, mtimeMs: 1000 })]),
    side([file('a.txt', { size: 12, mtimeMs: 2000 })]),
    meta({ 'a.txt': { size: 10, remoteMtimeMs: 1000, localMtimeMs: 1500 } }),
    true,
    noHash,
  )
  assert.deepEqual(plan.actions, [
    { kind: 'pull', rel: 'a.txt', size: 10, mtimeMs: 1000, reason: 'local-diverged' },
  ])
}

// --- A server edit wins ---------------------------------------------------
{
  const plan = await buildPlan(
    side([file('a.txt', { size: 10, mtimeMs: 3000 })]),
    side([file('a.txt', { size: 10, mtimeMs: 1500 })]),
    meta({ 'a.txt': { size: 10, remoteMtimeMs: 1000, localMtimeMs: 1500 } }),
    true,
    noHash,
  )
  assert.deepEqual(plan.actions, [
    { kind: 'pull', rel: 'a.txt', size: 10, mtimeMs: 3000, reason: 'remote-changed' },
  ])
}

// --- First run, identical size and mtime: seeded, never fetched -----------
{
  const plan = await buildPlan(
    side([file('a.txt', { size: 10, mtimeMs: 1000 })]),
    side([file('a.txt', { size: 10, mtimeMs: 1000 })]),
    meta({}),
    true,
    noHash,
  )
  assert.deepEqual(plan.actions, [])
  assert.deepEqual(plan.seeds, { 'a.txt': { size: 10, remoteMtimeMs: 1000, localMtimeMs: 1000 } })
}

// --- First run, same size but different bytes: hash decides ---------------
{
  let probed = 0
  const probe = async () => {
    probed += 1
    return { local: 'aaa', remote: 'bbb' }
  }
  const plan = await buildPlan(
    side([file('a.txt', { size: 10, mtimeMs: 1000 })]),
    side([file('a.txt', { size: 10, mtimeMs: 4000 })]),
    meta({}),
    true,
    probe,
  )
  assert.equal(probed, 1, 'equal sizes without a journal entry must be hashed once')
  assert.deepEqual(plan.actions, [
    { kind: 'pull', rel: 'a.txt', size: 10, mtimeMs: 1000, reason: 'first-run' },
  ])
}

// --- First run, same size and same bytes: seeded without a transfer -------
{
  const plan = await buildPlan(
    side([file('a.txt', { size: 10, mtimeMs: 1000 })]),
    side([file('a.txt', { size: 10, mtimeMs: 4000 })]),
    meta({}),
    true,
    async () => ({ local: 'same', remote: 'same' }),
  )
  assert.deepEqual(plan.actions, [], 'identical content must not be re-downloaded')
  assert.equal(plan.seeds['a.txt'].localMtimeMs, 4000)
}

// --- Different sizes never hash (content certainly differs) ---------------
{
  const plan = await buildPlan(
    side([file('a.txt', { size: 11, mtimeMs: 1000 })]),
    side([file('a.txt', { size: 10, mtimeMs: 4000 })]),
    meta({}),
    true,
    noHash,
  )
  assert.equal(plan.actions[0].kind, 'pull')
}

// --- Local extras: kept without the mirror toggle, removed with it ---------
{
  const kept = await buildPlan(
    side([]),
    side([file('mine.txt'), file('dir', { isDir: true })]),
    meta({}),
    false,
    noHash,
  )
  assert.deepEqual(kept.actions, [])
  assert.equal(kept.extrasIgnored, 2)

  const removed = await buildPlan(
    side([]),
    side([file('mine.txt'), file('dir', { isDir: true })]),
    meta({}),
    true,
    noHash,
  )
  assert.deepEqual(removed.actions, [
    { kind: 'delete-local', rel: 'mine.txt' },
    { kind: 'rmdir-local', rel: 'dir' },
  ])
}

// --- Ordering: obstacles → mkdirs (shallow first) → pulls → deletes → rmdirs
{
  const plan = await buildPlan(
    side([
      file('a', { isDir: true }),
      file('a/b', { isDir: true }),
      file('a/b/deep', { isDir: true }),
      file('a/b/deep/kept.txt', { size: 5, mtimeMs: 2 }),
      file('a/b/deep/fresh.txt', { size: 7, mtimeMs: 2 }),
      file('server-only.txt', { size: 5, mtimeMs: 2 }),
      file('gone-locally.txt', { size: 5, mtimeMs: 2 }),
    ]),
    side([
      file('a', { isDir: true }),
      file('a/b', { isDir: true }),
      file('a/b/deep', { isDir: true }),
      file('a/b/deep/kept.txt', { size: 5, mtimeMs: 2 }),
      file('extra.txt', { size: 5, mtimeMs: 2 }),
      file('stale', { isDir: true }),
    ]),
    meta({ 'a/b/deep/kept.txt': { size: 5, remoteMtimeMs: 2, localMtimeMs: 2 } }),
    true,
    noHash,
  )
  assert.deepEqual(
    plan.actions.map((a) => `${a.kind}:${a.rel}`),
    [
      'pull:a/b/deep/fresh.txt',
      'pull:server-only.txt',
      'pull:gone-locally.txt',
      'delete-local:extra.txt',
      'rmdir-local:stale',
    ],
    'mirrors transfers first and only then removes local extras',
  )
  assert.deepEqual(plan.seeds, {}, 'a journal-identical file is left alone')
}

// --- A local-only directory holding server content is never removed -------
{
  const plan = await buildPlan(
    // Inconsistent manifest on purpose: the dir entry is missing, its file is not.
    side([file('d/keep.txt', { size: 5, mtimeMs: 2 })]),
    side([file('d', { isDir: true }), file('d/local.txt', { size: 5, mtimeMs: 2 })]),
    meta({}),
    true,
    noHash,
  )
  assert.deepEqual(
    plan.actions.map((a) => `${a.kind}:${a.rel}`),
    ['pull:d/keep.txt', 'delete-local:d/local.txt'],
    'the directory stays because the server still has content under it',
  )
}

// --- Type mismatch: the local entry is cleared before the server's shape ---
{
  const plan = await buildPlan(
    side([file('thing', { isDir: true })]),
    side([file('thing', { size: 5 })]),
    meta({}),
    true,
    noHash,
  )
  assert.deepEqual(plan.actions, [
    { kind: 'remove-obstacle', rel: 'thing', isDir: false },
    { kind: 'mkdir-local', rel: 'thing' },
  ])
}

// --- The journal file itself is invisible to the algorithm ----------------
{
  const plan = await buildPlan(
    side([file(META_NAME, { size: 42, mtimeMs: 7 })]),
    side([file(META_NAME, { size: 40, mtimeMs: 8 })]),
    meta({}),
    true,
    noHash,
  )
  assert.deepEqual(plan.actions, [], 'the meta file is never mirrored or deleted')
  assert.equal(plan.checked, 0)
}

// --- Oversized files are skipped, never half-transferred -----------------
{
  const big = MAX_SYNC_FILE_BYTES + 1
  const plan = await buildPlan(
    side([file('big.bin', { size: big, mtimeMs: 1 })]),
    side([]),
    meta({}),
    true,
    noHash,
  )
  assert.deepEqual(plan.actions, [])
  assert.deepEqual(plan.skipped, [{ rel: 'big.bin', reason: 'too-large' }])
}

console.log('Folder Sync pre-flight diff checks passed.')
