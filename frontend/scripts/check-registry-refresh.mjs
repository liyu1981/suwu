#!/usr/bin/env node
/**
 * Guards the registry refresh contract. Both registries are read from disk per
 * request by the server, so a background or extension installed from a terminal
 * (`suwu install`) is live immediately — but the browser caches both lists for
 * the lifetime of the document, and the only place that re-reads them is the
 * settings screen.
 *
 * Asserted here (static: the repo has no browser test runner):
 *   - the settings screen re-fetches BOTH registries when it opens
 *   - the shell still fetches the background list on mount
 *   - the background fetch de-duplicates concurrent callers, so opening the
 *     settings screen immediately after load does not double-fetch
 *   - the extension cache is invalidated rather than appended to, so a re-fetch
 *     cannot keep a stale entry for an extension that was removed
 *   - a failed refresh keeps the last known list instead of blanking the picker
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const settings = read('src/components/dialogs/SettingsView.tsx')
const appShell = read('src/routes/AppShell.tsx')
const external = read('src/components/background/external.ts')
const extensions = read('src/lib/extensions.ts')

// The settings screen is mounted per view (SuwuDialog renders it on `view ===
// 'settings'`), so a mount effect runs on every open of the screen.
const refreshEffect = settings.match(
  /useEffect\(\(\) => \{([\s\S]*?)\}, \[\]\);/g,
)
assert.ok(refreshEffect, 'SettingsView has no empty-deps effect')
const withBoth = refreshEffect.find((b) => b.includes('loadExternalBackgrounds'))
assert.ok(withBoth, 'no effect calls loadExternalBackgrounds()')
assert.ok(
  withBoth.includes('reloadExtensions'),
  'opening the settings screen must also re-fetch the extension list',
)
assert.match(
  withBoth,
  /\.catch\(/,
  'a failed refresh must be swallowed so the last known list survives',
)

// The mount fetch stays: it is what a first paint without a cache relies on.
assert.match(
  appShell,
  /useEffect\(\(\) => \{\s*void loadExternalBackgrounds\(\);\s*\}, \[\]\);/,
  'AppShell must fetch the background list on mount',
)

// One request per burst: the in-flight promise is shared and cleared in a
// finally, so a later open re-fetches rather than reusing a settled promise.
assert.match(external, /let inflight: Promise<void> \| null = null;/)
assert.match(external, /if \(inflight\) return inflight;/)
assert.match(external, /inflight = fetchExternalBackgrounds\(\)\.finally/)
assert.match(external, /inflight = null;\n  \}\);/, 'the in-flight slot is cleared')

// The extension cache is dropped before re-fetching, so a removed extension
// disappears from the picker instead of lingering.
assert.match(
  extensions,
  /export function reloadExtensions\(\)[\s\S]*?cached = null;[\s\S]*?inflight = null;[\s\S]*?return loadExtensions\(\);/,
  'reloadExtensions must clear the cache, then fetch',
)
// Both consumers share it: the hook's reload and the settings screen.
assert.ok(
  extensions.includes('reloadExtensions()\n      .then'),
  'useExtensions().reload must go through reloadExtensions()',
)
assert.ok(
  settings.includes("from '../../lib/extensions'"),
  'SettingsView must import reloadExtensions',
)

console.log('Registry refresh check passed.')
