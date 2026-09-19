---
name: suwu-tile-plugin-design
description: "The design practice for Suwu tile plugins — the TilePlugin contract, the iframe page pattern, URL param conventions, CommonTileContainer, toolbar composition, user-editable app menu, session state, postMessage IPC, and the typography/material rules. Use when adding, refactoring, or reviewing a tile plugin, its pane UI, or its app-menu entry."
license: MIT
metadata:
  author: suwu
  source: "frontend/src/wm/"
  stack: "React + TypeScript + Tailwind + TanStack Router + Jotai"
---

# Suwu Tile Plugin Design

## Purpose

This is the current, implementation-derived design practice for tile plugins in
Suwu's tiling window manager. It describes the *contracts and conventions* a
plugin must honor, not just the mechanical steps. Read it before adding,
refactoring, or reviewing a tile plugin.

The through-line: **a tile is a durable, isolatable app surface**. Its content
may live in an iframe, it survives layout churn, it carries its own session
state, and it is registered by declaration — not by editing the window manager.

> This skill supersedes the older `tile-plugin-system` skill where they differ.
> The big shifts since that doc: `supportedParams` self-documentation, custom
> apps stored in an atom instead of hardcoded config presets, per-plugin HTML
> zoom, `setPageTransparent()`, and a broader set of IPC channels.

---

## 1. The mental model

```
TilingWM (parent window)
  ├── layout tree (pure data: leaf { tileType, initialPath, params })
  │       └── computeTiling() ──> pixel rects
  ├── flat list of absolutely-positioned <div class="pane"> (one per leaf)
  │       └── plugin.render(paneId, ctx) ──> <iframe src="/route?pane=…" data-pane=…>
  │               └── RoutePage (child window)
  │                     └── <CommonTileContainer>
  │                           ├── saved session state (localStorage, per server run)
  │                           ├── zoom + tile background
  │                           ├── focus → parent
  │                           └── WM shortcut relay → parent
  └── TileTools (hover toolbar per pane)
        ├── plugin.renderToolbar(ctx)   ← type-specific buttons
        └── shared move/swap/focus/space/close
```

**The single most important invariant:** panes are a *flat* list positioned by
inline `left/top/width/height`, not a nested flex tree. A layout change only
mutates those inline styles, so the `<iframe>` DOM node is never unmounted or
reparented. That is what keeps PTY sessions, scrollback, scroll position, open
dialogs and draft input alive across split/close/swap. If a change would cause
React to remount the iframe wrapper, the design is wrong.

---

## 2. The plugin contract

**File:** `frontend/src/wm/tilePlugins.ts`

```ts
export interface TilePlugin {
  id: TileType
  label: string
  description?: string
  /** Declared params this plugin accepts — drives the custom-app editor. */
  supportedParams?: PluginParamDoc[]
  /** Render the tile content. */
  render: (paneId: string, context?: TileRenderContext) => ReactNode
  /** Type-specific toolbar buttons, rendered before the shared controls. */
  renderToolbar?: (ctx: ToolbarContext) => ReactNode
}

export interface PluginParamDoc {
  key: string
  label: string
  description?: string
  defaultValue?: string
}

export interface TileRenderContext {
  paneId: string
  initialPath?: string                    // one-shot path from the action resolver
  onOpenPicker?: (paneId: string) => void // only meaningful for the empty plugin
  params?: Record<string, string>         // user/app-menu params
}

export interface ToolbarContext {
  paneId: string
  fontSize: number
  fontDefault: number
  setFontSize: (size: number) => void
  canMove: (id: string, dir: MoveDir) => boolean
  move: (id: string, dir: MoveDir) => void
  closeTile: (id: string) => void
  startSwap: (id: string) => void
}
```

Register by side effect; never build a central switch statement:

```ts
// frontend/src/wm/plugins/myplugin.tsx
import i18n from '../../i18n'
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'

registerTilePlugin({
  id: 'myplugin',
  get label() { return i18n.t('plugin.myplugin') },        // lazy — registry loads at module init
  get description() { return i18n.t('plugin.mypluginDesc') },
  render: (paneId, context?: TileRenderContext) => { /* … */ },
})
```

Then add the side-effect import in `TilingWM.tsx` next to the others:

```ts
import './plugins/myplugin'
```

### Not every plugin is an iframe

Most plugins return an `<iframe>`, but the render function returns arbitrary
React. `empty` (picker placeholder) and `gitgraph`/`diff` toolbar-interaction
patterns show the range. Rules of thumb:

