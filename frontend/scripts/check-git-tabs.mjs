#!/usr/bin/env node
/**
 * Git Graph repo-tab model regressions; run with Node 22's type stripping.
 *
 * Covers the pure parts of the multi-tab work: label disambiguation,
 * comparison sanitizing, tab patching, and the restore of both the current
 * tab-list format and the pre-tabs single-repo session state.
 */
import assert from 'node:assert/strict'
import {
  COMMITS_VIEW,
  MAX_COMPARISONS_PER_TAB,
  mergeTab,
  newRepoTab,
  normalizeRepoPath,
  parseRepoTabs,
  sameRepo,
  tabLabels,
} from '../src/components/gitgraph/repoTabs.ts'
import { comparisonId } from '../src/components/gitgraph/refs.ts'

// ── labels ────────────────────────────────────────────────────────────────
assert.deepEqual(tabLabels(['/home/me/work/suwu', '/home/me/tmp/frontend']), ['suwu', 'frontend'])
assert.deepEqual(
  tabLabels(['/home/me/work/suwu', '/home/me/tmp/suwu']),
  ['work/suwu', 'tmp/suwu'],
  'ambiguous basenames widen with the parent segment',
)
assert.deepEqual(tabLabels(['suwu', 'suwu']), ['suwu 1', 'suwu 2'], 'identical paths get an index')
assert.deepEqual(tabLabels(['/a/suwu', '/b/suwu', '/c/frontend']), ['a/suwu', 'b/suwu', 'frontend'])
assert.deepEqual(tabLabels([null, '/x/suwu']), ['', 'suwu'], 'an empty tab has no label')

// ── path comparison ───────────────────────────────────────────────────────
assert.equal(normalizeRepoPath('/home/me/suwu/'), '/home/me/suwu')
assert.ok(sameRepo('/home/me/suwu', '/home/me/suwu/'))
assert.ok(sameRepo(null, null))
assert.ok(!sameRepo(null, '/home/me/suwu'))
assert.ok(!sameRepo('/a', '/b'))

// ── mergeTab invariants ───────────────────────────────────────────────────
const base = newRepoTab('r1', '/repo')
assert.equal(base.branch, 'HEAD')
assert.equal(base.activeView, COMMITS_VIEW)
const comparison = {
  id: comparisonId('/repo', 'abc1234', 'def5678'),
  repoPath: '/repo',
  base: 'abc1234',
  target: 'def5678',
}
const merged = mergeTab(base, { comparisons: [comparison], activeView: comparison.id })
assert.equal(merged.comparisons.length, 1)
assert.equal(merged.activeView, comparison.id, 'a live comparison is kept active')
assert.equal(
  mergeTab(merged, { activeView: 'gone' }).activeView,
  COMMITS_VIEW,
  'an unknown active view falls back to commits',
)
// Duplicates and junk entries never make it into a tab.
const noisy = mergeTab(base, {
  comparisons: [comparison, { ...comparison }, { nope: true }, null, 'x'],
})
assert.equal(noisy.comparisons.length, 1)
// Stale ids are recomputed rather than trusted.
const restamped = mergeTab(base, { comparisons: [{ ...comparison, id: 'stale' }] })
assert.equal(restamped.comparisons[0].id, comparison.id)
assert.equal(mergeTab(base, { expandedIndex: -3 }).expandedIndex, null)
assert.equal(mergeTab(base, { expandedIndex: 4.7 }).expandedIndex, 4)
assert.equal(mergeTab(base, { scrollPosition: -10 }).scrollPosition, 0)
assert.equal(mergeTab(base, { branch: '' }).branch, 'HEAD')
assert.equal(mergeTab(base, { autoRefreshMs: 0 }).autoRefreshMs, 0)

const many = mergeTab(base, {
  comparisons: Array.from({ length: MAX_COMPARISONS_PER_TAB + 5 }, (_, i) => ({
    id: comparisonId('/repo', `a${i}`.padEnd(7, '0'), 'HEAD'),
    repoPath: '/repo',
    base: `a${i}`.padEnd(7, '0'),
    target: 'HEAD',
  })),
})
assert.equal(many.comparisons.length, MAX_COMPARISONS_PER_TAB, 'comparison list stays bounded')

