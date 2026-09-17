// Regression check for the Code Explorer pure helpers (range normalization,
// spec parsing, language mapping, binary sniff).
import { looksBinary, normalizeRanges, parseFileSpecs } from '../src/components/codeexplorer/spec.ts'
import { languageForPath } from '../src/components/codeexplorer/languages.ts'

function assert(condition, message) {
  if (!condition) throw new Error(`Code ranges check failed: ${message}`)
}

function eq(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`Code ranges check failed: ${message} (${a} != ${b})`)
}

// Ranges are clamped, sorted and merged.
eq(normalizeRanges(undefined, 10), [], 'undefined ranges')
eq(normalizeRanges([{ start: 5, end: 3 }], 10), [{ start: 3, end: 5 }], 'reversed range')
eq(normalizeRanges([{ start: 8, end: 99 }], 10), [{ start: 8, end: 10 }], 'clamped to line count')
eq(
  normalizeRanges([{ start: 40, end: 41 }, { start: 50, end: 55 }], 100),
  [{ start: 40, end: 41 }, { start: 50, end: 55 }],
  'sorted preserved',
)
eq(
  normalizeRanges([{ start: 10, end: 20 }, { start: 15, end: 25 }], 100),
  [{ start: 10, end: 25 }],
  'overlap merged',
)
eq(
  normalizeRanges([{ start: 10, end: 20 }, { start: 21, end: 25 }], 100),
  [{ start: 10, end: 25 }],
  'adjacent merged',
)
eq(normalizeRanges([{ start: Number.NaN, end: 5 }], 100), [], 'NaN dropped')

// Spec parsing.
eq(parseFileSpecs(null), [], 'null spec')
eq(parseFileSpecs('not json'), [], 'invalid json')
eq(parseFileSpecs('{}'), [], 'non-array')
eq(
  parseFileSpecs('[{"path":"/a.ts","ranges":[{"start":1,"end":2}]},{"path":""},{"nope":1}]'),
  [{ path: '/a.ts', ranges: [{ start: 1, end: 2 }] }],
  'valid entries only',
)

// Language mapping.
assert(languageForPath('/x/a.ts') === 'typescript', 'ts -> typescript')
assert(languageForPath('/x/Dockerfile') === 'dockerfile', 'Dockerfile')
assert(languageForPath('/x/a.unknown') === 'plaintext', 'unknown -> plaintext')

// Binary sniff.
assert(looksBinary(new Uint8Array([1, 0, 2])) === true, 'NUL is binary')
assert(looksBinary(new TextEncoder().encode('hello')) === false, 'text is not binary')

console.log('Code ranges check passed.')