- Use an **iframe** when the app owns heavy state, a server connection, or
  third-party code — isolation is the point.
- Use an **inline React node** only for tiny, stateless UI (e.g. the empty
  placeholder). Inline nodes live in the parent window, so they do *not* get
  `CommonTileContainer`'s session state or shortcut relay for free.

---

## 3. The iframe page pattern

Every iframe plugin needs a dedicated route rendered **under `rootRoute`**, not
under `appRoute` — tile pages have no app shell/header and must fill the frame.

**Step 1 — page component** in `frontend/src/routes/MyPluginPage.tsx`:

```tsx
export default function MyPluginPage() {
  useEffect(() => { setPageTransparent() }, [])   // 1. transparent page background
  return (
    <CommonTileContainer zoomAtom={myPluginZoomAtom} noPadding>  {/* 2. lifecycle wrapper */}
      {/* 3. your UI */}
    </CommonTileContainer>
  )
}
```

**Step 2 — route** in `frontend/src/router.tsx`:

```tsx
const myPluginRoute = createRoute({
  getParentRoute: () => rootRoute,   // rootRoute, never appRoute
  path: '/myplugin',
  component: MyPluginPage,
})
// …and add it to rootRoute.addChildren([...])
```

**Step 3 — plugin render** wires the iframe:

```tsx
render: (paneId, context) => {
  const p = new URLSearchParams({ pane: paneId })
  const path = context?.initialPath ?? context?.params?.path
  if (path) p.set('path', path)
  if (context?.params) for (const [k, v] of Object.entries(context.params)) p.set(k, v)
  return (
    <iframe
      src={`/myplugin?${p}`}
      title={`myplugin-${paneId}`}
      data-pane={paneId}                       // REQUIRED identity hook
      className="h-full w-full border-0 bg-transparent"
    />
  )
}
```

`data-pane` is the identity contract: `CommonTileContainer` reads
`window.frameElement.dataset.pane` to know which pane it belongs to, and
toolbar buttons find the target iframe with `iframe[data-pane="…"]`.

---

## 4. `CommonTileContainer` — the tile lifecycle wrapper

**File:** `frontend/src/components/CommonTileContainer.tsx`

Wrap every tile page in it. It centralizes five concerns so individual plugins
never reimplement them:

1. **Tile background + zoom** — reads `fileBrowserBgAtom`, applies
   `tileZoomStyle(zoom)`, and sets the wrapper background. `noPadding` removes
   the default `p-2` for full-bleed plugins (browsers, viewers, streams).
2. **Session restore** — listens for `server-started-at`, loads the saved state
   for this pane from `localStorage`.
3. **Focus notify** — posts `pane-focus` upward so the WM knows the active tile.
4. **Shortcut relay** — captures `Alt+…` inside the iframe and posts
   `wm-shortcut` so shortcuts work from any tile.
5. **Context** — exposes the loaded state via `useTileSessionState<T>()`.

```tsx
// read once on mount
const saved = useTileSessionState<MyState>()

// persist on change (debounced by the parent)
const reportState = useReportTileState()
useEffect(() => { reportState({ currentPath, sortKey }) }, [currentPath, sortKey, reportState])
```

**Transparency is a page-level concern, not a container one.** Route pages call
`setPageTransparent()` from `frontend/src/lib/constants.ts` on mount. Without it
the opaque `:root` background sits behind the translucent tile and defeats the
glass/alpha effect. Some plugins (e.g. `xdisplay`) intentionally opt out of
transparency and use a solid `bg-black` iframe instead.

**Per-plugin zoom** lives in `frontend/src/store/zoom.ts`
(`atomWithStorage('suwu.<plugin>-zoom', 1)`), one atom per plugin so every pane
of the same type stays in sync. Pass it as `zoomAtom`.

---

## 5. URL param contract

The query string is the plugin's launch API. Keep the vocabulary consistent.

| Param | Meaning | Written by |
|-------|---------|-----------|
| `pane` | Owning pane id — required by every iframe route | plugin `render` |
| `path` | One-shot initial path (browser/viewer/db/gitgraph) | plugin `render` from `initialPath`/`params` |
| `file1`, `file2` | Diff inputs | diff plugin |
| `files` | JSON array of `{ path, ranges }` opened as editor tabs | code plugin |
| arbitrary | Anything declared in `supportedParams` | app-menu custom app / preset |

