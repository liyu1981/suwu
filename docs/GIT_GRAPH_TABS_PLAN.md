# Git Graph Multi-Repo Tabs — Plan

Status: **implemented** (see the deviation note below)
Owner area: `frontend/src/components/gitgraph/`, `frontend/src/routes/GitGraphPage.tsx`

> **Implementation notes.**
> - Shortcuts ended up **Alt-first** (§3.6): browsers reserve `Ctrl/Cmd+1…9`,
>   `Ctrl+T` and `Ctrl+W`, so those events never reach an iframe page. The
>   handler accepts `Ctrl/Cmd` too, for the browsers that do deliver them.
> - `gitgraph/refs.ts` was added to hold `WORKTREE_REF`, `EMPTY_TREE_REF` and
>   `comparisonId`. `comparison.ts` re-exports them, so existing import sites
>   are unchanged — but the tab model can now import them without pulling in
>   the fetch layer, which lets `scripts/check-git-tabs.mjs` exercise the whole
>   restore path under Node's type stripping (wired into `pnpm check`).
> - The tile toolbar row (refresh + auto-refresh) moved from the panel to the
>   page host so the repo tab bar can sit directly under it; the host drives
>   the panel's refresh with a `refreshToken` prop instead of a ref handle.
> - Closing the **last** tab empties the tile (folder picker, no tab bar) rather
>   than being blocked, so a mis-click on `×` is always recoverable.

Related skills: `suwu-tile-plugin-design` (iframe page pattern, session state,
postMessage IPC, glass material, §11 type scale), `apple-design` (tabs as a
direct-manipulation surface, no modal ceremony).

---

## 1. Goal

Today a Git Graph tile tracks **one** repository. Everything else in the tile —
worktree browser, all-branches toggle, expanded commit rows, the compare /
diff tabs, auto-refresh — hangs off that single `repoPath` in one flat state
blob.

Target: the tile becomes a **tab host**. Each tab is an independent git graph
for one repository and carries **all** current features:

```
┌──────────────────────────────────────────────────────────────┐
│ ↻ ⏱  Git Graph                                              │  toolbar (unchanged)
├──────────────────────────────────────────────────────────────┤
│ suwu │ frontend │ .opencode   +                            │  NEW repo tab bar
├──────────────────────────────────────────────────────────────┤
│ Commits │ a1b2c3d → e4f5g6h                                  │  EXISTING diff sub-tabs
├──────────────────────────────────────────────────────────────┤
│ 📁 /home/yli/…   All  Worktree: main   128 commits  Change repo│  repo path bar (unchanged)
├──────────────────────────────────────────────────────────────┤
│ ●───● graph column + commit rows (+ expanded commit rows)    │  per-tab content
└──────────────────────────────────────────────────────────────┘
```

Requirements:

1. **Each tab is a full git graph** for one repo — commit list, graph lanes,
   expanded commit rows, worktree browser, all-branches toggle, context
   menus, auto-refresh, and its own comparison (diff) tabs.
2. **Tabs are durable**: the tab list, the active tab, and every tab's
   restorable state survive reload, iframe recreation (focus mode / space
   switch) and pane churn via the existing tile session-state channel.
3. **Backward compatible**: saved state from the single-repo version must
   restore as a one-tab list — no lost repos, no migration script.
4. **No window-manager changes.** Tabs live *inside* the tile; the plugin
   contract, `supportedParams` (`path`) and the iframe lifecycle stay as they
   are.

Non-goals (see §12): tab reordering by drag, splitting one repo across
multiple tiles, making worktrees their own tab kind, persisting search text.

---

## 2. Current state (what exists today)

