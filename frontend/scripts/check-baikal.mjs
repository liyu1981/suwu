// Baikal tile model checks; run with Node 22+ type stripping.
//
// The panel is thin over these helpers, so pinning them here covers the parts a
// headless test can reason about without a herdr-core daemon: status tones, space
// colours, what a row is called, how unlabelled terminals group, and the tab
// model (dedupe, close fallback, title drift).
import assert from 'node:assert/strict';
import {
  TONE_DOT,
  closeTab,
  closableTabs,
  groupUnassigned,
  makeTab,
  openTab,
  spaceColour,
  statusTone,
  syncTabTitles,
  terminalSubtitle,
  terminalTitle,
} from '../src/lib/baikal.ts';

// Plain JS on purpose: this file is a .mjs, so it cannot carry type syntax of
// its own (Node only strips types from .ts files).
const terminal = (over = {}) => ({
  address: 't1',
  name: 't1',
  title: '',
  agent: 'bash',
  cwd: '/home/yli/suwu-dev',
  state: 'live',
  live: true,
  createdMs: 1,
  ...over,
});

// ── status tones ─────────────────────────────────────────────────────────
assert.equal(statusTone(null), 'none');
assert.equal(statusTone(undefined), 'none', 'a plain shell has no status')
assert.equal(statusTone({ state: 'working' }), 'working')
assert.equal(statusTone({ state: 'done' }), 'done')
assert.equal(statusTone({ state: 'blocked' }), 'blocked')
assert.equal(statusTone({ state: 'error' }), 'error')
assert.equal(statusTone({ state: 'idle' }), 'idle')
assert.equal(statusTone({ state: 'something-new' }), 'none', 'unknown words fall back quietly')
assert.ok(TONE_DOT.working && TONE_DOT.blocked, 'every tone has a dot')

// ── space colours ────────────────────────────────────────────────────────
assert.equal(spaceColour('sky').dot, 'bg-sky-400')
assert.equal(spaceColour('not-a-colour').dot, spaceColour('sky').dot, 'unknown colour falls back')

// ── row text ─────────────────────────────────────────────────────────────
assert.equal(terminalTitle(terminal()), 't1', 'an unnamed shell shows its address')
assert.equal(terminalTitle(terminal({ name: 'claude' })), 'claude')
assert.equal(terminalTitle(terminal({ title: 'vim README.md' })), 'vim README.md')
assert.equal(terminalTitle(terminal({ name: 'claude', title: 'claude' })), 'claude')
assert.equal(terminalSubtitle(terminal({ status: { state: 'working', msg: 'building' } })), 'building')
assert.equal(
  terminalSubtitle(terminal({ status: { state: 'blocked', title: 'permission?' } })),
  'permission?',
  'title is used when there is no message',
)
assert.equal(terminalSubtitle(terminal({ agent: 'zsh' })), 'zsh')
assert.equal(terminalSubtitle(terminal({ agent: '' })), 't1', 'falls back to the address')

// ── unassigned grouping ──────────────────────────────────────────────────
const loose = groupUnassigned([
  terminal({ address: 't2', cwd: '/a/b' }),
  terminal({ address: 't3', cwd: '/a/b' }),
  terminal({ address: 't4', cwd: '/c' }),
]);
assert.deepEqual(
  loose.map((g) => [g.cwd, g.name, g.terminals.length]),
  [
    ['/a/b', 'b', 2],
    ['/c', 'c', 1],
  ],
  'grouped by directory, sorted by path, named by its basename',
);
assert.deepEqual(groupUnassigned([]), []);

// ── tabs ─────────────────────────────────────────────────────────────────
const t1 = terminal({ address: 't1', name: 'claude' });
const t2 = terminal({ address: 't2', name: 'zsh' });

const opened = openTab([], t1);
assert.equal(opened.tabs.length, 1);
assert.equal(opened.activeId, 't1');

const reopened = openTab(opened.tabs, t1);
assert.equal(reopened.tabs.length, 1, 'the same terminal is not opened twice')
assert.equal(reopened.activeId, 't1', 'opening an open terminal activates it')

const two = openTab(opened.tabs, t2);
assert.equal(two.tabs.length, 2);
assert.equal(two.activeId, 't2');

assert.equal(makeTab(t1, true).observe, true);

// Closing the middle tab keeps the one after it; closing the last falls back.
const three = ['a', 'b', 'c'].map((address) =>
  makeTab(terminal({ address, name: address })),
);
let closed = closeTab(three, 'b', 'b');
assert.deepEqual(
  closed.tabs.map((t) => t.id),
  ['a', 'c'],
);
assert.equal(closed.activeId, 'c', 'the tab after the closed one wins');
closed = closeTab(three, 'c', 'c');
assert.equal(closed.activeId, 'b', 'closing the last one falls back to the previous');
closed = closeTab(three, 'z', 'b');
assert.equal(closed.activeId, 'z', 'closing an inactive tab keeps the active one');
assert.equal(closeTab(three, 'a', 'nope').tabs.length, 3, 'unknown ids are ignored');

// Titles follow their terminals without churning identity.
const synced = syncTabTitles(
  [makeTab(terminal({ address: 't1', name: 'old' }))],
  [terminal({ address: 't1', name: 'new' })],
);
assert.equal(synced[0].title, 'new');
const stable = [makeTab(t1)];
assert.equal(syncTabTitles(stable, [t1]), stable, 'unchanged titles keep the same array');

// A tab whose terminal is no longer live is still closable, but not listed.
assert.deepEqual(
  closableTabs([makeTab(t1), makeTab(t2)], [terminal({ address: 't1' })]).map((t) => t.terminal),
  ['t1'],
);

console.log('check-baikal: ok');
