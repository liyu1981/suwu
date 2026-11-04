# Terminal Frequent Inputs & Snippets — Plan

Status: **implemented** (phases 1 + 2; see the implementation notes below)
Owner area: `frontend/src/components/FullTerminal.tsx`,
`frontend/src/components/hooks/`, `frontend/src/components/term/`,
`frontend/src/lib/`, `frontend/src/store/`

> **Implementation notes (deviations from the plan).**
> - The pure model lives in `lib/termInput.ts` + `lib/termSnippets.ts`, not in
>   the store: `store/termSnippets.ts` owns the three atoms only, so
>   `scripts/check-term-snippets.mjs` can import the model under Node type
>   stripping without pulling in jotai.
> - `consumeInput` is **resumable** across chunks (an escape sequence may
>   arrive split) and carries a `stale` flag: every escape sequence except the
>   bracketed-paste markers means the shell may have edited the line behind our
>   back (`↑` recall, `Tab` completion, cursor movement), so the line is
>   **dropped** rather than guessed at. A wrong history entry is one click from
>   being run, and the menu can run entries — the shell's `history` still has it.
> - Insertion feeds the same parser (`recordSent`) because `sendRaw` bypasses
>   `onData`; without it, insert-then-Enter would remember only the typed
>   prefix, i.e. a command the user never ran.
> - `SnippetIcon` is a bolt; `PencilIcon` was added for the edit affordance
>   (trash/check already existed). The manager's list scrolls inside the dialog
>   (`max-h-[40dvh]`) while the dialog body scrolls at `max-h-[85dvh]`.
> - Focus is handed over explicitly: the popover restores focus to the terminal
>   on close *unless* the manager is opening (`managerOpenRef`), so keystrokes
>   can never reach the shell behind the dialog.
> - `Alt+S` and any other shortcut were dropped (§11a): the feature is
>   click-only, and the menu is fully keyboard-navigable once open.

Related skills: `suwu-tile-plugin-design` (§11 glass material + type scale,
iframe page pattern, session state), `apple-design` (direct manipulation, no
modal ceremony for the fast path; the manager is the only dialog).

---

## 1. Goal

Typing long, repetitive commands into a terminal tile is the most common
friction in the whole app. Give the term tile a **local, offline command shelf**:

1. A small trigger button sits in the per-pane status bar, **immediately left of
   the "enter copy mode" button**.
2. It opens a **popover that grows upward** (it lives at the bottom edge) with
   three things: a **search field**, the user's **recent inputs**, and their
   **saved snippets**.
3. Clicking an entry **inserts** it at the shell prompt (no Enter) so it can be
   reviewed; an explicit **⏎** affordance inserts *and* runs. A snippet can be
   ticked **auto return** ("run when selected") — the command you always run
   as-is — and then selecting it is the run.
4. A **Manage snippets** entry opens the only modal: add / edit / delete named
   snippets, plus the recent-history controls.
5. Everything is stored **locally** (`localStorage` for snippets,
   `sessionStorage` for the typed history). No server, no extension API.

```
   (terminal content)
┌──────────────────────────────────────────────────────────────┐
│ ● Connected                          ⌁  ⧉  ↻                 │  status bar (h-5)
│                                    ↑ NEW   copy reset        │
└──────────────────────────────────────────────────────────────┘
     │ click ⌁
     ▼  (opens upward, right-aligned to the trigger)
   ┌─────────────────────────────────────────────┐
   │ 🔍 Search inputs and snippets…              │  Body 14
   ├─────────────────────────────────────────────┤
   │ RECENT                                      │  section label (Micro 10, wide)
   │  git status                                 │  mono Label 12
   │  pnpm --dir frontend build                  │
   │ SAVED                                       │
   │  deploy staging            ⏎   ✓  ⌫         │  ⏎ reveals on hover/focus
   │  tail the app log          ⏎   ✓  ⌫         │
   ├─────────────────────────────────────────────┤
   │ + Save current input        Manage snippets…│  footer buttons
   └─────────────────────────────────────────────┘
```

Requirements:

