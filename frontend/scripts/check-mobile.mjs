// Mobile-view model checks; run with Node 22+ type stripping.
//
// The decision matrix is the part that can strand a user (a phone stuck on the
// desktop UI, or a desktop bounced to the phone UI), so it is pinned here rather
// than discovered on a device. Everything is pure: the DOM-touching helpers
// (`detectMobileEnv`, `mobileRedirectTarget`) are exercised by hand on a phone.
import assert from 'node:assert/strict'
import {
  MOBILE_MAX_WIDTH,
  basename,
  cycleTile,
  parsePreference,
  preferenceFromSearch,
  shouldUseMobileView,
  tileInfoLine,
} from '../src/lib/mobile.ts'

const phone = {
  width: 390,
  height: 844,
  coarsePointer: true,
  hover: false,
  hasTouch: true,
}
const desktop = {
  width: 1440,
  height: 900,
  coarsePointer: false,
  hover: true,
  hasTouch: false,
}
const tablet = {
  width: 1024,
  height: 1366,
  coarsePointer: true,
  hover: false,
  hasTouch: true,
}

function env(overrides) {
  return { pathname: '/', search: '', preference: 'auto', ...overrides }
}

// ── the three shapes of client ────────────────────────────────────────────
assert.equal(shouldUseMobileView(env(phone)), true, 'a phone lands on /mobile')
assert.equal(shouldUseMobileView(env(desktop)), false, 'a desktop stays on /')
assert.equal(shouldUseMobileView(env(tablet)), false, 'a tablet keeps the tiling WM')
assert.equal(
  shouldUseMobileView({ ...env(phone), width: MOBILE_MAX_WIDTH + 1 }),
  false,
  'a touch device just past the breakpoint keeps the desktop view',
)
assert.equal(
  shouldUseMobileView({ ...env(phone), width: MOBILE_MAX_WIDTH }),
  true,
  'the breakpoint itself is mobile',
)
assert.equal(
  shouldUseMobileView({ ...env(desktop), width: 400 }),
  false,
  'a narrow desktop window is not a phone (fine pointer, no touch)',
)
assert.equal(
  shouldUseMobileView({ ...env(desktop), width: 400, hasTouch: true, hover: false }),
  true,
  'touch without hover counts even when the pointer query is unavailable',
)
assert.equal(
  shouldUseMobileView({ ...env(desktop), width: 400, hasTouch: true }),
  false,
  'a touch laptop that still reports hover keeps the desktop view',
)

// ── only the entry route is a redirect candidate ──────────────────────────
for (const pathname of ['/term', '/viewer', '/browser', '/sftp', '/extension', '/dropbox']) {
  assert.equal(
    shouldUseMobileView(env({ ...phone, pathname })),
    false,
    `${pathname} is a tile iframe and must never be redirected`,
  )
}
assert.equal(shouldUseMobileView(env({ ...phone, pathname: '/mobile' })), true)

// ── preferences and their escape hatches ─────────────────────────────────
assert.equal(shouldUseMobileView(env({ ...phone, preference: 'desktop' })), false)
assert.equal(shouldUseMobileView(env({ ...desktop, preference: 'mobile' })), true)
assert.equal(preferenceFromSearch('?desktop=1'), 'desktop')
assert.equal(preferenceFromSearch('?mobile=1'), 'mobile')
assert.equal(preferenceFromSearch('?foo=bar'), null)
assert.equal(preferenceFromSearch(''), null)
assert.equal(preferenceFromSearch('desktop=1'), 'desktop', 'a bare query string works too')
assert.equal(parsePreference('mobile'), 'mobile')
assert.equal(parsePreference('desktop'), 'desktop')
assert.equal(parsePreference('nonsense'), 'auto')
assert.equal(parsePreference(null), 'auto')

// ── tile cycling ─────────────────────────────────────────────────────────
const ids = ['a', 'b', 'c']
assert.equal(cycleTile(ids, 'a', 1), 'b')
assert.equal(cycleTile(ids, 'c', 1), 'a', 'next wraps')
assert.equal(cycleTile(ids, 'a', -1), 'c', 'previous wraps')
assert.equal(cycleTile(ids, 'b', 0), 'b')
assert.equal(cycleTile(ids, 'gone', 1), 'a', 'an unknown current id starts at the first')
assert.equal(cycleTile(ids, 'gone', -1), 'c', 'and backwards starts at the last')
assert.equal(cycleTile(['only'], 'only', 1), 'only', 'a single tile cycles to itself')
assert.equal(cycleTile([], '', 1), '', 'no tiles means no target')
assert.equal(cycleTile(ids, 'a', 3), 'a', 'a full lap returns to the start')

// ── overview card text ───────────────────────────────────────────────────
assert.equal(basename('/video/tv/BBC.纪录片'), 'BBC.纪录片')
assert.equal(basename('/video/tv/'), 'tv')
assert.equal(basename('relative/name.txt'), 'name.txt')
assert.equal(basename(''), '')
assert.equal(
  tileInfoLine({ initialPath: '/home/yli/suwu-dev', description: 'Terminal' }),
  'suwu-dev',
  'a path wins over the description',
)
assert.equal(
  tileInfoLine({ sessionHint: '~/suwu-dev · main', description: 'Git graph' }),
  '~/suwu-dev · main',
  'then the session hint',
)
assert.equal(tileInfoLine({ description: 'Terminal' }), 'Terminal')
assert.equal(tileInfoLine({}), '')
assert.equal(
  tileInfoLine({ initialPath: '   ', description: '  Terminal  ' }),
  'Terminal',
  'blank fields fall through, whitespace is trimmed',
)

console.log('check-mobile: ok')