Precedence convention: `context.initialPath` is a transient hand-off from the
action resolver (e.g. "open this file"); `context.params` are durable user
settings from the app menu. Prefer `initialPath ?? params.path` for
single-path plugins. For multi-param plugins (db, gitgraph, term, xdisplay),
apply `initialPath`/defaults first, then loop over `params` so user params win.

Reading params in the page is done from `window.location.search` (see
`FileViewerPage`).

---

## 6. `supportedParams` — self-documenting params

Declare every meaningful URL param the plugin accepts:

```ts
supportedParams: [
  { key: 'cmd', label: 'Command', description: 'Shell command to execute' },
  { key: 'cwd', label: 'Working directory', description: 'Initial directory path' },
],
```

Why this matters: the App Menu editor (`AppMenuView` / `AppSettingsView`) only
lists plugins that declare `supportedParams`, renders a labeled input per key,
shows the description as a hint, and pre-fills `defaultValue`. Params are shown
in declaration order, followed by any free-form user keys. If you skip this,
your plugin can never be used as a custom app — treat `supportedParams` as part
of the plugin contract, not optional documentation.

---

## 7. Toolbar composition

`TileTools` reveals a per-pane toolbar on hover near the top-right corner. It
composes, in order:

```
[ plugin.renderToolbar(ctx) ] │ [move ←→↑↓] │ [swap] │ [focus] │ [move-to-space] │ [close]
```

Design rules:

- **Type-specific controls go first and stay minimal.** Font size (term),
  refresh (gitgraph/diff) are the right scale. Do not duplicate shared controls.
- **Reuse the house button class.** Every toolbar button uses the `toolBtn`
  pattern (5×5 grid, `glass-btn`, hover tint, disabled opacity). Close uses the
  rose-tinted `closeBtn` variant.
- **Buttons must carry `aria-label` and `title`**, and include the keyboard
  shortcut in the title where one exists.
- **Cross-window actions go through postMessage**, not DOM poking. Example:

```tsx
onClick={() => {
  const iframe = document.querySelector(`iframe[data-pane="${paneId}"]`) as HTMLIFrameElement
  iframe?.contentWindow?.postMessage({ type: 'gitgraph-refresh' }, '*')
}}
```

---

## 8. App menu & custom apps (replaces hardcoded presets)

Design decision worth knowing: **presets are user data, not code.** The static
`registerAppConfig()` registry has been removed; the only model is the App Menu
(`frontend/src/store/appMenu.ts`):

- `appMenuAtom` (`atomWithStorage('suwu:app-menu')`) holds
  `{ hiddenApps: string[], customApps: CustomApp[] }`.
- **Blacklist visibility** — every registered plugin shows by default; users
  hide what they don't want.
- **`customApps`** — a user creates a named entry that targets an existing
  `pluginId` with a `params` map. There is no per-preset code.
- `getVisibleApps(plugins, state)` merges registry plugins and custom apps into
  one ordered list; order is user-defined.
- Custom apps inherit their icon from the parent `pluginId` via `appIcons.ts`.

Consequence for plugin authors: you do **not** add a preset file per
configuration. You declare `supportedParams`, and users compose their own
entries in App Menu settings. `empty` is deliberately excluded from the picker;
only plugins with non-empty `supportedParams` can back a custom app.

---

## 9. Session state

**Types:** `frontend/src/wm/sessionState.ts` — add one interface per plugin.

```ts
export interface MyPluginSessionState { currentPath: string; sortKey?: string }
```

Storage model: `SessionStore = { [serverStartedAt]: { [paneId]: { tileType, state } } }`,
keyed by server start timestamp so each server run gets its own slot (max 5,
FIFO). The parent persists `tile-state-update` messages; the child reads them
back on `server-started-at`. Persist only *restorable* UI state (path, sort,
selection) — never secrets or transient loading flags.

---

## 10. postMessage IPC channels

Same-origin `window.postMessage`, discriminated by a `type` field.

| Direction | Type | Payload | Purpose |
|-----------|------|---------|---------|
| parent → iframe | `server-started-at` | `{ startedAt }` | session-restore key |
| parent → iframe | `tile-font-size` | `{ fontSize, fontDefault }` | apply tile font size |
| parent → iframe | `tile-path-update` | `{ path }` | swap file without remount (reserved; only FileViewerPage listens today) |
| iframe → parent | `request-font-size` | `{ paneId }` | ask for current font size on load |
| iframe → parent | `pane-focus` | `{ pane }` | tile gained focus |
| iframe → parent | `tile-state-update` | `{ paneId, state }` | persist session state |
| iframe → parent | `wm-shortcut` | `{ action }` | relay a WM shortcut |
| iframe → parent | `wm-open-file` | `{ path, tileType, sourcePane }` | open a file in a new tile |
| iframe → parent | `wm-close-pane` | `{ pane }` | close this tile |
| parent → iframe (plugin-defined) | e.g. `gitgraph-refresh`, `diff-refresh`, `code-save`, `code-open`, `code-search` | — | toolbar-triggered actions |

