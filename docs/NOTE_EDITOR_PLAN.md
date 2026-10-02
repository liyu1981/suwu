# Note Extension — Apple Notes Feature Plan

> **Status:** Implemented. Phases 1–3 shipped in
> `examples/extension/note/`; the sections below are the design of record, with
> the places where the build deliberately departed from the first draft called
> out as **Changed**. `pnpm test:ext` (50 unit tests) plus a headless-Chromium
> integration pass (82 checks) cover the DOM-free modules and the wiring.
> **Goal:** add the two things the note is actually missing — **checklists** and
> **inline formatting** (bold / italic / underline / strikethrough / mono) —
> plus a live "Saved 2 min ago" line, while keeping the existing shape: a
> transparent document, nine numbered chips, one Post-it, **no library, no
> dependencies, no build step, pure client-side**.
>
> Reference implementations: `examples/extension/note/` (the current app),
> `examples/extension/hn-top-stories/` (ES-module static tree),
> `docs/EXTENSION_TILE_PLAN.md` §4.8 (the `ext-store` bridge),
> `.opencode/skills/apple-design/SKILL.md` (motion, materials, typography) and
> `.opencode/skills/suwu-tile-plugin-design/SKILL.md` §11 (tile corner
> clearance + the seven-step type scale).

---

## 1. Scope

### In scope

| Feature | Notes | Phase |
|---|---|---|
| **Checklists** — tappable boxes, indent/outdent, auto-continue, progress badge | The headline. Everything else is secondary. | 2 |
| **Inline formatting** — bold, italic, underline, strikethrough, monospace (per selection), plus a paragraph/heading line style | Six toggles, one bar | 3 |
| **"Saved 2 min ago"** — live, relative, bottom-left status line | Replaces today's error-only line, which grows a quiet resting state | 3 |
| **9 slots** instead of 7 | Same chip rail, two more chips | 1 |
| Undo/redo across structural edits (boxes, indents, marks) | Structural ops are invisible to the native textarea stack | 1 |

### Out of scope (deliberately)

- **A note library** — folders, search, tags, pin, trash, drawer, add/delete.
  The nine fixed slots stay; that is a fine model for a tile.
- Bullet and numbered lists, tables, media, links, colors pickers, lock,
  collaboration. Anything beyond checklists + character formatting.
- Drag-to-reorder, per-note titles (the first line *is* the note).

If a feature is not in the table above, it is not in this plan.

---

## 2. Architecture

### 2.1 Why a line model, not `contenteditable`

Apple Notes' editor is a custom rich-text engine. Re-implementing that in a
dependency-free tile is not realistic, and `contenteditable` inside an
opaque-origin sandbox brings IME, selection-restore and mobile-keyboard
problems for free.

Instead: **keep a real `<textarea>` as the only input surface** and pair it
with a *painted clone* that renders the structure. Both layers share identical
font metrics, width, padding and line-height, so the browser wraps them
identically.

```html
<main class="postit color-yellow">
  <div class="editor" id="editor">
    <!-- Screen-reader mirror: real list / checkbox roles, off-screen. -->
    <div class="a11y" id="a11y" role="list" aria-label="Note content"></div>
    <!-- The only input surface. Its glyphs are transparent; the paint layer
         above it carries the same characters with the same metrics. -->
    <textarea id="input" class="input" readonly spellcheck="false"
              aria-label="Note" placeholder="Type a note..."></textarea>
    <!-- .clip reaches the editor's left edge (the checkbox gutter) and stops
         at --pad-b, so a scrolled line can never slide under the format bar. -->
    <div class="clip"><div class="layer" id="layer"><div class="paint" id="paint" aria-hidden="true"></div></div></div>
  </div>
  <div class="hint" id="hint" hidden><button type="button" class="hint-btn" data-cmd="todo">+ Checklist</button></div>
  <nav class="bar" id="bar" aria-label="Format">…</nav>   <!-- floats over the paper -->
</main>
<p id="status" class="status" role="status"></p>   <!-- Saved 2 min ago / errors -->
```

