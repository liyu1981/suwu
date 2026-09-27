# Header Position & Appearance Merge — Plan

Status: **implemented**
Owner area: `frontend/src/routes/AppShell.tsx`, `frontend/src/components/dialogs/SettingsView.tsx`,
`frontend/src/components/NotificationPanel.tsx`, `frontend/src/store/settings.ts`,
`frontend/src/locales/`
Related skills: `apple-design` (§12 materials, §14 reduced motion, §15 typography),
`suwu-tile-plugin-design` (§11 type scale — Label 12 / Caption 11 / Micro 10).

## 1. Goal

Let the user move the app-shell header bar to any edge of the window, and merge
the Language setting into the Appearance screen in System Settings.

1. A new **Header position** setting with four values: `top` (default),
   `bottom`, `left`, `right`.
2. When the header is on `left`/`right` it becomes a vertical strip and its
   text renders at **90°**.
3. The notification panel anchors **right** for `top`/`bottom`/`left` header
   placement, and **left** for `right` placement.
4. System Settings gets dedicated **Header** and **Language** tabs; the old
   **Appearance** tab is renamed **Background**, since it now contains only
   the ambient-background controls.

Persistence is client-only (`localStorage`), consistent with every other
System Settings preference — no backend or API change.

## 2. Current state

| Concern | Where |
| --- | --- |
| Shell layout: `grid h-dvh grid-rows-[auto_1fr] px-3 pt-2`, `<header>` then `<main>` | `frontend/src/routes/AppShell.tsx` |
| Header contents (burger, logout, brand, space buttons + hover dropdown, split buttons, notification bell) | `AppShell.tsx` |
| Notification panel anchor `fixed right-4 top-4 bottom-4`, slide-in `animate-panel-in` | `frontend/src/components/NotificationPanel.tsx`, `styles.css` (`panel-in`) |
| System Settings tabs: notifications / appearance / spaces / actions / account / **language** | `frontend/src/components/dialogs/SettingsView.tsx` |
| Language control (`i18n.changeLanguage`, `Select`) | `SettingsView.tsx` `value="language"` content |
| Appearance tab body (background family + params) | `SettingsView.tsx` `value="appearance"` |
| Persisted settings atoms | `frontend/src/store/settings.ts` (`atomWithStorage`) |
| Locale strings | `frontend/src/locales/en.json`, `zh_CN.json` under `settings` |
| Shell material / glass classes | `frontend/src/styles.css` (`apple-panel`, `menu-glass`, `glass-btn`) |

The header is a single `flex items-center gap-2 px-2 py-1` row. It contains a
`ml-auto` cluster on the right and one absolutely-positioned hover dropdown
(the per-space tile list, `absolute left-0 top-full mt-6`).

## 3. Design decision — how the header becomes vertical

**Chosen: (A) restructure the header into a `flex-col` and set only the brand
label vertical.** The header keeps its markup but switches its main axis for
side docks:

- The inner row becomes `flex h-full flex-col items-center gap-2 px-1 py-2`.
- The right-hand cluster's `ml-auto` becomes `mt-auto` (still pins to the far
  end, now the bottom).
- The brand button gets `[writing-mode:vertical-rl]` so its label reads at 90°,
  plus `rotate-180` on a left dock so the left label reads bottom→top and the
  right label top→bottom. Every icon (burger, logout, splits, bell, space
  numbers) stays upright.
- The per-space hover dropdown opens sideways instead of downward:
  `left-full top-1/2 ml-2 -translate-y-1/2` for a left dock,
  `right-full top-1/2 mr-2 -translate-y-1/2` for a right dock, and the original
  `left-0 top-full mt-6` when horizontal. Both side variants open **inward**.

An earlier revision rotated the whole strip with one `transform`; it was
replaced because it also rotated the icons, which read wrong for a vertical
toolbar. No rotation is used now.

### 3.1 Side-header sizing

- `T` = header thickness = **2.25rem** (`HEADER_THICKNESS`), the cross-axis
  size of a side dock. Cross-axis padding is `px-1` (0.25rem) so the `h-7`
  (1.75rem) buttons fit exactly: `2.25 − 2×0.25 = 1.75rem`.
- The header is the grid item itself; with `gridTemplateRows: '1fr'` it
  stretches to the full run, so no `dvh` arithmetic or `ResizeObserver` is
  needed.

Control order is identical on both sides: burger/logout/brand at the **top**,
split buttons and notification bell at the **bottom**.

## 4. Data model

`frontend/src/store/settings.ts`:

```ts
export type HeaderPosition = 'top' | 'bottom' | 'left' | 'right';

/** Where the app-shell header bar is docked. Persisted in localStorage. */
export const headerPositionAtom = atomWithStorage<HeaderPosition>(
  'suwu:header-position',
  'top',
);
```

No migration needed: an unknown/missing stored value falls back to `top` via a
small guard (`isHeaderPosition`) read at the call site (or normalize in the
shell). Keep the guard exported so `SettingsView` can reuse it.

## 5. Implementation steps

### 5.1 `store/settings.ts`
- Add `HeaderPosition` type, `headerPositionAtom`, and an `isHeaderPosition`
  guard (default `top`).

### 5.2 `AppShell.tsx` — dynamic shell layout
- Read `headerPositionAtom`.
- Replace the hard-coded shell classes with position-derived values:

```tsx
const pos = headerPosition;
const vertical = pos === 'left' || pos === 'right';
const shellClass = vertical
  ? 'relative z-10 grid h-dvh gap-2 p-2 overflow-hidden'
  : 'relative z-10 grid h-dvh gap-2 overflow-hidden px-3 pt-2 pb-3';
const shellStyle: CSSProperties = vertical
  ? { gridTemplateColumns: pos === 'left' ? 'auto 1fr' : '1fr auto' }
  : { gridTemplateRows: pos === 'top' ? 'auto 1fr' : '1fr auto' };
```

- Place `header` and `main` explicitly instead of relying on DOM order:
  - `top`: header `gridRow: 1`, main `gridRow: 2`
  - `bottom`: header `gridRow: 2`, main `gridRow: 1`
  - `left`: header `gridColumn: 1`, main `gridColumn: 2`
  - `right`: header `gridColumn: 2`, main `gridColumn: 1`
- Keep the existing `<main>` semantics (`aria-hidden`/`inert` on `spacesHidden`,
  opacity transition) and move its `pb-3` into the horizontal shell class only.
- Extract the current header JSX into a local `headerContent` variable so it can
  be laid out horizontally or as a column without duplication.
- Render the header as the grid item directly (no wrapper, no transform):

```tsx
<header
  className={vertical ? 'apple-panel h-full rounded-[6px]' : 'apple-panel rounded-[6px]'}
  style={vertical ? { ...headerCellStyle, width: HEADER_THICKNESS } : headerCellStyle}
>
  <div className={vertical
    ? 'flex h-full flex-col items-center gap-2 px-1 py-2'
    : 'flex items-center gap-2 px-2 py-1'}>
    {headerContent}
  </div>
</header>
```

- Add `gridRow`/`gridColumn` via inline `style` on the header and `main`.
- Switch the hover dropdown anchor per side (see §3): `left-full …` on a left
  dock, `right-full …` on a right dock, `top-full mt-6` when horizontal.

### 5.3 `NotificationPanel.tsx` — side follows header
- Read `headerPositionAtom`.
- `const panelOnLeft = headerPosition === 'right';`
- Outer container: `fixed top-4 bottom-4` + (`panelOnLeft ? 'left-4' : 'right-4'`).
- Reader placement: keep DOM order (reader, panel) for right anchoring; add
  `flex-row-reverse` when `panelOnLeft` so the reader stays between the panel
  and the content.
- Animation: `animate-panel-in` currently slides from `translateX(100%)`
  (right). Add a mirrored `panel-in-left` keyframe + `.animate-panel-in-left`
  class in `styles.css` (`from { opacity: 0; transform: translateX(-100%) }`),
  and select it by `panelOnLeft`. Respect `prefers-reduced-motion` by reusing
  the existing reduced-motion handling if present (or fall back to the
  opacity-only path already used elsewhere).
- Panel sizing (`w-[min(90vw,20rem)]`) and the upgrade `Dialog` are unchanged.

### 5.4 `SettingsView.tsx` — Appearance tab + language merge
- Add a dedicated **Header** tab whose only content is a 4-way segmented
  control (`role="radiogroup"`) for the header position:

```
<TabsPrimitive.Content value="header">
  <div className={section}>
    <span className={sectionLabel}>{t('settings.headerPosition')}</span>
    <div role="radiogroup" aria-label={t('settings.headerPosition')}
         className="mt-2 grid grid-cols-4 gap-1">
      {(['top','bottom','left','right']).map(p => (
        <button role="radio" aria-checked={headerPosition === p}
                onClick={() => setHeaderPosition(p)} className={segBtn}>
          {t(`settings.headerPosition_${p}`)}
        </button>
      ))}
    </div>
    <p className={sectionHint}>{t('settings.headerPositionHint')}</p>
  </div>
</TabsPrimitive.Content>
```

  - Use the 12px Label type scale; active state via `bg-white/10
    text-popover-foreground` (the `data-active` attribute drives the
    `data-[active=true]` variant).
