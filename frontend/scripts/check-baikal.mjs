// Baikal tile model checks; run with Node 22+ type stripping.
//
// The panel is thin over these helpers, so pinning them here covers the parts a
// headless test can reason about without a herdr-core daemon: status tones, space
// colours, what a row is called, how unlabelled terminals group, and the tab
// model (dedupe, close fallback, title drift).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TONE_DOT,
  closeTab,
  closableTabs,
  groupUnassigned,
  makeTab,
  openTab,
  listAgents,
  spaceColour,
  spaceInitial,
  sortSpaces,
  statusTone,
  syncTabTitles,
  terminalLabel,
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

// ── space ordering and badges ────────────────────────────────────────────
const space = (id, name, order) => ({ id, name, identityCwd: '/' + name, colour: 'sky', terminals: [], order });
// Creation order: oldest first, newer appended — renaming never moves a space.
assert.deepEqual(
  sortSpaces([
    { ...space('b3', 'zeta'), createdMs: 300 },
    { ...space('b1', 'Alpha'), createdMs: 100 },
    { ...space('b2', 'beta'), createdMs: 200 },
  ]).map((s) => s.name),
  ['Alpha', 'beta', 'zeta'],
  'spaces keep creation order, not alphabetical',
);
assert.deepEqual(
  sortSpaces([space('b9', 'same'), space('b1', 'same')]).map((s) => s.id),
  ['b1', 'b9'],
  'equal or missing creation times fall back to the id',
);

// Agents: only terminals that announced a status, most actionable first.
const agent = (address, state, createdMs) =>
  terminal({
    address,
    name: address,
    createdMs,
    status: state ? { state } : null,
  });
assert.deepEqual(
  listAgents([
    agent('t4', 'blocked', 30),
    agent('t1', 'idle', 10),
    agent('t2', 'working', 20),
    agent('t3', null, 5),
    { ...agent('t5', 'done', 40), live: false },
  ]).map((t) => t.address),
  ['t1', 't2', 't4'],
  'agents keep their opening order — a state change must not move a row',
);
assert.deepEqual(
  listAgents([agent('t9', 'working', 7), agent('t8', 'done', 7)]).map((t) => t.address),
  ['t8', 't9'],
  'same creation time falls back to the address, so the order is still stable',
);
assert.equal(spaceInitial('suwu-dev'), 'S');
assert.equal(spaceInitial('~'), '~');
assert.equal(spaceInitial(''), '·', 'an unnamed space still has a badge');

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

// ── the pick list's label: name *and* address ────────────────────────────
// Two shells in the same directory share the name the core derives from it, so
// a list of bare names cannot say which terminal a click will attach to. The
// address is the identity, so it rides along in parentheses — once.
assert.equal(
  terminalLabel(terminal({ address: 't12', name: 'suwu-dev' })),
  'suwu-dev (t12)',
  'a named terminal shows its address too',
);
assert.equal(
  terminalLabel(terminal({ address: 't12', name: 't12' })),
  't12',
  'an unnamed terminal does not repeat itself',
);
assert.equal(
  terminalLabel(terminal({ address: 't7', name: '', title: 'vim README.md' })),
  'vim README.md (t7)',
  'a program title is a name like any other',
);

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

// ── the attach effect must not depend on a re-render ─────────────────────
// A terminal reattached its WebSocket on every parent render because the
// callbacks were inline arrows that changed identity on each snapshot — several
// times a second, which spun the CPU and flickered "connected/disconnected".
// The callbacks live in refs, and `visible` is a resize concern, so none of them
// may appear in the attach effect's dependency list.
const termSource = readFileSync(
  new URL('../src/components/baikal/BaikalTerm.tsx', import.meta.url),
  'utf8',
);
const deps = termSource.match(/\}, \[term, terminal[^\]]*\]\);/)?.[0] ?? '';
assert.ok(deps, 'the attach effect dependency list was not found');
for (const leak of ['onDetached', 'onSize', 'visible']) {
  assert.ok(!deps.includes(leak), `attach effect must not depend on ${leak}: ${deps}`);
}
assert.match(termSource, /onDetachedRef\.current\?\.\(terminal\)/, 'detach must go through the ref');
assert.match(termSource, /onSizeRef\.current\?\./, 'size reports must go through the ref');

