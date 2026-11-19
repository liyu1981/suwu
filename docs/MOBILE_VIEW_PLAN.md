# Mobile View — Plan

Status: **shipped** (phases 0–4 and the PWA; see §12–§13 for what landed and
where it differs from this plan).
Owner area: `frontend/src/main.tsx`, `frontend/src/router.tsx`,
`frontend/src/routes/AuthGate.tsx`, new `frontend/src/routes/MobilePage.tsx` +
`frontend/src/mobile/`, `frontend/src/lib/mobile.ts`, locales.
Companion docs: `docs/TERM_FREQUENT_INPUTS_PLAN.md` (same tile chrome),
`docs/TERM_KEY_CHORDS_PLAN.md` (on mobile the key-chord menu is the *only* way to
send `Ctrl`).
Skills: `suwu-tile-plugin-design` (§1 flat pane layer — the invariant this plan
must not break; §11 type scale), `apple-design` (tap targets, direct
manipulation, no hover affordances).

---

## 1. Goal and non-goals

A phone-sized view of the same app, reached automatically:

1. **`/` redirects to `/mobile`** when the client is a phone/tablet. The desktop
   view at `/` stays exactly as it is — no layout changes, no new conditionals in
   `TilingWM`.
2. `/mobile` keeps **all the same logic and state**: the same spaces, the same
   layout tree, the same tile iframes (terminal, files, SFTP, …), the same
   settings, menu and notifications. Only the chrome differs:
   - the header is **fixed at the top** and cannot be re-docked (the
     `headerPosition` setting does not apply);
   - **one tile per screen** — the space's selected tile fills the viewport,
     i.e. focus mode is the only mode;
   - the header carries **previous/next tile** buttons and an **overview** button
     that shows every tile of the space as a card (name + info, no live tile) and
     switches to the one tapped;
   - everything else behaves as on the desktop.

Non-goals: a separate mobile layout model, a PWA/offline mode, native gestures
beyond tile switching, and any change to the desktop route.

## 2. What already exists (reuse map)

| Piece | Where | Mobile |
|---|---|---|
| Spaces + layout tree (persisted) | `wm/atoms.ts` (`spacesAtom`, `activeSpaceAtom`, `layoutAtom`), `wm/layout.ts` | **reuse as-is** — same tiles on phone and desktop |
| Pure layout ops (`leaves`, `findLeaf`, `computeTiling`, `createLeaf`, `splitAndFocus`, `closeAt`, `moveLeafBetweenSpaces`) | `wm/layout.ts` | reuse; mobile needs only `leaves` + focus/close |
| Tile content | `wm/plugins/*.tsx` — each renders its own `<iframe src="/term?pane=…">` | **reuse as-is** (`getTilePlugin(type).render(paneId, ctx)`) |
| Per-tile data (font size, params, `initialPath`) | `space.paneData`, `leaf.initialPath`, `leaf.params` | reuse |
| Per-tile UI state (file browser path, git tabs, code file…) | `wm/sessionState.ts`, `tiling-session-state` in localStorage | reuse read-only, for the overview cards' "info" line |
| Pane ↔ WM messages (font size, `server-started-at`, focus, `auth-expired`) | `wm/TilingWM.tsx` (inline) | **extract** into a hook both shells use (§5) |
| Header chrome, menu/settings/notifications/avatar | `routes/AppShell.tsx`, `components/dialogs/*` | reuse the dialogs; the header itself is replaced |
| Auth (token + login) | `routes/AuthGate.tsx`, `lib/api.ts` | reuse; `AuthGate` becomes a wrapper (§3) |
| Key-chord menu | `components/term/KeyChordMenu.tsx` | reuse; it is the *only* way to send `Ctrl` on a phone |
| Hover toolbar (`TileTools`), dividers, drag/swap, focus mode, keyboard shortcuts | `wm/TileTools.tsx`, `wm/shortcuts.ts` | **not rendered** on mobile; the actions live in the overview sheet |

## 3. Route, detection and auth shape

```
rootRoute
├── appRoute   (id 'app')        → <AuthGate><AppShell/></AuthGate>   ← desktop, unchanged
│    └── indexRoute '/'          → DemoPage (TilingWM)
├── mobileRoute '/mobile'        → <AuthGate><MobileShell/></AuthGate>
└── …tile routes (/term, /viewer, /browser, /sftp, …)  ← iframes, never redirected
```

