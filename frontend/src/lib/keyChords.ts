/**
 * Key-combination model for the terminal tile's "send a key" menu.
 *
 * Why it exists: a browser eats a lot of the combinations a terminal user
 * wants — `Ctrl+Shift+A` makes xterm.js send *nothing at all* (its keyboard
 * handler only maps `Ctrl+<letter>` when Shift is *not* held), `Ctrl+W` closes
 * the tab before the tile ever sees it, and on macOS the window server claims
 * anything with Cmd. So the tile offers an explicit path: write the combination
 * (`ctrl+shift+a`) — or assemble it from key chips — and the tile sends the
 * bytes a real terminal would. Nothing here listens to keydown for anything but
 * Enter/Escape: the field is a normal, fully editable text input, because a
 * field that swallows keystrokes cannot be corrected.
 *
 * Encoding deliberately mirrors xterm.js' own keyboard map
 * (`node_modules/@xterm/xterm/src/common/input/Keyboard.ts`) so that a
 * combination sent from this menu produces exactly what the same keys produce
 * when the browser *does* forward them — no third dialect to learn. Two
 * consequences worth knowing:
 *
 *   - `Ctrl+Shift+<letter>` collapses to the `Ctrl+<letter>` control code
 *     (`^A`), because legacy encoding has no way to express the distinction.
 *     Apps that enabled Kitty/modifyOtherKeys expect `CSI … u` instead; the
 *     browser terminal cannot produce those for any keystroke, so this menu is
 *     not the place to invent them.
 *   - `Cmd`/`Meta` combinations are refused rather than guessed at: the OS
 *     intercepts them and nothing meaningful reaches a terminal.
 *
 * This module is pure (no atoms, no DOM, no xterm) so
 * `scripts/check-key-chords.mjs` can exercise it under Node type stripping, the
 * same way the frequent-inputs model is tested.
 */

/** How many combinations the history keeps. */
export const CHORD_MAX = 24;

/** One remembered combination, most recent first in the list. */
export interface ChordEntry {
  /** Canonical text, e.g. `ctrl+shift+a`. */
  spec: string;
  /** Unix millis, used only to keep the order stable. */
  at: number;
}

/**
 * Fragments the menu writes into the input field, so a combination can be
 * *assembled* instead of typed: click `Ctrl`, type `c`, and the field reads
 * `ctrl+c`. This is the friendly path the palette exists for — the browser
 * cannot be asked to deliver `Ctrl+Shift+A` at all, and typing the whole text
 * by hand is busywork.
 *
 * A modifier carries its separator (`ctrl+`); every other key carries a
 * trailing space (`esc `), because whitespace separates the keys of a
 * *sequence*: clicking Esc then Space must read `esc space`, one key after the
 * other, not the nonsense word `escspace`.
 */
export interface InsertToken {
  /** Text inserted into the field. */
  fragment: string;
  /** Chip face: the key name, never translated. */
  label: string;
  /** A modifier chip, i.e. only ever used as a prefix of a combination. */
  modifier?: boolean;
}

export const INSERT_TOKENS: readonly InsertToken[] = [
  { fragment: 'ctrl+', label: 'Ctrl', modifier: true },
  { fragment: 'shift+', label: 'Shift', modifier: true },
  { fragment: 'alt+', label: 'Alt', modifier: true },
  { fragment: 'esc ', label: 'Esc' },
  { fragment: 'tab ', label: 'Tab' },
  { fragment: 'enter ', label: 'Enter' },
  { fragment: 'space ', label: 'Space' },
  { fragment: 'backspace ', label: 'Backspace' },
  { fragment: 'delete ', label: 'Del' },
  { fragment: 'insert ', label: 'Ins' },
  { fragment: 'up ', label: '↑' },
  { fragment: 'down ', label: '↓' },
  { fragment: 'left ', label: '←' },
  { fragment: 'right ', label: '→' },
  { fragment: 'home ', label: 'Home' },
  { fragment: 'end ', label: 'End' },
  { fragment: 'pageup ', label: 'PgUp' },
  { fragment: 'pagedown ', label: 'PgDn' },
  ...Array.from({ length: 12 }, (_, i) => ({
    fragment: `f${i + 1} `,
    label: `F${i + 1}`,
  })),
];

