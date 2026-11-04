// Terminal frequent-inputs model checks; run with Node 22+ type stripping.
//
// Covers the two pure modules behind the tile's "Frequent inputs" menu:
//   src/lib/termInput.ts     — keystroke -> current line -> submitted lines
//   src/lib/termSnippets.ts  — snippet/history list transforms
// The parts worth testing are exactly the parts a user would notice being
// wrong: what ends up in the history, and what order the menu shows.
import assert from 'node:assert/strict'
import {
  EMPTY_LINE,
  LINE_MAX,
  buildPayload,
  consumeInput,
} from '../src/lib/termInput.ts'
import {
  RECENTS_MAX,
  firstLine,
  lineCount,
  makeSnippet,
  markSnippetUsed,
  matchesQuery,
  orderSnippets,
  pushRecent,
  removeSnippet,
  runsOnSelect,
  upsertSnippet,
} from '../src/lib/termSnippets.ts'

/** Feed a whole string and return the accumulated state plus submissions. */
function feed(input, state = EMPTY_LINE) {
  let next = state
  const submitted = []
  for (const ch of input) {
    const result = consumeInput(next, ch)
    next = result.state
    submitted.push(...result.submitted)
  }
  return { state: next, submitted }
}

// ── consumeInput: the plain path ───────────────────────────────────────────
assert.equal(feed('git status').state.text, 'git status')
assert.deepEqual(feed('git status\r').submitted, ['git status'])
assert.equal(feed('git status\r').state.text, '', 'Enter clears the line')
assert.deepEqual(feed('a\rb\n').submitted, ['a', 'b'], 'both terminators submit')

// A chunk can hold many keystrokes (paste, or a fast typist).
const paste = consumeInput(EMPTY_LINE, 'pnpm build\r')
assert.deepEqual(paste.submitted, ['pnpm build'])
assert.equal(paste.state.text, '')

// Whitespace-only lines are not worth remembering.
assert.deepEqual(feed('   \r').submitted, [])
assert.deepEqual(feed('\r\r').submitted, [])
assert.equal(feed('  ls  \r').submitted[0], 'ls', 'submitted lines are trimmed')

// ── consumeInput: editing keys ─────────────────────────────────────────────
assert.equal(feed('lsx\x7f').state.text, 'ls', 'DEL removes one char')
assert.equal(feed('lsx\b').state.text, 'ls', 'BS removes one char')
assert.equal(feed('git push\x03').state.text, '', 'Ctrl-C clears the line')
assert.equal(feed('git push\x15').state.text, '', 'Ctrl-U clears the line')
assert.equal(feed('git push\x0c').state.text, '', 'Ctrl-L clears the line')
assert.deepEqual(feed('git push\x03').submitted, [], 'a cancelled line is not recorded')

// ── consumeInput: only trust lines that were actually typed ────────────────
// Any non-paste escape sequence may have edited the line behind our back
// (history recall, tab completion, cursor movement), so the line is dropped
// rather than guessed at.
assert.deepEqual(feed('ls\x1b[A\r').submitted, [], 'a recalled line is not remembered')
assert.deepEqual(feed('git pus\x1b[Dh\r').submitted, [], 'a cursor edit poisons the line')
assert.equal(feed('ls\x1b[A').state.stale, true, 'a completed escape marks the line stale')
assert.equal(feed('ls\x1b').state.stale, false, 'a lone Esc decides nothing yet')
assert.equal(feed('ls\x1b[A\x03').state.stale, false, 'Ctrl-C clears the doubt with the line')
assert.deepEqual(feed('git push\x03git status\r').submitted, ['git status'], 'recovers after Ctrl-C')
assert.deepEqual(
  feed('\x1b[200~cargo test\x1b[201~\r').submitted,
  ['cargo test'],
  'a bracketed paste is still trusted',
)