- `#input` has `color: transparent; caret-color: var(--ink)` and a visible
  `::selection`, so the user sees the clone's glyphs and the browser's own
  selection highlight, caret, IME composition and spellcheck. Its scrollbar is
  hidden, because a scrollbar would change the content width the clone wraps
  against; scrolling stays native.
- **The paint layer sits above the textarea** (`z-index: 2`, `pointer-events:
  none` on the layer, `auto` on the boxes) — otherwise the transparent textarea
  swallows every click meant for a checkbox, and its selection highlight would
  paint over the clone's glyphs.
- `#a11y` carries the same content as `role="list"` / `role="listitem"` /
  `role="checkbox"` nodes (visually hidden, **not** `display:none`) so screen
  readers get semantics without hearing the duplicate clone.
- The checkboxes are real `<button role="checkbox" aria-checked>` elements
  living inside their line, at a negative `left` in the editor's gutter.
- Because line-height is a fixed constant, **hit-testing is arithmetic**: one
  line is one block in the paint layer, so a box's row is `lineIndex × 24px` —
  no `getClientRects()` per frame. (`getClientRects` is used only to place the
  strike bars across wrapped rows: a per-toggle cost, not a per-frame one.)
- Scroll sync is one `translate3d` on the paint layer — compositor-only, no
  layout (apple-design §11).
- The format bar floats over the bottom of the Post-it (translucent) and
  `--pad-b` reserves the space, so the last line always scrolls clear of it.
  The status line sits *below* the paper, on the transparent document, so it
  carries **its own dark material** (like the chips): ink down there vanishes
  on a dark tile.

### 2.1a Changed from the first draft

- **Indent is leading whitespace in the text**, not a `d` field. A textarea
  cannot give one line a different padding from the next, so if the clone
  indented its text the two layers would wrap differently and the caret would
  drift. Keeping the indent *in the characters* is what makes the layers
  provably identical. Consequences: the box offset is measured from the real
  font (`indentPx`), nesting is two spaces of plain text (and reads correctly
  when copied out), and `toPlainText()` restores `- [ ] ` markers.
- **No dotted indent guides.** With a 32px gutter there is no room between the
  parent level and the child's box; the box's step is the signal. Dropped
  rather than drawn wrong.
- **The checkbox press responds on `pointerdown`; the model flips on `click`.**
  Responding visually on down (apple-design §1) while committing on release
  keeps a click that turns into a text drag from toggling a box.

### 2.2 File layout

`public/` becomes an ES-module tree (same pattern as `hn-top-stories`), served
from `/gqjs/static/note/…`. The render stub switches to
`<script type="module" src="/gqjs/static/note/note.js">`.

```
examples/extension/note/
├── index.js                     render stub (shell markup only)
├── package.json                 unchanged — "suwu": { "static": "public" }
├── public/
│   ├── note.js                  boot: DOM refs, wiring, input routing, chrome
│   ├── model.js                 PURE — line model, marks, validation, migration
│   ├── commands.js              PURE — Editor: commands, caret, undo stack
│   ├── render.js                paint layer, checkboxes, strike bars, springs
│   ├── store.js                 PURE — debounced writer + v1→v2 migration
│   ├── bridge.js                ext-store transport (postMessage to the parent)
│   ├── format.js                PURE — relative time ("2 min ago"), plain text
│   └── style.css                Post-it, lines, checkbox, chips, format bar
└── test/
    ├── model.test.mjs           node --test, zero deps
    ├── commands.test.mjs
    ├── store.test.mjs           migration + debounce + quota
    └── format.test.mjs          the "Saved …" clock + plain-text export
```

**Rule:** `model.js`, `commands.js`, `store.js` and `format.js` must never
touch `document`/`window`; the transport in `bridge.js` is injected into
`store.js`. That is what makes them unit-testable under `node --test` with no
browser, no jsdom and no bundler.

### 2.3 Data model (record `v2`)

The v1 record is `{ active: number, texts: string[7] }` — nine opaque strings,
no structure. v2 keeps the same shape (slot index *is* the identity) and adds
structure per line.

