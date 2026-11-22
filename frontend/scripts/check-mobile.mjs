// Mobile-view model checks; run with Node 22+ type stripping.
//
// The decision matrix is the part that can strand a user (a phone stuck on the
// desktop UI, or a desktop bounced to the phone UI), so it is pinned here rather
// than discovered on a device. Everything is pure: the DOM-touching helpers
// (`detectMobileEnv`, `mobileRedirectTarget`) are exercised by hand on a phone.
import assert from 'node:assert/strict'
import {
  PAGE_DOWN_SEQUENCE,
  PAGE_UP_SEQUENCE,
  TAB_SEQUENCE,
  cursorSequence,
  softInputText,
} from '../src/lib/termSoftKeys.ts';
import {
  parseRendererPreference,
  RENDERER_PREFERENCES,
} from '../src/lib/termRenderer.ts';
import {
  TWO_FINGER_MAX_DRIFT_PX,
  TWO_FINGER_MAX_MS,
  isTwoFingerTap,
} from '../src/lib/twoFinger.ts';
import {
  MOBILE_MAX_WIDTH,
  basename,
  cycleTile,
  isMobileShell,
  sessionHint,
  tileAfterClose,
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

// ── desktop-only settings ───────────────────────────────────────────────
assert.equal(isMobileShell('/mobile'), true)
assert.equal(isMobileShell('/mobile/'), true)
assert.equal(isMobileShell('/'), false, 'the desktop shell keeps its settings')
assert.equal(isMobileShell('/term'), false, 'tile iframes are not the mobile shell')
assert.equal(isMobileShell('/mobileish'), false, 'prefix must be a path segment')

// ── what to select after a close ─────────────────────────────────────────
assert.equal(tileAfterClose(['a', 'b', 'c'], 'a'), 'b', 'closing the first selects the next')
assert.equal(tileAfterClose(['a', 'b', 'c'], 'b'), 'c', 'closing a middle tile selects the next')
assert.equal(tileAfterClose(['a', 'b', 'c'], 'c'), 'b', 'closing the last falls back to the previous')
assert.equal(tileAfterClose(['only'], 'only'), '', 'closing the only tile selects nothing')
assert.equal(tileAfterClose(['a', 'b'], 'gone'), 'a', 'an unknown id selects the first')
assert.equal(tileAfterClose([], 'x'), '')

// ── overview hint from persisted tile state ──────────────────────────────
assert.equal(sessionHint(undefined), '')
assert.equal(sessionHint({}), '')
assert.equal(sessionHint({ currentPath: '/video/tv' }), '/video/tv')
assert.equal(sessionHint({ path: '  /home/yli  ' }), '/home/yli', 'trimmed')
assert.equal(sessionHint({ repoPath: '/src/suwu', branch: 'main' }), '/src/suwu')
assert.equal(sessionHint({ path: 42, file: '/a/b.ts' }), '/a/b.ts', 'non-strings are skipped')
assert.equal(sessionHint({ path: '   ' }), '', 'blank values are skipped')
assert.equal(sessionHint({ path: 's' }), '', 'values that are not path-shaped are skipped')
assert.equal(sessionHint({ directory: '~/code' }), '~/code', 'home paths count')
assert.equal(sessionHint({ dir: '/other', path: '/first' }), '/first', 'declaration order wins')

// ── terminal renderer preference ─────────────────────────────────────────
assert.equal(parseRendererPreference('dom'), 'dom')
assert.equal(parseRendererPreference('webgl'), 'webgl')
assert.equal(parseRendererPreference('auto'), 'auto')
assert.equal(parseRendererPreference(null), 'auto', 'unset means auto')
assert.equal(parseRendererPreference('garbage'), 'auto', 'unknown values fall back')
assert.deepEqual([...RENDERER_PREFERENCES], ['auto', 'dom', 'webgl'])

// ── soft-input keypad ────────────────────────────────────────────────────
assert.equal(cursorSequence('up', false), '\u001b[A', 'a shell prompt wants CSI arrows')
assert.equal(cursorSequence('down', false), '\u001b[B')
assert.equal(cursorSequence('right', false), '\u001b[C')
assert.equal(cursorSequence('left', false), '\u001b[D')
assert.equal(cursorSequence('up', true), '\u001bOA', 'DECCKM apps (vim, less) want SS3 arrows')
assert.equal(TAB_SEQUENCE, '\t', 'Tab is the control character, not spaces')
assert.equal(PAGE_UP_SEQUENCE, '\u001b[5~')
assert.equal(PAGE_DOWN_SEQUENCE, '\u001b[6~')

assert.equal(softInputText('ls -la'), 'ls -la', 'the typed text is data: untouched')
assert.equal(softInputText('  Mixed Case  '), '  Mixed Case  ', 'spaces and case survive')
assert.equal(softInputText('cmd|pipe > out'), 'cmd|pipe > out', 'no shell-quoting games')
assert.equal(softInputText(''), null, 'nothing typed means nothing to send')

// ── two-finger tap = right click ─────────────────────────────────────────
// A tap is quick and still; anything that moves is a pinch/two-finger scroll and
// must keep working as one.
assert.equal(isTwoFingerTap(120, 0), true, 'a quick still tap is a right click')
assert.equal(isTwoFingerTap(TWO_FINGER_MAX_MS, TWO_FINGER_MAX_DRIFT_PX), true, 'at the limits')
assert.equal(isTwoFingerTap(TWO_FINGER_MAX_MS + 1, 0), false, 'a held press is not a tap')
assert.equal(isTwoFingerTap(120, TWO_FINGER_MAX_DRIFT_PX + 1), false, 'movement means pinch, not tap')
assert.equal(isTwoFingerTap(0, 0), true)

console.log('check-mobile: ok')
