import assert from 'node:assert/strict'
import { createStore } from 'jotai'
import {
  CODE_EDITOR_DEFAULTS, codeEditorFontOptions,
  normalizeCodeEditorSettings, codeEditorSettingsAtom,
} from '../src/store/codeExplorer.ts'

for (const value of [null, undefined, 'invalid', [], {}, { fontSize: NaN, lineHeight: Infinity, fontFamily: 123 }]) {
  assert.deepEqual(normalizeCodeEditorSettings(value), CODE_EDITOR_DEFAULTS)
}
assert.deepEqual(normalizeCodeEditorSettings({ fontSize: 100, lineHeight: -1, fontFamily: '  My Font, monospace  ' }), {
  fontSize: 32, lineHeight: 1, fontFamily: 'My Font, monospace',
})
assert.equal(normalizeCodeEditorSettings({ fontSize: 1 }).fontSize, 10)
assert.equal(normalizeCodeEditorSettings({ lineHeight: 10 }).lineHeight, 2.5)
assert.equal(normalizeCodeEditorSettings({ fontSize: 15.6 }).fontSize, 16)
assert.equal(normalizeCodeEditorSettings({ lineHeight: 1.56 }).lineHeight, 1.6)
for (const fontFamily of ['', '   ', 'x'.repeat(513), 'bad\nfont']) {
  assert.equal(normalizeCodeEditorSettings({ fontFamily }).fontFamily, CODE_EDITOR_DEFAULTS.fontFamily)
}
assert.deepEqual(codeEditorFontOptions({ fontSize: 20, lineHeight: 1.5, fontFamily: 'monospace' }), {
  fontSize: 20, lineHeight: 30, fontFamily: 'monospace',
})

const store = createStore()
assert.deepEqual(store.get(codeEditorSettingsAtom), CODE_EDITOR_DEFAULTS)
store.set(codeEditorSettingsAtom, { fontSize: 18, lineHeight: 1.8, fontFamily: 'Custom, monospace' })
assert.equal(store.get(codeEditorSettingsAtom).fontSize, 18)
assert.equal(store.get(codeEditorSettingsAtom).lineHeight, 1.8)
store.set(codeEditorSettingsAtom, { ...CODE_EDITOR_DEFAULTS })
assert.deepEqual(store.get(codeEditorSettingsAtom), CODE_EDITOR_DEFAULTS)
console.log('Code editor settings check passed.')
