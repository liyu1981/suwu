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
(the per-space tile list, `absolute left-0 top-full mt-6`). All in-header
dialogs/menus are portalled by Radix, so only that hover dropdown is inside the
rotated element.

## 3. Design decision — how the header becomes vertical

Two candidate approaches:

- **(A) Restructure the header into a `flex-col` and rotate only the text.**
  Best-looking (upright icons, sideways labels) but requires rewriting the
  flex axis, `ml-auto` → `mt-auto`, each button group's direction, and the
  dropdown anchor per side. High touch surface on complex, stateful JSX.
- **(B) Rotate the whole header strip with a single CSS `transform`.**
  Zero changes to the header internals: flex, `ml-auto`, gaps, dropdown
  anchoring and bell badge all keep working because they rotate with the strip.
  Text lands at exactly 90°, satisfying requirement 2 literally.

**Recommended: (B).** It is the smallest, lowest-risk change and preserves the
existing header behaviour. Trade-off: the space hover dropdown is rendered
rotated too; because it anchors at `top-full` it automatically opens *inward*
(toward the content) on both left and right, which is the correct direction.
This is acceptable and consistent with the rotated strip. Approach (A) is left
as a possible follow-up if upright dropdowns are later required.

### 3.1 Rotation geometry

Define:

- `T` = header thickness = **2.25rem** (`h-9`; matches the current
  `py-1` + `h-7` button height).
- `L` = vertical run = `calc(100dvh - 1rem)` (the shell uses `p-2` = 0.5rem
  top + bottom in vertical mode).

Wrapper is the grid cell `position: relative` with `width: T; height: 100%`.
Inner `<header>` is `position: absolute; top: 0; left: 0; width: L; height: T`.

| Position | transform | transform-origin |
| --- | --- | --- |
| `left` | `translateX(T) rotate(90deg)` | `top left` |
| `right` | `translateX(T) rotate(90deg)` | `top left` |

Both produce a bounding box of exactly `T × L` flush with the cell (verified
by transforming the four corners). Because the rotation is identical on both
sides, the control order is the same: the burger/logout/brand start at the
**top**, the split buttons and notification bell sit at the **bottom**, and the
text reads top→bottom. The per-space hover dropdown anchors at `top-full` on
the right and `bottom-full` on the left, so it always opens **inward** (toward
the content) in both cases.

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
  be wrapped either directly or by the vertical wrapper without duplication.
- Render:

```tsx
{vertical ? (
  <div className="relative h-full overflow-visible" style={{ width: '2.25rem' }}>
    <header
      className="apple-panel absolute left-0 top-0 rounded-[6px]"
      style={{
        width: 'calc(100dvh - 1rem)',
        height: '2.25rem',
        transformOrigin: 'top left',
        transform:
          pos === 'left'
            ? 'translateY(calc(100dvh - 1rem)) rotate(-90deg)'
            : 'translateX(2.25rem) rotate(90deg)',
      }}
    >
      {headerContent}
    </header>
  </div>
) : (
  <header className="apple-panel rounded-[6px]">{headerContent}</header>
)}
```

- Add `gridRow`/`gridColumn` via inline `style` on the wrapper/`main`.
- Do **not** change the hover dropdown markup: rotation already redirects it
  inward (see §3).

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

- **Rotated in-header popovers.** The space hover dropdown and any in-header
  tooltip render rotated. Direction is correct (inward); visual rotation is the
  accepted cost of approach (B). Document in code comment.
- **`dvh` dependence.** `L = calc(100dvh - 1rem)` assumes the `p-2` vertical
  shell padding. If that padding changes, update both together — note this in a
  comment next to the constants.
- **Grid placement.** DOM order stays `header` then `main`; visible order is
  controlled by `gridRow`/`gridColumn`. Screen-reader order is unchanged
  (header first) for every position, which is correct.
- **No scrollbars from rotation.** Shell gets `overflow-hidden`; the rotated
  strip's bounding box is exactly the grid cell, so nothing overflows.
- **Narrow viewports.** A side header consumes ~2.25rem + gaps of width; panes
  reflow via the existing tiling logic. No change needed.
- **Language tab removal.** Any deep link/keyboard path to the old `language`
  tab is gone; Radix `TabsPrimitive.Root` uses `defaultValue`, so no dangling
  value. Confirm no other code references a `language` tab value.
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

| Header | Text 90° | Panel side | Tabs |
| --- | --- | --- | --- |
| top | n/a | right | Header + Language tabs present; Background tab renamed |
| bottom | n/a | right | same |
| left | yes (burger top, split bottom) | right | same |
| right | yes (burger top, split bottom) | left | same |

- Reload after each change to confirm `localStorage` persistence.
- Open the space hover dropdown on left/right and confirm it opens inward and
  remains clickable.
- Toggle `prefers-reduced-motion` and confirm the panel does not slide.

## 8. Delivery / commit plan

Follow the repo `git-workflow` skill and `AGENTS.md`:

- Branch: `feat/header-position` off the current trunk.
- Atomic commits (ask for permission before each):
  1. `feat(settings): add header position preference atom`
  2. `feat(shell): dock header to any edge and rotate side headers`
  3. `feat(notifications): anchor panel opposite a right-docked header`
  4. `feat(settings): merge language into appearance, add header position control`
  5. `docs: add header position plan`
- Run the §7 checks before the first commit; do not commit unprompted.
- No version bump: this is a feature, not a release; bump only when the user
  asks for a release (per `AGENTS.md` release workflow).