- **`AuthGate` becomes a wrapper**: today it hard-codes `<AppShell/>`; it gains
  `children` (the shell to render once authenticated). The login screen and the
  token flow are unchanged, so `/mobile` inherits auth for free.
- **Detection** lives in a new pure module `lib/mobile.ts`:
  `shouldUseMobileView({ pathname, search, pointerCoarse, width, hasTouch, preference })`.
  Defaults: mobile when `pathname === '/'`, the viewport is ≤ 820 px **and** the
  pointer is coarse (or `hasTouch` with ≤ 820 px), so a small desktop window does
  not get the phone UI and an iPad does.
- **Two redirect points**, so no flash and no escape route:
  1. `main.tsx`, before `createRoot` — only for `pathname === '/'`, only when
     `shouldUseMobileView()` is true: `history.replaceState(null, '', '/mobile' + search)`.
  2. `indexRoute`'s `beforeLoad` — the same decision, so in-app navigation to `/`
     (brand tap, back button) does not land on the desktop shell.
- **Escape hatches**: `?desktop=1` on `/` (and `/mobile`) pins the choice in
  `localStorage['suwu.mobile-preference'] = 'desktop' | 'mobile'`; the menu gains a
  "Desktop view on this device" toggle so it is discoverable, and `/mobile` stays
  reachable on a desktop for development.
- Tile routes are untouched: they are iframes *inside* either shell, and their
  own auth/WS token logic already works on a phone.

## 4. The mobile shell

### 4.1 Header (fixed, top, not configurable)

One 44 px row, `padding-top: env(safe-area-inset-top)`, `text-xs`/`text-sm` per
the type scale, every control a ≥ 40 px tap target:

```
[☰]  [space ▸]      ‹  Terminal  ›        [▦ overview]  [🔔]
```

- `☰` opens the existing unified menu (settings, app menu, about, logout —
  unchanged).
- `space ▸` is a pill showing the active space number; tapping opens a sheet with
  the space list (name, tile count), add/remove space. Replaces the desktop's row
  of numbered space buttons, which does not fit.
- `‹ label ›` cycles the tiles of the active space
  (`cycleTile(leaves(layout), focused, ±1)`); the label is the plugin's label
  (`Terminal`, `File browser`, …), truncated with ellipsis.
- `▦` opens the overview sheet (§4.3). `🔔` is the existing notification bell.
- `headerPositionAtom` is **ignored** here; `SettingsView`'s header-position
  control is hidden (or shown disabled with a "desktop only" hint) so the setting
  cannot claim something the phone does not do.

### 4.2 Content: one tile, full screen, without unmounting the others

The shell renders **the same flat, keyed pane layer as the desktop** — every pane
of every space, absolutely positioned, `display: none` unless it is the active
space's selected tile — and then simply gives the visible one the full viewport
rect. This keeps the design skill's invariant (§1): switching tiles only flips
`display`, so a terminal keeps its WS session, a folder sync keeps running, and a
half-typed form survives.

Order of selection: `focusedIdAtom` when it belongs to the active space, else the
first leaf of that space, else the empty state (`+ Open app`).

No `TileTools`, no dividers, no drag/swap, no focus mode: all of those are
desktop-only chrome. Actions a phone still needs (add tile, close tile, font size)
move into the overview sheet.

### 4.3 Overview sheet

A bottom sheet (glass material, `max-h-[80dvh]`, scrollable body) listing the
space's tiles as cards in a 2-column grid:

```
┌────────────────┬────────────────┐
│ [T] Terminal   │ [F] Files      │
│ ~/suwu-dev     │ /video/tv      │  ← info line
│            ⋯   │            ⋯   │
└────────────────┴────────────────┘
```

- Card = `appIcons.ts` badge + plugin label + one info line: `leaf.initialPath`
  (basename), else the plugin description, else the pane's persisted session hint
  (file browser path, git repo, code tab) read from `tiling-session-state`.