1. **Zero new backend surface.** Nothing added to Go; no WebSocket message
   types; no `/term` route change (the pane URL stays `?pane=…`).
2. **Insert = `sendRaw`.** Reuses the existing PTY input channel
   (`usePtySession().sendRaw`), so no xterm echo hackery and no new IPC.
3. **Shared across panes, per browser.** Every `/term` iframe is its own
   document; snippets and history sync through `localStorage`/`sessionStorage`
   `storage` events (the `atomWithStorage` pattern already used by
   `store/appearance.ts`).
4. **Disconnected-safe.** The menu still opens while the PTY is detached;
   insertion reports "not connected" through the existing `Toast` instead of
   silently dropping input.
5. **Type-scale and material compliant** (`pnpm check` must pass, including
   the backup-registry guard).

Non-goals (§11): shell-side history import, variables/placeholders in
snippets, per-pane snippet scoping, drag-reorder, sync to the server, or a
tile-toolbar (hover) entry point.

---

## 2. Current state (what exists today)

| Concern | Where |
| --- | --- |
| The status bar + copy-mode button + reset button | `frontend/src/components/FullTerminal.tsx` L171–L227 (`<footer>`; right cluster is `<div className="ml-auto flex …">`) |
| Raw-input injection into the PTY (`sendRaw`) | `frontend/src/components/hooks/usePtySession.ts` L96–L131, L531 |
| xterm `onData` → WebSocket plumbing (single listener) | `usePtySession.ts` L467 |
| Selection-mode key handling / single `attachCustomKeyEventHandler` | `frontend/src/components/hooks/useTermCopy.ts` L108–L160 |
| Toast primitive | `frontend/src/components/Toast.tsx`, used as `showToast(...)` in `FullTerminal` |
| Dialog primitive + material | `frontend/src/components/ui/dialog.tsx` |
| Popover primitive (portal, `data-[side=top]` animations already defined) | `frontend/src/components/ui/popover.tsx` |
| Shared-icon set | `frontend/src/components/icons.tsx` (has `SearchIcon`, `PlusIcon`, `TrashIcon`, `CheckIcon`; **no** history/snippet mark) |
| Persisted-list precedent (`atomWithStorage` + pure list helpers) | `frontend/src/store/sftp.ts`, `store/dbbrowser.ts`, `store/appearance.ts` |
| Backup allowlist guard (build fails on unregistered `suwu*` keys) | `frontend/src/lib/backup/registry.ts`, `frontend/scripts/check-backup-registry.mjs` |
| Type-scale guard | `frontend/scripts/check-typography.mjs` |

Nothing in the tree today records or replays terminal input, so both the
recorder and the store are new.

---

## 3. Data model

`frontend/src/store/termSnippets.ts` (new):

```ts
export interface TermSnippet {
  id: string;          // crypto.randomUUID()
  text: string;        // what gets inserted (may be multi-line) — the only label
  autoReturn?: boolean; // send Enter after the text: run it on selection
  createdAt: number;
  lastUsedAt?: number; // used to sort within the saved section
  useCount?: number;
}

export interface RecentInput {
  text: string;
  at: number;
}

/** localStorage — user-authored data, survives reloads, backed up. */
export const termSnippetsAtom = atomWithStorage<TermSnippet[]>(
  'suwu.term-snippets', [], undefined, { getOnInit: true },
);

/** sessionStorage — typed history, tab-scoped, never backed up. */
export const termRecentsAtom = atomWithStorage<RecentInput[]>(
  'suwu.term-recents', [], createJSONStorage(() => sessionStorage),
  { getOnInit: true },
);

/** How many rows each section lists, and how much history is kept. */
export interface TermShelfSettings {
  maxSaved: number;    // 5 by default, 1…20
  maxRecent: number;   // 5 by default, 1…20
  recentsKept: number; // 50 by default, 1…200
}
export const termShelfSettingsAtom = atomWithStorage<TermShelfSettings>(
  'suwu.term-snippets-settings', SHELF_SETTINGS_DEFAULT,
);
// Read/written through `normalizeShelfSettings()`, which clamps every field, so
// a stale payload or a hand-edited localStorage value can never reach the UI.

/** Whether typed history is recorded at all (default on). */
export const termRecordInputsAtom = atomWithStorage<boolean>(
  'suwu.term-record-inputs', true, undefined, { getOnInit: true },
);
```