// ── parseRepoTabs: cold start ─────────────────────────────────────────────
const cold = parseRepoTabs(null, null)
assert.equal(cold.tabs.length, 1)
assert.equal(cold.tabs[0].repoPath, null)
assert.equal(cold.activeTabId, cold.tabs[0].id)
assert.equal(cold.nextTabId, 2)
assert.equal(parseRepoTabs(null, '/from/url').tabs[0].repoPath, '/from/url')

// ── parseRepoTabs: legacy single-repo state ───────────────────────────────
const legacy = parseRepoTabs(
  {
    // Exactly what a pre-multi-tab build wrote: no tab list at all.
    repoPath: '/legacy/repo',
    branch: 'main',
    selectedWorktree: null,
    allBranches: false,
    scrollPosition: 240,
    diffTabs: [
      { id: comparisonId('/legacy/repo', 'aaaaaaa', 'bbbbbbb'), repoPath: '/legacy/repo', base: 'aaaaaaa', target: 'bbbbbbb' },
    ],
    activeTab: comparisonId('/legacy/repo', 'aaaaaaa', 'bbbbbbb'),
  },
  '/ignored/url',
)
assert.equal(legacy.tabs.length, 1, 'a pre-tabs session becomes exactly one tab')
const [legacyTab] = legacy.tabs
assert.equal(legacyTab.repoPath, '/legacy/repo')
assert.equal(legacyTab.branch, 'main')
assert.equal(legacyTab.allBranches, false)
assert.equal(legacyTab.scrollPosition, 240)
assert.equal(legacyTab.comparisons.length, 1)
assert.equal(legacyTab.activeView, legacyTab.comparisons[0].id, 'the open diff tab is restored')

// ── parseRepoTabs: saved tab list ─────────────────────────────────────────
const saved = parseRepoTabs(
  {
    tabs: [
      { ...newRepoTab('r1', '/a'), scrollPosition: 12 },
      { ...newRepoTab('r2', '/b') },
      { ...newRepoTab('r3', null) },
      null,
      { id: 'r9' },
    ],
    activeTabId: 'r3',
    nextTabId: 4,
  },
  null,
)
assert.equal(saved.tabs.length, 4, 'malformed entries are dropped, usable ones kept')
assert.equal(saved.tabs[3].repoPath, null, 'a tab without a path stays an empty picker tab')
assert.equal(saved.activeTabId, 'r3')
assert.equal(saved.nextTabId, 10, 'nextTabId clears every id in use')

// Duplicate ids in a hand-edited session must not break selection.
const dupe = parseRepoTabs(
  {
    tabs: [newRepoTab('r1', '/a'), newRepoTab('r1', '/b')],
    activeTabId: 'r1',
    nextTabId: 2,
  },
  null,
)
assert.equal(new Set(dupe.tabs.map((tab) => tab.id)).size, 2, 'ids are made unique')
assert.ok(dupe.tabs.some((tab) => tab.id === dupe.activeTabId))

// A saved list always wins over the cold-start URL param.
const savedWins = parseRepoTabs(
  { tabs: [newRepoTab('r1', '/saved')], activeTabId: 'r1', nextTabId: 2 },
  '/url',
)
assert.equal(savedWins.tabs[0].repoPath, '/saved')

// Broken state falls back to the URL param instead of throwing.
const broken = parseRepoTabs({ tabs: 'nonsense', activeTabId: 5, nextTabId: 'x' }, '/url')
assert.equal(broken.tabs.length, 1)
assert.equal(broken.tabs[0].repoPath, '/url')

console.log('Git Graph repo tab model checks passed.')

// An explicitly emptied tile is restored empty, not re-seeded from the URL.
const emptied = parseRepoTabs({ tabs: [], activeTabId: '', nextTabId: 3 }, '/url')
assert.deepEqual(emptied.tabs, [])
assert.equal(emptied.nextTabId, 3, 'the id counter survives an empty tile')

console.log('Git Graph empty-tile restore checks passed.')