// ── the soft-input panel is shared, not copied ──────────────────────
// A phone cannot drive vim from a keyboard that has no arrows, PgUp/PgDn or a
// reliable Escape. Baikal's terminal renders the same panel the shell tile does
// (one row, one focus rule, one set of bytes) and puts its toggle in the shared
// toolbar, so both tiles offer the button in the same place.
assert.match(termSource, /<SoftInputPanel/, 'the baikal terminal hosts the shared panel');
// A hidden xterm is not free: it keeps parsing and rendering every byte its
// agent writes, so the panel mounts only the tab on screen and the attach asks
// the core for a scrollback replay instead.
assert.match(termSource, /history: String\(HISTORY_LINES\)/, 'the attach replays the core scrollback');
assert.match(
  termSource, /softInput=\{[\s\S]*?touchFirst/,
  'the toggle rides in the shared toolbar, on touch devices only',
);
assert.match(
  termSource,
  /enabled=\{state === 'ready'\}/,
  'the panel can only send while the attachment is ready',
);
const panelSource = readFileSync(
  new URL('../src/components/term/SoftInputPanel.tsx', import.meta.url),
  'utf8',
);
const shellSource = readFileSync(
  new URL('../src/components/FullTerminal.tsx', import.meta.url),
  'utf8',
);
for (const [name, source] of [
  ['the baikal terminal', termSource],
  ['the shell tile', shellSource],
]) {
  assert.match(source, /<SoftInputPanel/, `${name} renders the shared panel`);
  assert.match(source, /softInput=\{/, `${name} hands the toolbar the toggle`);
}
assert.match(panelSource, /gridTemplateRows: open \? '1fr' : '0fr'/, 'the row grows from 0fr');
assert.match(panelSource, /inert: true/, 'a closed panel stays out of the tab order');

// ── the tile's own state must be readable by the tile ──────────────────────
// `CommonTileContainer` *provides* the session context; a panel that rendered it
// and also called `useTileSessionState` read the default context instead — always
// `state: null, ready: false` — so the tile never restored and never reported its
// tabs, which is how a space came back with only the tab you had just clicked.
const baikalPanelSource = readFileSync(
  new URL('../src/components/baikal/BaikalPanel.tsx', import.meta.url),
  'utf8',
);
const workspaceAt = baikalPanelSource.indexOf('function BaikalWorkspace()');
const sessionAt = baikalPanelSource.indexOf('useTileSessionState<');
assert.ok(workspaceAt > 0, 'the panel body lives in its own component');
assert.ok(
  sessionAt > workspaceAt,
  'session-state hooks must be read inside the container, i.e. after BaikalWorkspace',
);
assert.match(
  baikalPanelSource,
  /<CommonTileContainer[^>]*>\s*<BaikalWorkspace \/>/,
  'the page wraps the workspace in the container that provides the session',
);
assert.match(baikalPanelSource, /useTileSessionReady/, 'restore waits for the WM to answer, not for a non-null state');

// ── only the tab on screen is mounted ─────────────────────────────────────
const panelMount = baikalPanelSource.slice(baikalPanelSource.indexOf('{activeTab && ('));
assert.ok(
  !/display: visible \? undefined : 'none'/.test(baikalPanelSource),
  'hidden tabs must not stay mounted behind display:none — they render anyway',
);
assert.match(
  panelMount,
  /<BaikalTerm/,
  'the visible tab mounts its terminal',
);
assert.ok(
  baikalPanelSource.includes('delete next[activeSpaceId]'),
  'a terminal whose program ended still leaves its space behind',
);

console.log('check-baikal: ok');