// ── consumeInput: escape sequences are not text ────────────────────────────
assert.equal(feed('\x1b[A\x1b[B').state.text, '', 'arrows contribute nothing')
assert.equal(feed('echo hi\x1b[D\x1b[C').state.text, 'echo hi', 'cursor moves are ignored')
assert.equal(feed('\x1bOP').state.text, '', 'SS3 function key is skipped whole')
assert.equal(feed('lsx\x1bx').state.text, 'lsx', 'an Alt+key byte is not text')
// Sequences are not guaranteed to arrive in one chunk, so the parser resumes.
assert.equal(feed('\x1b').state.pending, 'esc', 'a lone Esc leaves the parser pending')
assert.equal(feed('\x1b').state.text, '', 'a lone Esc is not text')
assert.equal(feed('\x1b[A').state.text, '', 'a sequence split across chunks is still skipped')
assert.equal(
  feed('a\x1b[200~b').state.text,
  'ab',
  'chunking never leaks escape bytes into the line',
)
// Bracketed paste markers vanish but the pasted text stays.
assert.equal(
  feed('\x1b[200~cargo test\x1b[201~').state.text,
  'cargo test',
  'bracketed paste keeps its payload',
)
// A bracketed paste is literal text: the shell holds it until Enter, so it is
// one entry (with its newlines), not one entry per line.
const pasted = consumeInput(EMPTY_LINE, '\x1b[200~cd /tmp\nls\x1b[201~')
assert.deepEqual(pasted.submitted, [], 'a paste is not a submission')
assert.equal(pasted.state.text, 'cd /tmp\nls', 'the whole pasted block stays on one line')
assert.deepEqual(
  consumeInput(pasted.state, '\r').submitted,
  ['cd /tmp\nls'],
  'Enter submits the pasted block as one entry',
)
assert.equal(
  consumeInput(pasted.state, ' --force').state.text,
  'cd /tmp\nls --force',
  'typing after a paste appends, so the line stays accurate',
)

// ── consumeInput: overflow is dropped, never truncated ─────────────────────
const long = 'x'.repeat(LINE_MAX + 1)
const overflowed = feed(long)
assert.equal(overflowed.state.overflow, true, 'overflow is flagged')
assert.deepEqual(feed(`${long}\r`).submitted, [], 'an over-long line is dropped, not cut')
assert.deepEqual(feed(`${'y'.repeat(LINE_MAX)}\r`).submitted.length, 1, 'exactly LINE_MAX is fine')

// ── buildPayload ───────────────────────────────────────────────────────────
assert.equal(buildPayload('ls', false, false), 'ls')
assert.equal(buildPayload('ls', true, false), 'ls\r')
assert.equal(buildPayload('  ls  ', false, false), '  ls  ', 'insertion keeps the user\'s text')
assert.equal(buildPayload('ls\n', false, false), 'ls', 'trailing newlines are not re-sent')
assert.equal(buildPayload('ls\r\n\r\n', true, false), 'ls\r')
assert.equal(buildPayload('ls\n', false, true), 'ls', 'single line needs no paste wrapper')
assert.equal(
  buildPayload('cd /tmp\nls', false, true),
  '\x1b[200~cd /tmp\nls\x1b[201~',
  'multi-line text is bracketed when the shell accepts it',
)
assert.equal(
  buildPayload('cd /tmp\r\nls', true, true),
  '\x1b[200~cd /tmp\nls\x1b[201~\r',
  'run appends exactly one Enter after the paste',
)
assert.equal(
  buildPayload('cd /tmp\nls', false, false),
  'cd /tmp\nls',
  'without bracketed paste the newline goes through raw',
)
assert.equal(buildPayload('   ', false, false), '')

// ── pushRecent ─────────────────────────────────────────────────────────────
let recents = []
for (const cmd of ['ls', 'git status', 'pnpm build']) recents = pushRecent(recents, cmd, 1)
assert.deepEqual(
  recents.map((r) => r.text),
  ['pnpm build', 'git status', 'ls'],
  'newest first',
)
recents = pushRecent(recents, 'ls', 2)
assert.deepEqual(
  recents.map((r) => r.text),
  ['ls', 'pnpm build', 'git status'],
  'a repeat moves to the front instead of duplicating',
)
assert.equal(pushRecent(recents, '   ', 3).length, recents.length, 'blank lines are ignored')
assert.equal(
  pushRecent(recents, 'z'.repeat(LINE_MAX + 1), 4).length,
  recents.length,
  'over-long lines are ignored',
)
assert.deepEqual(pushRecent([], 'ls', 7), [{ text: 'ls', at: 7 }], 'timestamps come from the caller')
const same = pushRecent([{ text: 'ls', at: 1 }], 'ls', 9)
assert.deepEqual(same, [{ text: 'ls', at: 1 }], 're-running the top command keeps its timestamp')

