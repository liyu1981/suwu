---
name: tile-plugin-system
description: "How to add and organize tile plugins in the Suwu tiling window manager — plugin registry, iframe page structure, CommonTileContainer, app config presets, session state, toolbar convention, and postMessage IPC."
license: MIT
metadata:
  author: suwu
  source: "frontend/src/wm/"
---

# Tile Plugin System Skill

## Purpose

When adding or modifying a tile plugin (a self-contained app that lives inside a tiling pane), follow this guide. It covers the full lifecycle: registering a plugin, creating its iframe page, wiring session state, adding toolbar buttons, and creating app config presets.

## Architecture at a Glance

```
TilingWM (parent)
  ├── layout tree (pure data) ── computeTiling() ──> pixel rects
  ├── flat <div> list, each absolutely positioned from rects
  │     └── plugin.render(paneId) ──> <iframe src="/myroute?pane=...">
  │           └── MyPage (child, inside iframe)
  │                 └── <CommonTileContainer>
  │                       ├── session state (localStorage)
  │                       ├── focus notify → parent
  │                       └── WM shortcut relay → parent
  └── TileTools (hover toolbar per pane)
        ├── plugin.renderToolbar(ctx)  ← type-specific buttons
        └── shared move / swap / close buttons
```

**Key invariant**: iframes are never recreated or reparented during layout changes. Splitting, closing, and moving only mutate inline `left/top/width/height` styles on the flat `<div>` list. This keeps every tile's state — PTY sessions, scroll position, form inputs, scrollback — intact across layout changes.

---

## 1. Tile Plugin Registry

**File**: `frontend/src/wm/tilePlugins.ts`

```ts
export interface TilePlugin {
  id: TileType              // unique string, e.g. 'term', 'filebrowser'
  label: string             // shown in the picker
  description?: string      // shown below label in picker
  render: (paneId: string, context?: TileRenderContext) => ReactNode
  renderToolbar?: (ctx: ToolbarContext) => ReactNode
}
```

Register via side-effect import:

```ts
// In your plugin file, e.g. plugins/myplugin.tsx
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'
import i18n from '../../i18n'

registerTilePlugin({
  id: 'myplugin',
  get label() { return i18n.t('plugin.myplugin') },   // lazy i18n
  get description() { return i18n.t('plugin.mypluginDesc') },
  render: (paneId, context) => { /* ... */ },
})
```

**Then add the side-effect import** in `TilingWM.tsx`:

```ts
import './plugins/myplugin'
```

### TileRenderContext

```ts
interface TileRenderContext {
  paneId: string
  initialPath?: string                    // from actionResolver (e.g. open file)
  onOpenPicker?: (paneId: string) => void  // used by empty plugin
  params?: Record<string, string>         // extra URL params from AppConfig
}
```

### ToolbarContext

```ts
interface ToolbarContext {
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

The toolbar renders between a divider and the shared move/swap/close section. Use the `toolBtn` class pattern for consistent styling:

```ts
const toolBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30'
```

---

## 2. Creating the Iframe Page

Each plugin renders an `<iframe>` pointing to a dedicated route. The page inside the iframe is a full-space React component (no app shell, no header).

### Step A: Create the route component

**Location**: `frontend/src/routes/MyPluginPage.tsx`

```tsx
import { useEffect } from 'react'
import { CommonTileContainer, useTileSessionState, useReportTileState } from '../components/CommonTileContainer'
import type { MyPluginSessionState } from '../wm/sessionState'

export default function MyPluginPage() {
  const savedState = useTileSessionState<MyPluginSessionState>()
  const reportState = useReportTileState()

  // Override opaque :root background so translucent tile bg shows through.
  useEffect(() => {
    document.documentElement.style.backgroundColor = 'transparent'
  }, [])

  // ... your component logic ...

  // Report state changes for session restore.
  useEffect(() => {
    reportState({ myKey: myValue })
  }, [myValue, reportState])

  return (
    <CommonTileContainer>
      <div className="h-screen w-screen overflow-hidden rounded-[6px] p-2 text-sm text-white/80"
           style={{ backgroundColor: myBgColor }}>
        {/* Your UI */}
      </div>
    </CommonTileContainer>
  )
}
```

### Step B: Register the route

**File**: `frontend/src/router.tsx`

```tsx
import MyPluginPage from './routes/MyPluginPage'

const myPluginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/myplugin',
  component: MyPluginPage,
})