```js
// key: "v2"  → suwu:ext/note/v2
{
  v: 2,
  active: 0,                  // slot index 0..8
  notes: [ Note × 9 ]
}

Note = {
  c: "yellow",                // paper color, derived from the slot index (§2.6)
  u: 1690000000000,           // epoch ms of the last committed edit
  l: [ Line × n ]             // at least one line, always
}

Line = {
  t: "  Buy milk",            // text; the leading 2-space groups ARE the indent
  k: "todo",                  // para|todo|head
  c: 0,                       // checked 0|1 (todo only)
  m: [[0, 3, "b"]]            // marks: [start, end, kind], sorted, non-overlapping
}
```

`d` is not stored: `depthOf(t)` reads the leading whitespace (see §2.1a).
Mark kinds: `b` bold, `i` italic, `u` underline, `s` strikethrough,
`c` monospace. Marks are **ranges within a line**, not per-line flags, so
selecting three words in the middle of a paragraph and pressing ⌘B works.
Invariants enforced by `model.js` (and asserted in tests): ranges clamped to
`[0, t.length]`, sorted, non-overlapping and adjacent-merged per kind;
different kinds may overlap, and `rebaseMarks` moves them across a keystroke
(inside a run extends it, at a run's start pushes it right, at its end leaves
it alone).

**Caps:** `MAX_CHARS = 4000` per note (up from 1500), `MAX_LINES = 500`,
`MAX_DEPTH = 3` (4 levels). Nine notes × 4000 chars is ~36 KB — far under the
512 KB `ext-store` cap. A keystroke past `MAX_CHARS` is refused (the last good
value goes back into the textarea) and the status line says "Note is full.";
enforced in `model.js` so no code path can write an oversized record.

### 2.4 Migration v1 → v2

`store.js` reads `v2`; on miss it reads `v1` and converts:

- `texts[0..6]` → notes `0..6`, one note per slot, each source line becoming
  one `{ t, k: "para" }` line so existing multi-line pastes keep their shape.
- Notes `7` and `8` start empty.
- `active` maps straight across.
- Written to `v2` immediately. **`v1` is never overwritten** — it is the
  rollback path if this ships broken.