- Tap = switch (`focusedIdAtom`, close the sheet). The active tile is marked.
- `⋯` opens a small action list: **Close tile**, **Font size** (−/reset/+ on the
  pane's `paneData.fontSize`), **Move to space** (reuses `moveLeafBetweenSpaces`).
- Footer: **+ Open app** → the existing `TileTypePicker` (list of plugins with
  labels/descriptions). On mobile the picker inserts with `splitAndFocus(…, 'vertical')`
  or `createLeaf` when the space is empty; the split geometry is invisible on a
  phone and stays correct on the desktop.
- No live tiles inside the cards (the user asked for name + info only): the real
  iframes stay in the content layer, hidden.

## 5. Shared plumbing extraction (the one refactor)

`TilingWM` currently owns the pane ↔ WM protocol inline: `server-started-at`
broadcast, per-tile font-size push, `request-font-size` replies, `auth-expired`
relay, focus acknowledgements. Both shells need that, so it moves into
`wm/usePaneBus.ts` (one hook: subscribes to `window` messages, exposes
`sendFontSize(paneId)`, `serverStartedAt`, and the pane iframe refs). This is a
pure move with no behaviour change — do it **first**, with the desktop as the
regression test, before any mobile UI exists.

## 6. Touch and soft-keyboard specifics

- `index.html` viewport →
  `width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content`
  (notch padding + Android resize-on-keyboard; iOS is handled below).
- Shell height: `h-dvh` and nothing else; no `min-h-screen` (which is 100vh on
  iOS and hides the last line behind the URL bar).
- Keyboard: listen to `window.visualViewport` (`resize`/`scroll`) and set
  `--vvh` on the shell when the keyboard opens, so the terminal bottom stays
  visible on iOS. xterm re-fits through its existing `ResizeObserver`.
- No drag/resize/divider gestures (they fight scrolling); the header buttons and
  the sheet are the only navigation. Swipe-to-switch is deliberately **not** in
  v1 — it conflicts with xterm's horizontal scroll and text selection.
- Tap targets ≥ 40 px; no hover-only affordance (`opacity-0 group-hover` patterns
  are replaced by always-visible buttons in the sheet).
- The terminal's own touch behaviour is unchanged (xterm handles scrolling and
  selection); the key-chord menu from `docs/TERM_KEY_CHORDS_PLAN.md` is the way to
  send `Ctrl`, `Esc`, `F*` keys on a phone.

## 7. Files

New:

- `src/lib/mobile.ts` — `shouldUseMobileView()`, `cycleTile()`, `tileInfo()`
  (pure; Node-testable).
- `src/routes/MobilePage.tsx` — route component: `<AuthGate><MobileShell/></AuthGate>`.
- `src/mobile/MobileShell.tsx` — fixed header + pane layer + sheets.
- `src/mobile/MobileHeader.tsx`, `src/mobile/OverviewSheet.tsx`,
  `src/mobile/SpaceSheet.tsx`.
- `src/wm/usePaneBus.ts` — the extracted protocol hook.
- `scripts/check-mobile.mjs` — checks the pure model (see §9).

Changed:

- `src/main.tsx` (pre-render redirect), `src/router.tsx` (`/mobile`,
  `beforeLoad` guard).
- `src/routes/AuthGate.tsx` (children instead of hard-coded `AppShell`).
- `src/wm/TilingWM.tsx` (use `usePaneBus`; drop the moved code).
- `src/components/dialogs/SettingsView.tsx` (hide header-position on mobile).
- `src/locales/{en,zh_CN}.json` (`mobile.*` keys; reuse `plugin.*` labels).
- `index.html` (viewport meta).

Untouched: every tile plugin, `pkg/server`, the desktop route's behaviour.

## 8. Phases

| Phase | Work | Effort |
|---|---|---|
| 0 | Extract `usePaneBus` from `TilingWM` (pure move); desktop must behave identically | 1 d |
| 1 | `lib/mobile.ts` + `check-mobile.mjs`; `/mobile` route; `AuthGate` wrapper; redirect in `main.tsx` + `beforeLoad`; escape hatch | 0.5 d |
| 2 | `MobileShell`: fixed header, flat pane layer with one visible tile, `focusedIdAtom` selection, empty state | 1 d |
| 3 | Overview sheet (cards, switch, close, font size, move-to-space, + open app), space sheet | 1 d |
| 4 | Touch/keyboard polish: `visualViewport`, safe areas, tap targets, hide desktop-only settings, i18n, docs | 0.5–1 d |

Total ≈ 4–4.5 days, with the phone build usable after phase 2.

## 9. Testing

