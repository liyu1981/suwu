/**
 * Note — document model. Pure: no DOM, no globals.
 *
 * A note is a list of *lines*; a line is text plus a kind, a checked flag and
 * a list of mark ranges. Indentation is not a separate field: it is the
 * leading whitespace of the line text itself (`  ` per level). That is what
 * lets a plain <textarea> stay the only input surface — the painted clone
 * and the textarea hold the same characters, so the browser wraps them
 * identically and the caret can never drift from the paint (see render.js).
 *
 * Public file: never put secrets here (docs/EXTENSION_API_PLAN.md §2.8).
 */

export const RECORD = "v2";
export const LEGACY_RECORD = "v1";

/** Fixed slots, numbered 1..9 in the rail (was 7 in v1). */
export const SLOTS = 9;
/** Characters per note, summed over all lines. */
export const MAX_CHARS = 4000;
/** Lines per note. */
export const MAX_LINES = 500;
/** Indent levels; `INDENT` whitespace per level. */
export const MAX_DEPTH = 3;
export const INDENT = "  ";

/** Line kinds. Deliberately small: a checklist is the feature, not a word processor. */
export const KINDS = ["para", "todo", "head"];
/** Mark kinds: bold, italic, underline, strikethrough, monospace. */
export const MARKS = ["b", "i", "u", "s", "c"];

/** Paper colors, cycled by slot index. */
export const COLORS = {
  yellow: "#f7edc6",
  pink: "#f5dbe2",
  blue: "#d9e9f1",
  green: "#deecd4",
  orange: "#f8e2c9",
};
export const COLOR_ORDER = ["yellow", "pink", "blue", "green", "orange"];

export function colorForSlot(i) {
  return COLORS[COLOR_ORDER[((i % COLOR_ORDER.length) + COLOR_ORDER.length) % COLOR_ORDER.length]];
}

/** Palette name for a stored hex color, for the paper class. */
export function colorName(hex) {
  for (const name of COLOR_ORDER) {
    if (COLORS[name] === hex) return name;
  }
  return COLOR_ORDER[0];
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return n < lo ? lo : n > hi ? hi : n;
}

export function clampDepth(d) {
  return clampInt(d, 0, MAX_DEPTH, 0);
}

export function indentFor(depth) {
  return INDENT.repeat(clampDepth(depth));
}

/** Indent level of a raw line text (leading 2-space groups, capped). */
export function depthOf(text) {
  const max = MAX_DEPTH * INDENT.length;
  let n = 0;
  const s = String(text == null ? "" : text);
  while (n < max && s.charCodeAt(n) === 32) n++;
  return Math.floor(n / INDENT.length);
}

/** Indent level of a line, from its own text. */
export function depthOfLine(line) {
  return line ? depthOf(line.t) : 0;
}

/** The text with its leading indent removed — what a checkbox labels. */
export function labelOf(line) {
  return line ? line.t.slice(depthOf(line.t) * INDENT.length) : "";
}

// ---------------------------------------------------------------- marks

/**
 * Coerce arbitrary stored marks into the invariant form: [start, end, kind]
 * triples, integer offsets clamped to the line length, sorted, non-overlapping
 * and adjacent-merged per kind. Different kinds may overlap.
 */
export function normalizeMarks(marks, len) {
  const out = [];
  if (!Array.isArray(marks)) return out;
  const byKind = new Map();
  for (const r of marks) {
    if (!Array.isArray(r) || r.length !== 3) continue;
    const kind = r[2];
    if (typeof kind !== "string" || MARKS.indexOf(kind) < 0) continue;
    const s = clampInt(r[0], 0, len, 0);
    const e = clampInt(r[1], 0, len, 0);
    if (e <= s) continue;
    const list = byKind.get(kind);
    if (list) list.push([s, e]);
    else byKind.set(kind, [[s, e]]);
  }
  for (const kind of MARKS) {
    const list = (byKind.get(kind) || []).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = null;
    for (const range of list) {
      if (cur && range[0] <= cur[1]) {
        if (range[1] > cur[1]) cur[1] = range[1];
        continue;
      }
      if (cur) out.push([cur[0], cur[1], kind]);
      cur = [range[0], range[1]];
    }
    if (cur) out.push([cur[0], cur[1], kind]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : 1));
  return out;
}