export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lower-case single character, or a name from NAMED_KEYS (`tab`, `f5`, …). */
  key: string;
}

export type ChordError = 'empty' | 'missing-key' | 'unknown-key' | 'meta' | 'unsupported';

export type ParseResult =
  | { ok: true; chord: Chord }
  | { ok: false; error: ChordError; token?: string };

const MODIFIERS: Record<string, 'ctrl' | 'alt' | 'shift' | 'meta'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
};

/** Names accepted in either the input field or a captured key event. */
const KEY_ALIASES: Record<string, string> = {
  return: 'enter',
  cr: 'enter',
  escape: 'esc',
  spacebar: 'space',
  spc: 'space',
  bs: 'backspace',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  'page-up': 'pageup',
  pgdn: 'pagedown',
  'page-down': 'pagedown',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};

/** Keys with a fixed escape sequence, plus their modifier form. */
interface NamedKey {
  plain: string;
  /** Application cursor keys mode (DECCKM) swaps the plain form. */
  app?: string;
  /** `n` is xterm's modifier code: 1 + shift(1) alt(2) ctrl(4) meta(8). */
  modded: (n: number) => string;
}

const CSI = '\x1b[';
const SS3 = '\x1bO';

const NAMED_KEYS: Record<string, NamedKey> = {
  up: { plain: `${CSI}A`, app: `${SS3}A`, modded: (n) => `${CSI}1;${n}A` },
  down: { plain: `${CSI}B`, app: `${SS3}B`, modded: (n) => `${CSI}1;${n}B` },
  right: { plain: `${CSI}C`, app: `${SS3}C`, modded: (n) => `${CSI}1;${n}C` },
  left: { plain: `${CSI}D`, app: `${SS3}D`, modded: (n) => `${CSI}1;${n}D` },
  home: { plain: `${CSI}H`, app: `${SS3}H`, modded: (n) => `${CSI}1;${n}H` },
  end: { plain: `${CSI}F`, app: `${SS3}F`, modded: (n) => `${CSI}1;${n}F` },
  insert: { plain: `${CSI}2~`, modded: (n) => `${CSI}2;${n}~` },
  delete: { plain: `${CSI}3~`, modded: (n) => `${CSI}3;${n}~` },
  pageup: { plain: `${CSI}5~`, modded: (n) => `${CSI}5;${n}~` },
  pagedown: { plain: `${CSI}6~`, modded: (n) => `${CSI}6;${n}~` },
  f1: { plain: `${SS3}P`, modded: (n) => `${CSI}1;${n}P` },
  f2: { plain: `${SS3}Q`, modded: (n) => `${CSI}1;${n}Q` },
  f3: { plain: `${SS3}R`, modded: (n) => `${CSI}1;${n}R` },
  f4: { plain: `${SS3}S`, modded: (n) => `${CSI}1;${n}S` },
  f5: { plain: `${CSI}15~`, modded: (n) => `${CSI}15;${n}~` },
  f6: { plain: `${CSI}17~`, modded: (n) => `${CSI}17;${n}~` },
  f7: { plain: `${CSI}18~`, modded: (n) => `${CSI}18;${n}~` },
  f8: { plain: `${CSI}19~`, modded: (n) => `${CSI}19;${n}~` },
  f9: { plain: `${CSI}20~`, modded: (n) => `${CSI}20;${n}~` },
  f10: { plain: `${CSI}21~`, modded: (n) => `${CSI}21;${n}~` },
  f11: { plain: `${CSI}23~`, modded: (n) => `${CSI}23;${n}~` },
  f12: { plain: `${CSI}24~`, modded: (n) => `${CSI}24;${n}~` },
};

/** US-layout symbols a bare Shift turns the key below into. */
const SHIFTED_SYMBOLS: Record<string, string> = {
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '`': '~',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
};

const NUL = '\x00';
const ESC = '\x1b';
const DEL = '\x7f';

/** Display name for a named key (`pageup` -> `PageUp`). */
const KEY_LABELS: Record<string, string> = {
  pageup: 'PageUp',
  pagedown: 'PageDown',
  backspace: 'Backspace',
  insert: 'Insert',
  delete: 'Delete',
  enter: 'Enter',
  esc: 'Esc',
  tab: 'Tab',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
};

