#!/usr/bin/env node
/**
 * Guards the generated user names in src/lib/username.ts:
 *   - every name is a two-word `Adjective Noun` handle built from the lists
 *   - the generator is deterministic for a given rand(), so seeded runs
 *     (and the settings UI) can rely on it
 *   - out-of-range rand() values are clamped instead of producing undefined
 *   - `avoid` keeps the "Random name" button from repeating the current name
 */
import assert from 'node:assert/strict'
import { USER_NAME_COMBINATIONS, randomUserName } from '../src/lib/username.ts'

const SHAPE = /^[A-Z][a-z]+ [A-Z][a-z]+$/

// Seeded picks: index 0 and the last entry of each list.
assert.equal(randomUserName(() => 0), 'Sassy Otter')
assert.equal(randomUserName(() => 0.999999999), 'Nifty Feather')
assert.equal(randomUserName(() => 1), 'Nifty Feather') // clamped, not undefined
assert.equal(randomUserName(() => Number.NaN), 'Sassy Otter') // NaN floors to 0

// A real run produces well-formed names, always different from the current one.
for (let i = 0; i < 500; i++) {
  const name = randomUserName()
  assert.match(name, SHAPE, name)
  assert.equal(name.trim(), name)
  assert.notEqual(name, '')
}
for (let i = 0; i < 50; i++) {
  const first = randomUserName()
  assert.notEqual(randomUserName(() => 0, first), first)
}

// 48 × 48 curated words — a rename of the lists is a deliberate, visible change.
assert.equal(USER_NAME_COMBINATIONS, 2304)

console.log('Username check passed.')