/** Marks of one kind covering [a, b) exactly? */
export function rangeCovered(marks, kind, a, b) {
  if (b <= a) return true;
  let covered = 0;
  for (const m of marks) {
    if (m[2] !== kind) continue;
    const s = Math.max(a, m[0]);
    const e = Math.min(b, m[1]);
    if (e > s) covered += e - s;
  }
  return covered >= b - a;
}

function addRange(marks, kind, a, b) {
  if (b <= a) return marks;
  return marks.concat([[a, b, kind]]);
}

/** Remove [a, b) of one kind, splitting any range that straddles it. */
export function removeRange(marks, kind, a, b) {
  const out = [];
  for (const m of marks) {
    if (m[2] !== kind || b <= a || m[1] <= a || m[0] >= b) {
      out.push(m);
      continue;
    }
    if (m[0] < a) out.push([m[0], a, kind]);
    if (m[1] > b) out.push([b, m[1], kind]);
  }
  return out;
}

/** Add or remove [a, b) of one kind so the range ends up fully marked. */
export function applyMark(marks, kind, a, b, on) {
  return normalizeMarks(on ? addRange(marks, kind, a, b) : removeRange(marks, kind, a, b), Infinity);
}

/**
 * Where the single contiguous edit between two versions of one line sits.
 * Input events are almost always one insertion or one deletion, so the
 * common prefix/suffix is the edit.
 */
export function diffPoint(oldText, newText) {
  const a = String(oldText);
  const b = String(newText);
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (
    s < a.length - p &&
    s < b.length - p &&
    a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)
  ) {
    s++;
  }
  return { start: p, removed: a.length - p - s, inserted: b.length - p - s };
}

/**
 * Move marks across an edit. A caret strictly inside a run extends it; a
 * caret exactly at the run's start pushes the run right, and one exactly at
 * its end leaves it alone — so typing next to a bold word never silently
 * styles the new character. Unresolvable edits (multi-character replacements,
 * pastes across a run boundary) shift by position and let normalizeMarks trim.
 */
export function rebaseMarks(oldText, newText, marks) {
  const base = normalizeMarks(marks, oldText.length);
  const { start, removed, inserted } = diffPoint(oldText, newText);
  if (!removed && !inserted) return normalizeMarks(base, newText.length);
  const delta = inserted - removed;
  return normalizeMarks(
    base.map(([a, b, kind]) => [a >= start ? a + delta : a, b > start ? b + delta : b, kind]),
    newText.length,
  );
}

// ---------------------------------------------------------------- lines

export function makeLine(t, k, c, m) {
  const text = String(t == null ? "" : t);
  const kind = KINDS.indexOf(k) >= 0 ? k : "para";
  return {
    t: text,
    k: kind,
    c: kind === "todo" && c ? 1 : 0,
    m: normalizeMarks(m, text.length),
  };
}

export function cloneLine(line) {
  return { t: line.t, k: line.k, c: line.c, m: line.m.map((r) => [r[0], r[1], r[2]]) };
}

/** A stored value is a line if it is an object with string text, or a bare string. */
export function parseLine(raw) {
  if (typeof raw === "string") return makeLine(raw);
  if (!raw || typeof raw !== "object") return makeLine("");
  return makeLine(raw.t, raw.k, raw.c, raw.m);
}

export function makeNote(patch) {
  const p = patch || {};
  const raw = Array.isArray(p.l) && p.l.length ? p.l.slice(0, MAX_LINES) : [makeLine("")];
  const l = raw.map(parseLine);
  if (!l.length) l.push(makeLine(""));
  return { c: p.c || colorForSlot(0), u: Number.isFinite(p.u) ? Math.floor(p.u) : 0, l };
}

export function cloneNote(note) {
  return {
    c: note.c,
    u: note.u,
    l: note.l.map(cloneLine),
  };
}

export function cloneDoc(doc) {
  return { v: 2, active: doc.active, notes: doc.notes.map(cloneNote) };
}

export function textOf(note) {
  return note.l.map((l) => l.t).join("\n");
}

export function charsOf(note) {
  let n = 0;
  for (const l of note.l) n += l.t.length;
  return n;
}

/** Open / total checklist items in a note — what the chip badge shows. */
export function countTodos(note) {
  let open = 0;
  let total = 0;
  for (const l of note.l) {
    if (l.k !== "todo") continue;
    total++;
    if (!l.c) open++;
  }
  return { open, total, done: total - open };
}