- Any record failing `normalize()` — wrong shape, non-string `t`, absurd sizes
  — is discarded and replaced with nine empty notes. Never throw on user data;
  degrade to the status line (today's behavior).

### 2.5 Environment constraints (verified, not assumed)

Read off the shipped code; these bound the design.

| Constraint | Source | Consequence |
|---|---|---|
| Opaque origin: no `localStorage`, no `IndexedDB` | `sandbox` without `allow-same-origin` (`ExtensionPage.tsx`) + the `sandbox` directive in the render CSP (`pkg/server/extension.go`) | All persistence goes through the `ext-store` bridge |
| Record cap 512 KB, key charset `[A-Za-z0-9._-]{1,64}`, 3 s reply timeout | `EXT_VALUE_MAX` / `EXT_KEY_RE` / `REPLY_TIMEOUT` | One `v2` key, hard char caps, fire-and-forget saves |
| `script-src 'unsafe-inline' <origin> https://unpkg.com`, `style-src 'unsafe-inline' <origin>` | `extensionCSPFor` | ES modules from `/gqjs/static/note/` load; no `eval`, no bundler needed |
| `connect-src 'self' <origin>` | same | No third-party network from the document (irrelevant — we make none) |
| `Alt`+key is relayed to the WM as a shortcut (`ext-key`) | `ExtensionPage.tsx` relay | Bind shortcuts to ⌘/Ctrl, never Alt |
| The WM hover toolbar owns the tile's top-right 224×48 | tile skill §11 | Chip rail stays top-left; the format bar floats over the paper's bottom edge |
| No build step, no `node_modules` for extensions | `suwu.static` serves files as-is | Zero dependencies; pure modules + `node --test` |

### 2.6 Slots and the chip rail

- `COUNT = 9`; chips are numbered `1`–`9` and `aria-selected` marks the active
  one, exactly as today.
- Paper color stays **derived from the slot index** (`COLORS[i % COLORS.length]`)
  — no color picker, no per-note color field to store. The palette grows from 4
  to 5 papers (adds `orange`) so 9 slots cycle less obviously; that is two lines
  of CSS and no model change.
- The rail is 9 × 26 px + 8 × 6 px = **282 px** wide at the default chip size.
  A `ResizeObserver` drops it to a compact form below 300 px of tile width
  (22 px chips, 4 px gaps = 230 px); below that the rail scrolls horizontally.
  Never let a chip be clipped or overlap the WM's corner zone.
- Each chip grows a Micro (10 px) badge with the number of **open** items and a
  2 px progress fill along its bottom edge (`done / total`) — the Reminders
  read, at chip scale. Chips with no checklist show neither.
- The selected chip draws a 2 px ring *outside* its border box, so the chip
  itself must not set `overflow: hidden` (which would slice the ring) and the
  rail needs 3 px of padding: it is a scroll container, and `overflow-x` clips
  the cross axis too. The badge and the progress fill stay inside the chip's
  rounded corners by geometry, not by clipping.

### 2.7 Saving and the "Saved 2 min ago" line

- Keep the existing bridge verbatim (3 s timeout, `rid` matching,
  `window.parent === window` → `NoParent` → in-memory mode, `pagehide` flush),
  moved into `bridge.js` so `store.js` stays DOM-free and testable.
- Debounce 250 ms after the last transaction, as today; **flush immediately**
  on slot switch and on `pagehide`.
- The model is the source of truth, the paint layer is a pure function of it,
  and saving is fire-and-forget — the bridge round-trip must never block typing.
- On a successful save, `store.js` returns the save timestamp; `format.js`
  renders it relative: `just now` (<45 s) → `1 min` → `12 min` → `1 hr` →
  `3 hr` → `yesterday` → a date. The status line shows **"Saved 2 min ago"**
  on a dark pill (the status line sits on the transparent document, so ink
  there would vanish on a dark tile — §2.1), refreshed by a 15 s interval while
  the document is visible.
- Errors replace the resting text in the same line and turn the pill red:
  `Storage full — changes may not be saved.` / `Couldn't save changes.`.
  One line, one purpose, no stacking.
- The line is **always present** (`.status` keeps a min-height and is never
  `display:none`) so appearing and disappearing text never reflows the Post-it.
  Opened outside a tile there is no parent to answer the bridge, so it says
  "Couldn't save changes." and keeps working in memory — as v1 did.

### 2.8 Undo

Apple Notes has a real undo stack; a plain textarea only has text undo, which
knows nothing about checkboxes. Plan: **app-level transaction stack** over
model snapshots.

- Every structural op (`toggleCheck`, `setKind`, `indent`, `outdent`, mark
  toggles) is one transaction = one undo entry.
- Typing coalesces: a new entry after 400 ms idle, on any non-`insertText`
  `inputType`, or on a selection jump.
- Cap 100 entries (snapshots reference a copy-on-write line array — no deep
  clone of the document).
- Entries store `{ notes, active, selStart, selEnd, scrollTop }`, so undo also
  restores the caret and viewport.
- The native stack is neutralized in `note.js`:
  ```js
  input.addEventListener("beforeinput", (e) => {
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
      e.preventDefault();
      commands.undo();                    // ours
    }
  });
  ```
  and ⌘Z / ⇧⌘Z route to the same entry points.
- Programmatic text writes (indent, kind change, undo) go through
  `input.setRangeText(next, start, end, "end")` + `syncCaret()`, so the caret
  lands where the model says it should.

---

## 3. Phase 1 — Foundation: model, renderer, migration, 9 slots (done)

No new user-visible behavior beyond the ninth chip and the "Saved …" line; this
phase exists so Phases 2–3 are pure additions.

- [x] `model.js`: line parse/serialize, marks, caps, `validate()`, `migrateV1()`
- [x] `commands.js`: transactions, the caret, and the undo stack
- [x] `render.js`: paint layer, node reuse, scroll sync, the checkbox spring
- [x] `store.js` + `bridge.js`: transport injection, debounce, v1 → v2 migration
- [x] `format.js`: the relative-time formatter
- [x] `note.js` / `index.js` / `style.css`: 9 chips, compact rail, status pill
- [x] Tests: model round-trip, caps, migration (7-slot, all-empty, corrupt),
      quota path, relative time, undo/redo with the caret

## 4. Phase 2 — Checklists (the headline feature) (done)

The one thing this phase must nail is *feel*: a box that answers the finger
instantly, in a document that stays perfectly aligned.

### 4.1 Behavior

- **Make a line a checklist:** the format bar's checklist button, or type
  `- [ ] ` / `[x] ` / `[] ` at the caret — the marker is consumed, never left
  in the text. The rule fires on a paragraph *and* on a line that is already a
  checklist item, so a habitual "- [ ] " never survives as literal text.
- **Check / uncheck:** click the box. The press is answered on `pointerdown`
  (apple-design §1) and the model flips on release, so a click that turns into
  a text drag cannot toggle a box. The paint layer updates that frame, and the
  box's fill and tick are driven by one rAF spring (damping 0.8, response 0.3)
  that is interruptible: pressing again mid-flight reverses from the current
  on-screen value.
- **Checked appearance:** the text desaturates to 55 % and a strikethrough
  *draws in* from the left — one bar per visual row, sized from
  `getClientRects()` so a wrapped item is struck across both lines.
  (`text-decoration` cannot animate and cannot wrap, hence the bars.)
- **Auto-continue:** Enter at the end of a `todo` creates the next `todo` at
  the same depth, unchecked. Enter on an *empty* `todo` turns it back into a
  plain paragraph (Apple's "leave the list" gesture) and creates no new item.
  Enter after a `head` leaves a paragraph behind.
- **Backspace:** on an empty item — wherever the caret is — it leaves the list
  and strips the indent; at the start of a filled item it removes the marker
  first, then the indent; otherwise the browser joins lines.
- **Nesting:** `- ` typed on an *empty* checklist item nests it and is consumed
  (Apple Reminders' nesting-by-dash). Depth capped at 3.
- **Indent / outdent:** Tab and ⇧Tab, or the format bar's two indent buttons,
  or Backspace at the start of an indented line. Tab indents any line, so it is
  always useful; ⇧Tab at depth 0 and Tab at the cap are no-ops.
- **Keyboard:** ↑/↓, Home/End and word-wise motion stay native (never
  intercepted); Enter/Backspace are handled on `keydown` (the one event every
  engine reports) and skipped while `isComposing`, so an IME keeps its Return.
- **Empty-note affordance:** a blank note shows the "Type a note…" placeholder
  plus a one-tap **Checklist** chip that turns line 1 into a todo — the empty
  state teaches the feature (apple-design §16, Purpose). The chip stays up until
  the note has any text *or* any list structure.

### 4.2 Rendering

- Fixed `line-height: 1.5 × 16px = 24px` (`LINE_HEIGHT` in render.js must
  match `--line-height`), no variable metrics anywhere — this is what makes one
  line one block, and therefore hit positions arithmetic. Any future font-size
  change must keep the ratio integer-valued.
- The checkbox hangs in the editor's 2rem gutter at
  `indentPx(depth) − (15 + 6 + 5)` — a negative offset that lands it just left
  of its own text and steps right by one indent per level. `indentPx` is
  measured in the real font, so the box tracks the actual whitespace.
- Box: 15 × 15 px painted, 1.5 px ink ring, 3 px radius; ink fill plus a
  paper-colored tick when checked, both driven by the spring's `--p` value.
- Box hit target 25 × 25 px (5 px transparent border, `box-sizing: content-box`
  so the padding is hit area and not paint) — a thumb can hit it in a narrow
  tile (apple-design §10).
- Marks paint as one span per *uniform formatting run*: overlapping kinds share
  a span with several classes, so bold + italic over the same words is one
  element, not two copies of the text.
- Chip badge + progress fill per §2.6.

### 4.3 Motion (apple-design §4, §7)

| Event | Motion |
|---|---|
| Press the box | Fill + scale 0.92 on `pointerdown` (no transition delay) |
| Check on | Spring scale 0.8 → 1 (damping 0.8, response 0.3) + check-mark stroke reveal |
| Check off | Same spring reversed from the current value; strikethrough retracts to 0 |
| Row text on check | Strike draws left→right 180 ms ease-out; text opacity 1 → 0.55 |
| Chip progress | `transform: scaleX()` on the fill, spring, origin at the left edge |
| Format bar appear | (Phase 3) blur 0 → 14 px + translateY 10px → 0, spring 1.0/0.3 |

`@media (prefers-reduced-motion: reduce)`: the strike cross-fades in 100 ms,
springs collapse to 120 ms transform/opacity, no overshoot. Feedback is never
removed — only the physics.

### 4.4 Deliverables

- [x] `commands.js`: `toggleCheck`, `setKind`, `indent`, `outdent`,
      `insertLineBreak`, `backspaceStructural`, `consumeMarker`, `nestMarker`
- [x] `render.js`: checkbox buttons in the gutter, checked styling, strike bars
- [x] `note.js`: `keydown`/`beforeinput` routing, input rules, chip badge
- [x] `style.css`: `.ln`, `.box`, `.strike`, `.chip-badge`, `.chip-progress`
- [x] Tests: every Enter/Backspace/Tab transition, marker consumption per input
      rule, depth cap, toggle idempotence, undo of a toggle

## 5. Phase 3 — Inline formatting, format bar, timestamps (done)

### 5.1 Marks

- Toggle a mark over the selection: intersect the selection with every line,
  clip the ranges, then either add (if the selection is not fully marked) or
  remove (if it is). The "fully marked?" test decides direction — that is what
  makes ⌘B idempotent and predictable.
- Marks collapse to an empty array when they cover nothing; adjacent same-kind
  ranges merge on the next `normalize()`.
- `format.js` exports `toPlainText()` (marks stripped, `- [x] `/`- [ ] `
  markers) for the copy path and for snapshot tests.
- The `head` line style is a `k` value, not a mark: it is the last toggle in
  the bar (an `H` glyph with `aria-pressed`), not a popover — a two-state
  control does not need a menu. If the surface should be even tighter, drop it;
  nothing else depends on it.

### 5.2 Format bar

A translucent bar floating over the **bottom** of the Post-it (never the
top-right 224 × 48 the WM owns):

```
[☑] │ [⇤] [⇥] │ B I U S </> │ H
```

- Glass material: `backdrop-filter: blur(14px)` over a paper-matched
  translucent fill, hairline top border, a shadow scaled to the bar. On
  `prefers-reduced-transparency: reduce` → solid paper color, no blur. On
  `prefers-contrast: more` → solid fill + defined border.
- It **arrives as material** (apple-design §12): opacity 0 → 1 and
  translateY 10px → 0 on a 0.22 s ease-out, with the blur already in place —
  animating `backdrop-filter` per frame is not worth the cost at this size.
- The bar reflects the caret's state (active line kind, active marks) on
  `selectionchange`; an active button gets an ink fill. The indent buttons
  disable themselves when there is nothing to indent or outdent.
- **Compact mode:** a `ResizeObserver` on the tile reduces the bar to
  `[☑] [⇤] [⇥] B I U` below 300 px wide or 240 px tall, and hides it below
  ~160 px tall (which also drops `--pad-b`, giving the text the room back) — a
  120 × 80 tile must stay writable.
- Pressing a bar button focuses the textarea *without losing the caret*:
  `focusEditor()` saves the selection, focuses, and restores it, so a press
  never acts on line 1 because focus reset the caret to zero.
- Every button is a real `<button>` with `aria-label` + `title` (which carries
  the shortcut) and shows its state with `aria-pressed`.
- Shortcuts: ⌘/Ctrl+B, I, U, ⇧⌘X (strikethrough), ⇧⌘M (monospace), ⇧⌘H
  (heading), ⇧⌘C (checklist), ⌘/Ctrl+Z, ⇧⌘Z, Tab / ⇧Tab. Never Alt (relayed
  to the WM — §2.5).

### 5.3 Typography (type scale — §11 of the tile skill)

| Element | Size | Category |
|---|---|---|
| Note text / heading | 16 px | Heading |
| Toolbar buttons, chips, gutter glyphs | 12 px | Label |
| Status, "Saved 2 min ago" | 11 px | Caption |
| Chip counters (open items) | 10 px | Micro |
| `</>` mono glyph | 9 px | Glyph |

Monospace swaps the family to the mono stack for marked ranges only, so the
document keeps its typewriter voice — the current extension's whole identity.
No sizes outside this table.

---

## 6. Implementation order and suggested commits

Each phase is independently shippable and independently revertable. Follow
`AGENTS.md`: **ask before committing.**

1. `docs(note):` this document.
2. `refactor(note):` split the classic script into an ES-module tree, no
   behavior change (a pure move, so it is trivially reviewable).
3. `feat(note):` line model, v1→v2 migration, brush renderer, undo stack,
   9 slots, "Saved … ago" status line.
4. `feat(note):` checklists — boxes, auto-continue, nesting, chip progress.
5. `feat(note):` marks + format bar + compact mode.
6. `docs(note):` update `examples/extension/README.md` (the "what each example
   demonstrates" table) and the extension's own description.

---

## 7. Verification

**Unit** (no new dependencies — `node --test`, Node ≥ 20; 50 tests, all green):

```sh
pnpm test:ext        # node --test "examples/extension/*/test/*.test.mjs"
```

Covered: model round-trip and normalization, cap enforcement, mark
add/remove/merge and `rebaseMarks`, line offsets/spans, `v1 → v2` migration
(7-slot record, all-empty record, corrupt record), the debounce and the
`pagehide` flush, the quota path, the relative-time formatter, `toPlainText()`,
and the full command surface — every Enter/Backspace/Tab/marker transition,
undo coalescing and caret restore, the bounded undo stack.

**Integration** (headless Chromium, throwaway harness — 82 checks, all green):
the generated `index.js` shell is served over HTTP, hosted in an iframe whose
parent answers `ext-store` exactly as `ExtensionPage.tsx` does, and driven with
synthetic `input` / `keydown` / `beforeinput` / `click` events — including a
faithful emulation of the browser's own default edit, so "did the page prevent
it?" is really tested. It covers boot + migration, typing, the checklist and
its checkbox geometry (the box must sit in the gutter, clear of the text, with
a 25 px hit target), Enter/Tab/nesting/leaving the list, all three marker
rules, marks (including that overlapping marks share one span and the text is
not duplicated), undo/redo, the heading style, the chip badge and progress,
the "Saved …" line, slot switching, and a full reload round-trip. That pass is
what found the four real bugs called out in §2.1a plus the DOM-sync and
status-legibility defects.

**Existing suites stay green:** `go test ./...`, `pnpm --dir frontend check`
(the typography linter guards the frontend, not this extension — but the scale
in §5.3 is the contract).

**Still manual** (needs a real WM, a keyboard and a touchscreen):

- [ ] Type a checklist with a hardware keyboard and with a touchscreen; IME
      composition in a todo line is not corrupted (Enter is skipped while
      `isComposing`, but the IME path itself is untested).
- [ ] Boxes stay pixel-aligned at 1×, 1.5× and 2× tile zoom, and after the tile
      is split / dragged / swapped (the iframe must not remount).
- [ ] All 9 chips reachable and labelled by keyboard at 220 px and 400 px tile
      width; nothing under the WM's top-right zone.
- [ ] Two panes on the same tile: last writer wins, no crash, no partial write.
- [ ] `prefers-reduced-motion` and `prefers-reduced-transparency` look right.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Overlay/textarea drift after zoom or font change | Indent lives *in* the text (§2.1a), so both layers hold the same characters; `--line-height` is the only metric duplicated with JS (`LINE_HEIGHT`), and it is a fixed integer |
| Native undo fighting the model stack | Structural keys are handled on `keydown` and prevented, so the browser's history never records them; typing is coalesced into the model stack, tested per gesture |
| 512 KB record cap hit by nine long notes | `MAX_CHARS` guard + the existing "Storage full" status (36 KB worst case today) |
| Nine chips crowding a narrow tile | Compact rail below 300 px (§2.6), horizontal scroll as the floor |
| Losing existing users' notes | `v1` is never overwritten; migration is additive and tested |
| Scope creep toward Apple parity | §1 is the allow-list; anything not in it is a v3 conversation |