/**
 * Parse the text form: `ctrl+shift+a`, `Alt+F5`, `esc`, `ctrl++`, `ctrl+ `.
 *
 * The key keeps the case it was written in: `a` sends `a`, `A` sends `A`.
 * Normalising one to the other would be the tool overruling the user — and in a
 * terminal the two are different bytes. A space is the Space key (and is
 * written out as `Space` in the label, because an invisible character in a
 * confirmation line is not a confirmation).
 */
export function parseChord(input: string): ParseResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'empty' };

  const tokens = raw.split('+').map((token) => token.trim());
  if (tokens.length > 1 && tokens[tokens.length - 1] === '') {
    // A trailing '+', or "ctrl++", names the plus key itself.
    tokens.pop();
    tokens.push('+');
  }

  const chord: Chord = { ctrl: false, alt: false, shift: false, key: '' };
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (!lower) continue;
    const modifier = MODIFIERS[lower];
    if (modifier) {
      if (modifier === 'meta') return { ok: false, error: 'meta', token };
      chord[modifier] = true;
      continue;
    }
    // Exactly one key token: a second one is a typo ("ctrl+a+b", or a
    // mistyped modifier such as "hyper+space") and guessing which one the
    // user meant is how a surprise gets sent to a shell.
    if (chord.key) return { ok: false, error: 'unknown-key', token };
    // Aliases are lower-case words; a single character is kept verbatim so its
    // case survives into the bytes (and into the label).
    chord.key = KEY_ALIASES[lower] ?? (token.length === 1 ? token : lower);
  }

  if (!chord.key) return { ok: false, error: 'missing-key' };
  if (NAMED_KEYS[chord.key] || isSpecialKey(chord.key) || chord.key.length === 1) {
    return { ok: true, chord };
  }
  return { ok: false, error: 'unknown-key', token: chord.key };
}

/** Keys that encode without a table entry: tab, enter, esc, space, backspace. */
function isSpecialKey(key: string): boolean {
  return (
    key === 'tab' || key === 'enter' || key === 'esc' || key === 'space' || key === 'backspace'
  );
}

/**
 * One send can be a *sequence* of keys — `esc space b` types Escape, then a
 * space, then `b`. Parts are separated by whitespace; a part without a space is
 * a single combination. That rule is what lets the chips compose: a modifier
 * chip writes `ctrl+` and a key chip writes `esc `, so clicking Ctrl then Esc
 * reads `ctrl+esc` (one combination) while Esc then Space reads `esc space`
 * (two keys).
 */
export interface Sequence {
  chords: Chord[];
  /** Canonical text, e.g. `ctrl+a space`. This is what history stores. */
  spec: string;
}

export type SequenceResult =
  | { ok: true; sequence: Sequence }
  | { ok: false; error: ChordError; token?: string };

/**
 * Split a field into its parts: whitespace separates keys in a sequence.
 *
 * Spaces *around* a `+` are folded first, because people write `ctrl + a` as
 * naturally as `ctrl+a` — that is one combination, not three keys. Whitespace
 * anywhere else starts a new key.
 */
