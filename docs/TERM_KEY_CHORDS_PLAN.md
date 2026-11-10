# Terminal Key Combinations — Plan

Status: **implemented**.
Owner area: `frontend/src/lib/keyChords.ts`,
`frontend/src/store/termKeyChords.ts`,
`frontend/src/components/term/KeyChordMenu.tsx`,
`frontend/src/components/FullTerminal.tsx`, `frontend/src/components/icons.tsx`,
`frontend/scripts/check-key-chords.mjs`

Companion: `docs/TERM_FREQUENT_INPUTS_PLAN.md` (same status bar, same glass
popover, same "click-only, no shortcut" stance).
Skills: `suwu-tile-plugin-design` (§11 type scale + material, iframe shell),
`apple-design` (direct manipulation, feedback over explanation).

---

## 1. The problem

A browser is a hostile keyboard host for a terminal:

| Combination | What happens today |
|---|---|
| `Ctrl+Shift+A` | **Nothing.** xterm.js only maps `Ctrl+<letter>` when Shift is *not* held (`Keyboard.ts`), so the key is dropped entirely. |
| `Ctrl+W`, `Ctrl+T`, `Ctrl+N` | The browser acts first; the tile never sees them. |
| `Cmd`/`Meta` + anything | macOS window server / the browser claim it. |
| `Tab`, arrows, `F1…F12` inside a text field | Move focus or scroll instead of reaching the PTY. |
| `Alt+<key>` on macOS | Produces an accented character (a composition), not an escape. |

The tile therefore needs an explicit path: name the combination, and let the
tile send the bytes.

## 2. What was built

1. A **keyboard button** in the per-pane status bar, immediately **left of the
   "Frequent inputs" bolt** (the position the brief asked for).
2. It opens a **popover that grows upward** (the status bar is at the bottom
   edge, so a downward menu has nothing to grow into).
3. A **normal, fully editable text input**. It captures no keystrokes: arrows
   move the caret, Ctrl+A selects, Backspace deletes, IME works. Only Enter
   (send) and Escape (close) are claimed. An earlier cut captured modifier
   combinations to build the value, which made the field impossible to correct —
   that is gone.
4. A **pill mirror** makes the value readable. The field's text is tokenised
   (`displayTokens`) and drawn behind the input: known key names render as
   pills, everything else stays literal, so `ctrl+shift+a` reads
   `[ctrl] + [shift] + a` and `esc space b` reads `[esc] [space] b`. The input's
   own text is transparent with a visible caret; the mirror repeats the same
   characters and font metrics (no padding, no border — a `box-shadow` ring
   instead) so the caret from the real input lines up exactly.
5. A **chip row** that assembles the value: modifiers insert `ctrl+` / `shift+` /
   `alt+`, and every other key inserts its name plus a space — `esc `, `tab `,
   `enter `, `space `, `backspace `, `delete `, `insert `, arrows, `home`,
   `end`, `pgup`, `pgdn`, `f1`…`f12`. A modifier already in the current
   combination is not inserted twice, and insertion happens at the caret.
6. **Whitespace separates keys of a sequence.** `esc space b` sends Escape, then
   a space, then `b`; `ctrl+a` is one combination. Spaces *around* a `+` are
   folded first, because `ctrl + alt + a` is how people actually write it. Every
   part must be encodable, otherwise the send button is disabled with a reason.
7. **The bytes are shown per key**, in order — the honesty check for the
   `Ctrl+Shift+letter` collapse and for sequences.
8. **History** of the last 24 sends (localStorage, MRU, de-duplicated), stored as
   the canonical spec (`ctrl+a esc`), rendered with the same pills, one click
   re-sends, hover reveals a trash button.
9. **The user's text is never rewritten.** `a` stays `a` and sends `a`; `A`
   stays `A` and sends `A`; `space` is spelled out rather than drawn as an
   invisible character.

```
   (terminal content)
┌──────────────────────────────────────────────────────────────┐
│ ● Connected                       ⌨  ⌁  ⧉  ↻                 │  status bar (h-5)
│                        key  snippets copy reset              │
└──────────────────────────────────────────────────────────────┘

   ⌨ popover (grows upward)
   ┌──────────────────────────────────────────────┐
   │ [ctrl] + [shift] + a              [ Send ]   │  pills behind the input
   │ Bytes sent, per key:            ^A           │
   │ Ctrl Shift Alt Esc Tab Enter Space Del Ins …│  chips insert text
   │ RECENT                                       │
   │ [ctrl] + w                      ^W      🗑   │  click re-sends
   │ [esc] [space] b               ESC SP b  🗑   │
   └──────────────────────────────────────────────┘
```

## 3. Encoding rules## 3. Encoding rules (and why they look arbitrary)

`lib/keyChords.ts` mirrors **xterm.js' own keyboard map**
(`node_modules/@xterm/xterm/src/common/input/Keyboard.ts`) byte for byte, so a
combination sent from this menu is exactly what the same keys produce when the
browser does forward them — one dialect, not two.

