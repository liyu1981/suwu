---
name: glass-webui-design
description: "The liquid-glass (Apple-style frosted material) design system practice used in the mindx project — the glass-control / apple-panel / ambient-bg class system in Tailwind CSS v4 / Next.js, why each CSS detail exists, and the composition rules for applying it. Use when creating or reviewing glass/frosted surfaces: backdrop-filter blur, translucent panels, glass buttons, frosted dropdowns/dialogs/sheets, ambient gradient backgrounds, material shadows, or dark-mode glass."
license: MIT
compatibility: opencode
metadata:
  tags: "glass,frosted,backdrop-filter,apple-style,design-system,tailwind,nextjs,dark-mode,glass-control,ambient-bg"
  source: "mindx (github)"
  stack: "Tailwind CSS v4 + Next.js"
---

## Purpose
When creating or reviewing any glass/frosted surface in the app, follow this
taolu. A glass interface only looks good when the frosted surface has
something colorful to blur and the material is built from the app's theme
tokens, not hardcoded colors.

## 1. The core surface: `glass-control`

Single source of truth for every frosted control — buttons, cards, dropdowns,
dialogs, sheets, chat bubbles, toolbars, search boxes. Never copy these
declarations into a screen; apply the class name.

```css
.glass-control {
  background: linear-gradient(
    180deg,
    color-mix(in oklch, var(--background) 45%, transparent),
    color-mix(in oklch, var(--background) 14%, transparent)
  );
  border: 1px solid color-mix(in oklch, var(--border), transparent 45%);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  box-shadow:
    0 8px 32px rgb(0 0 0 / 0.12),
    inset 0 1px 0 color-mix(in oklch, white 28%, transparent);
}
```

| Detail | Why it exists |
| --- | --- |
| Vertical background gradient (`45% → 14%`) | A flat fill reads as paper; a gradient reads as a sheet of material catching light. |
| `color-mix(in oklch, var(--background) …)` | Derives translucency from the theme token, so light/dark are automatic and never drift. |
| 1px translucent border (`--border` @ 45%) | A solid border on glass looks cheap; a faded one reads as the material's edge. |
| `blur(24px) saturate(180%)` | The blur is what makes it glass; `saturate` boosts whatever color sits behind so it doesn't wash out to gray. |
| Outer shadow `0 8px 32px` | Separates the surface from the page (depth hierarchy). |
| Inset highlight `inset 0 1px 0 white 28%` | Light catching the top edge — the signature "glass lip." |

### Dark mode is a separate spec, not a brightness flip

In dark mode the surface is built from white-based translucency (16% → 5%),
not from `--background` (which is itself dark). A color-mix of a dark token
onto a dark page disappears; white-based glass is what actually reads as
frosted over a dark backdrop. The shadow deepens (`.45` alpha) and the inset
highlight dims (`white 14%`) because there is less light.

## 2. Supporting surfaces

- **`apple-panel`** — blurred sticky headers/panels. Gradient `68% → 34%` of
  `--background`, same `blur(24px) saturate(180%)`, inset top highlight.
- **`apple-panel-dark`** — heavier chrome: `--background` at 25% transparency
  with a stronger `blur(30px) saturate(200%)`. Bigger surfaces read as thicker
  → stronger blur + deeper shadow.
- **`apple-scrim`** — gradient `transparent → var(--background)` bottom fade
  for content scrolling under floating chrome (scroll edge effect, not a hard
  divider).
- **`ambient-bg`** — page-level background of radial glows in `--primary` and
  `--ring`. This is what the glass blurs. Frosted surfaces over a flat
  background look like gray plastic; over ambient color they look like real
  frosted glass. Every screen that uses glass surfaces must sit on `ambient-bg`.

## 3. Composition rules

1. Overlays get `glass-control` from the shared UI component, never inline —
   `ui/dialog.tsx`, `ui/sheet.tsx`, `ui/dropdown-menu.tsx` apply it on their
   `Content`/`Popup` wrapper; screens just inherit it.
2. Buttons use the `glass` variant (`ui/button.tsx`): `glass-control
   !border-border/60` plus brightness feedback — `hover:brightness-[1.06]`,
   `active:brightness-95`, `aria-expanded:brightness-110`. Brightness (not a
   color change) keeps the material consistent while adding affordance.
3. Interactive surfaces get physicality: cards/dropzones/new-project buttons
   combine `glass-control` with `hover:brightness-[1.04] hover:-translate-y-px
   active:scale-[0.98]`.
4. Add `bg-clip-padding` on buttons/sheets so the translucent border doesn't
   bleed into children.
5. Scrims stay light because the glass is translucent: dialog overlay
   `bg-black/45 + backdrop-blur-md`, sheet overlay `bg-black/60 +
   backdrop-blur-sm`. A heavy scrim would darken the dialog itself.
6. Text on glass uses `text-popover-foreground` / `text-muted-foreground`
   (vibrancy: slightly higher contrast and heavier weight than flat-gray over
   busy backgrounds).
7. Materialize, don't just fade: overlays enter with `data-open:animate-in
   data-open:fade-in-0 data-open:zoom-in-95` (+ a directional slide) and exit
   mirrored — a real sheet arriving, not a ghost.
8. Standard screen skeleton: `div.h-screen.ambient-bg` → `header.apple-panel`
   (sticky) → content, with `apple-scrim` at the bottom of scrolling chrome.
9. Reduced motion: `@media (prefers-reduced-motion: reduce)` collapses all
   animation/transition durations and strips animate-in classes. Never ship
   glass motion without this guard.

## 4. Pitfalls

- Hardcoded `rgba(...)` surfaces ignore the theme and break dark mode — always
  `color-mix(in oklch, var(--...), transparent)`.
- Copying the glass CSS into individual screens — one source of truth in
  `globals.css`; screens only list the class.
- Solid borders on glass — use `color-mix(..., transparent 45%)`.
- Dark mode by inverting the light spec — write the separate white-based
  `.dark` block.
- Flat backgrounds under glass — without `ambient-bg` the blur has nothing to
  show and the surface looks gray.
- Blur + scroll jank — `backdrop-filter` is expensive; apply it to few, large
  surfaces, not every child inside a glass panel.

## 5. Reference

- Surface: `glass-control` on `ProjectCard`, `OpenDropzone`, chat bubbles,
  `AiAssistantFloating`, `NodeSearch`, `FloatingToolbar`, dialog/sheet/dropdown
  content.
- Chrome: `apple-panel` on all three sticky headers; `apple-panel-dark` for
  heavier panels.
- Backdrop: `ambient-bg` on project browser + LLM page.
- Button variant: `variant="glass"` in `src/components/ui/button.tsx`.
- Standalone viewer (HTML export) uses a simplified offline spec
  (`viewer/src/viewer.css`, `blur(14px)`, no Tailwind) — keep the two in sync
  by intent, not by string-matching.
