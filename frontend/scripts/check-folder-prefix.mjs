// Remote folder picker path/prefix regressions; run with Node 22+ type stripping.
import assert from 'node:assert/strict'
import { joinPath, parentPath, splitPrefix } from '../src/lib/foldersync/remotePath.ts'

// --- joinPath -------------------------------------------------------------
assert.equal(joinPath('/', 'home'), '/home')
assert.equal(joinPath('', 'home'), '/home')
assert.equal(joinPath('/home/yli', 'docs'), '/home/yli/docs')
assert.equal(joinPath('/home/yli/', 'docs'), '/home/yli/docs', 'trailing slash is not doubled')
assert.equal(joinPath('/home/yli///', 'docs'), '/home/yli/docs')

// --- parentPath -----------------------------------------------------------
assert.equal(parentPath('/'), '/')
assert.equal(parentPath(''), '/')
assert.equal(parentPath('/home'), '/')
assert.equal(parentPath('/home/yli'), '/home')
assert.equal(parentPath('/home/yli/'), '/home', 'trailing slash is ignored')
assert.equal(parentPath('/home/yli///'), '/home')
assert.equal(parentPath('relative'), '/', 'a bare name has the root as parent')

// --- splitPrefix: the typed path is a prefix, not necessarily a directory --
assert.deepEqual(splitPrefix('/home/yli/single'), { dir: '/home/yli', prefix: 'single' })
assert.deepEqual(splitPrefix('/home/yli/sing'), { dir: '/home/yli', prefix: 'sing' })
assert.deepEqual(splitPrefix('/single'), { dir: '/', prefix: 'single' })
assert.deepEqual(splitPrefix('single'), { dir: '/', prefix: 'single' })
assert.deepEqual(splitPrefix('/'), { dir: '/', prefix: '' })
assert.deepEqual(splitPrefix('/home/yli/'), { dir: '/home/yli/', prefix: '' }, 'trailing slash lists children')
assert.deepEqual(splitPrefix('/home/'), { dir: '/home/', prefix: '' })

// The two halves rejoin to the input for absolute paths, so a filtered listing
// is always contextual to the directory it was fetched from.
for (const input of ['/home/yli/single', '/home/yli/', '/', '/single']) {
  const { dir, prefix } = splitPrefix(input)
  assert.equal(joinPath(dir, prefix), input, `splitPrefix(${JSON.stringify(input)}) must round-trip`)
}

console.log('Folder Sync path prefix checks passed.')
