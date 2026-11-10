// Key-combination model checks; run with Node 22+ type stripping.
//
// Covers src/lib/keyChords.ts — the pure half of the "send a key combination"
// menu. What is worth testing is exactly what a user would notice being wrong:
// that a combination parses to the keys they meant, and that the bytes match
// what xterm.js itself would send for the same keys pressed inside the tile.
// The expected sequences below were taken from
// node_modules/@xterm/xterm/src/common/input/Keyboard.ts, which is why some of
// them look arbitrary (Ctrl+3 is ESC, Ctrl+8 is DEL).
import assert from 'node:assert/strict'
import {
  CHORD_MAX,
  INSERT_TOKENS,
  chordBytesLabel,
  displayTokens,
  chordLabel,
  chordSpec,
  encodeChord,
  encodePart,
  encodeSequence,
  sequenceLabel,
  parseChord,
  parseSequence,
  splitSequence,
  pushChord,
  removeChord,
} from '../src/lib/keyChords.ts'

/** Parse-or-throw, for the terse cases. */
function parse(text) {
  const result = parseChord(text)
  assert.equal(result.ok, true, `expected ${text} to parse`)
  return result.chord
}

function encode(text, options) {
  return encodeChord(parse(text), options)
}

// ── parsing ────────────────────────────────────────────────────────────────
assert.deepEqual(parse('ctrl+shift+a'), { ctrl: true, alt: false, shift: true, key: 'a' })
assert.deepEqual(parse('Ctrl + Shift + A'), { ctrl: true, alt: false, shift: true, key: 'A' },
  'spaces are irrelevant; the key keeps its case')
assert.deepEqual(parse('control+option+shift+up'), { ctrl: true, alt: true, shift: true, key: 'up' },
  'control/option are aliases')
assert.deepEqual(parse('return'), { ctrl: false, alt: false, shift: false, key: 'enter' },
  'return is enter')
assert.deepEqual(parse('ctrl++'), { ctrl: true, alt: false, shift: false, key: '+' },
  'a trailing + names the plus key')
assert.deepEqual(parse('shift+tab'), { ctrl: false, alt: false, shift: true, key: 'tab' })
assert.deepEqual(parse('f5'), { ctrl: false, alt: false, shift: false, key: 'f5' })
assert.deepEqual(parse('a+ctrl'), { ctrl: true, alt: false, shift: false, key: 'a' },
  'modifiers may come after the key')
assert.deepEqual(parseChord('ctrl+a+b'), { ok: false, error: 'unknown-key', token: 'b' },
  'two keys is a typo, not a guess')

assert.deepEqual(parseChord(''), { ok: false, error: 'empty' })
// Whitespace is the Space key (see below), not an empty field.
assert.deepEqual(parseChord('ctrl+shift'), { ok: false, error: 'missing-key' })
assert.deepEqual(parseChord('ctrl+cmd+a'), { ok: false, error: 'meta', token: 'cmd' })
assert.deepEqual(parseChord('hyper+space'), { ok: false, error: 'unknown-key', token: 'space' },
  'a mistyped modifier is caught instead of silently sending Space')
assert.deepEqual(parseChord('ctrl+nope'), { ok: false, error: 'unknown-key', token: 'nope' })

// ── case is the user's, and it reaches the bytes ──────────────────────────
// "ctrl + alt + a" must not turn into "Ctrl + Alt + A" anywhere: the label is a
// confirmation of what was typed, and a bare letter's case is its byte.
assert.deepEqual(parse('A'), { ctrl: false, alt: false, shift: false, key: 'A' })
assert.equal(encode('A'), 'A', 'a typed capital sends a capital')
assert.equal(encode('a'), 'a')
assert.equal(chordSpec(parse('ctrl+alt+a')), 'ctrl+alt+a')
assert.equal(chordLabel(parse('ctrl+alt+a')), 'Ctrl + Alt + a', 'the label does not shout')
assert.equal(chordLabel(parse('ctrl+alt+A')), 'Ctrl + Alt + A', 'and keeps a capital the user typed')
assert.equal(encode('ctrl+alt+A'), encode('ctrl+alt+a'),
  'both collapse to the same control code, which the byte preview shows')
assert.equal(chordLabel(parse('shift+a')), 'Shift + a')

// ── the space key is visible ──────────────────────────────────────────────
// Space is a key, not whitespace: whitespace separates the keys of a sequence,
// so the key is written `space` (or inserted by the Space chip) and always has a
// face — `Space` in the label, `SP` in the byte chip.
assert.deepEqual(chordSpec(parse('space')), 'space')
assert.equal(chordLabel(parse('space')), 'Space')
assert.equal(encode('space'), ' ')
assert.equal(chordBytesLabel(encode('space')), 'SP')
assert.deepEqual(chordSpec(parse('ctrl+space')), 'ctrl+space')
assert.equal(chordLabel(parse('ctrl+space')), 'Ctrl + Space')
assert.equal(encode('ctrl+space'), '\x00', 'Ctrl+Space is NUL')
assert.equal(chordSpec(parse('ctrl++')), 'ctrl++', 'the plus key keeps its own spelling')
assert.deepEqual(parseChord('   '), { ok: false, error: 'empty' },
  'a field of only whitespace holds no keys')