| Concern | Where |
| --- | --- |
| Tile plugin registration, toolbar refresh button, `?pane`/`?path` params | `frontend/src/wm/plugins/gitgraph.tsx` |
| Route + page shell (`CommonTileContainer`, `setPageTransparent`) | `frontend/src/routes/GitGraphPage.tsx` |
| All single-repo UI state (`repoPath`, `branch`, `expandedIndex`, `picking`, `worktrees`, `selectedWorktree`, `allBranches`, `autoRefresh`, `diffTabs`, `activeTab`, `contextMenu`, `dialog`) + ~600 lines of context menus | `GitGraphPage.tsx` `GitGraphContent()` (L88–~L1150) |
| Commit-row / expanded-row / inline-diff subcomponents | `GitGraphPage.tsx` `CommitRow`, `ExpandedCommitRow`, `FileChangeItem`, `DiffView` (L1136+) |
| Comparison (diff) tab strip — `Commits` + `base → target` tabs | `frontend/src/components/gitgraph/GitGraphTabs.tsx` |
| Comparison tab payload + id helper | `gitgraph/comparison.ts` (`DiffTab`, `comparisonId`, `WORKTREE_REF`) |
| Commit fetching / pagination / layout | `gitgraph/useGitGraph.ts` (already takes `enabled`) |
| Diff data fetching + patch cache | `gitgraph/useGitComparison.ts` |
| Repo folder picker | `gitgraph/RepoPicker.tsx` |
| Graph SVG, layout | `gitgraph/GraphRenderer.tsx`, `gitgraph/graph.ts` |
| Persisted state shape (flat, single repo) | `frontend/src/wm/sessionState.ts` `GitGraphSessionState` |
| Docs page | `website/docs/features/git-graph.html` + `website/docs/pages/git-graph.content.html` |
| i18n | `frontend/src/locales/{en,zh_CN}.json` → `gitCompare.*` |

Key structural facts that shape the plan:

- `GitGraphContent` is ~1050 lines and mixes **durable** state (what must be
  persisted) with **ephemeral** state (menus, dialogs, loading flags). The
  tabs work is mostly a *separation* of those two, then a hoist of the
  durable half into a list.
- The commits panel and every diff panel are all mounted simultaneously and
  toggled with `style={{ display: … }}`. That keeps scroll and diff caches
  warm but means **N live fetchers** once the same trick is applied to repos.
- `useGitGraph` already exposes `enabled` — the gating primitive for
  background tabs.
- `useGitActions(repoPath)` and `useGitComparison(tab, active)` are already
  path/activation scoped — they work unchanged inside a per-repo panel.
- `GitGraphTabs.tsx` hardcodes `id`/`aria-controls` as `git-tab-N` /
  `git-panel-N`, and index 0 is always the "Commits" pseudo-tab. With a second
  tablist on the page these ids must be namespaced per bar.
- The WM hover toolbar owns the **top-right `w-56 h-12` corner** of the tile
  (skill §11). The repo tab bar must keep its right end (`+`, overflow
  controls) clear of that zone or place it left of it.

---

## 3. UX model

### 3.1 Two levels, deliberately

| Level | Identity | Holds |
| --- | --- | --- |
| **Repo tab** (new, outer) | one repository | the entire current feature set |
| **Comparison tab** (existing, inner) | one `base → target` diff inside that repo | file tree + split diff |

They are *not* flattened into one strip. A flat strip would make it ambiguous
which repo a `a1b2c3d → e4f5g6h` comparison belongs to, and the strip would
become unreadable past ~4 repos. The outer bar answers "which repo am I
looking at"; the inner bar answers "which view of it".

Both bars are `role="tablist"` with distinct `aria-label`s and id namespaces:
`repo-tab-N` / `repo-panel-N` and `cmp-tab-N` / `cmp-panel-N`.

### 3.2 Tab bar anatomy

- **Label** — repo basename (`suwu`); when two tabs share a basename, the
  label disambiguates to `parent/base`. Full path in `title` + `aria-label`.
- **Close** — `×` per tab, hidden until hover/focus for inactive tabs; disabled
  for the only tab (a tile always keeps one graph; the last tab becomes the
  empty state instead — see §3.5).
- **`+`** — new tab, opens an empty tab showing the repo picker.
- **Middle-click** closes a tab; the close button is discoverable without
  hover for the active tab.
- Selected tab: `bg-white/10 text-white`; inactive `text-white/55`. Row is
  `shrink-0 overflow-x-auto glass-control` — same material recipe as the
  existing comparison bar.
- The bar sits **directly under the toolbar row and above the comparison
  bar**, full-bleed, `border-b border-white/10`.

### 3.3 Where each existing control goes

