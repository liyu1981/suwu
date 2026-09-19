// Regression check for the Code Explorer search helpers (extension token
// normalization, typeahead suggestion ranking, and set comparison).
import {
  filterExtensionSuggestions,
  normalizeExtensionToken,
} from '../src/components/codeexplorer/search.ts'

function eq(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`Code search check failed: ${message} (${a} != ${b})`)
}

// Token normalization strips a leading dot and rejects globs/flags.
for (const [raw, want] of [
  ['', null],
  ['   ', null],
  ['.', null],
  ['ts', 'ts'],
  [' .TSX ', 'TSX'],
  ['d.ts', 'd.ts'],
  ['c++', 'c++'],
  ['*.ts', null],
  ['--hidden', null],
  ['ts,go', null],
  ['x'.repeat(65), null],
]) {
  eq(normalizeExtensionToken(raw), want, `normalize ${JSON.stringify(raw)}`)
}

// Suggestions drop selected values, filter by substring, and rank prefix
// matches first.
const suggestions = ['ts', 'tsx', 'json', 'jsx', 'go', 'd.ts']
eq(filterExtensionSuggestions(suggestions, 'ts', []), ['ts', 'tsx', 'd.ts'], 'prefix first')
eq(filterExtensionSuggestions(suggestions, 'ts', ['ts']), ['tsx', 'd.ts'], 'drop selected')
eq(
  filterExtensionSuggestions(suggestions, 't', []),
  ['ts', 'tsx', 'd.ts'],
  'substring/prefix filter',
)
eq(
  filterExtensionSuggestions(suggestions, 'TSX', []),
  ['tsx'],
  'case-insensitive query',
)
eq(filterExtensionSuggestions(suggestions, '', []).slice(0, 2), ['ts', 'tsx'], 'keeps ranking when blank')
eq(filterExtensionSuggestions(suggestions, '', [], 2).length, 2, 'respects the limit')

console.log('Code search check passed.')
