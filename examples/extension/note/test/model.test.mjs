/**
 * Note — model tests. Zero dependencies: `node --test examples/extension/note/test`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  INDENT,
  MAX_CHARS,
  MAX_DEPTH,
  MAX_LINES,
  SLOTS,
  applyMark,
  charsOf,
  colorForSlot,
  colorName,
  countTodos,
  depthOf,
  diffPoint,
  emptyDoc,
  fits,
  indentFor,
  labelOf,
  lineIndexOf,
  lineOffsetOf,
  lineSpanOf,
  linesFromText,
  makeLine,
  makeNote,
  migrateV1,
  normalizeMarks,
  rangeCovered,
  rebaseMarks,
  removeRange,
  textOf,
  validate,
  mergeDocs,
} from "../src/model.js";
/** Nine notes from nine first-line strings. */
function mkNotes(lines) {
  const notes = [];
  for (let i = 0; i < SLOTS; i++) {
    notes.push(makeNote({ c: colorForSlot(i), u: 0, l: [makeLine(lines[i] || "")] }));
  }
  return notes;
}


test("indent is leading whitespace, capped at MAX_DEPTH", () => {
  assert.equal(depthOf("plain"), 0);
  assert.equal(depthOf("  one"), 1);
  assert.equal(depthOf("      deep"), MAX_DEPTH);
  assert.equal(depthOf("          over"), MAX_DEPTH, "never deeper than the cap");
  assert.equal(indentFor(2), INDENT + INDENT);
  assert.equal(indentFor(99), indentFor(MAX_DEPTH));
  assert.equal(labelOf(makeLine("  Buy milk")), "Buy milk");
});

test("normalizeMarks clamps, sorts, merges, and drops nonsense", () => {
  const marks = normalizeMarks(
    [
      [4, 2, "b"],
      [0, 3, "b"],
      [3, 5, "b"],
      [-2, 2, "i"],
      [1, 1, "u"],
      [0, 3, "z"],
      "nope",
    ],
    10,
  );
  assert.deepEqual(marks, [
    [0, 2, "i"],
    [0, 5, "b"],
  ]);
  assert.deepEqual(normalizeMarks([[0, 99, "b"]], 4), [[0, 4, "b"]]);
  assert.deepEqual(normalizeMarks([[0, 2, "b"]], 0), [], "clipped to nothing");
});

test("marks of different kinds may overlap the same characters", () => {
  const marks = normalizeMarks(
    [
      [0, 4, "b"],
      [0, 4, "i"],
    ],
    6,
  );
  assert.equal(marks.length, 2);
  assert.ok(rangeCovered(marks, "b", 0, 4));
  assert.ok(rangeCovered(marks, "i", 0, 4));
  assert.ok(!rangeCovered(marks, "b", 0, 5));
});

test("removeRange splits a straddling run", () => {
  const marks = normalizeMarks([[0, 10, "b"]], 10);
  assert.deepEqual(removeRange(marks, "b", 4, 6), [
    [0, 4, "b"],
    [6, 10, "b"],
  ]);
  assert.deepEqual(applyMark(marks, "b", 2, 5, false), [
    [0, 2, "b"],
    [5, 10, "b"],
  ]);
  assert.deepEqual(applyMark(marks, "b", 2, 5, true), [[0, 10, "b"]]);
});

test("diffPoint finds the single edit between two line versions", () => {
  assert.deepEqual(diffPoint("buy milk", "buy milkk"), {
    start: 8,
    removed: 0,
    inserted: 1,
  });
  assert.deepEqual(diffPoint("buy milk", "buy mik"), { start: 6, removed: 1, inserted: 0 });
});

test("rebaseMarks extends a run when typing inside it, shifts it otherwise", () => {
  const bold = [[0, 4, "b"]];
  // Caret inside the run (offset 2): the new character joins the run.
  assert.deepEqual(rebaseMarks("bold", "boXld", bold), [[0, 5, "b"]]);
  // Caret after the run: the run moves with the text.
  assert.deepEqual(rebaseMarks("bold", "boldX", bold), [[0, 4, "b"]]);
  // Caret before the run.
  assert.deepEqual(rebaseMarks("bold", "Xbold", bold), [[1, 5, "b"]]);
  // Backspace inside the run shrinks it.
  assert.deepEqual(rebaseMarks("bold", "bod", bold), [[0, 3, "b"]]);
  // Deleting the whole run leaves nothing.
  assert.deepEqual(rebaseMarks("bold", "", bold), []);
});

