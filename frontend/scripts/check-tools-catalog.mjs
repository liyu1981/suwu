// tools/catalog.json is the single source for every pinned tool: the release
// builders read it, the server embeds it, and a running server fetches the same
// path from GitHub. A typo in a pin is therefore a shipped bug, not a local one,
// so it is checked here — offline and without a browser.
//
// The Go side (pkg/tools) validates the schema again, and refuses to install
// from a catalog it cannot trust. This check exists to catch a bad edit at
// `pnpm check` time, before anything is built.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const catalogURL = new URL('../../tools/catalog.json', import.meta.url);
const catalog = JSON.parse(readFileSync(catalogURL, 'utf8'));

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PLATFORM = /^(linux|darwin)-(amd64|arm64)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MODE = /^0[0-7]{3}$/;

assert.equal(catalog.schema, 1, 'catalog schema must be 1');
assert.match(catalog.updatedAt ?? '', /^\d{4}-\d{2}-\d{2}$/, 'updatedAt is a plain date');
assert.ok(Array.isArray(catalog.tools) && catalog.tools.length > 0, 'the catalog lists tools');

const names = new Set();
const owned = new Map();

for (const tool of catalog.tools) {
  assert.match(tool.name, NAME, `tool name ${tool.name}`);
  assert.ok(!names.has(tool.name), `${tool.name} is listed twice`);
  names.add(tool.name);
  assert.ok(tool.version, `${tool.name}: version is required`);
  assert.ok(tool.summary, `${tool.name}: a one-line summary is required`);
  assert.match(tool.homepage ?? '', /^https:\/\//, `${tool.name}: homepage must be https`);
  assert.ok(tool.license, `${tool.name}: license is required`);
  if (tool.bundled !== undefined) {
    assert.ok(['max', 'hcbin'].includes(tool.bundled), `${tool.name}: unknown bundle marker`);
  }
  for (const keep of tool.keep ?? []) {
    assert.match(keep, /^[A-Za-z0-9._-]+$/, `${tool.name}: keep ${keep} is a plain name`);
  }

  const platforms = Object.keys(tool.platforms ?? {});
  assert.ok(platforms.length > 0, `${tool.name}: no platforms`);
  for (const key of platforms) {
    assert.match(key, PLATFORM, `${tool.name}: platform ${key}`);
    const p = tool.platforms[key];
    assert.match(p.url, /^https:\/\//, `${tool.name} (${key}): url must be https`);
    assert.match(p.sha256, SHA256, `${tool.name} (${key}): sha256 must be 64 hex chars`);
    assert.ok(
      ['tar.gz', 'tar.xz', 'zip', 'none'].includes(p.archive),
      `${tool.name} (${key}): archive`,
    );
    assert.ok(Number.isInteger(p.strip) && p.strip >= 0, `${tool.name} (${key}): strip`);
    assert.ok(Array.isArray(p.entries) && p.entries.length > 0, `${tool.name} (${key}): entries`);
    if (p.archive === 'none') {
      assert.equal(p.entries.length, 1, `${tool.name} (${key}): a bare binary has one entry`);
      assert.equal(p.strip, 0, `${tool.name} (${key}): a bare binary has no strip`);
    }
    for (const entry of p.entries) {
      assert.match(entry.file, /^(?!\.)[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, `${tool.name}: ${entry.file}`);
      assert.ok(!entry.file.split('/').some((seg) => seg === '..' || seg === ''), `${tool.name}: ${entry.file}`);
      assert.match(entry.mode, MODE, `${tool.name}: ${entry.file} mode`);
      const mode = parseInt(entry.mode, 8);
      assert.equal(mode & 0o7000, 0, `${tool.name}: ${entry.file} must not be setuid/setgid/sticky`);
      assert.equal(mode & 0o002, 0, `${tool.name}: ${entry.file} must not be world-writable`);
      assert.equal(owned.get(entry.file) ?? tool.name, tool.name, `${entry.file} is owned by two tools`);
      owned.set(entry.file, tool.name);
    }
  }
}

// The tools Suwu itself relies on must be in the catalog: file search needs rg,
// herdr sessions need herdr and herdr-core, and `suwu hc` reads the same pin.
for (const required of ['rg', 'herdr', 'herdr-core']) {
  assert.ok(names.has(required), `catalog is missing ${required}`);
}

console.log(`check-tools-catalog: ok (${catalog.tools.length} tools)`);
