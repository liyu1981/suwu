import assert from 'node:assert/strict'
import { completeSave } from '../src/components/codeexplorer/saveState.ts'

let version = 2
let disposed = false
const tab = {
  model: {
    getAlternativeVersionId: () => version,
    isDisposed: () => disposed,
  },
  savedVersionId: 1,
  mtimeMs: 100,
  isNew: true,
  error: 'previous failure',
}

// The submitted buffer changed before the response arrived.
assert.equal(completeSave(tab, 1, 200), true)
assert.equal(tab.savedVersionId, 1)
assert.equal(tab.mtimeMs, 200)
assert.equal(tab.isNew, false)
assert.equal(tab.error, undefined)

// Undo back to the submitted version is clean, as is saving unchanged text.
version = 1
assert.equal(completeSave(tab, 1), false)
assert.equal(tab.mtimeMs, 200)
version = 3
assert.equal(completeSave(tab, 3, 300), false)

// A response for a closed tab must not touch its model or metadata.
disposed = true
tab.model.getAlternativeVersionId = () => { throw new Error('disposed model accessed') }
assert.equal(completeSave(tab, 4, 400), null)
assert.equal(tab.savedVersionId, 3)
assert.equal(tab.mtimeMs, 300)
console.log('Code save check passed.')