Pure helpers in the same file (exported, unit-testable by the `check-*` script):

- `upsertSnippet(list, next)` — replace by `id`, newest first, cap 200.
- `removeSnippet(list, id)`.
- `pushRecent(list, text)` — trim, ignore empty, dedupe by exact text (move to
  front), cap 50, drop entries longer than 500 chars.
- `clearRecents()`.
- `markSnippetUsed(list, id)` — bump `lastUsedAt`/`useCount`; the saved section
  sorts by `lastUsedAt desc` then `createdAt desc`.

**Storage-key naming.** Follow the existing `suwu.term-*` family
(`suwu.term-font-family`, `suwu.term-theme`), not the `suwu:` colon family:
`suwu.term-snippets`, `suwu.term-recents`, `suwu.term-record-inputs`.

**Why two storage scopes (decision).** Snippets are intentional, hand-written,
and worth keeping plus backing up. The typed history is *incidental* and can
contain anything the user typed at any prompt (including a secret at a
password prompt, which the browser cannot detect because it only sees
keystrokes). Keeping history in `sessionStorage` means it survives F5 but not
a tab close, and it can never end up in a backup or on another device. The
real long-term command record is still the shell's own `history`.

---

## 4. Recording recent inputs

`frontend/src/lib/termInput.ts` (new) holds the state machine, kept pure so it
can be tested:

```ts
export interface LineBuffer { text: string; }
export const emptyLine: LineBuffer = { text: '' };

/** Feed one onData chunk; returns the new buffer plus any submitted lines. */
export function consumeInput(buffer: string, chunk: string): {
  buffer: string;
  submitted: string[];
};
```

Rules:

- Split on `\r` / `\n` — each terminator finalizes the current line (so a
  free-typed multi-line block yields one entry per line).
- `\x7f` / `\b` → drop one char; `\x03` (Ctrl-C), `\x15` (Ctrl-U), `\x0c`
  (Ctrl-L) → clear the buffer (and any doubt about it).
- `\x1b…` escape sequences are consumed, never rendered as text. The parser is
  resumable, so a sequence split across chunks yields the same result as one
  that arrives whole.
- **Bracketed paste is literal.** Between `\x1b[200~` and `\x1b[201~` every byte
  is content — newlines and control bytes included — because the shell's line
  editor holds it untouched until Enter. A pasted block therefore stays *one*
  entry (rendered with its `N lines` badge), which also keeps the model honest
  for text typed after the paste.
- **Trust rule:** the bracketed-paste markers are the only sequences that leave
  the line trustworthy. Any other sequence sets `stale`, and a stale line is
  dropped on submit instead of being remembered — `↑` recall, `Tab` completion
  and `←`/`Home` edits all change the shell's line in ways keystrokes cannot
  reveal. `getCurrentLine()` returns `''` while stale or overflowing, so
  *Save current input* cannot save a guess either.
- Other C0 controls (`< 0x20`, `0x7f`) → ignored; everything else appends
  (replaced by the literal rule above while pasting).
- Cap the buffer at 500 chars; a longer line is dropped, not truncated
  (truncating a command would produce a wrong, runnable history entry).

`frontend/src/components/hooks/useInputRecorder.ts` (new) attaches a **second**
`term.onData` listener (xterm supports multiple listeners; `usePtySession`'s
stays untouched) and writes through `pushRecent` on submit. It returns
`getCurrentLine()` so the popover footer's *Save current input* action can seed
the manager with text the user is still composing. It is a no-op when `termRecordInputsAtom` is false or
`selectionMode` is on.

> Deliberately **not** filtered by heuristics such as "looks like a password".
> The mitigation is scoping (sessionStorage) + an off switch + a clear action,
> not a guess that would silently drop the command the user actually wanted.

---

## 5. Insertion into the PTY

`insert(text, { run })` in `FullTerminal.tsx`:

1. If `sendRaw` reports not-ready (detached PTY), `showToast(t('terminal.snippets.notReady'))`
   and keep the menu open.
2. Build the payload:
   - Multi-line and `term.modes.bracketedPasteMode` → wrap in
     `\x1b[200~ … \x1b[201~` so bash/zsh treat it as one paste instead of
     executing line by line. Single-line text is sent bare (works everywhere).
   - `run` → append `\r`.
3. `sendRaw(payload)`, close the popover, `term.focus()`.
4. If the entry came from the saved list, `markSnippetUsed`.
5. If it came from history, leave it in place (already at the front after the
   shell echoes and re-records it).

The server already echoes PTY output, so no local echo is needed — same path
the reset button and the restore-commands logic use.

---

## 6. The menu (popover, opens upward)

`frontend/src/components/term/SnippetMenu.tsx` (new) exports the trigger and
content; `FullTerminal` owns the `open` state and the `insert` callback.

**Trigger** — first child of the existing `ml-auto` cluster in the status bar,
i.e. directly left of the copy-mode button:

```tsx
<button
  type="button"
  onClick={() => setOpen((v) => !v)}
  className="rounded p-0.5 hover:bg-white/10"
  title={t('terminal.snippets.button')}    // "Frequent inputs"
  aria-label={t('terminal.snippets.button')}
  aria-expanded={open}
>
  <SnippetIcon className="h-3 w-3" />
</button>
```

The status bar is `h-5 text-[11px]` with `h-3 w-3` icons; the new button must
match those dimensions and inherit the footer's colour (no own `text-*`
colour), and it must never be `disabled` — see §9 for the disconnected case.

**Popover** — uses the shared primitive, so material (`menu-glass`) and
side-aware animation are free:

```tsx
<PopoverContent
  side="top"            // grows upward from the bottom status bar
  align="end"           // right-aligned with the trigger
  sideOffset={6}
  collisionPadding={8}  // Radix flips to "bottom" if a short pane has no room
  className="w-[min(22rem,calc(100vw-1rem))] p-0"
  onCloseAutoFocus={(e) => { e.preventDefault(); term?.focus(); }}
>
```

Sections (top → bottom): **search input** (autofocused, Body 14, `SearchIcon`
inline), **SAVED**, **RECENT**, then a footer row with *+ Save current input*
and *Manage snippets…*. SAVED leads because it is the shelf the user built on
purpose; history is the incidental one.