test("linesFromText keeps structure and inherits kind for split lines", () => {
  const prev = [makeLine("milk", "todo", 1, []), makeLine("eggs")];
  const next = linesFromText("milk\neggs\ntea", prev);
  assert.equal(next.length, 3);
  assert.equal(next[0].k, "todo");
  assert.equal(next[0].c, 1);
  assert.equal(next[1].k, "para");
  assert.equal(next[2].k, "para", "a pasted tail inherits nothing to inherit");
  // A split of one item: the tail continues the list, unchecked.
  const split = linesFromText("milk\neggs", [makeLine("milk eggs", "todo", 1)]);
  assert.equal(split[1].k, "todo");
  assert.equal(split[1].c, 0);
});

test("line offsets, indexes and spans", () => {
  const text = "a\nbb\nccc";
  assert.equal(lineOffsetOf(text, 0), 0);
  assert.equal(lineOffsetOf(text, 1), 2);
  assert.equal(lineOffsetOf(text, 2), 5);
  assert.equal(lineOffsetOf(text, 9), text.length, "past the end clamps");
  assert.equal(lineIndexOf(text, 0), 0);
  assert.equal(lineIndexOf(text, 2), 1);
  assert.equal(lineIndexOf(text, 4), 1);
  assert.equal(lineIndexOf(text, 5), 2);
  assert.deepEqual(lineSpanOf(text, 1), { start: 2, end: 4 });
  assert.deepEqual(lineSpanOf(text, 2), { start: 5, end: 8 });
});

test("counts, caps and text round-trip", () => {
  const note = makeNote({ l: [makeLine("milk", "todo"), makeLine("eggs", "todo", 1), makeLine("note")] });
  assert.deepEqual(countTodos(note), { open: 1, total: 2, done: 1 });
  assert.equal(charsOf(note), 12);
  assert.equal(textOf(note), "milk\neggs\nnote");
  assert.ok(fits("short"));
  assert.ok(!fits("x".repeat(MAX_CHARS + 1)), "over the character cap");
  assert.ok(!fits(new Array(MAX_LINES + 2).fill("x").join("\n")), "over the line cap");
});

test("checked is a todo-only flag", () => {
  assert.equal(makeLine("x", "para", 1).c, 0);
  assert.equal(makeLine("x", "todo", 1).c, 1);
});

test("a fresh document is nine empty notes with distinct papers", () => {
  const doc = emptyDoc();
  assert.equal(doc.notes.length, SLOTS);
  assert.equal(textOf(doc.notes[0]), "");
  const colors = new Set(doc.notes.map((n) => n.c));
  assert.equal(colors.size, 5);
  assert.equal(colorName(doc.notes[3].c), "green");
  assert.equal(colorName("#123456"), "yellow", "unknown colors fall back");
});

test("validate accepts a good record and repairs a partial one", () => {
  const good = {
    v: 2,
    active: 4,
    notes: [{ c: "#d9e9f1", u: 5, l: [{ t: "hi", k: "todo", c: 1, m: [[0, 2, "b"]] }] }],
  };
  const doc = validate(good);
  assert.equal(doc.active, 4);
  assert.equal(doc.notes[0].c, "#d9e9f1");
  assert.deepEqual(doc.notes[0].l[0].m, [[0, 2, "b"]]);
  assert.equal(doc.notes[1].l.length, 1, "missing slots are filled");
  assert.equal(doc.notes[8].c, colorForSlot(8), "a bad color falls back to the slot's");

  assert.equal(validate(null), null);
  assert.equal(validate({ v: 1, texts: ["a"] }), null, "v1 is not a v2 record");
  assert.equal(validate({ v: 2, notes: "nope" }), null);
  assert.equal(validate({ v: 2, active: 99, notes: [] }).active, SLOTS - 1);
});

