/**
 * Note — editor (commands.js) tests. Zero dependencies.
 *
 * The Editor is pure with respect to the DOM: a fake sink records what the
 * textarea would have been told, so every command, caret move and undo step
 * is assertable without a browser.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Editor } from "../public/commands.js";
import { MAX_CHARS, MAX_DEPTH, SLOTS, emptyDoc, makeLine, makeNote, textOf } from "../public/model.js";

function harness(lines) {
  const writes = [];
  const statuses = [];
  const doc = emptyDoc();
  if (lines) doc.notes[0].l = lines;
  const editor = new Editor(doc, {
    setText(value, start, end) {
      writes.push({ value, start, end });
    },
    changed() {},
    commit() {},
    status(message) {
      statuses.push(message);
    },
    selection() {},
  });
  return { editor, writes, statuses, doc };
}

function type(editor, value, caret = value.length) {
  return editor.syncFromText(value, caret, caret);
}

test("checking a box flips the line and is one undo step", () => {
  const h = harness([makeLine("milk", "todo")]);
  assert.ok(h.editor.toggleCheck(0));
  assert.equal(h.editor.note().l[0].c, 1);
  assert.ok(h.editor.toggleCheck(0));
  assert.equal(h.editor.note().l[0].c, 0);
  h.editor.toggleCheck(0);
  assert.equal(h.editor.note().l[0].c, 1);
  assert.ok(h.editor.undo());
  assert.equal(h.editor.note().l[0].c, 0);
  assert.ok(h.editor.redo());
  assert.equal(h.editor.note().l[0].c, 1);
});

test("only checklist lines can be checked", () => {
  const h = harness([makeLine("milk")]);
  assert.equal(h.editor.toggleCheck(0), false);
  assert.equal(h.editor.toggleCheck(9), false);
});

test("kinds toggle, and leaving a checklist clears the checked flag", () => {
  const h = harness([makeLine("milk")]);
  assert.equal(h.editor.activeKind(), "para");
  h.editor.toggleKindAtCaret("todo");
  assert.equal(h.editor.activeKind(), "todo");
  h.editor.toggleCheck(0);
  h.editor.toggleKindAtCaret("head");
  assert.equal(h.editor.activeKind(), "head");
  assert.equal(h.editor.note().l[0].c, 0);
  h.editor.toggleKindAtCaret("head");
  assert.equal(h.editor.activeKind(), "para", "pressing the active style leaves it");
});

test("Tab indents the caret's line and moves the caret with the text", () => {
  const h = harness([makeLine("milk"), makeLine("eggs")]);
  type(h.editor, "milk\neggs", 9);
  assert.ok(h.editor.canIndent());
  assert.ok(!h.editor.canOutdent());
  h.editor.indent();
  assert.equal(h.editor.text(), "milk\n  eggs");
  assert.equal(h.editor.sel.start, 11);
  assert.ok(h.editor.canOutdent());
  h.editor.outdent();
  assert.equal(h.editor.text(), "milk\neggs");
  assert.equal(h.editor.sel.start, 9);
});

test("indent stops at MAX_DEPTH and outdent stops at zero", () => {
  const deep = Array.from({ length: MAX_DEPTH }, () => "  ").join("") + "milk";
  const h = harness([makeLine(deep)]);
  type(h.editor, deep, deep.length);
  assert.equal(h.editor.canIndent(), false);
  assert.equal(h.editor.indent(), false);
  assert.equal(h.editor.text(), deep);
  h.editor.outdent();
  assert.equal(h.editor.text(), "    milk");
  h.editor.outdent();
  h.editor.outdent();
  h.editor.outdent();
  assert.equal(h.editor.text(), "milk");
  assert.equal(h.editor.outdent(), false, "nothing left to outdent");
});

test("Enter continues a checklist, carrying the indent", () => {
  const h = harness([makeLine("  milk", "todo")]);
  type(h.editor, "  milk", 6);
  assert.ok(h.editor.insertLineBreak());
  assert.equal(h.editor.text(), "  milk\n  ");
  assert.equal(h.editor.sel.start, 9);
  assert.equal(h.editor.note().l.length, 2);
  assert.equal(h.editor.note().l[1].k, "todo", "the new line continues the list");
  assert.equal(h.editor.note().l[1].c, 0, "a new item starts unchecked");
  assert.equal(h.editor.text().split("\n")[1], "  ");
});

test("Enter on an empty item leaves the list instead of adding one", () => {
  const h = harness([makeLine("  milk", "todo"), makeLine("  ", "todo")]);
  type(h.editor, "  milk\n  ", 8);
  assert.ok(h.editor.insertLineBreak());
  assert.equal(h.editor.text(), "  milk\n");
  assert.equal(h.editor.activeKind(), "para");
  assert.equal(h.editor.note().l.length, 2, "no third line");
});

test("Enter after a heading leaves a paragraph behind", () => {
  const h = harness([makeLine("Title", "head")]);
  type(h.editor, "Title", 5);
  h.editor.insertLineBreak();
  assert.equal(h.editor.note().l[1].k, "para");
});

test("Enter in the middle splits the item and the tail is unchecked", () => {
  const h = harness([makeLine("milk eggs", "todo", 1)]);
  type(h.editor, "milk eggs", 5);
  h.editor.insertLineBreak();
  assert.equal(h.editor.text(), "milk \neggs", "the split point keeps the space on the left");
  assert.equal(h.editor.note().l[1].k, "todo");
  assert.equal(h.editor.note().l[1].c, 0);
});

test("Backspace at the start removes the marker, then the indent, then joins", () => {
  const h = harness([makeLine("milk", "todo")]);
  type(h.editor, "milk", 0);
  assert.equal(h.editor.backspaceStructural(), true, "the checklist marker goes first");
  assert.equal(h.editor.activeKind(), "para");
  assert.equal(h.editor.backspaceStructural(), false, "nothing left but the join");
});

test("Backspace at the start of an indented line outdents it", () => {
  const h = harness([makeLine("  milk", "todo")]);
  type(h.editor, "  milk", 0);
  assert.equal(h.editor.backspaceStructural(), true, "marker first");
  assert.equal(h.editor.backspaceStructural(), true, "then the indent");
  assert.equal(h.editor.text(), "milk");
  assert.equal(h.editor.backspaceStructural(), false);
});

test("Backspace mid-line is left to the browser", () => {
  const h = harness([makeLine("milk")]);
  type(h.editor, "milk", 2);
  assert.equal(h.editor.backspaceStructural(), false);
});

test("Backspace anywhere in an empty item leaves the list", () => {
  const h = harness([makeLine("milk", "todo"), makeLine("  ", "todo")]);
  type(h.editor, "milk\n  ", 7);
  assert.ok(h.editor.backspaceStructural(), "the caret is at the end, not the start");
  assert.equal(h.editor.text(), "milk\n");
  assert.equal(h.editor.activeKind(), "para");
  assert.equal(h.editor.backspaceStructural(), false, "a paragraph has nothing to strip");
});

test("a selection is deleted before anything structural happens", () => {
  const h = harness([makeLine("milk")]);
  type(h.editor, "milk eggs", 9);
  h.editor.setSelection(0, 5);
  assert.ok(h.editor.deleteSelection());
  assert.equal(h.editor.text(), "eggs");
  assert.equal(h.editor.sel.start, 0);
});

test("marks toggle on a selection and clear when applied twice", () => {
  const h = harness([makeLine("buy milk")]);
  type(h.editor, "buy milk", 8);
  h.editor.setSelection(0, 3);
  assert.ok(h.editor.toggleMark("b"));
  assert.deepEqual(h.editor.note().l[0].m, [[0, 3, "b"]]);
  assert.equal(h.editor.activeMarks().b, true);
  assert.equal(h.editor.activeMarks().i, false);
  h.editor.toggleMark("b");
  assert.deepEqual(h.editor.note().l[0].m, []);
});

test("a mark straddles lines and stays clipped to the text", () => {
  const h = harness([makeLine("milk"), makeLine("eggs")]);
  type(h.editor, "milk\neggs", 8);
  h.editor.setSelection(2, 6);
  h.editor.toggleMark("i");
  assert.deepEqual(h.editor.note().l[0].m, [[2, 4, "i"]], "clipped to the end of its line");
  assert.deepEqual(h.editor.note().l[1].m, [[5, 6, "i"]], "the second line starts at offset 5");
});

test("a mark with no selection does nothing", () => {
  const h = harness([makeLine("milk")]);
  type(h.editor, "milk", 2);
  assert.equal(h.editor.toggleMark("b"), false);
  assert.deepEqual(h.editor.note().l[0].m, []);
});

test("typing carries a mark along with the caret", () => {
  const h = harness([makeLine("milk")]);
  type(h.editor, "milk", 4);
  h.editor.setSelection(0, 4);
  h.editor.toggleMark("b");
  type(h.editor, "milkk", 5);
  assert.deepEqual(h.editor.note().l[0].m, [[0, 4, "b"]], "typed past the end, run unchanged");
  type(h.editor, "milk", 4);
  type(h.editor, "mXilk", 2);
  assert.deepEqual(h.editor.note().l[0].m, [[0, 5, "b"]], "typed inside, run grows");
});

test("a list marker typed at the start of a paragraph becomes the item", () => {
  const h = harness([makeLine("")]);
  type(h.editor, "- [ ] ", 6);
  assert.ok(h.editor.consumeMarker("todo", 6));
  assert.equal(h.editor.text(), "");
  assert.equal(h.editor.activeKind(), "todo");
  assert.equal(h.editor.sel.start, 0);
});

test("a heading marker is consumed too", () => {
  const h = harness([makeLine("")]);
  type(h.editor, "## ", 3);
  assert.ok(h.editor.consumeMarker("head", 3));
  assert.equal(h.editor.text(), "");
  assert.equal(h.editor.activeKind(), "head");
});

test("a dash typed on an empty checklist item nests it", () => {
  const h = harness([makeLine("  ", "todo")]);
  type(h.editor, "  - ", 4);
  assert.ok(h.editor.nestMarker(4));
  assert.equal(h.editor.text(), "  ", "the marker is consumed, the indent grows");
  assert.equal(h.editor.note().l[0].k, "todo");
  assert.equal(h.editor.sel.start, 2);
  const full = "      milk";
  const h2 = harness([makeLine(full, "todo")]);
  type(h2.editor, full, full.length);
  assert.equal(h2.editor.nestMarker(full.length), false, "no deeper than MAX_DEPTH");
});

test("typing coalesces into one undo entry, structural edits do not", () => {
  const h = harness([makeLine("")]);
  type(h.editor, "m", 1);
  type(h.editor, "mi", 2);
  type(h.editor, "mil", 3);
  h.editor.setSelection(0, 3);
  h.editor.toggleMark("b");
  h.editor.breakUndoGroup();
  type(h.editor, "milk", 4);
  assert.ok(h.editor.undo());
  assert.equal(h.editor.text(), "mil", "the typing group is one step");
  assert.deepEqual(h.editor.note().l[0].m, [[0, 3, "b"]], "and the mark survived it");
  assert.ok(h.editor.undo());
  assert.deepEqual(h.editor.note().l[0].m, [], "the mark is its own step");
});

test("the undo stack is bounded", () => {
  const h = harness([makeLine("x", "todo")]);
  for (let i = 0; i < 140; i++) {
    h.editor.breakUndoGroup();
    h.editor.toggleCheck(0);
  }
  let steps = 0;
  while (h.editor.undo()) steps++;
  assert.equal(steps, 100, "cap at 100 entries");
});

test("over the character cap the edit is refused, not the model lost", () => {
  const h = harness([makeLine("")]);
  assert.equal(type(h.editor, "x".repeat(MAX_CHARS + 1), MAX_CHARS + 1), false);
  assert.equal(h.editor.text(), "");
  assert.equal(type(h.editor, "x".repeat(10), 10), true);
});

test("switching slots saves the caret and lands on an empty line", () => {
  const h = harness([makeLine("milk")]);
  type(h.editor, "milk", 4);
  assert.equal(h.editor.active, 0);
  h.editor.select(4);
  assert.equal(h.editor.active, 4);
  assert.equal(h.editor.text(), "");
  assert.equal(h.editor.sel.start, 0);
  h.editor.select(99);
  assert.equal(h.editor.active, SLOTS - 1, "clamped");
});

test("every note keeps its own text", () => {
  const doc = emptyDoc();
  doc.notes[2].l = [makeLine("second", "todo", 1)];
  const editor = new Editor(doc, {});
  assert.equal(textOf(editor.doc.notes[2]), "second");
  editor.select(2);
  assert.equal(editor.text(), "second");
  assert.equal(editor.note().l[0].c, 1);
  assert.equal(textOf(editor.doc.notes[0]), "", "the other slots are untouched");
  assert.equal(makeNote({ l: [makeLine("")] }).l.length, 1);
});