- Add a dedicated **Language** tab (restored) holding the existing
  `i18n.changeLanguage` `<Select>`.
- Rename the `value="appearance"` tab to `value="background"` and relabel it
  with a new `settings.backgroundTab` ("Background") key. It keeps only the
  ambient-background controls.
- Tab order: Notifications, Background, Header, Spaces, Actions, Account,
  Language.
- `defaultValue` stays `notifications`.

### 5.5 Locales
Add under `settings` in both `en.json` and `zh_CN.json`:

| Key | en | zh_CN |
| --- | --- | --- |
| `backgroundTab` | Background | 背景 |
| `headerTab` | Header | 标题栏 |
| `headerPosition` | Header position | 标题栏位置 |
| `headerPosition_top` | Top | 顶部 |
| `headerPosition_bottom` | Bottom | 底部 |
| `headerPosition_left` | Left | 左侧 |
| `headerPosition_right` | Right | 右侧 |
| `headerPositionHint` | Dock the header bar to any edge. On the sides, labels render vertically. | 将标题栏停靠到任意边缘。在左右两侧时，文字将垂直显示。 |

The old `appearanceTab` key is replaced by `backgroundTab`; `settings.language`
is reused as the Language tab label. Remove nothing else.

### 5.6 `styles.css`
- Add the mirrored keyframe/class:

```css
@keyframes panel-in-left {
  from { opacity: 0; transform: translateX(-100%); }
}
.animate-panel-in-left {
  animation: panel-in-left 0.25s cubic-bezier(0.32, 0.72, 0, 1);
}
```

- Wrap under `@media (prefers-reduced-motion: reduce)` alongside the existing
  animation handling so the slide is dropped for users who opt out.

## 6. Edge cases & risks

- **In-header popovers.** The space hover dropdown is repositioned to open
  sideways (`left-full`/`right-full`) and its content stays upright; no
  counter-rotation is needed.
- **Cross-axis padding.** Side headers use `px-1` so the `h-7` buttons fit the
  `2.25rem` strip (`2.25 − 2×0.25 = 1.75rem`). Changing `HEADER_THICKNESS`
  means revisiting that padding.
- **Grid placement.** DOM order stays `header` then `main`; visible order is
  controlled by `gridRow`/`gridColumn`. Screen-reader order is unchanged
  (header first) for every position, which is correct.
- **No overflow.** Shell gets `overflow-hidden`; the header is exactly the grid
  cell, so nothing overflows.
- **Narrow viewports.** A side header consumes ~2.25rem + gaps of width; panes
  reflow via the existing tiling logic. No change needed.
- **Tab values.** `appearance` was renamed to `background`; `header` and
  `language` are new. Radix `TabsPrimitive.Root` uses `defaultValue`, so no
  dangling value. Confirm no other code references the old `appearance` value.
- **First paint / hydration.** `atomWithStorage` may briefly render `top` before
  the stored value loads; this matches existing settings behavior and is
  acceptable (no visible flash beyond one frame).
- **Transition on change.** Position changes are applied instantly. Optional:
  a short opacity cross-fade could soften the swap, but keep it out of v1 to
  avoid animating layout.

## 7. Verification

- `pnpm --dir frontend typecheck`
- `pnpm --dir frontend check` (biome + typography + the per-feature checkers);
  run `pnpm --dir frontend check:typography` explicitly since new UI is added.
- Manual matrix:

| Header | Brand label | Icons | Panel side | Tabs |
| --- | --- | --- | --- | --- |
| top | horizontal | upright | right | Header + Language tabs; Background renamed |
| bottom | horizontal | upright | right | same |
| left | vertical (top→bottom) | upright | right | same |
| right | vertical (top→bottom) | upright | left | same |

- Reload after each change to confirm `localStorage` persistence.
- Open the space hover dropdown on left/right and confirm it opens inward and
  remains clickable.
- Toggle `prefers-reduced-motion` and confirm the panel does not slide.

## 8. Delivery / commit plan

Follow the repo `git-workflow` skill and `AGENTS.md`:

- Branch: `feat/header-position` off the current trunk.
- Atomic commits (ask for permission before each):
  1. `feat(settings): add header position preference atom`
  2. `feat(shell): dock header to any edge with a vertical side column`
  3. `feat(notifications): anchor panel opposite a right-docked header`
  4. `feat(settings): merge language into appearance, add header position control`
  5. `docs: add header position plan`
- Run the §7 checks before the first commit; do not commit unprompted.
- No version bump: this is a feature, not a release; bump only when the user
  asks for a release (per `AGENTS.md` release workflow).