// ── sequences: whitespace starts a new key ────────────────────────────────
// The chips write `ctrl+` for a modifier and `esc ` for a key, so one field can
// hold several keys in order. `esc space b` is Escape, then Space, then b.
assert.deepEqual(splitSequence('  ctrl+a   esc space b '), ['ctrl+a', 'esc', 'space', 'b'])
assert.deepEqual(splitSequence('   '), [])
assert.deepEqual(parseSequence(''), { ok: false, error: 'empty' })
assert.equal(parseSequence('ctrl+a esc').ok, true)
assert.deepEqual(parseSequence('ctrl+a nope').ok, false)
assert.equal(parseSequence('ctrl+a').sequence.spec, 'ctrl+a', 'specs are canonical')
assert.equal(parseSequence('Ctrl + A  ESC').sequence.spec, 'ctrl+A esc',
  'specs fold spaces around "+" but keep the case of the key')
assert.deepEqual(splitSequence('ctrl + alt + a'), ['ctrl+alt+a'],
  'spaces around "+" are one combination, not a sequence')
assert.deepEqual(splitSequence('esc space b'), ['esc', 'space', 'b'])
assert.equal(encodeSequence('esc space b'), '\x1b b', 'a sequence is its keys in order')
assert.equal(encodeSequence('ctrl+a ctrl+e'), '\x01\x05')
assert.equal(encodeSequence('ctrl+a nope'), null, 'one bad part disables the whole send')
assert.equal(encodeSequence('ctrl+1'), null)
assert.equal(encodePart('up', { applicationCursorKeys: true }), '\x1bOA', 'parts honour DECCKM')
assert.equal(encodePart('ctrl+w'), '\x17', 'the browser-eaten one is sendable here')

// The chip row glues fragments together; these are the shapes it must produce.
// `ctrl+b` + `space ` would otherwise fuse into the word `bspace`.
assert.equal(encodeSequence('ctrl+b space a'), '\x02 b'.replace(' b', ' a'), 'chips that keep the separator parse')
assert.equal(parseChord('bspace').ok, false, 'and the fused form really is invalid')
assert.equal(sequenceLabel('ctrl+a esc space'), 'Ctrl + a · Esc · Space', 'labels read a sequence')
assert.equal(sequenceLabel('ctrl+A'), 'Ctrl + A', 'and keep the case of the key')

// ── display tokens: what the mirror draws as pills ────────────────────────
// The pill text is the field text verbatim (no re-casing): the mirror has to
// occupy the same advance as the input underneath it.
assert.deepEqual(displayTokens('ctrl+a'), [{ pill: 'ctrl' }, { text: '+a' }])
assert.deepEqual(displayTokens('esc space b'), [
  { pill: 'esc' },
  { space: true, text: ' ' },
  { pill: 'space' },
  { space: true, text: ' ' },
  { text: 'b' },
])
assert.deepEqual(displayTokens('ctrl+b space a'), [
  { pill: 'ctrl' },
  { text: '+b' },
  { space: true, text: ' ' },
  { pill: 'space' },
  { space: true, text: ' ' },
  { text: 'a' },
], 'the separator is a visible token, so pills cannot fuse into a word')
assert.deepEqual(displayTokens('a  b'), [{ text: 'a' }, { space: true, text: '  ' }, { text: 'b' }],
  'a run of spaces is one separator')
assert.deepEqual(displayTokens('ctrl+shift+F5'), [
  { pill: 'ctrl' },
  { text: '+' },
  { pill: 'shift' },
  { text: '+' },
  { pill: 'F5' },
], 'pills keep the case the user typed')
assert.deepEqual(displayTokens('hyper+a'), [{ text: 'hyper+a' }], 'unknown words stay literal')
assert.deepEqual(displayTokens(''), [], 'an empty field has nothing to draw')
// Every pill must be a key the parser understands (or a modifier), otherwise the
// UI would be promising something the sender cannot do.
const MODIFIER_WORDS = new Set([
  'ctrl', 'control', 'shift', 'alt', 'opt', 'option',
  'meta', 'cmd', 'command', 'super', 'win',
]);
for (const token of displayTokens(
  'ctrl shift alt esc tab enter space backspace del ins up down left right home end pgup pgdn f1 f12',
)) {
  if (token.pill === undefined) continue;
  if (MODIFIER_WORDS.has(token.pill.toLowerCase())) continue;
  assert.equal(parseChord(token.pill).ok, true, `${token.pill} is a real key`);
}

// ── history ───────────────────────────────────────────────────────────────
let history = []
history = pushChord(history, 'ctrl+a', 1)
history = pushChord(history, 'ctrl+b', 2)
assert.deepEqual(history.map((entry) => entry.spec), ['ctrl+b', 'ctrl+a'], 'most recent first')
history = pushChord(history, 'ctrl+a', 3)
assert.deepEqual(history.map((entry) => entry.spec), ['ctrl+a', 'ctrl+b'], 're-sending moves up, no duplicate')
assert.equal(pushChord(history, 'x', 4).length, 3)
let capped = []
for (let i = 0; i < CHORD_MAX + 5; i += 1) {
  capped = pushChord(capped, `ctrl+${String.fromCharCode(97 + (i % 26))}`, 10 + i)
}
assert.equal(capped.length, CHORD_MAX, 'history is capped')
assert.equal(removeChord(capped, 'ctrl+a').length, CHORD_MAX - 1, 'delete drops just that row')
assert.equal(pushChord([], 'ctrl+a', 1).length, 1, 'a first entry is kept')

console.log('check-key-chords: ok')
