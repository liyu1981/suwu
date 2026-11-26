// Static checks for the Tools page.
//
// The page is thin over four endpoints, and the things that used to go wrong in
// this codebase are all visible in the source: a component that calls a route
// the server does not serve, a string hard-coded instead of coming from the
// server, a label that only exists in one locale, or a `fetch` that forgets the
// token. Each is checked here, in `pnpm check`, without a browser or a server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const lib = read('../src/lib/tools.ts');
const view = read('../src/components/dialogs/ToolsView.tsx');
const dialog = read('../src/components/dialogs/SuwuDialog.tsx');
const menu = read('../src/components/dialogs/MainMenuView.tsx');
const server = read('../../pkg/server/tools.go');
const statusGo = read('../../pkg/tools/status.go');
const router = read('../../pkg/server/server.go');

// ── the client calls exactly the routes the server serves ────────────────
// Matches the path part of a URL, quoted or inside a template literal (the
// list request appends `?refresh=1` when asked to refresh).
const clientRoutes = new Set([...lib.matchAll(/\/api\/tools[a-z/]*/g)].map((m) => m[0]));
const expected = ['/api/tools', '/api/tools/install', '/api/tools/uninstall', '/api/tools/setup'];
for (const route of expected) {
  assert.ok(clientRoutes.has(route), `the client does not call ${route}`);
  assert.ok(server.includes(`"${route}"`), `the server does not serve ${route}`);
}
assert.deepEqual(
  [...clientRoutes].sort(),
  [...expected].sort(),
  'the client calls a tools route that is not in the four this page owns',
);
// The page is reachable as its own menu screen, above System Settings.
assert.match(dialog, /<ToolsView \/>/, 'the menu does not render the tools view');
assert.match(menu, /onSelect\('tools'\)/, 'the menu has no Tools row');
const settings = read('../src/components/dialogs/SettingsView.tsx');
assert.ok(!settings.includes('ToolsView'), 'Tools must not live inside System Settings');

// ── the page never talks to the network itself ───────────────────────────
// Every request goes through lib/api, which attaches the token and turns a
// non-2xx into the server's own message.
assert.ok(!/\bfetch\(/.test(view), 'the view must go through lib/api, not fetch()');
for (const helper of ['fetchTools', 'installTool', 'uninstallTool', 'setToolSetup']) {
  assert.match(view, new RegExp(`${helper}\\(`), `the view does not use ${helper}`);
}

// ── the tool directory is the server's to name ────────────────────────────
// A hard-coded ~/.suwu/bin would be wrong for SUWU_VAR and for a test install.
// Comments may name it (they explain the layout); code may not.
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const [name, source] of [
  ['the view', view],
  ['the lib', lib],
]) {
  assert.ok(!stripComments(source).includes('.suwu/bin'), `${name} hard-codes the tool directory`);
}

// ── every label exists in both locales ───────────────────────────────────
const en = JSON.parse(read('../src/locales/en.json'));
const zh = JSON.parse(read('../src/locales/zh_CN.json'));
const keys = new Set([...view.matchAll(/t\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]));
// The state badges are built from a template, so they are listed explicitly.
for (const state of ['installed', 'update', 'missing', 'unsupported', 'unmanaged', 'manual']) {
  keys.add(`tools.state.${state}`);
}
assert.ok(keys.size > 0, 'no i18n keys found in the view');

const lookup = (obj, dotted) => dotted.split('.').reduce((acc, part) => acc?.[part], obj);
for (const key of keys) {
  if (key.includes('${')) continue; // tools.state.${...}: covered above
  assert.ok(typeof lookup(en, key) === 'string', `missing en locale key: ${key}`);
  assert.ok(typeof lookup(zh, key) === 'string', `missing zh_CN locale key: ${key}`);
}

// ── the page has a state for every tool state the server can send ────────
// pkg/tools decides the state; the page must be able to render each one.
for (const state of ['installed', 'update', 'missing', 'unsupported', 'unmanaged', 'manual']) {
  assert.ok(lib.includes(`'${state}'`), `ToolState is missing ${state}`);
  assert.ok(
    statusGo.includes(`State = "${state}"`),
    `pkg/tools no longer has a ${state} state`,
  );
}

// ── the routes are mounted ───────────────────────────────────────────────
assert.match(router, /strings\.HasPrefix\(r\.URL\.Path, "\/api\/tools"\)/, '/api/tools is not routed');
assert.match(router, /handleTools/, 'the tools handler is not wired');

// ── the list is filterable ──────────────────────────────────────────────
assert.match(view, /filterPlaceholder/, 'the tools list has no filter');
assert.match(view, /filtered\.map/, 'the filter result is not what gets rendered');

// ── manual tools are instructions, never an Install button ──────────────
assert.match(view, /tool\.manual/, 'the view does not special-case manual tools');
assert.match(view, /tool\.instruction/, 'manual rows must show their instruction');
assert.match(lib, /instruction\?: string/, 'ToolStatus is missing the manual instruction');
assert.match(statusGo, /ManualStatuses\(/, 'pkg/tools does not merge manual tools');

// ── the PATH block is a notice, never an opt-in toggle ──────────────────
assert.ok(!view.includes('setToolsPath'), 'the view still offers a PATH toggle');
assert.match(view, /tools\.pathNotice/, 'the PATH section must explain that it is always on');

console.log('check-tools: ok');