| Today | After |
| --- | --- |
| `Change repo` (path bar) | kept — *retargets the current tab* |
| — | new: `+` in the tab bar — *adds a tab*; picking a repo that is already open activates that tab instead of duplicating it |
| `DiffTabs` strip (`Commits │ a1b2→e4f5`) | unchanged in behaviour, renamed to `ComparisonTabs`, scoped to the active repo tab |
| toolbar `↻` (pane toolbar → `gitgraph-refresh`) | unchanged — the active panel is the only mounted fetcher |
| toolbar auto-refresh `⏱` + dropdown | unchanged, now **per tab** (stored in tab state) |
| `All` toggle / worktree browser / context menus | unchanged, now per tab |

### 3.4 Adding a tab

- `+` creates `{ id, repoPath: null }` and activates it. The tab body shows the
  existing `RepoPicker` in place of the commit list.
- Selecting a path fills `tab.repoPath`; the tab immediately starts fetching.
- If any tab already tracks that exact path → activate it, close the new empty
  tab, do nothing else.
- `Esc` in an empty tab closes it (back to the previous/adjacent tab).

### 3.5 Empty state

Closing the last tab empties the tile: a single `RepoPicker` filling the panel,
no repo tab bar (a bar with zero tabs is noise). Selecting a repo creates tab
#1. This is exactly today's cold-start behavior, so nothing regresses for a
fresh tile — and an emptied tile restores as empty instead of re-seeding a tab.

### 3.6 Keyboard map (inside the tile iframe)

| Keys | Action |
| --- | --- |
| `Alt+1…9` | activate tab *n* |
| `Alt+Shift+[` / `]` | previous / next tab |
| `Alt+T` | new tab (picker) |
| `Alt+W` | close active tab (a single remaining tab is kept) |
| `Ctrl/Cmd+Enter` | change repo of the active tab (same as `Change repo`) |

All WM shortcuts stay `Alt+…` (`wm/shortcuts.ts`) and none of the four above
collide with them, so the `CommonTileContainer` relay is untouched. The
handler also accepts the `Ctrl/Cmd` spelling of each binding — browsers reserve
`Ctrl/Cmd+1…9`, `Ctrl+T` and `Ctrl+W`, so those never arrive in an iframe and
the `Alt` variants are the ones that actually work.

---

## 4. Data model

### 4.1 New durable tab state — `gitgraph/repoTabs.ts`

```ts
/** One repository tab. Everything here is serializable and restorable. */
export interface RepoTab {
  id: string;                    // stable, e.g. `r1`, `r2`, … or path-derived
  repoPath: string | null;       // null ⇒ tab is an un-filled picker
  branch: string;                // default 'HEAD'
  selectedWorktree: string | null;
  allBranches: boolean;          // default true
  autoRefreshMs: number;         // default 0 (off)
  scrollPosition: number;        // commit-list scroll top
  expandedIndex: number | null;  // expanded commit row
  worktreeBrowserOpen: boolean;  // keep it open across a tab switch
  comparisons: ComparisonTab[];  // was `diffTabs`
  activeView: string;            // 'commits' | comparisonId(...)
}
```

`ComparisonTab` reuses today's `DiffTab` (`id` from `comparisonId(repoPath,
base, target)`); only the owner changes — it is now inside `RepoTab`.

Per-tab `id` generation: monotonically increasing counter persisted in the
session state (`nextTabId`), so ids survive reload and stay unique. Derived
from repo path only when there is exactly one tab for that path (keeps saved
state small).

### 4.2 Persisted pane state — `wm/sessionState.ts`

```ts
export interface GitGraphTabState {           // mirrors components/gitgraph/repoTabs.RepoTab
  id: string;
  repoPath: string | null;
  branch: string;
  selectedWorktree: string | null;
  allBranches: boolean;
  autoRefreshMs: number;
  scrollPosition: number;
  expandedIndex: number | null;
  worktreeBrowserOpen: boolean;
  comparisons: Array<{ id: string; repoPath: string; base: string; target: string; focusFile?: string }>;
  activeView: string;
}

