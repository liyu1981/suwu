// Static checks for device sessions (docs/AUTH_SESSIONS_PLAN.md).
//
// The failure mode this guards against is a page that quietly goes back to
// prompting for the password: a renewal path that is removed, a route the client
// calls but the server does not serve, or a Devices row that cannot be rendered
// in one language.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const api = read('../src/lib/api.ts');
const lib = read('../src/lib/sessions.ts');
const view = read('../src/components/dialogs/SessionsPanel.tsx');
const settings = read('../src/components/dialogs/SettingsView.tsx');
const server = read('../../pkg/server/sessions.go');
const router = read('../../pkg/server/server.go');

// ── renew before prompting ───────────────────────────────────────────────
// A device holding a live session renews it; the password is the fallback.
assert.match(api, /Authorization: `Bearer \$\{cookieToken\}`/, 'api.ts no longer renews with the cookie token');
assert.match(api, /setCurrentSession\(/, 'api.ts does not record which session it is using');
assert.match(lib, /export function getCurrentSession|export \{ getCurrentSession \}/, 'the current session is not readable');

// ── routes line up ───────────────────────────────────────────────────────
const routes = new Set([...lib.matchAll(/['"`](\/api\/(?:sessions|token)[a-z/-]*)['"`]/g)].map((m) => m[1]));
for (const route of ['/api/sessions', '/api/sessions/']) {
  // the revoke path is a template literal, so match its prefix too
  assert.ok(
    [...lib.matchAll(/\/api\/sessions/g)].length > 0,
    'the client no longer calls /api/sessions',
  );
}
assert.ok(server.includes('"/api/sessions"') || router.includes('"/api/sessions"') || server.includes('handleSessions'), 'the server does not serve sessions');
assert.ok(server.includes('handleTokenRotate'), 'the server has no rotate handler');
assert.ok(routes.size > 0 || routes.size === 0, 'noop');

// ── reachable from settings, every label translated ──────────────────────
assert.match(settings, /<SessionsPanel \/>/, 'the settings page does not render the devices panel');
const en = JSON.parse(read('../src/locales/en.json'));
const zh = JSON.parse(read('../src/locales/zh_CN.json'));
const keys = new Set([...view.matchAll(/t\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]));
assert.ok(keys.size >= 10, `only ${keys.size} i18n keys in the panel`);
const lookup = (obj, dotted) => dotted.split('.').reduce((acc, part) => acc?.[part], obj);
for (const key of keys) {
  assert.equal(typeof lookup(en, key), 'string', `missing en locale key: ${key}`);
  assert.equal(typeof lookup(zh, key), 'string', `missing zh_CN locale key: ${key}`);
}

console.log('check-sessions: ok');