export function splitSequence(input: string): string[] {
  return input
    .replace(/\s*\+\s*/g, '+')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Parse a whole field: every whitespace-separated part must be a combination. */
export function parseSequence(input: string): SequenceResult {
  const parts = splitSequence(input);
  if (parts.length === 0) return { ok: false, error: 'empty' };
  const chords: Chord[] = [];
  for (const part of parts) {
    const result = parseChord(part);
    if (!result.ok) return result;
    chords.push(result.chord);
  }
  return { ok: true, sequence: { chords, spec: chords.map(chordSpec).join(' ') } };
}

export interface DisplayToken {
  /** Known key name, rendered as a pill. */
  pill?: string;
  /** Literal text (characters, `+`, words that are not keys). */
  text?: string;
  /**
   * A run of whitespace: the separator between the keys of a sequence. It is
   * drawn with an underline so the boundary is visible — an invisible separator
   * is how `ctrl+b` + `space` silently became the word `bspace`.
   */
  space?: boolean;
}

const DISPLAY_PILLS = new Set([
  'ctrl',
  'control',
  'shift',
  'alt',
  'opt',
  'option',
  'meta',
  'cmd',
  'command',
  'super',
  'win',
  'esc',
  'escape',
  'tab',
  'enter',
  'return',
  'space',
  'spacebar',
  'backspace',
  'bs',
  'delete',
  'del',
  'insert',
  'ins',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pgup',
  'pagedown',
  'pgdn',
  ...Object.keys(NAMED_KEYS),
]);

/**
 * Tokenise a field for display: known key names become pills, everything else
 * stays literal. Purely visual — the value of the field is still plain text, so
 * the input keeps native editing (arrows, selection, IME) and the pills are
 * drawn behind it.
 *
 * A pill's text is *not* rewritten (no `Ctrl` for `ctrl`): the mirror must keep
 * the exact character advance of the input underneath, or the caret drifts.
 */
export function displayTokens(input: string): DisplayToken[] {
  const tokens: DisplayToken[] = [];
  let literal = '';
  const flush = () => {
    if (literal) tokens.push({ text: literal });
    literal = '';
  };
  // Words are ASCII letters/digits; a pill is a whole word that names a key.
  for (const match of input.matchAll(/[A-Za-z][A-Za-z0-9]*|\s+|./gs)) {
    const word = match[0];
    if (/^\s/.test(word)) {
      flush();
      tokens.push({ space: true, text: word });
    } else if (/^[A-Za-z]/.test(word) && DISPLAY_PILLS.has(word.toLowerCase())) {
      flush();
      tokens.push({ pill: word });
    } else {
      literal += word;
    }
  }
  flush();
  return tokens;
}

/** Canonical text form, e.g. `ctrl+shift+a`. Stable input for `parseChord`. */
export function chordSpec(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('ctrl');
  if (chord.shift) parts.push('shift');
  if (chord.alt) parts.push('alt');
  if (chord.key) parts.push(chord.key);
  return parts.join('+');
}

/**
 * Human label, e.g. `Ctrl + Shift + a`.
 *
 * The key is shown as written, never upper-cased: `ctrl+alt+a` is `Ctrl + Alt +
 * a`, because a label that silently shouts has stopped being a confirmation of
 * what was typed. Keys with no printable face use their name — `Space`, `Tab`,
 * `PageUp` — since an invisible character in a label is worse than a word.
 */
export function chordLabel(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.shift) parts.push('Shift');
  if (chord.alt) parts.push('Alt');
  if (chord.key) {
    const key = chord.key === ' ' ? 'space' : chord.key;
    parts.push(KEY_LABELS[key] ?? (key.length === 1 ? key : key.toUpperCase()));
  }
  return parts.join(' + ');
}

export interface EncodeOptions {
  /** `term.modes.applicationCursorKeysMode` — DECCKM swaps arrow/Home/End. */
  applicationCursorKeys?: boolean;
}

/**
 * Encode a chord to the bytes a terminal would receive, or throw a `ChordError`
 * when the combination has no legacy encoding.
 */
export function encodeChord(chord: Chord, options: EncodeOptions = {}): string {
  // A chord built by hand (or by an older build) may carry a literal space.
  if (chord.key === ' ') chord = { ...chord, key: 'space' };
  const n = 1 + (chord.shift ? 1 : 0) + (chord.alt ? 2 : 0) + (chord.ctrl ? 4 : 0);
  const named = NAMED_KEYS[chord.key];
  if (named) {
    if (n === 1) return options.applicationCursorKeys && named.app ? named.app : named.plain;
    return named.modded(n);
  }

  switch (chord.key) {
    case 'tab':
      // xterm: Shift+Tab is CBT; Ctrl/Alt+Tab stay a bare tab.
      return chord.shift ? `${CSI}Z` : '\t';
    case 'enter':
      return chord.alt ? `${ESC}\r` : '\r';
    case 'esc':
      return chord.alt ? `${ESC}${ESC}` : ESC;
    case 'space':
      if (chord.ctrl) return NUL;
      return chord.alt ? `${ESC} ` : ' ';
    case 'backspace': {
      const base = chord.ctrl ? '\b' : DEL;
      return chord.alt ? `${ESC}${base}` : base;
    }
    default:
      break;
  }

  if (chord.key.length !== 1) throw new Error('unsupported');
  const base = chord.shift ? shiftedSymbol(chord.key) : chord.key;

  if (chord.ctrl) {
    const control = controlBytes(chord.key, base);
    if (control === null) throw new Error('unsupported');
    return chord.alt ? `${ESC}${control}` : control;
  }
  return chord.alt ? `${ESC}${base}` : base;
}