Conventions: always `window.parent?.postMessage({ type: '…', … }, '*')` from a
child; the parent listens on `window.addEventListener('message', …)`. Namespace
plugin-specific channels with the plugin id to avoid collisions.

---

## 11. Material, typography & layout rules

**Glass material.** Tile surfaces use the shared `glass-control` / `glass-btn`
classes (and `menu-glass` for floating menus) — never hand-rolled
`backdrop-blur` + rgba. The container supplies the tile background; child panels
that need separation use `bg-black/20`-style translucent layers.

**Typography — the type scale.** Suwu uses a fixed seven-step scale. This table
is the single source of truth (`AGENTS.md` points here). Do not invent sizes; if
a value is not in this table it is wrong.

| Category | Size | Tailwind | Use for |
|----------|------|----------|---------|
| Display | 24px | `text-2xl` | Brand/wordmark only (auth, about). At most one per screen. |
| Heading | 16px | `text-base` | Dialog/panel titles, empty-state titles. |
| Body | 14px | `text-sm` | Primary reading + interactive rows: list rows, menu items, tile body, primary buttons. |
| Label | 12px | `text-xs` | Form/section labels, dense secondary body, standard buttons, badges. |
| Caption | 11px | `text-[11px]` | Descriptions, hints, error text, metadata. |
| Micro | 10px | `text-[10px]` | Timestamps, counters, keyboard chips, drag hints — non-essential meta only. |
| Glyph | 9px | `text-[9px]` | Toolbar letter glyphs (`A-`/`A+`), icon-adjacent decoration. |

Rules:

- **The floor is Micro (10px).** The only 9px allowed is the Glyph category for
  letter marks that read as icons. Never go smaller than 9px anywhere.
- **A tile's primary content is Body (14px) or Label (12px).** Caption and Micro
  are for non-essential metadata — never the main content of a tile.
- **Mono reuses the same sizes** — `font-mono` changes family, not scale.
- **Letter-spacing pairs with the scale:** Body/Label ≈ `tracking-[-0.01em]`,
  headings `tracking-tight`, uppercase section labels `tracking-wider`.
- **Prefer the named class** (`text-xs`, `text-sm`) where it exists; arbitrary
  values are reserved for Caption/Micro/Glyph, which have no token.
- **Migrate off-scale values when you touch them:** `text-[13px]` → Body (14px),
  `text-[12px]` → Label (12px), `text-[8px]` → Micro (10px).

Element → category cheatsheet (use this when auditing a tile):

| Element | Category |
|---------|----------|
| Dialog / panel / sidebar title | Heading (16) |
| Primary list rows, file names, table cells, inputs, code/diff blocks | Body (14) |
| Buttons, tabs, menu items, table headers, form & section labels, badges | Label (12) |
| Hints, helper text, descriptions, error text, secondary meta | Caption (11) |
| Timestamps, counts, kbd chips, status bars, tag/ref chips, decorative arrows | Micro (10) |
| Toolbar letter marks (`A-`/`A+`) | Glyph (9) |

**This scale is enforced.** `frontend/scripts/check-typography.mjs` fails the
build (`pnpm check`, run in CI) on any font-size utility outside the table above.
Run `pnpm --dir frontend check:typography` locally before committing.

**Shell.** The plugin UI owns the full iframe: `h-screen w-screen`, inner
`overflow-hidden`, and `rounded-[6px]` to match the pane radius. Long content
scrolls in an inner `min-h-0 flex-1 overflow-auto` region, keeping the header
fixed.

**Icons.** App badges come from `frontend/src/wm/appIcons.ts` — add a
`{ bg, text, letter }` entry for each new plugin id, otherwise it falls back to
a grey default. WM control icons live in `frontend/src/wm/icons.tsx`; shared
SVGs in `frontend/src/components/icons.tsx`. Reuse, don't inline.

---

## 12. Icons & user-visible strings

- Every user-visible string goes through i18n. Plugin labels use **lazy
  getters** (`get label() { return i18n.t('plugin.x') }`) because the registry
  module executes before locale initialization; a plain `i18n.t(...)` at
  registration time can capture the wrong language.