let many = []
for (let i = 0; i < RECENTS_MAX + 10; i += 1) many = pushRecent(many, `cmd ${i}`, i)
assert.equal(many.length, RECENTS_MAX, 'history is capped')
assert.equal(many[0].text, `cmd ${RECENTS_MAX + 9}`, 'the newest survives the cap')

// ── snippets ───────────────────────────────────────────────────────────────
const a = makeSnippet('pnpm build', { label: '  Build  ' }, 100)
assert.equal(a.label, 'Build', 'labels are trimmed')
assert.equal(a.text, 'pnpm build')
assert.ok(a.id.length > 0)
assert.equal(makeSnippet('ls', { label: '   ' }, 100).label, undefined, 'a blank label is no label')

// Auto return: a command the user runs as-is. Off is stored as absent so a
// restored/legacy snippet needs no migration.
assert.equal(makeSnippet('ls', {}).autoReturn, undefined, 'off stays absent')
assert.equal(runsOnSelect(makeSnippet('ls', { autoReturn: true })), true)
assert.equal(runsOnSelect(makeSnippet('ls', {})), false, 'missing flag reads as off')

let list = upsertSnippet([], a)
assert.deepEqual(list.map((s) => s.id), [a.id])
const b = makeSnippet('cargo test', { label: 'Test' }, 200)
list = upsertSnippet(list, b)
assert.deepEqual(list.map((s) => s.text), ['cargo test', 'pnpm build'], 'new snippets go first')

const edited = { ...a, text: 'pnpm --dir frontend build' }
list = upsertSnippet(list, edited)
assert.equal(list.length, 2, 'an edit replaces in place')
assert.equal(list[1].text, 'pnpm --dir frontend build', 'an edit keeps its position')
assert.equal(list[1].id, a.id)

assert.equal(markSnippetUsed(list, a.id, 300)[1].useCount, 1, 'usage is counted')

list = removeSnippet(list, a.id)
assert.deepEqual(list.map((s) => s.text), ['cargo test'])

// Ordering: used snippets float; never-used ones fall back to createdAt.
const old = makeSnippet('old', {}, 10)
const fresh = makeSnippet('fresh', {}, 999)
const used = markSnippetUsed([old, fresh], old.id, 1000)
assert.deepEqual(
  orderSnippets(used).map((s) => s.text),
  ['old', 'fresh'],
  'recent use beats a newer created-at',
)
assert.deepEqual(
  orderSnippets([old, fresh]).map((s) => s.text),
  ['fresh', 'old'],
  'without usage, newest first',
)
assert.deepEqual(orderSnippets([]), [])

// ── row helpers ────────────────────────────────────────────────────────────
assert.equal(firstLine('a\nb'), 'a')
assert.equal(firstLine('a\r\nb'), 'a')
assert.equal(firstLine('a'), 'a')
assert.equal(lineCount('a'), 1)
assert.equal(lineCount('a\nb\nc'), 3)
assert.equal(lineCount('a\r\nb'), 2)

assert.equal(matchesQuery({ text: 'pnpm build' }, ''), true, 'empty query matches everything')
assert.equal(matchesQuery({ text: 'pnpm build' }, '  '), true)
assert.equal(matchesQuery({ text: 'pnpm build' }, 'BUILD'), true, 'case-insensitive')
assert.equal(matchesQuery({ text: 'pnpm build', label: 'Deploy' }, 'depl'), true, 'label matches')
assert.equal(matchesQuery({ text: 'pnpm build' }, 'cargo'), false)

console.log('Terminal frequent-input checks passed.')