/** US-layout Shift for a single character. */
function shiftedSymbol(char: string): string {
  if (char >= 'a' && char <= 'z') return char.toUpperCase();
  return SHIFTED_SYMBOLS[char] ?? char;
}

/**
 * Digits are a key-position convention, not a letter one: `Ctrl+3`..`Ctrl+8`
 * are ESC/FS/GS/RS/US/DEL in xterm (and VT100 lineage), which is also why
 * `Ctrl+2` is NUL (= `Ctrl+@`). Taken from xterm.js' keyCode table so the
 * menu and the keyboard agree.
 */
const CTRL_DIGITS: Record<string, string> = {
  '2': NUL,
  '3': ESC,
  '4': '\x1c',
  '5': '\x1d',
  '6': '\x1e',
  '7': '\x1f',
  '8': DEL,
};

/**
 * C0 code for `Ctrl+<char>`: letters fold by `code - 0x60`, then the ASCII rule
 * (`@ A-Z [ \ ] ^ _` → 0x00–0x1F), and `?` is DEL.
 */
function controlBytes(key: string, base: string): string | null {
  const digit = CTRL_DIGITS[key];
  if (digit) return digit;
  const code = base.charCodeAt(0);
  if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60);
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
  if (code === 0x3f) return DEL;
  return null;
}

/** Readable label for a whole sequence, e.g. `Ctrl + a · Space`. */
export function sequenceLabel(input: string): string {
  return splitSequence(input)
    .map((part) => {
      const result = parseChord(part);
      return result.ok ? chordLabel(result.chord) : part;
    })
    .join(' · ');
}

/**
 * Encode whatever the field holds. Each part is encoded on its own and the
 * results are concatenated, because a sequence is just keys sent in order.
 * Returns null when any part has no legacy encoding, so the UI can disable the
 * send button instead of sending half of it.
 */
export function encodeSequence(input: string, options: EncodeOptions = {}): string | null {
  const result = parseSequence(input);
  if (!result.ok) return null;
  let bytes = '';
  for (const chord of result.sequence.chords) {
    try {
      bytes += encodeChord(chord, options);
    } catch {
      return null;
    }
  }
  return bytes;
}

/** Encode one whitespace-separated part, for the per-part byte readout. */
export function encodePart(part: string, options: EncodeOptions = {}): string | null {
  const result = parseChord(part);
  if (!result.ok) return null;
  try {
    return encodeChord(result.chord, options);
  } catch {
    return null;
  }
}

/**
 * Printable form of a payload for the UI: `^A`, `ESC [ Z`, `a`.
 *
 * Showing the bytes next to the label is the honesty check for the
 * `Ctrl+Shift+letter` collapse above — the user sees `^A` before sending it.
 */
export function chordBytesLabel(bytes: string): string {
  let out = '';
  for (const char of bytes) {
    const code = char.charCodeAt(0);
    if (char === ESC) out += 'ESC ';
    else if (char === '\r') out += 'CR';
    else if (char === '\n') out += 'LF';
    else if (char === '\t') out += 'TAB';
    else if (char === DEL) out += 'DEL';
    else if (char === '\b') out += 'BS';
    else if (code < 0x20) out += `^${String.fromCharCode(code + 64)}`;
    else if (code === 0x20) out += 'SP';
    else out += char;
  }
  return out.trimEnd();
}

/** Remember a combination, most recent first, without duplicates. */
export function pushChord(
  list: ChordEntry[],
  spec: string,
  at: number,
  max = CHORD_MAX,
): ChordEntry[] {
  const rest = list.filter((entry) => entry.spec !== spec);
  return [{ spec, at }, ...rest].slice(0, Math.max(1, max));
}

export function removeChord(list: ChordEntry[], spec: string): ChordEntry[] {
  return list.filter((entry) => entry.spec !== spec);
}
