// Pure renderer regressions; run with Node 22's type stripping.
import assert from 'node:assert/strict'
import { alignDiffLines, highlightWords } from '../src/components/gitgraph/splitDiff.ts'

const line = (kind, text, old = null, next = null) => ({ kind, text, old, new: next })
const rows = alignDiffLines([
  line('context', 'before', 1, 1),
  line('remove', 'old a', 2), line('remove', 'old b', 3),
  line('add', 'new a', null, 2), line('add', 'new b', null, 3), line('add', 'extra', null, 4),
  line('note', '\\ No newline at end of file'),
  line('context', 'after', 4, 5),
])
assert.equal(rows.length, 6)
assert.equal(rows[1].left.text, 'old a')
assert.equal(rows[1].right.text, 'new a')
assert.equal(rows[2].left.text, 'old b')
assert.equal(rows[2].right.text, 'new b')
assert.equal(rows[3].left, null)
assert.equal(rows[3].right.new, 4)
assert.match(rows[4].note, /No newline/)
assert.equal(rows[5].left.old, 4)
assert.equal(rows[5].right.new, 5)
assert.equal(alignDiffLines([line('remove', 'deleted', 1)])[0].right, null)
assert.equal(alignDiffLines([line('add', 'added', null, 1)])[0].left, null)
for (const [left, right] of [
  ['old value', 'new value'], ['same', 'same'], ['', 'added'],
  ['中文 old', '中文 new'], ['<script> &', '<script> >'],
  ['word '.repeat(10000), 'next '.repeat(10000)],
]) {
  const [a, b] = highlightWords(left, right)
  assert.equal(a.map(span => span.text).join(''), left)
  assert.equal(b.map(span => span.text).join(''), right)
}
const [left, right] = highlightWords('old value', 'new value')
assert.deepEqual(left.filter(span => span.highlight).map(span => span.text), ['old'])
assert.deepEqual(right.filter(span => span.highlight).map(span => span.text), ['new'])
console.log('Git comparison alignment and bounded word highlighting checks passed.')