- `scripts/check-mobile.mjs` (in `pnpm check`), over the pure module:
  redirect decision matrix (`/` vs tile routes, coarse vs fine pointer, wide vs
  narrow, `?desktop=1`, stored preference), `cycleTile` wrap-around and
  empty/single-tile cases, `tileInfo` fallbacks.
- A check that every registered plugin has a label and description (the overview
  cards need both) — extend `tilePlugins` with a dev assertion or reuse the
  existing plugin-picker test.
- Manual matrix (recorded in the doc when run):

| Case | Expect |
|---|---|
| iPhone Safari (notch), `/` | redirects to `/mobile`; header clears the notch; keyboard does not hide the prompt |
| Android Chrome, `/` | redirects; keyboard resizes instead of overlaying |
| iPad / small desktop window | stays on `/` (fine pointer, or > 820 px) |
| Tile switching | terminal keeps its session; a running folder sync keeps running |
| Rotation | tile re-fits, xterm reflows (`ResizeObserver`) |
| Background → foreground | WS reattaches, no duplicate tiles |
| `/term` opened directly | still a bare tile, no redirect loop |
| Desktop | byte-identical behaviour; `pnpm check` green |

## 10. Risks

| Risk | Mitigation |
|---|---|
| Iframe state lost when switching tiles | flat keyed pane layer + `display: none` (the existing invariant); never conditionally render panes |
| Many live terminals on a phone's memory | the layout is shared, not duplicated; document that a phone sees the same tiles — closing them is in the sheet. Revisit lazy-mounting if users report pressure |
| Soft keyboard hiding the terminal / jumping layout | `dvh` + `visualViewport` + `interactive-widget=resizes-content`, verified on both platforms |
| Redirect loop or trapping a phone user in the mobile UI | single-source decision in `lib/mobile.ts`, `?desktop=1` + a persisted toggle, `beforeLoad` failure falls through to desktop |
| Extract refactor breaking desktop | phase 0 is a move-only change, covered by the existing checks and a manual pass; no behaviour changes in the same commit |
| Divergent behaviour between shells over time | both shells read the same atoms and the same plugin render; mobile-specific code stays inside `src/mobile/` |

## 11. Open questions

1. Overview cards: is `initialPath`/session hint enough for "info", or should a
   terminal card show the server-side cwd (needs a small `/api/session-state`
   read or the existing WS state on attach)? Default: no extra request in v1.
2. Should the phone default to a larger terminal font (13–14 px) via the font
   preset, given `TileTools`' A−/A+ is not on screen? Default: keep the user's
   setting, expose font size in the sheet's `⋯` actions.
3. Multiple spaces on a phone: keep the space pill + sheet (v1), or flatten to a
   single "All tiles" list? Default: keep spaces, they are cheap.
4. PWA install (manifest + icon + `display: standalone`) is out of scope here but
   would make the "phone app" feel complete — see a follow-up doc if wanted.

---

## 12. What shipped

Phases 0–4 landed in four commits, each with the plan's exit criteria:

| Phase | Commit | Contents |
|---|---|---|
| 0 | `refactor(wm): extract the pane message bus into usePaneBus` | the shell↔tile postMessage protocol (`server-started-at`, `tile-font-size`, `tile-state-update`, `request-session-state`, `request-font-size`, restarts, FIFO pruning) moved out of `TilingWM.tsx` into `wm/usePaneBus.ts`; move-only |
| 1 + 2 | `feat(mobile): a phone shell at /mobile, one tile per screen` | `lib/mobile.ts` + `scripts/check-mobile.mjs`, `/mobile` route, `AuthGate` children, both redirect points, `?desktop=1` escape hatch, `mobile/MobileShell.tsx` + `MobileHeader.tsx`, shared `wm/registerPlugins.ts` and `wm/TileTypePicker.tsx` |
| 3 | `feat(mobile): the overview sheet, the space sheet and per-tile actions` | `mobile/BottomSheet.tsx`, `OverviewSheet.tsx` (cards, ⋯ → close/font/move, "+ Open app"), `SpaceSheet.tsx` (rows, add/remove) |
| 4 | `feat(pwa): installable manifest and a hashed-asset service worker` | `--vvh` visual-viewport hook, header-position control hidden on `/mobile`, `manifest.webmanifest`, `sw.js`, `.webmanifest` media type |

Phases 1 and 2 were committed together: the `/mobile` route with no shell in it
would have been dead code, and the shell without the route could not be opened.