Each section lists **5 rows by default** (`maxSaved` / `maxRecent` in the
manager's General tab, 1…20) and, when it holds back entries, ends with a
Micro 10 `+N more` caption. Typing in the search box **lifts the limit** — a
search is a question about the whole shelf, not about the visible five.

Row anatomy: the snippet's own text, first line only, `truncate`; mono,
Label 12 (a snippet has no name — the command *is* the label). Sub-line for
multi-line snippets = Micro 10 `N lines`. Trailing
actions appear on hover / keyboard focus (opacity transition, always reachable
by Tab):

- `⏎` — insert and run (`title`: "Insert and run"). Hidden on auto-return
  snippets, where plain selection already runs and a persistent `↵` badge in
  the row says so (no hidden modifier: the flag is the whole story).
- For saved rows only: `✓` (edit → opens the manager with that snippet
  focused) and `⌫` (delete, immediate, no confirm — it is one row, and the
  manager is the recovery surface; if a confirm is wanted, reuse the
  `Toast`-less inline "click again to confirm" pattern instead of a dialog).

Keyboard: `↑`/`↓` move a highlight across the **flattened filtered** list,
`Enter` inserts (no run), `Ctrl/Cmd+Enter` inserts and runs, `Esc` closes
(Radix default), and `Tab` walks into the footer buttons. The list scrolls in
`min-h-0 flex-1 overflow-auto` inside `max-h-[min(24rem,60vh)]`; the search row
and footer stay fixed.

Search is a case-insensitive substring match over the text, applied to both
sections at once; an empty result shows one Caption 11 line
("No matching inputs").

---

## 7. The manager — a table, edited in place

`frontend/src/components/term/SnippetManagerDialog.tsx`, using the existing
`Dialog` / `DialogContent` / `DialogTitle`. It is a **table of snippets, not a
form above a list**: editing happens in the row you clicked, so the shelf stays
in view and there is no "which row am I editing?" state to read.

```
┌──────────────────────────────────────────────────────────┐
│ Frequent inputs                                  [+ New] │  Heading 16
├──────────────────────────────────────────────────────────┤
│ INPUT TEXT                                          ↵    │  Micro 10, uppercase
├──────────────────────────────────────────────────────────┤
│ git status                                        ↵      │  row: Body 14 mono,
│ pnpm --dir frontend build                                │  2-line clamp
├──────────────────────────────────────────────────────────┤
│ ▸ click a row → it becomes the editor:                   │
│   [ textarea, mono Body 14 ]                             │
│   ☐ Auto return — run when selected   Save Cancel Delete │
└──────────────────────────────────────────────────────────┘
```

- **Tabs** — `Saved` | `General` (Label 12, sky underline on the selected tab).
  Any edit target opens the Saved tab.
- **Saved tab** — *New* button (Label 12, `PlusIcon`) above the table.
- **Columns** — `Input text` and a narrow `↵` column that shows whether the
  snippet auto-returns (Micro 10 badge, tooltip "Runs when selected").
- **Rows** — ordered by `orderSnippets` (most recently used, then newest).
  The whole row is the hit target (`cursor-pointer`, `Edit` tooltip); clicking
  it swaps the row for the editor.
- **Editor row** — mono `<textarea rows={2}>` (Body 14, so multi-line snippets
  are writable), the *Auto return — run when selected* checkbox (Label 12, off
  by default, stored as absent so legacy/restored snippets need no migration),
  then `Save` (disabled while `text.trim()` is empty) / `Cancel` / `Delete`
  (danger tint, only for saved rows). `Ctrl/Cmd+Enter` saves, `Esc` cancels
  without closing the dialog. `Delete` lives here rather than on every row:
  two clicks for a destructive act, and it is always reachable.
- **New** — prepends an empty editor row at the top of the table; saving it
  prepends the snippet (`upsertSnippet`) and the rest of the table keeps its
  order. The button is disabled while that draft row is already open.
- **General tab** — three bounded number fields (`Saved shown in menu`,
  `Recent shown in menu`, `Recent inputs kept`), each with a Caption 11 hint.
  The input keeps a local draft while typing and commits on blur/Enter, so a
  half-typed value is never clamped out from under the caret. Lowering
  `recentsKept` prunes the stored history immediately rather than waiting for
  the next submitted command. Below them: the `Record recent inputs` checkbox,
  a Micro 10 count, and a `Clear` button.
- **Footer** — Close (`t('dialog.close')`).

Confirmations surface through the existing `Toast`
(`t('terminal.snippets.savedToast')`, `…deletedToast`).

### 7a. Save current input — confirm, don't manage

`frontend/src/components/term/SnippetSaveDialog.tsx` is the second and last
dialog. The menu's *Save current input* used to open the manager with an empty
"add" form, forcing the user to retype the line they had just typed. It now
opens a small confirm: the **captured line** (editable, autofocused, Body 14
mono), the **auto-return** checkbox, and `Cancel` / `Save`. Saving appends to
the same store and toasts; an empty or untrustworthy line (see §4) never opens
the dialog at all — the menu toasts "Nothing typed to save yet" instead.

Creation has exactly two entry points, both deliberate: the popover footer's
*+ Save current input* (the confirm dialog above, seeded from the live line
buffer) and the manager's *New* row. There is **no** per-history-row "save
this" action — history rows stay one-click insert/run, so the fast path never
grows a second button.

Both dialogs are opened from the popover footer; opening one closes the popover
and hands focus to the dialog (the popover's close focus-restore is suppressed
while a dialog owns the screen). On close, focus returns to the terminal.

---

## 8. Strings

New keys under `terminal.snippets.*` in **both**
`frontend/src/locales/en.json` and `zh_CN.json`:

| key | en |
| --- | --- |
| `button` | Frequent inputs |
| `searchPlaceholder` | Search inputs and snippets… |
| `recent` / `saved` | Recent / Saved |
| `emptyRecent` / `emptySaved` / `noMatches` | hints |
| `insert` / `run` | Insert / Insert and run |
| `saveCurrent` | Save current input |
| `manage` | Manage snippets… |
| `notReady` | Terminal is not connected |
| `managerTitle` | Frequent inputs |
| `general` | General |
| `maxSaved` / `maxSavedHint` | Saved shown in menu |
| `maxRecent` / `maxRecentHint` | Recent shown in menu |
| `recentsKept` / `recentsKeptHint` | Recent inputs kept |
| `moreCount` | +{{count}} more |
| `newSnippet` | New |
| `nothingToSave` | Nothing typed to save yet |
| `commandLabel` / `commandPlaceholder` | Input text (also the table header) |
| `autoReturn` / `autoReturnBadge` | Auto return — run when selected / Runs when selected |
| `save` / `cancel` / `delete` / `edit` | buttons |
| `recordInputs` / `recordInputsHint` / `clearRecents` / `recentCount` | history controls |
| `savedToast` / `deletedToast` / `historyClearedToast` | toasts |
| `linesCount` / `recent` / `saved` / `insert` / `run` | menu labels |

There is no `nameLabel` / `namePlaceholder` / `add` key: snippets have no name,
and every save goes through the same `Save` button (new or existing row).

`SnippetIcon` (a history/lightning mark) is added to
`frontend/src/components/icons.tsx` with the house default props
(`{ className = 'h-3 w-3' }`), reusing `SearchIcon`, `PlusIcon`, `TrashIcon`,
`CheckIcon` and `ChevronUpIcon` rather than inlining new SVGs.

---

## 9. Edge cases

| Case | Behaviour |
| --- | --- |
| PTY detached / reconnecting | Menu opens and lists everything; insert → `Toast` "Terminal is not connected"; menu stays open |
| Selection mode active | Trigger still works (history recording paused). Inserting in selection mode is allowed but focus goes back to the terminal; the mode stays as-is |
| Very narrow pane | Popover is `min(22rem, 100vw - 1rem)`; the status bar right cluster can wrap-free truncate the connection label first |
| Short pane (no room above) | Radix `collisionPadding` flips the popover below the trigger; the `data-[side=bottom]` animation is already defined in `popover.tsx` |
| Two panes open, both menus | Both read the same store; `storage` events keep them in sync (same as font/theme atoms) |
| Two panes write at once | Last write wins for the whole list (read-modify-write). Accepted: single user, tiny lists, and the alternative is a server-backed CRDT |
| Multi-line snippet in a shell without bracketed paste | Sent raw; bash 5.2's "paste N lines?" prompt is the backstop. Documented, not prevented. With bracketed paste the block is one entry, exactly as the shell holds it |
| Snippet containing `\r` typed by hand | Allowed — it is the escape hatch for "run these three commands" |
| History entry that is a secret | Prevented from long-term persistence by `sessionStorage`; user can disable recording or clear the list |
| Typed, then edited with `←` / recalled with `↑` | The line is dropped from the history (it can no longer be reconstructed from keystrokes) — *Save current input* also refuses. Recall-only reruns still exist in the shell's own `history` and in the recents from the first run |
| Backup/restore | `suwu.term-snippets` + `suwu.term-record-inputs` go in the `settings` category; `suwu.term-recents` goes in `DENY` (transient, not user data) |

---

## 10. Files touched

**New**

- `frontend/src/lib/termInput.ts` — `consumeInput` line-buffer state machine
  (resumable escape parsing, `stale` trust rule) + `buildPayload`.
- `frontend/src/lib/termSnippets.ts` — `TermSnippet` / `RecentInput` types,
  limits, and the pure list transforms (`upsertSnippet`, `removeSnippet`,
  `markSnippetUsed`, `pushRecent`, `orderSnippets`, `matchesQuery`, …).
- `frontend/src/store/termSnippets.ts` — the three `atomWithStorage` atoms
  (localStorage ×2, sessionStorage ×1) and the scoping rationale.
- `frontend/src/components/hooks/useInputRecorder.ts` — second `onData`
  listener + `recordSent` (for `sendRaw` insertion) → recents atom; exposes
  `getCurrentLine()`.
- `frontend/src/components/term/SnippetMenu.tsx` — trigger + popover content
  (search, sections, footer, keyboard navigation).
- `frontend/src/components/term/SnippetManagerDialog.tsx` — the manager.
- `frontend/scripts/check-term-snippets.mjs` — Node test (`--experimental-strip-types`)
  over `termInput.ts` + `termSnippets.ts`: chunk parsing (Enter, backspace,
  Ctrl-U, arrows, split escape sequences, bracketed paste, the `stale` rule,
  >500 chars), `buildPayload` shapes, recents dedupe/cap/order, snippet
  upsert/delete/usage sort.

**Edited**

- `frontend/src/components/FullTerminal.tsx` — menu / manager state,
  `insertInput()`, recorder wiring, the status-bar trigger, the manager mount,
  focus handover.
- `frontend/src/components/icons.tsx` — `SnippetIcon`, `PencilIcon`.
- `frontend/src/locales/en.json`, `frontend/src/locales/zh_CN.json` — §8 keys.
- `frontend/src/lib/backup/registry.ts` — two `settings` entries, one `DENY`
  entry (the guard script fails the build otherwise).
- `frontend/package.json` — `check:term-snippets` script, appended to `check`
  (repo convention for `check-*.mjs`).
- (none in `useTermCopy.ts` — see the shortcut note in §11)

Not touched: any Go code, `router.tsx`, `wm/plugins/term.tsx`, `TermPage.tsx`,
the PTY WebSocket protocol, `TilingWM`.

---

## 11. Phases

**Phase 1 — store, recorder, menu (MVP)** — *done*
`termSnippets.ts`, `termInput.ts`, `useInputRecorder.ts`, `SnippetMenu`,
status-bar trigger, insert / insert-and-run, search, recents, delete from the
menu, i18n, backup registry, check script. Ships usable without the manager:
"+ Save current input" is the way to create a snippet.

**Phase 2 — manager dialog** — *done*
`SnippetManagerDialog` with add/edit/delete, record toggle, clear history,
"saved"/"deleted" toasts, and `✓` from the menu deep-linking into the editor.
No keyboard shortcut is added (see §11a).

**Phase 3 — polish (optional, only if asked)**
Per-row drag reorder; "run in a new tile" (needs WM IPC); a parent-page
shortcut that opens the focused pane's menu via a `term-snippets-toggle`
postMessage (mirrors `tile-font-size`); import/export JSON.

---

## 11a. No keyboard shortcut (decision)

`Alt+S` is already taken at the app level, and xterm allows exactly one
`attachCustomKeyEventHandler` per terminal (`useTermCopy` owns it for `Alt+C`),
so adding a pane-level binding would either collide or force a keymap refactor
for no user-visible gain. The feature is click-only: status-bar button → menu.
The `SnippetMenu` is still fully keyboard *navigable* once open (autofocused
search, `↑`/`↓`, `Enter`, `Esc`, `Tab`), so it is reachable with a mouse click
and then usable from the keyboard.

---

## 12. Verification

1. `pnpm --dir frontend typecheck`
2. `pnpm --dir frontend check` — biome, typography (all new text
   `text-sm`/`text-xs`/`text-[11px]`/`text-[10px]` only), backup registry,
   and the new `check-term-snippets`.
3. `pnpm test` (Go) stays green — nothing server-side changed.
4. Manual matrix, one header-docked and one bottom-docked layout:
   - trigger position is exactly left of copy mode and does not disturb the
     cached-char badge in selection mode;
   - popover grows upward and flips in a 12-row pane;
   - insert (no Enter) leaves the line editable; ⏎ runs; multi-line paste
     arrives as one bracketed paste;
   - reload keeps snippets, drops recents after the tab closes;
   - second pane sees the same list without a reload;
   - disconnected pane → toast, menu stays open;
   - `zh_CN` labels render without overflow.