test("migrateV1 carries seven slots across and leaves 7 and 8 empty", () => {
  const doc = migrateV1({ active: 2, texts: ["one", "", "  three", "four\nlines", "", "", ""] });
  assert.equal(doc.active, 2);
  assert.equal(textOf(doc.notes[0]), "one");
  assert.equal(textOf(doc.notes[2]), "three", "leading whitespace is trimmed, not read as nesting");
  assert.equal(textOf(doc.notes[3]), "four\nlines");
  assert.equal(textOf(doc.notes[7]), "");
  assert.equal(doc.notes.length, SLOTS);
  assert.equal(migrateV1(null).notes.length, SLOTS);
  assert.equal(migrateV1({ texts: [] }).active, 0);
});

// ── per-slot timestamps and the server merge ───────────────────────────────
// Turning on "server" asks whether to merge; a merge must never replace a note
// somebody wrote with a blank one, and must not need a clock both sides agree
// on — per-slot edit times are enough.

test("validate keeps per-slot timestamps and defaults them to zero", () => {
  const doc = validate({ v: 2, active: 1, notes: [], at: [5, "7", -1, null] });
  assert.equal(doc.at.length, SLOTS);
  assert.deepEqual(doc.at.slice(0, 4), [5, 7, 0, 0]);
  assert.equal(validate({ v: 2, active: 0, notes: [] }).at[0], 0);
  assert.equal(emptyDoc().at.length, SLOTS);
});

test("merge keeps the newer side per slot", () => {
  const local = validate({
    v: 2,
    active: 2,
    notes: mkNotes(["local one", "local two", ""]),
    at: [100, 100, 0],
  });
  const server = validate({
    v: 2,
    active: 0,
    notes: mkNotes(["server one", "server two", "server three"]),
    at: [50, 150, 0],
  });
  const merged = mergeDocs(local, server);
  const texts = merged.notes.map((n) => n.l[0].t);
  assert.equal(texts[0], "local one", "the newer local slot wins");
  assert.equal(texts[1], "server two", "the newer server slot wins");
  assert.equal(texts[2], "server three", "an empty local slot never wins");
  assert.equal(merged.active, 2, "the active slot is the local one");
  assert.deepEqual(merged.at.slice(0, 3), [100, 150, 0]);
  assert.equal(merged.at.length, SLOTS);
});

test("merge prefers content over a blank when neither side has a timestamp", () => {
  const local = validate({ v: 2, active: 0, notes: mkNotes(["", "", ""]) });
  const server = validate({ v: 2, active: 0, notes: mkNotes(["from the server", "", ""]) });
  const merged = mergeDocs(local, server);
  assert.equal(merged.notes[0].l[0].t, "from the server");
  // A tie with content on both sides keeps the local note: the prompt exists to
  // protect what the user is looking at.
  const both = mergeDocs(
    validate({ v: 2, active: 0, notes: mkNotes(["mine", "", ""]) }),
    validate({ v: 2, active: 0, notes: mkNotes(["theirs", "", ""]) }),
  );
  assert.equal(both.notes[0].l[0].t, "mine");
});

test("merge never loses a checklist or a non-paragraph line", () => {
  const local = validate({ v: 2, active: 0, notes: mkNotes([""]) });
  const server = validate({ v: 2, active: 0, notes: [] });
  server.notes[0] = makeNote({
    c: colorForSlot(0),
    u: 0,
    l: [makeLine("buy milk", "todo", 1)],
  });
  const merged = mergeDocs(local, server);
  assert.equal(merged.notes[0].l[0].k, "todo");
  assert.equal(merged.notes[0].l[0].c, 1);
});

test("an unseen record merges to itself", () => {
  const doc = validate({ v: 2, active: 3, notes: mkNotes(["a", "b", "c"]), at: [1, 2, 3] });
  const merged = mergeDocs(doc, emptyDoc());
  assert.equal(merged.notes[0].l[0].t, "a");
  assert.equal(merged.active, 3);
});