Deviations from the plan, and why:

- **The redirect lives in `router.tsx` module scope**, before `createRouter`, not
  only in `indexRoute.beforeLoad`. `beforeLoad` runs after the router has read
  `window.location`, so a phone would paint the desktop shell for a frame.
  `beforeLoad` is kept as the second line of defence for in-app navigation.
- **No swipe-to-switch.** It conflicts with xterm's horizontal scroll and text
  selection; the header arrows and the sheet are the navigation. (§4.1)
- **`sessionHint` only trusts path-shaped values.** The plugins persist short
  flags under ordinary-looking names (`path: "s"`), and a card that reads "s" is
  worse than a card that reads the plugin description.
- **Close selects the next tile in arrow order**, else the previous — the plan
  said "nearest by geometry", but the geometry is invisible on a phone and the
  arrow order is what the user just saw.
- **The overview is a bottom sheet, not a full-screen takeover**: the tile stays
  visible behind it, which is what makes "switch and look" one gesture.
- **`--vvh` instead of relying on `dvh` alone**: iOS shrinks only the visual
  viewport when the keyboard opens.

Verified (headless Chromium over CDP, 390×844, seeded two-space/three-tile
profile): one visible tile with the other two still mounted
(`iframe[data-pane]` = 3, visible = 1), a live terminal prompt in a full-screen
tile, arrows cycling Terminal → File Browser → Terminal, overview cards with
labels and hints, A+ writing `paneData.fontSize` into the same `tiling-spaces`
the desktop reads, close removing its leaf and keeping focus, "+ Open
Application" opening the picker, the space sheet with correct `1 tile`/`2 tiles`
plurals, and `/` at 1440×900 unchanged.

Not verified here (needs a real phone): iOS keyboard behaviour, safe-area insets
on a notched device, PWA install from the home screen, and the 44 px tap targets
under a thumb. These are the manual matrix items in §9.

## 13. PWA

The phone shell is also installable:

- `frontend/public/manifest.webmanifest` — `name`/`short_name` Suwu,
  `start_url: "/"` (the redirect decides), `display: "standalone"`,
  `theme_color` `#0b1020`, and **PNG** icons: 192, 512, **1024** and a 512
  `maskable` one whose artwork sits inside the mask's safe zone. Apple's guidance
  for a PWA manifest is 512 or 1024 — the platform scales the launcher icon, so a
  larger source survives any density — and Chrome keeps its 192 for the install
  prompt.
  The SVG is not enough: **iOS ignores an SVG `apple-touch-icon`** and invents a
  letter tile ("S") instead, and a home-screen icon is the one part of a PWA you
  cannot fix in CSS. `scripts/gen-icons.mjs` regenerates all four PNGs from
  `logo.svg` by rendering it in a Chromium at each size — there is no image
  toolchain in this repo, but the app is a browser app, so there is always a
  Chromium. Run it by hand after editing the logo; `TestPwaIconsAreServed` keeps
  a missing icon from shipping.
- `frontend/public/sw.js` — deliberately minimal: **cache-first for
  `/assets/<hashed-name>` only**, everything else passes through untouched. No
  navigation, `/api/*`, `/ws/*` or tile-route caching: a cached shell or API
  response would show a stale build or a stale file list, and a terminal
  reconnecting to a server it does not match is worse than a slower start. The
  cache is pruned to 80 entries and old cache names are dropped on activate.
  Registered in `main.tsx` in production builds only — a cache-first worker over
  Vite's dev server would pin unhashed modules.
- `index.html` — manifest link, `theme-color`, `mobile-web-app-capable`, the
  three `apple-mobile-web-app-*` metas so iOS launches it without browser chrome,
  and `apple-touch-icon` pointing at the 180 px PNG.

### 13.1 Why "Install app" may not appear

Chrome only offers installation in a **secure context with a valid certificate**.
`Page.getInstallabilityErrors` (CDP) on this build reports nothing but
`in-incognito`, so the manifest, icons, `start_url`, `display` and the service
worker all satisfy the criteria — but a LAN address over HTTPS with a
self-signed certificate (`https://192.168.0.221:8080`, the ⚠️ in the address bar)
is *not* a secure context: the service worker never registers and the install
prompt never appears. Same for plain `http://` on a LAN IP.

Ways to get a real install on a phone:

- a certificate the device trusts (mkcert's CA installed on the phone, Caddy, or a
  tunnel with a valid cert), or
- `chrome://flags/#unsafely-treat-insecure-origin-as-secure` with the origin
  added (a test-only escape hatch), or
- `http://localhost:PORT` on the machine itself, which is secure by definition.

iOS "Add to Home Screen" has no such requirement — it works from any page — which
is why the iPhone install worked while Android's did not.

### 13.2 The PWA files must never be behind the login gate

A home-screen install fetches the manifest, the icons and the worker **before
anyone logs in**, and iOS fetches the touch icon with no cookies and no referer at
all. That is why `serveAsset` leaves static files unauthenticated (only the API
handlers check the token), and `TestPwaFilesArePublic` pins the behaviour: the
test starts a server *with a password set* and asserts that
`/manifest.webmanifest`, `/sw.js`, `/icons/icon-180.png` and
`/apple-touch-icon.png` all answer 200 without a cookie.

Putting them behind auth fails in a way that is invisible on a logged-in desktop:
iOS falls back to a generated letter tile and Chrome silently drops the install
prompt.

iOS has three bites at the icon, and all are present: one
`<link rel="apple-touch-icon">` per size the device may ask for (120/152/167/180 —
older iOS falls back to a screenshot when no offered size matches),
`/apple-touch-icon.png` (+ the `-precomposed` alias) at the site root for entry
points that ignore the link, and the manifest's PNG icons.

Safari caches a web app's icon **per icon URL**, so the links carry `?v=2`: bump
that when the artwork changes and iOS fetches it again instead of reusing the old
tile. If an icon is still stale, delete it from the home screen, close the old
tab, open the origin in a **fresh** tab, and add it again — and make sure the
origin and port are the ones running the current build
(`curl -sk https://host:port/mobile | grep apple-touch-icon` prints nothing on an
old binary).

One environment note for self-signed deployments: the home-screen icon is fetched
by the system's web-app machinery, not by the tab you are looking at. A
certificate the device does not trust (the ⚠️ in the address bar) is the one thing
that reliably gets in the way, and it is also why Chrome withholds the install
prompt (§13.1). If everything above checks out and the icon is still a letter
tile, test the same build over plain `http://` — no certificate, no argument.
- `pkg/server` — `.webmanifest` joined `mimeTypes` as
  `application/manifest+json`; without it the file was sniffed as `text/plain`
  and Chrome refuses to install from that. Both the manifest and the worker keep
  `Cache-Control: no-store`, so a pinned worker cannot outlive a deploy.
  Covered by `TestPwaFilesAreServedWithCorrectType`.

## 14. Fixes from the first real phone test

Four things the first pass got wrong, and what they were:

1. **The tile was edge to edge.** `MobileShell` put the panes in `absolute inset-0`
   children of a `p-2` container, and an absolutely positioned child spans its
   containing block's *padding box* — the padding was ignored. The panes now live
   in a `relative h-full w-full` box inside the padded `main`, and carry the same
   `rounded-[6px] border border-white/5 shadow` the desktop's panes do, so a
   phone tile looks like a tile (8 px margin, matching `AppShell`'s `p-2` and
   `wm/layout.ts`'s 8 px gutter).
2. **A terminal born in a hidden box could paint nothing.** Every pane of every
   space was mounted up front, and a pane inside `display: none` has a 0×0
   viewport: xterm fits itself to zero rows and a terminal that reports
   "Connected" draws an empty screen. Panes are now mounted on their first reveal
   (`seen`) and never unmounted again — the session-preservation invariant is
   untouched, and a phone no longer opens a PTY per unvisited tile.
3. **The settings dialog was 576 px wide on a 390 px screen** — it rendered off
   the edge. `SuwuDialog` is now `w-[min(92vw,36rem)]` / `h-[min(682px,92dvh)]`
   (identical to 576×682 on a desktop) and `SettingsView` turns its vertical tab
   rail into a horizontally scrolling row on `/mobile`.
4. **A lost GPU context left the terminal blank.** Each terminal tile loads a
   WebglAddon; when the browser reclaims a context (routine on phones after
   backgrounding, and more likely with one context per tile) the terminal kept its
   buffer and its WebSocket — status "Connected" — but painted nothing.
   `useTerminal` now re-attaches the renderer once and repaints through the
   fallback, and `usePtySession` backs its reconnect off (2 s → 15 s) instead of
   retrying every 2 s forever.

Known limitation, not fixed here: **two views of the same layout in one browser**
(a desktop tab plus `/mobile`, or two tabs) share one PTY, keyed by pane id, and
the newest attachment evicts the older one, so the two fight. The backoff makes it
degrade to "the visible view owns the terminal" instead of a 2 s hot loop. The
proper fix (several viewers per session, or a cross-tab lease) is its own change.

### 14.1 The blank terminal was a software GPU

The "Connected but no prompt" tile was reproduced exactly: **WebGL on a software
rasteriser**. Such a driver (SwiftShader/llvmpipe — what a VM without GPU
passthrough, a blocked GPU or Chrome's device emulation gives you) hands out a
perfectly usable context: it clears, `readPixels` returns the right pixels,
`onContextLoss` never fires. It just never composites the terminal's canvas into
the page, so the tile shows its background and its status bar and nothing else.
The buffer was always correct (`__term.buffer` held `yli@pvedev:~$`).

That was fixed for software GPUs, but **Android Chrome on a real GPU** showed the
same blank tile while iOS Safari rendered fine, so "software" was not the whole
story: a WebGL canvas can simply fail to composite on a phone. The renderer is
therefore a preference (`lib/termRenderer.ts`, `localStorage['suwu.term-renderer']`,
`auto` by default):

| preference | behaviour |
|---|---|
| `auto` | built-in renderer on touch-first devices and on software GPUs, WebGL elsewhere |
| `dom` | always xterm's built-in renderer — slowest, always correct |
| `webgl` | always the accelerated renderer, for devices known to be fine with it |

`auto` is conservative on phones because that is exactly where the canvas
disappears and where a terminal's throughput matters least. It is a preference,
not a hidden heuristic: the tile's ⋯ panel has a **Renderer** row (Auto / DOM /
GL) that writes the key and reloads the tile iframes so the change applies
immediately, and the same panel shows the live diagnostics line
(`dom · 39x38 · dpr 3 · software · ANGLE (…SwiftShader…)`) read from the tile's
`__term` / `__termRenderer` handles. `window.__termRenderer` also reports the
choice per document; `?renderer=dom` on a tile URL still forces it for a one-off
test.

Slower on heavy output than WebGL, but it draws DOM nodes, which always
composite — a renderer that can silently show nothing is not worth the
throughput.

### 13.3 Trusting Suwu's local CA on an iPhone

`suwu serve` uses HTTPS with a leaf certificate signed by a **persistent local CA**
(`pkg/certs`: `~/.config/suwu/CA/rootCA.pem`, ten years, named "suwu local CA"),
because a private IP cannot get a public certificate. Browsers show a warning until
the device trusts that CA — and until then iOS will not reliably fetch the
home-screen icon, Chrome will not offer to install, and the service worker does not
register. So trust the CA and everything else (icons, install, offline assets)
falls into place.

The CA **certificate** is public; the key next to it must stay on the server. Only
the `.crt` goes to the phone.

1. On the server, write a DER copy with a `.crt` name (iOS offers to install that,
   not `.pem`):

   ```sh
   openssl x509 -in ~/.config/suwu/CA/rootCA.pem -outform DER \
     -out ~/.suwu/dropbox/suwu-local-ca.crt
   ```

2. On the iPhone, open Suwu's Dropbox tile over the same origin, download
   `suwu-local-ca.crt`, and accept the certificate warning one last time.
3. **Settings → General → VPN & Device Management →** the downloaded profile **→
   Install** (enter the passcode).
4. **Settings → General → About → Certificate Trust Settings →** enable full trust
   for "suwu local CA". Step 4 is the one people miss: installing the profile is
   not the same as trusting it.
5. Reload Safari — the ⚠️ is gone. Remove any Suwu home-screen icon and add it
   again; the icon, the install prompt and the worker all work from here.

Sanity checks from the phone's network (or from the server):

```sh
openssl s_client -connect 192.168.0.221:8181 </dev/null 2>/dev/null |
  openssl x509 -noout -subject -issuer -ext subjectAltName
# subject must list the IP you browse to, issuer must be "suwu local CA"
```

If the certificate is regenerated with a new CA, the old profile has to be removed
from the device and the new one installed.