- Add keys under `plugin.*` in both `frontend/src/locales/en.json` and
  `zh_CN.json`.

---

## 13. File map

```
frontend/src/
├── wm/
│   ├── tilePlugins.ts        registry + TilePlugin / contexts / PluginParamDoc
│   ├── TilingWM.tsx          parent: panes, dividers, picker, IPC listeners
│   ├── TileTools.tsx         per-tile hover toolbar (composes plugin toolbar)
│   ├── layout.ts             pure tree ops + computeTiling
│   ├── atoms.ts              layout / focus / spaces atoms
│   ├── sessionState.ts       persisted state types + storage keys
│   ├── appIcons.ts           app badge colors/letters
│   ├── plugins/*.tsx         one file per plugin; registerTilePlugin()
│   └── icons.tsx             WM control icons
├── routes/
│   ├── AppShell.tsx          app shell (appRoute)
│   └── *Page.tsx             one iframe route per plugin (under rootRoute)
├── components/
│   ├── CommonTileContainer.tsx   tile lifecycle wrapper + hooks
│   └── <plugin>/             plugin UI, often with its own hooks/ dir
├── store/
│   ├── appMenu.ts            hiddenApps + customApps (user presets)
│   └── zoom.ts               per-plugin zoom atoms
├── lib/
│   ├── constants.ts          setPageTransparent()
│   └── actionResolver.ts     notification → open tile (sets initialPath/params)
└── router.tsx                route tree
```

---

## 14. Checklist — adding a tile plugin

- [ ] Add `MyPluginSessionState` to `sessionState.ts` (if it restores state).
- [ ] Add a zoom atom in `store/zoom.ts` (if it needs zoom).
- [ ] Create `routes/MyPluginPage.tsx`; call `setPageTransparent()`.
- [ ] Wrap content in `<CommonTileContainer zoomAtom={…} noPadding?>`.
- [ ] Register the route under `rootRoute` in `router.tsx`.
- [ ] Create `wm/plugins/myplugin.tsx` with `registerTilePlugin()`.
- [ ] Declare `supportedParams` for every accepted URL param.
- [ ] Render an iframe with `data-pane={paneId}` and
      `className="h-full w-full border-0 bg-transparent"`.
- [ ] Add lazy i18n label/description keys in `en.json` + `zh_CN.json`.
- [ ] Add an `appIcons.ts` color entry.
- [ ] Add the side-effect import in `TilingWM.tsx`.
- [ ] If needed, implement `renderToolbar` using the `toolBtn` pattern.
- [ ] Persist state with `useReportTileState`; restore with `useTileSessionState`.
- [ ] Use only the declared type scale (Body 14 / Label 12 for tile content).
- [ ] Verify: split/close/move/swap keeps the iframe alive; reload restores
      state; zoom syncs across panes; font size flows from the toolbar.

---

## 15. Design principles & anti-patterns

1. **Declare, don't enumerate.** Register by side effect; the WM discovers
   plugins. No central `switch (tileType)`.
2. **The iframe is the unit of isolation.** Give it a stable identity
   (`data-pane`) and never let layout changes remount it.
3. **Params are the public API.** Document them with `supportedParams`; users
   compose custom apps from them rather than you shipping presets.
4. **Centralize lifecycle, not content.** `CommonTileContainer` owns
   transparency, zoom, session, focus and shortcuts; plugins own their UI.
5. **Compose the toolbar.** Plugin controls are additive, minimal, and
   styled with the house classes.
6. **Stay on the type scale.** Use the seven-step scale; differentiate
   emphasis with weight, color and opacity — not by inventing sizes.
7. **Same-origin messaging is the IPC.** Don't reach into `contentWindow`
   internals; post a typed message.
8. **Transparency is deliberate.** Call `setPageTransparent()` for glass tiles;
   opt into a solid background only when the content demands it (e.g. video).

**Anti-patterns to reject:**

- Adding a hardcoded preset file where `supportedParams` + a custom app would do.
- Nesting panes in a flex tree that mirrors the layout tree (breaks iframe
  persistence).
- Rendering a tile without `data-pane` (breaks session restore, focus, toolbars).
- `text-xs` / `text-[10px]` for tile body content.
- Off-scale font sizes (`text-[8px]`, `text-[12px]`, `text-[13px]`, …) — use the
  declared scale.
- Registering a plugin with a non-lazy `i18n.t()` label.
- Duplicating move/swap/close buttons inside `renderToolbar`.