/** Would this text fit the caps? */
export function fits(text) {
  const parts = String(text).split("\n");
  if (parts.length > MAX_LINES) return false;
  let n = 0;
  for (const p of parts) n += p.length;
  return n <= MAX_CHARS;
}

/**
 * Re-derive lines from a textarea value. Existing lines keep their kind,
 * checked flag and rebased marks; a line with no predecessor (the tail a
 * split or paste produced) inherits the previous line's kind but starts
 * unchecked and unmarked.
 */
export function linesFromText(text, prev) {
  const value = String(text == null ? "" : text);
  const parts = value.split("\n");
  const out = [];
  const before = Array.isArray(prev) ? prev : [];
  for (let i = 0; i < parts.length; i++) {
    const old = before[i];
    if (old) {
      out.push(makeLine(parts[i], old.k, old.c, rebaseMarks(old.t, parts[i], old.m)));
      continue;
    }
    const inherit = out[i - 1] || before[i - 1];
    out.push(makeLine(parts[i], inherit ? inherit.k : "para", 0, []));
  }
  return out;
}

// ------------------------------------------------- offsets and line spans

/** Offset of the first character of line `i` in `text`. */
export function lineOffsetOf(text, i) {
  const s = String(text);
  let line = 0;
  let off = 0;
  while (line < i && off <= s.length) {
    const nl = s.indexOf("\n", off);
    if (nl < 0) return s.length;
    off = nl + 1;
    line++;
  }
  return Math.min(off, s.length);
}

/** Index of the line containing `offset`. */
export function lineIndexOf(text, offset) {
  const s = String(text);
  const at = clampInt(offset, 0, s.length, 0);
  let line = 0;
  for (let i = 0; i < at; i++) if (s.charCodeAt(i) === 10) line++;
  return line;
}

/** Start offset (inclusive) and end offset (exclusive of the newline). */
export function lineSpanOf(text, i) {
  const s = String(text);
  const start = lineOffsetOf(s, i);
  const nl = s.indexOf("\n", start);
  const end = nl < 0 ? s.length : nl;
  return { start, end };
}

// ---------------------------------------------------------------- documents

export function emptyDoc() {
  const notes = [];
  for (let i = 0; i < SLOTS; i++) {
    notes.push(makeNote({ c: colorForSlot(i), u: 0, l: [makeLine("")] }));
  }
  return { v: 2, active: 0, notes };
}

const HEX = /^#[0-9a-f]{6}$/;

/**
 * Validate a stored record. Returns a fresh document, or null when the
 * record is unusable — the caller then starts clean rather than throwing on
 * user data (the v1 behavior).
 */
export function validate(raw) {
  if (!raw || raw.v !== 2 || !Array.isArray(raw.notes)) return null;
  const notes = [];
  for (let i = 0; i < SLOTS; i++) {
    const n = raw.notes[i];
    if (!n || typeof n !== "object") {
      notes.push(makeNote({ c: colorForSlot(i), u: 0, l: [makeLine("")] }));
      continue;
    }
    const color = typeof n.c === "string" && HEX.test(n.c) ? n.c : colorForSlot(i);
    notes.push(
      makeNote({ c: color, u: n.u, l: Array.isArray(n.l) && n.l.length ? n.l : [makeLine("")] }),
    );
  }
  return { v: 2, active: clampInt(raw.active, 0, SLOTS - 1, 0), notes };
}

/**
 * v1 → v2: seven strings become seven structured notes, slots 7 and 8 start
 * empty. Leading whitespace is trimmed (up to a full indent) so old text
 * cannot arrive as accidental nesting.
 */
export function migrateV1(raw) {
  const doc = emptyDoc();
  if (!raw || !Array.isArray(raw.texts)) return doc;
  for (let i = 0; i < SLOTS; i++) {
    const t = typeof raw.texts[i] === "string" ? raw.texts[i] : "";
    if (!t) continue;
    const parts = t.slice(0, MAX_CHARS).split("\n");
    doc.notes[i].l = parts
      .slice(0, MAX_LINES)
      .map((s) => makeLine(s.replace(/^ {1,6}/, "").slice(0, MAX_CHARS)));
  }
  doc.active = clampInt(raw.active, 0, SLOTS - 1, 0);
  return doc;
}