export interface GitGraphSessionState {
  tabs: GitGraphTabState[];
  activeTabId: string;
  nextTabId: number;
  /** @deprecated single-repo fields, read once for migration, never written */
  repoPath?: string; branch?: string; selectedWorktree?: string | null;
  allBranches?: boolean; scrollPosition?: number; diffTabs?: …; activeTab?: string;
}
```

The page keeps a **local** interface identical to today's (`GitGraphSessionState`
declared in `GitGraphPage.tsx`) or — preferred — imports the one from
`wm/sessionState.ts` so there is exactly one definition. Decide during
implementation; the recommendation is to import the shared one.

### 4.3 Restore & migration — `parseRepoTabs(saved, urlPath)`

Pure function, unit-testable, three cases:

1. **`saved.tabs` non-empty** → sanitize each tab (drop malformed entries, drop
   comparisons whose `id !== comparisonId(repoPath, base, target)`, clamp
   `activeView` to `'commits'` or a surviving comparison id). Active tab falls
   back to the first tab if `activeTabId` is unknown. `nextTabId` =
   `max(id)+1`.
2. **Legacy single-repo state** (`repoPath` present, no `tabs`) → build one tab
   carrying `repoPath`, `branch`, `selectedWorktree`, `allBranches`,
   `scrollPosition`, `diffTabs` → `comparisons`, `activeTab` → `activeView`.
3. **Nothing saved** → one tab from `?path=` if present, else one tab with
   `repoPath: null` (picker). Precedence matches today: saved state beats the
   URL param, because the URL param is only the cold-start hand-off.

Every field is read defensively (`typeof x === 'number' ? x : fallback`) — the
blob comes from `localStorage` and can be from any older build.

### 4.4 Ephemeral (never persisted, per mounted panel)

`picking`, `contextMenu`, `dialog`, `commits`, `loading`, `loadingMore`,
`error`, `worktrees`, `compareDialog`, dropdown open flags. These already are
ephemeral today; the plan does not widen the surface.

---

## 5. Module plan

### 5.1 New files

| File | Responsibility |
| --- | --- |
| `components/gitgraph/repoTabs.ts` | Types (`RepoTab`), `parseRepoTabs`, `newRepoTab`, `repoTabLabel`, `findTabByPath`, `sanitizeComparisons`. Pure, no React. |
| `components/gitgraph/useRepoTabs.ts` | Owns `RepoTab[]`, `activeTabId`, `nextTabId`; exposes `{ tabs, activeTab, select, add, close, closeOthers, closeAll, patch, restorePending }`. Handles one-shot session restore + `useReportTileState` reporting. |
| `components/gitgraph/RepoTabBar.tsx` | The outer tab strip: labels, close, `+`, middle-click, keyboard, per-tab context menu (`Close`, `Close Others`, `Close All`). Reuses `ContextMenu`. |
| `components/gitgraph/RepoGraphPanel.tsx` | **Extracted** `GitGraphContent` body, minus the tab list: toolbar row, auto-refresh dropdown, `ComparisonTabs`, repo path bar, worktree browser, commit list, expanded rows, context menus, compare dialog. Receives `tab`, `onPatch`, `onRequestRepoChange`. |

### 5.2 Changed files

| File | Change |
| --- | --- |
| `routes/GitGraphPage.tsx` | Shrinks to ~120 lines: `CommonTileContainer` + `GitGraphContent` = `useRepoTabs` + `RepoTabBar` + active `RepoGraphPanel`. Moves `CommitRow`, `ExpandedCommitRow`, `FileChangeItem`, `DiffView` into `RepoGraphPanel.tsx` (or `CommitRow.tsx` if the file gets > ~700 lines). |
| `components/gitgraph/GitGraphTabs.tsx` → **`ComparisonTabs.tsx`** | Rename (the name now means the *inner* bar). Namespaced ids `cmp-tab-N`/`cmp-panel-N`, `aria-label` from a new key, panel rendering stays in the panel component. |
| `wm/sessionState.ts` | New `GitGraphSessionState` shape (§4.2) + `GitGraphTabState`. |
| `locales/en.json`, `locales/zh_CN.json` | New `gitTabs.*` block (§9). |
| `wm/plugins/gitgraph.tsx` | Optional: a `+` toolbar button posting `gitgraph-new-tab` (see §7.4). `supportedParams` unchanged. |
| `website/docs/features/git-graph.html`, `website/docs/pages/git-graph.content.html` | Document repo tabs + the new shortcuts (§10). |

### 5.3 Component wiring

```tsx
function GitGraphContent() {
  const saved = useTileSessionState<GitGraphSessionState>();
  const { tabs, activeTab, activeTabId, select, add, close, closeOthers, closeAll, patch } =
    useRepoTabs(saved);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {tabs.length > 0 && (
        <RepoTabBar
          tabs={tabs}
          activeId={activeTabId}
          onSelect={select}
          onClose={close}
          onCloseOthers={closeOthers}
          onCloseAll={closeAll}
          onNew={() => add(null)}
        />
      )}
      {activeTab ? (
        <RepoGraphPanel
          key={activeTab.id}              // remount on tab switch → fresh fetches
          tab={activeTab}
          onPatch={(p) => patch(activeTab.id, p)}
        />
      ) : (
        <RepoPicker onSelect={(path) => add(path)} />
      )}
    </div>
  );
}
```

---

## 6. State ownership & lifecycle

### 6.1 One panel mounted at a time

Only the **active** repo tab renders `RepoGraphPanel` (keyed by tab id).
Inactive tabs keep their state in the parent hook, nothing else.

Consequences, accepted deliberately:

| Thing | Behaviour on tab switch |
| --- | --- |
| Commits | refetched on activation (one `/api/git/commits?count=100`) |
| Loaded-more history depth | **lost** — switches back to the first 100 commits and the commit counter. Note this in the docs; `loadMore` is append-only in-memory today. |
| Scroll position | restored from `tab.scrollPosition` via the existing `pendingScrollRestore` mechanism |
| Expanded commit row | restored from `tab.expandedIndex`; its details refetch (one small request) |
| Comparison data + patch cache | refetched (`useGitComparison` already gates on `active`) |
| Auto-refresh timer | only the active tab ticks; resumes on activation |

*Alternative considered and rejected:* keep every panel mounted with
`display:none` (mirrors today's commit/diff toggle) and gate fetches with
`useGitGraph({ enabled: active })`. It preserves `loadMore` depth, but N tabs
means N `GraphRenderer` SVGs (each up to 100 nodes × 15 colored lanes) resident
in a tile that is often a quarter of a small screen. Revisit only if users
complain about losing scroll depth; the seam is one boolean.

### 6.2 Gating rules

- `useGitGraph({ repoPath, enabled: active && repoPath !== null })` — reuse the
  existing `enabled` flag; add `repoPath !== null` so an un-filled picker tab
  never fires `/api/git/commits?path=null`.
- `useGitActions(repoPath ?? '.')` — already path-scoped; never called while
  `repoPath === null` (the picker hides all git actions).
- Auto-refresh `setInterval` lives inside the mounted panel → naturally
  single-flight.

### 6.3 `key={activeTab.id}` vs preserving the panel

Remounting on switch is intentional (fresh data, no stale timers) but it also
discards the scroll container and dialogs — which is what §4.1 re-persists.
`scrollPosition` is reported on every scroll event (debounced by the existing
`reportState` path), and `expandedIndex` / `worktreeBrowserOpen` are patched on
change, so a switch never loses more than loaded-history depth.

---

## 7. Interactions

### 7.1 `useRepoTabs` API

```ts
interface UseRepoTabs {
  tabs: RepoTab[];
  activeTab: RepoTab | undefined;
  activeTabId: string;
  activeIndex: number;             // -1 when the tile has no tabs
  select(id: string): void;
  openRepo(path: string, tabId?: string): void;  // dedupes on an exact path match
  addTab(): void;                  // empty picker tab, activated
  close(id: string): void;         // refuses to close the last tab
  closeOthers(id: string): void;
  closeAll(): void;                // empties the tile
  patch(id: string, next: Partial<RepoTab>): void;
}
```

`close` focuses the neighbour (`index + 1`, else `index - 1`) — same rule the
existing `closeDiffTab` already uses. `add`/`close`/`patch` are pure
`setTabs` reducers (no reducer library in the codebase today).

### 7.2 Reporting cadence

`useReportTileState` is debounced by the parent, so the page reports on every
state change; the report payload is `{ tabs, activeTabId, nextTabId }`.
`patch()` from a panel during a scroll event is throttled to the existing
scroll handler (it already calls `setScrollPosition` per scroll tick — the
parent debounce absorbs it).

### 7.3 Failure modes

| Case | Behaviour |
| --- | --- |
| Repo path deleted / not a repo | existing error pane inside that tab (`Retry`, `Choose another folder`); the tab stays |
| `Change repo` picks a path open in another tab | allowed (two tabs, two independent graphs); only `+` dedupes |
| Comparison opened for a repo the tab no longer tracks | comparison keeps its own `repoPath`, so it still resolves |
| Saved state corrupt / truncated | `parseRepoTabs` drops bad entries; the tile degrades to one tab |

### 7.4 Toolbar IPC (optional increment)

Add a `+` button to `renderToolbar` posting `{ type: 'gitgraph-new-tab' }`
alongside the existing `gitgraph-refresh`; the page listens once and calls
`add(null)`. Toolbar placement must stay left of the `w-56` corner zone.
Kept in a **separate commit** so the core tabs work is reviewable on its own.

---

## 8. Detailed diff of today's logic

The extraction is mechanical except for these, which is where the review
effort should go:

1. `resolveInitPath(saved)` → deleted; replaced by `parseRepoTabs(saved, urlPath)`.
2. Every `setX` in `GitGraphContent` becomes either a local `useState` (ephemeral)
   or `onPatch({ x })` (durable). The `diffTabs` / `activeTab` pair becomes
   `comparisons` / `activeView` **inside** the tab; `addDiffTab` / `closeDiffTab`
   stay local to the panel and patch upward.
3. `activePath` (worktree-resolved path) stays panel-local — it is derived, not
   durable.
4. `reportState` moves from the panel to `useRepoTabs` (§7.2); the panel stops
   importing `useReportTileState`.
5. Panel ids/aria: `git-panel-N` → `cmp-panel-N` in `ComparisonTabs` and the
   panel's diff-tab container.
6. Scroll restore effect: currently gated on `activeTab === 'commits'` and a
   one-shot ref; keep the one-shot but key it off `tab.id` so switching away and
   back re-applies the saved offset once per activation.
7. `showWorktreeBrowser` / `expandedIndex` become tab state (§4.1) — the only
   "ephemeral became durable" promotions, both cheap booleans/numbers.

---

## 9. i18n keys

New `gitTabs` block (`en.json` + `zh_CN.json`); existing `gitCompare.*` keys
are untouched.

| Key | en | zh_CN |
| --- | --- | --- |
| `gitTabs.tabs` | `Repository tabs` | 仓库标签页 |
| `gitTabs.new` | `New repository tab` | 新建仓库标签页 |
| `gitTabs.close` | `Close repository tab` | 关闭仓库标签页 |
| `gitTabs.closeTab` | `Close {{label}}` | 关闭 {{label}} |
| `gitTabs.closeOthers` | `Close other tabs` | 关闭其他标签页 |
| `gitTabs.closeAll` | `Close all tabs` | 关闭全部标签页 |
| `gitTabs.select` | `Select repository tab {{index}}: {{label}}` | 选择仓库标签页 {{index}}：{{label}} |
| `gitTabs.selectEmpty` | `Select new repository tab {{index}}` | 选择新建的仓库标签页 {{index}} |
| `gitTabs.noRepo` | `No repository` | 未选择仓库 |
| `gitTabs.emptyHint` | `Open a repository here, or add a tab to track several at once.` | 在此打开一个仓库，或新建标签页同时跟踪多个仓库。 |

Repo path-bar strings that are currently hardcoded English
(`"Change repo"`, `"No repository selected"`, `"Worktree:"`, `"All"`,
`"Scroll down to load more commits"`, `"All commits loaded"`) get keys **only
if** they are touched during the refactor — no drive-by translation churn in the
tabs commit.

Typography: tab labels are Label (`text-xs`, 12px); the toolbar title stays at
its current `text-base`. Nothing below Micro (10px). The `+`/close buttons reuse
the house `w-4 h-4`/`grid place-items-center` treatment of the existing tab bar.

---

## 10. Documentation updates

`website/docs/pages/git-graph.content.html` — add a **Repository tabs**
section (what a tab is, `+`, close, `Change repo` retargets the active tab,
per-tab auto-refresh, note that deeper history beyond the first 100 commits is
reloaded when you switch away and back) and extend the shortcut table with the
`Ctrl/Cmd` bindings. `website/docs/features/git-graph.html` is the shell —
only the `<meta description>` / sidebar copy needs a look.

---

## 11. Implementation steps

Each step is independently reviewable and leaves the tile working.

1. **Scaffold the model** — add `components/gitgraph/repoTabs.ts` with
   `RepoTab`, `newRepoTab`, `repoTabLabel`, `sanitizeComparisons`,
   `parseRepoTabs` (incl. legacy migration). Pure; add a unit test if the
   project has a runner (`pnpm test` — check), otherwise a `console.assert`
   smoke script. Update `wm/sessionState.ts` with the new shape.
2. **Rename `GitGraphTabs` → `ComparisonTabs`** — namespace ids to `cmp-*`, new
   `aria-label`. Pure rename; no behavior change.
3. **Extract `RepoGraphPanel`** — cut the per-repo body out of
   `GitGraphPage.tsx` into `RepoGraphPanel.tsx`, keeping local state local and
   lifting durable state through an `onPatch` prop wired to a local
   `useState<RepoTab>` in `GitGraphContent`. At this point the tile is still
   single-tab, still writes the **legacy** flat state. Commit boundary: this is
   a pure refactor.
4. **`useRepoTabs` + `RepoTabBar`** — tab list, `+`, close, keyboard,
   context menu, empty state; report `{ tabs, activeTabId, nextTabId }`.
   `parseRepoTabs` migration is what makes old sessions restore as one tab.
5. **Wire the panel to the active tab** — `key={activeTab.id}`, `enabled: active
   && repoPath !== null`, per-tab auto-refresh, per-tab scroll/expanded restore.
6. **i18n** — add the `gitTabs.*` keys in both locales.
7. **Optional: toolbar `+`** (§7.4), separate commit.
8. **Docs** — website git-graph page.
9. **Manual verification pass** (below) + `pnpm lint`, `tsc --noEmit`, `pnpm build`.

### Verification checklist

- Fresh tile (no saved state) with no `?path=` → picker; pick a repo → graph.
- `suwu open --git-graph .` → tile opens with that repo in tab 1.
- `+` → new tab with picker; choose a repo → two independent graphs.
- `+` and pick a repo already open → activates the existing tab, no duplicate.
- Switch tabs repeatedly: scroll position, expanded row, all-branches toggle,
  worktree selection, comparison tabs, auto-refresh interval all survive.
- Close a tab → neighbour activates; close the last tab → picker state.
- Reload the tile / restart the server → tab list, active tab, and each tab's
  state come back.
- **Load state saved by the pre-tabs build** (single repo + diff tabs) → restores
  as one tab with its comparison tab intact.
- Context menus (commit / branch / tag / stash) work identically per tab.
- Tile in a small pane: tab bar scrolls horizontally, no control lands under the
  WM's top-right hover-toolbar zone.
- Zoom (`gitGraphZoomAtom`) at 0.8×/1.25×: bar, labels and dropdown position
  still correct.

---

## 12. Out of scope / follow-ups

- **Tab drag-reordering.** The horizontal strip supports it later; the `tabs`
  array is already the ordering, so it is a pure reorder op.
- **Custom tab labels** (`rename()` is stubbed in §7.1 but the field is *not*
  added to the persisted shape unless implemented together).- **Tab badge** — e.g. uncommitted-change dot per repo (needs a cheap
  `/api/git/status` count endpoint; the uncommitted pseudo-commit in
  `useGitGraph` could carry it).
- **Session state size** — comparisons are capped per tab at 12 in `mergeTab`
  (`MAX_COMPARISONS_PER_TAB`), so a busy tile cannot grow the `localStorage`
  entry without bound. A cap on *tabs* would be the natural follow-up.
- **Worktree-as-tab** — today a tab selects one worktree via the dropdown;
  exposing each worktree as its own tab is a natural next step but a different
  data model (worktree tabs share a repo path).
- **Terminal integration** — `suwu gitgraph <path>` could accept multiple paths;
  out of scope for this change (the plugin still takes a single `path`).