// Add to routeTree:
const routeTree = rootRoute.addChildren([
  appRoute.addChildren([indexRoute]),
  termRoute,
  fileViewerRoute,
  filebrowserRoute,
  forwardRoute,
  myPluginRoute,   // ← add here
])
```

Tile pages live under `rootRoute` (not `appRoute`) so they have no header and fill the iframe completely.

### Step C: Wire the plugin render function

```ts
registerTilePlugin({
  id: 'myplugin',
  get label() { return i18n.t('plugin.myplugin') },
  render: (paneId, context) => {
    const p = new URLSearchParams({ pane: paneId })
    if (context?.initialPath) p.set('path', context.initialPath)
    if (context?.params) {
      for (const [k, v] of Object.entries(context.params)) p.set(k, v)
    }
    return (
      <iframe
        src={`/myplugin?${p}`}
        title={`myplugin-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    )
  },
})
```

**Critical**: the `<iframe>` must have `data-pane={paneId}` — this is how `CommonTileContainer` and `TilingWM` identify which pane owns which iframe.

---

## 3. CommonTileContainer

**File**: `frontend/src/components/CommonTileContainer.tsx`

Every iframe tile page wraps its content in `<CommonTileContainer>`. It handles three things:

1. **Session state restore**: listens for `server-started-at` postMessage from parent, loads saved state from `localStorage` (keyed by server start timestamp + pane ID), and provides it via `useTileSessionState<T>()`.

2. **Focus notification**: posts `pane-focus` to parent window when the iframe gains focus, so `TilingWM` can update `focusedIdAtom`.

3. **WM shortcut relay**: intercepts `Alt+key` combinations and posts `wm-shortcut` to parent, so keyboard shortcuts work from inside any tile.

### Session state hooks

```ts
// Read saved state (returns null if none exists).
const saved = useTileSessionState<MyState>()

// Report state changes (debounced, written to localStorage by parent).
const reportState = useReportTileState()
useEffect(() => {
  reportState({ currentPath, sortKey })
}, [currentPath, sortKey, reportState])
```

### Session state types

**File**: `frontend/src/wm/sessionState.ts`

Add your plugin's state shape here:

```ts
export interface MyPluginSessionState {
  myKey: string
  anotherKey?: number
}
```

---

## 4. App Config Presets

**File**: `frontend/src/wm/appConfigs.ts`

App configs are preset entries shown in the "New Application" picker. They map to an existing tile plugin with extra URL params — useful for launching a plugin in a specific mode.

```ts
// frontend/src/wm/configs/myconfig.ts
import { registerAppConfig } from '../appConfigs'
import i18n from '../../i18n'

registerAppConfig({
  id: 'my-preset',
  get label() { return i18n.t('plugin.myPreset') },
  get description() { return i18n.t('plugin.myPresetDesc') },
  iconBg: 'bg-emerald-500/20 text-emerald-400',  // icon badge colors
  iconLetter: 'M',                                 // first letter in badge
  pluginId: 'myplugin',                            // which real plugin to use
  params: { mode: 'preset' },                      // merged into iframe src
})
```

Then side-effect import in `TilingWM.tsx`:

```ts
import './configs/myconfig'
```

The picker merges plugins and app configs into a single list. Plugins appear first, then presets.

---

## 5. PostMessage IPC Convention

Parent ↔ iframe communication uses `window.postMessage` with a `type` field discriminator:

| Direction | type | Purpose |
|-----------|------|---------|
| Parent → iframe | `server-started-at` | `{ startedAt: string }` — session restore key |
| Parent → iframe | `tile-font-size` | `{ fontSize: number, fontDefault: number }` |
| Iframe → parent | `pane-focus` | `{ pane: string }` — tile gained focus |
| Iframe → parent | `tile-state-update` | `{ paneId: string, state: Record }` — persist session |
| Iframe → parent | `wm-shortcut` | `{ action: WmAction }` — relay keyboard shortcut |
| Iframe → parent | `wm-open-file` | `{ path, tileType, sourcePane }` — open file in new tile |
| Iframe → parent | `wm-close-pane` | `{ pane: string }` — close this tile |

**Convention**: always use `window.parent?.postMessage({ type: '...', ... }, '*')` from iframes. The parent listens on `window.addEventListener('message', ...)`.

---

## 6. UI Convention

### Glass material

All tile UIs use the `glass-control` / `glass-btn` class system for frosted surfaces:

```css
/* frosted panel */
className="glass-control rounded-[6px] p-2"

/* frosted button */
className="glass-btn rounded-md px-2 py-1 text-white/60 hover:bg-white/10 hover:text-white"
```

### Toolbar button pattern

```ts
const toolBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30'
```

### Tile container pattern

Every tile page fills the iframe with `h-screen w-screen` and uses `rounded-[6px]` to match the tile border radius:

```tsx
<div className="flex h-screen w-screen flex-col overflow-hidden rounded-[6px] p-2 text-sm text-white/80"
     style={{ backgroundColor: bgColor }}>
```

### Transparent background

Tile pages must set `document.documentElement.style.backgroundColor = 'transparent'` on mount so the user's configured background alpha shows through. Without this, the opaque `:root` background defeats glass effects.

### Why iframes are never recreated

The layout tree stores each tile's content type (`tileType`) and state on a stable leaf node. When the layout changes, only the pixel rects change — the `<div>` wrapper moves, but the `<iframe>` inside it is the same DOM node. This means:

- Any in-memory state (scroll position, open menus, draft input) survives splits, closes, and swaps.
- External processes tied to the tile (like PTY sessions for terminals) stay alive.
- No remount flicker or re-initialization cost.

If you find yourself tempted to use `key={leafId}` on the iframe wrapper in a way that would cause React to unmount it, reconsider — the flat absolutely-positioned pattern exists specifically to avoid this.

### Icons

Shared SVG icons live in `frontend/src/components/icons.tsx`. WM-specific icons (chevrons, close, swap) are in `frontend/src/wm/icons.tsx`. Reuse these rather than adding inline SVGs.

---

## 7. File Organization

```
frontend/src/
├── wm/
│   ├── tilePlugins.ts          ← registry (TilePlugin interface + Map)
│   ├── appConfigs.ts           ← preset registry (AppConfig interface)
│   ├── TilingWM.tsx            ← parent: renders panes, dividers, picker
│   ├── TileTools.tsx           ← per-tile hover toolbar
│   ├── atoms.ts                ← Jotai atoms (layout, focused, spaces, menu)
│   ├── layout.ts               ← pure tree functions (split, close, swap, computeTiling)
│   ├── shortcuts.ts            ← keyboard → WmAction mapping
│   ├── sessionState.ts         ← session state type definitions
│   ├── usePaneGhosts.ts        ← ghost divs during layout transitions
│   ├── icons.tsx               ← WM-specific SVG icons
│   ├── plugins/
│   │   ├── term.tsx            ← terminal plugin (iframe + font toolbar)
│   │   ├── filebrowser.tsx     ← file browser plugin
│   │   ├── viewer.tsx          ← file viewer plugin
│   │   ├── forward.tsx         ← port forwarder plugin
│   │   └── empty.tsx           ← empty placeholder (opens picker)
│   └── configs/
│       └── herdr.ts            ← herdr preset (term + cmd param)
├── routes/
│   ├── AppShell.tsx            ← header + TilingWM (app route)
│   ├── TermPage.tsx            ← iframe page: terminal
│   ├── FileBrowserPage.tsx     ← iframe page: file browser
│   ├── FileViewerPage.tsx      ← iframe page: file viewer
│   └── ForwardPage.tsx         ← iframe page: port forwarder
├── components/
│   ├── CommonTileContainer.tsx ← session state + focus + shortcut relay
│   └── ui/dialog.tsx           ← shared dialog primitive
└── router.tsx                  ← route tree definition
```

---

## 8. Checklist for Adding a New Tile Plugin

- [ ] Define session state type in `sessionState.ts`
- [ ] Create route component in `routes/MyPage.tsx`, wrapping in `<CommonTileContainer>`
- [ ] Set transparent background: `document.documentElement.style.backgroundColor = 'transparent'`
- [ ] Register route in `router.tsx` under `rootRoute` (not `appRoute`)
- [ ] Create plugin file in `plugins/myplugin.tsx`, calling `registerTilePlugin()`
- [ ] Side-effect import plugin in `TilingWM.tsx`
- [ ] Wire `render` to return `<iframe data-pane={paneId} src="/myplugin?pane=...">`
- [ ] If toolbar buttons needed: implement `renderToolbar` using `toolBtn` class pattern
- [ ] If presets needed: create config in `configs/myconfig.ts`, register in `appConfigs.ts`, import in `TilingWM.tsx`
- [ ] Add i18n keys to `locales/en.json` and `locales/zh_CN.json`
- [ ] Verify: tile splits, closes, moves, swaps correctly; session restores on reload