- `Ctrl+<letter>` → `0x01…0x1A`. **`Ctrl+Shift+<letter>` collapses to the same
  code**: legacy encoding cannot express the distinction, so `Ctrl+Shift+A`
  sends `^A`. The byte preview shows it before it is sent.
- `Ctrl+3…Ctrl+8` → `ESC FS GS RS US DEL`, `Ctrl+2` → NUL, `Ctrl+[ \ ] ^ _` →
  `0x1B…0x1F`, `Ctrl+?` → DEL. These are key-position conventions, not ASCII —
  taken from xterm.
- `Alt` is an `ESC` prefix; `Shift+Tab` is `CSI Z`; arrows/Home/End honour
  `DECCKM` (`term.modes.applicationCursorKeysMode`); modified named keys use the
  `CSI 1;<n>` form with `n = 1 + shift(1) alt(2) ctrl(4)`.
- `Cmd`/`Meta` is **refused**, not guessed at.
- **Case is data, not decoration.** A single-character key keeps the case it was
  written in, because `a` and `A` are different bytes. For the `Ctrl+` forms the
  case disappears into the control code (`Ctrl+Alt+A` and `Ctrl+Alt+a` both send
  `ESC ^A`), which is what the byte preview is for: it shows the collapse instead
  of hiding it.
- `Space` is spelled out everywhere it appears (label `Space`, byte chip `SP`).

Known limitation, deliberately not solved here: apps that enabled the
Kitty keyboard protocol / `modifyOtherKeys` expect `CSI … u`, which xterm.js
does not produce for *any* keystroke either. Fixing it belongs on the server
(libghostty-vt 1.0 ships `ghostty_key_encoder_*` with
`ghostty_key_encoder_set_from_terminal`, i.e. an encoder that reads the real
terminal mode state) — see §8.

## 4. Why the chips write text instead of sending

Two designs were tried and rejected before this one:

1. A palette of whole combinations (`^C`, `^D`, `^W`) whose click sends the
   bytes. A click that *does* something to a running shell is a trigger to
   misfire, and no palette covers the combination the user actually wants.
2. A capture field that turned pressed combinations into text. Convenient right
   up to the moment something must be corrected — then the field swallows the
   very keystrokes needed to fix it (arrows, Ctrl+A, Backspace).

The shipped design is an **input assistant**: the chips write text, the field is
an ordinary input, and the pills make key names legible. It generalises to
anything the parser understands (`ctrl+shift+f5`, `alt+backspace`, `esc space
b`), and because the field is a real input, everything the browser does well —
selection, undo, IME, autocorrect-free typing — keeps working.

## 5. Sending path

```ts
term.input(bytes)   // xterm's public API: goes through onData
```

Going through `term.input` rather than `sendRaw` matters for the
frequent-inputs model: the second `onData` listener in `useInputRecorder` sees
the chord too. Control bytes leave the recorded line untouched (why the model
ignores other C0 controls), and escape sequences mark the line `stale`, so a
wrong command can never be saved and re-run from the shelf.

## 6. Reference: what a real terminal sends

Cross-checked against libghostty-vt 1.0's own key encoder
(`ghostty_key_encoder_encode`, driven from the embedded wasm in a throwaway
harness) so the menu is not inventing a dialect:

| Combination | libghostty-vt 1.0 | `pkg session` menu |
|---|---|---|
| `Ctrl+a` | `0x01` | `0x01` |
| `Ctrl+Alt+a` | `0x1b 0x01` | `0x1b 0x01` |
| `Ctrl+Shift+a` | `0x01` | `0x01` |
| `Ctrl+Space` | `0x00` | `0x00` |
| `Alt+a` (encoder default: alt-prefix off) | `a` | `0x1b a` — xterm.js' behaviour, and what a terminal with alt-prefix on sends |
| `Shift+a` | `A` | `A` |
| `Ctrl+Alt+Shift+a` | `CSI 97;7u` (the kitty fallback) | `0x1b 0x01` — legacy only, see the limitation above |

## 7. Storage

| Key | Scope | Why |
|---|---|---|
| `suwu.term-key-chords` | localStorage, **in the backup allowlist** | A combination is a shortcut the user wrote on purpose — not captured text, so it cannot leak a secret. It is worth keeping across reloads and devices, unlike `suwu.term-recents` (sessionStorage, denied in backups). |

`scripts/check-backup-registry.mjs` enforces that the new key is registered.

## 8. Follow-ups

1. **Server-side encoding** for Kitty/modifyOtherKeys apps: a `key` control
   message `{type:'key', key:'a', mods:{ctrl:true,shift:true}}` encoded with
   libghostty-vt's key encoder and written to the PTY by the session. That would
   make `Ctrl+Shift+A` a *distinct* key for apps that asked for it. It needs a
   protocol addition, so it is deliberately out of scope for the browser-side
   menu.
2. Optional: chips for the printable ASCII set if anyone misses them; the field
   already types those, so they are deliberately absent.
3. Optional: a dedicated key for "send Esc" once `Esc` reliably closes the
   popover (today `Esc` closes, and `esc` must be typed to send the key).
