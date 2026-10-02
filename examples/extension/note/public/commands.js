/**
 * Note — editor core: the command surface, the caret, and the undo stack.
 *
 * Pure with respect to the DOM: the Editor owns a document and a selection,
 * and reports every change through an injected sink
 * ({ setText, changed, commit, status }). The <textarea> in note.js is the
 * input surface; this class is the only thing allowed to decide what the
 * document means.
 *
 * Public file: never put secrets here (docs/EXTENSION_API_PLAN.md §2.8).
 */

import {
  INDENT,
  KINDS,
  MARKS,
  MAX_DEPTH,
  MAX_LINES,
  SLOTS,
  applyMark,
  charsOf,
  cloneDoc,
  depthOf,
  fits,
  indentFor,
  lineIndexOf,
  lineSpanOf,
  linesFromText,
  rangeCovered,
  textOf,
} from "./model.js";

/** Typing coalesces into one undo entry after this much idle. */
const TYPING_COALESCE = 400;
const UNDO_LIMIT = 100;

/** Lines that start a new list item when typed at the start of a paragraph. */
const MARKER_RULES = [
  { re: /^(?:[-*+]\s+\[[ xX]\]\s+|\[[ xX]\]\s+|\[\]\s+)$/, kind: "todo" },
  { re: /^#{1,2}\s+$/, kind: "head" },
];

const NULL_SINK = { setText() {}, changed() {}, commit() {}, status() {}, selection() {} };

export class Editor {
  constructor(doc, sink) {
    this.doc = doc;
    // A partial sink is fine: the missing channels become no-ops.
    this.sink = Object.assign({}, NULL_SINK, sink || {});
    this.sel = { start: 0, end: 0 };
    this.scroll = 0;
    this._undo = [];
    this._redo = [];
    this._typing = false;
    this._typingTimer = null;
  }

  // ------------------------------------------------------------ reading

  get active() {
    return this.doc.active;
  }

  note() {
    return this.doc.notes[this.doc.active];
  }

  otherNotes() {
    return this.doc.notes;
  }

  text() {
    return textOf(this.note());
  }

  lineCount() {
    return this.note().l.length;
  }

  /** Index of the line the caret sits in. */
  caretLine() {
    return Math.min(lineIndexOf(this.text(), this.sel.start), this.lineCount() - 1);
  }

  /** Caret position collapsed to the start of the selection. */
  anchor() {
    return Math.min(this.sel.start, this.sel.end);
  }

  focus() {
    return Math.max(this.sel.start, this.sel.end);
  }

  hasSelection() {
    return this.anchor() !== this.focus();
  }

  // ------------------------------------------------------------ undo stack

  _snapshot() {
    return { doc: cloneDoc(this.doc), sel: { start: this.sel.start, end: this.sel.end }, scroll: this.scroll };
  }

  _push(entry) {
    this._undo.push(entry);
    if (this._undo.length > UNDO_LIMIT) this._undo.shift();
    this._redo.length = 0;
  }

  /** One undoable change: snapshot, mutate, report. */
  _change(label, fn, keepGroup) {
    if (!(keepGroup && this._typing)) this.breakUndoGroup();
    if (!(keepGroup && this._typing)) this._push(this._snapshot());
    fn();
    this._report(label);
  }

  canUndo() {
    return this._undo.length > 0;
  }

  canRedo() {
    return this._redo.length > 0;
  }

  undo() {
    const entry = this._undo.pop();
    if (!entry) return false;
    this.breakUndoGroup();
    this._redo.push(this._snapshot());
    this._restore(entry);
    return true;
  }

  redo() {
    const entry = this._redo.pop();
    if (!entry) return false;
    this.breakUndoGroup();
    this._undo.push(this._snapshot());
    this._restore(entry);
    return true;
  }

  _restore(entry) {
    this.doc = entry.doc;
    this.sel = { start: entry.sel.start, end: entry.sel.end };
    this.scroll = entry.scroll || 0;
    this._emit("undo");
  }

  /** End the current typing group (selection moved, arrow key, toolbar click). */
  breakUndoGroup() {
    if (this._typingTimer) clearTimeout(this._typingTimer);
    this._typingTimer = null;
    this._typing = false;
  }

  _groupTyping() {
    if (this._typing) {
      if (this._typingTimer) clearTimeout(this._typingTimer);
      this._typingTimer = setTimeout(() => this.breakUndoGroup(), TYPING_COALESCE);
      if (this._typingTimer && this._typingTimer.unref) this._typingTimer.unref();
      return;
    }
    this._push(this._snapshot());
    this._typing = true;
    this._typingTimer = setTimeout(() => this.breakUndoGroup(), TYPING_COALESCE);
    if (this._typingTimer && this._typingTimer.unref) this._typingTimer.unref();
  }

  // ------------------------------------------------------------ reporting

  touch() {
    this.note().u = Date.now();
  }

  _emit(label) {
    this.touch();
    this.sink.changed(this.doc, label);
    this.sink.commit(this.doc, label);
  }

  _report(label) {
    this._emit(label);
    this.sink.setText(this.text(), this.sel.start, this.sel.end);
  }

  setSelection(start, end) {
    const len = this.text().length;
    const s = Math.max(0, Math.min(len, start));
    const e = Math.max(0, Math.min(len, end === undefined ? s : end));
    if (s === this.sel.start && e === this.sel.end) return;
    this.sel = { start: s, end: e };
    this.sink.selection(this.sel, this.doc);
  }

  // ------------------------------------------------------------ text edits

  /** Adopting a textarea value from a keystroke, paste, or cut. */
  syncFromText(value, selStart, selEnd) {
    const next = String(value);
    if (next === this.text()) {
      if (selStart !== undefined) this.setSelection(selStart, selEnd);
      return true;
    }
    if (!fits(next)) return false;
    this._groupTyping();
    this.note().l = linesFromText(next, this.note().l);
    if (selStart !== undefined) this.sel = { start: selStart, end: selEnd === undefined ? selStart : selEnd };
    this.touch();
    this.sink.changed(this.doc, "type");
    this.sink.commit(this.doc, "type");
    return true;
  }

  /** Replace the whole note text (used by every structural command). */
  _setText(next, selStart, selEnd, label) {
    if (!fits(next)) {
      this.sink.status("Note is full.");
      return false;
    }
    this._change(label, () => {
      this.note().l = linesFromText(next, this.note().l);
      this.sel = { start: selStart, end: selEnd };
    });
    return true;
  }

  // ------------------------------------------------------------ commands

  /** Check / uncheck line `i`. Returns true when something changed. */
  toggleCheck(i) {
    const line = this.note().l[i];
    if (!line || line.k !== "todo") return false;
    this._change("check", () => {
      line.c = line.c ? 0 : 1;
    });
    return true;
  }

  toggleCheckAtCaret() {
    return this.toggleCheck(this.caretLine());
  }

  /** Switch a line's kind. */
  setKind(i, kind) {
    if (KINDS.indexOf(kind) < 0) return false;
    const line = this.note().l[i];
    if (!line || line.k === kind) return false;
    this._change("kind", () => {
      line.k = kind;
      if (kind !== "todo") line.c = 0;
    });
    return true;
  }

  toggleKindAtCaret(kind) {
    const i = this.caretLine();
    const line = this.note().l[i];
    if (!line) return false;
    return this.setKind(i, line.k === kind ? "para" : kind);
  }

  /** Indent the caret's line one level. Text is the source of truth for depth. */
  indent() {
    const text = this.text();
    const i = this.caretLine();
    const { start, end } = lineSpanOf(text, i);
    if (depthOf(text.slice(start, end)) >= MAX_DEPTH) return false;
    const next = text.slice(0, start) + INDENT + text.slice(start);
    return this._setText(next, this.sel.start + INDENT.length, this.sel.end + INDENT.length, "indent");
  }

  /** Outdent the caret's line one level. */
  outdent() {
    const text = this.text();
    const i = this.caretLine();
    const { start, end } = lineSpanOf(text, i);
    const body = text.slice(start, end);
    if (!body.startsWith(INDENT)) return false;
    const next = text.slice(0, start) + body.slice(INDENT.length) + text.slice(end);
    const at = Math.max(start, this.sel.start - INDENT.length);
    return this._setText(next, at, Math.max(at, this.sel.end - INDENT.length), "outdent");
  }

  /**
   * Enter. Splits the line, carries the indent, and continues a checklist —
   * or leaves the list when pressed on an empty item.
   */
  insertLineBreak() {
    const text = this.text();
    const a = this.anchor();
    const f = this.focus();
    const i = this.caretLine();
    const { start, end } = lineSpanOf(text, i);
    const body = text.slice(start, end);
    const line = this.note().l[i];
    const depth = depthOf(body);

    if (line && line.k === "todo" && body.slice(depth * INDENT.length) === "") {
      // Empty item: drop the marker, stay on the line (Apple's exit gesture).
      this.setKind(i, "para");
      const flat = text.slice(0, start) + body.slice(INDENT.length) + text.slice(end);
      if (flat !== text) this._setText(flat, Math.max(start, a - INDENT.length), Math.max(start, f - INDENT.length), "exit-list");
      else this.sink.setText(text, start, start);
      return true;
    }

    const head = text.slice(0, a);
    const tail = text.slice(f);
    const next = head + "\n" + indentFor(depth) + tail;
    const caret = a + 1 + depth * INDENT.length;
    if (next.split("\n").length > MAX_LINES) {
      this.sink.status("Note is full.");
      return false;
    }
    const ok = this._setText(next, caret, caret, "break");
    if (ok && line && line.k === "head") {
      // A heading is one line: the continuation is a paragraph.
      const fresh = this.note().l[i + 1];
      if (fresh) fresh.k = "para";
    }
    return ok;
  }

  /**
   * Backspace with a collapsed caret, before the browser gets a chance to
   * join lines: on an empty list item it leaves the list (Apple's gesture),
   * at the start of a line it removes the marker, then the indent. Returns
   * false when the native Backspace should run.
   */
  backspaceStructural() {
    const text = this.text();
    const a = this.anchor();
    const f = this.focus();
    if (a !== f) return false;
    const i = this.caretLine();
    const line = this.note().l[i];
    if (!line) return false;
    const { start, end } = lineSpanOf(text, i);
    const body = text.slice(start, end);
    const depth = depthOf(body);
    const hasMarker = line.k !== "para";

    if (hasMarker && body.slice(depth * INDENT.length) === "") {
      // Empty item: drop the marker (and the indent it was nested at).
      const flat = body.slice(INDENT.length);
      const next = text.slice(0, start) + flat + text.slice(end);
      const at = Math.max(start, a - (body.length - flat.length));
      if (!fits(next)) {
        this.sink.status("Note is full.");
        return true;
      }
      this._change("exit-list", () => {
        this.note().l = linesFromText(next, this.note().l);
        const fresh = this.note().l[i];
        if (fresh) {
          fresh.k = "para";
          fresh.c = 0;
        }
        this.sel = { start: at, end: at };
      });
      return true;
    }

    if (a !== start) return false;
    if (hasMarker) {
      this.setKind(i, "para");
      return true;
    }
    if (body.startsWith(INDENT)) {
      const next = text.slice(0, start) + body.slice(INDENT.length) + text.slice(end);
      return this._setText(next, start, f, "outdent");
    }
    return false;
  }

  /** Delete the selection, if any. Returns true when it did the work. */
  deleteSelection() {
    if (!this.hasSelection()) return false;
    const text = this.text();
    const a = this.anchor();
    const f = this.focus();
    const next = text.slice(0, a) + text.slice(f);
    return this._setText(next, a, a, "delete");
  }

  /**
   * Consume a list marker typed at the caret ("- [ ] " → todo, "## " → head).
   * Works on a paragraph and on a line that is already a list item, so a
   * habitual "- [ ] " never survives as literal text.
   */
  consumeMarker(kind, removeUpTo) {
    const i = this.caretLine();
    const note = this.note();
    const line = note.l[i];
    if (!line || removeUpTo <= 0) return false;
    const text = textOf(note);
    const { start, end } = lineSpanOf(text, i);
    const body = text.slice(start, end);
    const next = text.slice(0, start) + body.slice(removeUpTo) + text.slice(end);
    const at = Math.max(start, this.sel.start - removeUpTo);
    if (!fits(next)) {
      this.sink.status("Note is full.");
      return false;
    }
    this._change(
      "marker",
      () => {
        note.l = linesFromText(next, note.l);
        this.sel = { start: at, end: at };
        const fresh = note.l[i];
        if (fresh) {
          fresh.k = kind;
          if (kind !== "todo") fresh.c = 0;
        }
      },
      true,
    );
    return true;
  }

  /** A "-" typed at the start of a checklist item nests it (Apple Reminders). */
  nestMarker(removeUpTo) {
    const i = this.caretLine();
    const note = this.note();
    const line = note.l[i];
    if (!line || line.k !== "todo" || removeUpTo <= 0) return false;
    if (depthOf(line.t) >= MAX_DEPTH) return false;
    const text = textOf(note);
    const { start, end } = lineSpanOf(text, i);
    const body = text.slice(start, end);
    const next = text.slice(0, start) + INDENT + body.slice(removeUpTo) + text.slice(end);
    const at = Math.max(start + INDENT.length, this.sel.start - removeUpTo + INDENT.length);
    if (!fits(next)) {
      this.sink.status("Note is full.");
      return false;
    }
    this._change(
      "nest",
      () => {
        note.l = linesFromText(next, note.l);
        this.sel = { start: at, end: at };
      },
      true,
    );
    return true;
  }

  /** B / I / U / S / mono over the selection. */
  toggleMark(kind) {
    if (MARKS.indexOf(kind) < 0) return false;
    const a = this.anchor();
    const f = this.focus();
    if (a === f) return false;
    const text = this.text();
    const note = this.note();
    const first = lineIndexOf(text, a);
    const last = lineIndexOf(text, f - 1);
    // Direction: add unless the selection is already fully marked, so
    // pressing the same mark twice clears it (apple-design §16, familiarity).
    let add = false;
    for (let i = first; i <= last; i++) {
      const span = lineSpanOf(text, i);
      const s = Math.max(a, span.start);
      const e = Math.min(f, span.end);
      if (e <= s) continue;
      if (!rangeCovered(note.l[i].m, kind, s, e)) {
        add = true;
        break;
      }
    }
    this._change("mark", () => {
      for (let i = first; i <= last; i++) {
        const span = lineSpanOf(text, i);
        const s = Math.max(a, span.start);
        const e = Math.min(f, span.end);
        if (e <= s) continue;
        note.l[i].m = applyMark(note.l[i].m, kind, s, e, add);
      }
    });
    return true;
  }

  /** Which marks cover the caret / selection — what the toolbar reflects. */
  activeMarks() {
    const text = this.text();
    const note = this.note();
    const a = this.anchor();
    const f = Math.max(a + 1, this.focus());
    const first = lineIndexOf(text, a);
    const last = lineIndexOf(text, f - 1);
    const on = {};
    for (const kind of MARKS) {
      let all = true;
      let any = false;
      for (let i = first; i <= last && all; i++) {
        const span = lineSpanOf(text, i);
        const s = Math.max(a, span.start);
        const e = Math.min(f, span.end);
        if (e <= s) continue;
        any = true;
        if (!rangeCovered(note.l[i].m, kind, s, e)) all = false;
      }
      on[kind] = any && all;
    }
    return on;
  }

  /** The caret line's kind — what the toolbar's checklist/heading buttons reflect. */
  activeKind() {
    const line = this.note().l[this.caretLine()];
    return line ? line.k : "para";
  }

  /** Is the caret in a line that can be indented / outdented? */
  canIndent() {
    const text = this.text();
    const { start, end } = lineSpanOf(text, this.caretLine());
    return depthOf(text.slice(start, end)) < MAX_DEPTH;
  }

  canOutdent() {
    const text = this.text();
    const { start, end } = lineSpanOf(text, this.caretLine());
    return text.slice(start, end).startsWith(INDENT);
  }

  // ------------------------------------------------------------ slots

  select(i) {
    const idx = Math.max(0, Math.min(SLOTS - 1, i | 0));
    if (idx === this.doc.active) return;
    this._change("slot", () => {
      this.doc.active = idx;
      this.sel = { start: 0, end: 0 };
      this.scroll = 0;
    });
  }

  noteChars() {
    return charsOf(this.note());
  }

  destroy() {
    this.breakUndoGroup();
  }
}
