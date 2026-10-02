/**
 * Note — boot: DOM wiring, input routing, chrome, persistence.
 *
 * Pure client: nothing leaves the browser. The document runs in a sandboxed
 * (opaque-origin) frame with no web storage of its own, so reads and writes go
 * over a scoped postMessage bridge to the trusted parent frame, which keeps
 * them in its IndexedDB under this extension's key namespace
 * (docs/EXTENSION_TILE_PLAN.md §4.8).
 *
 * The editing model lives in model.js (pure) and commands.js (pure); this file
 * only connects them to the DOM: a transparent <textarea> for input, the
 * painted clone from render.js for structure, the chip rail, the format bar,
 * and the "Saved 2 min ago" line.
 *
 * Public file: must never contain secrets (docs/EXTENSION_API_PLAN.md §2.8).
 */

import { createBridge } from "./bridge.js";
import { Editor } from "./commands.js";
import { savedLabel } from "./format.js";
import { MARKS, SLOTS, colorName, countTodos, emptyDoc, lineSpanOf } from "./model.js";
import { createRenderer } from "./render.js";
import { createStore } from "./store.js";

const TICK_MS = 15000; // how often "Saved 2 min ago" re-reads the clock
const SAVE_DELAY = 250; // debounce before a write goes to the bridge
const MARK_CMDS = { b: "b", i: "i", u: "u", s: "s", c: "c" };

/** Typed at the caret → a checklist item or a heading. */
const MARKER_RULES = [
  { kind: "todo", re: /^(?:[-*+]\s+\[[ xX]\]\s+|\[[ xX]\]\s+|\[\]\s+)$/ },
  { kind: "head", re: /^#{1,2}\s+$/ },
];
/** Typed at the start of a checklist item → nests it. */
const NEST_RULE = /^[-*+]\s+$/;
/** Firefox delivers ⌘B and friends as beforeinput types, not keystrokes. */
const FORMAT_INPUTS = {
  formatBold: "b",
  formatItalic: "i",
  formatUnderline: "u",
  formatStrikeThrough: "s",
  insertUnorderedList: "todo",
};

const els = {
  rail: document.getElementById("tabs"),
  postit: document.getElementById("postit"),
  editor: document.getElementById("editor"),
  layer: document.getElementById("layer"),
  paint: document.getElementById("paint"),
  a11y: document.getElementById("a11y"),
  input: document.getElementById("input"),
  status: document.getElementById("status"),
  bar: document.getElementById("bar"),
  hint: document.getElementById("hint"),
};

const input = els.input;
const buttons = Object.create(null);
const chips = [];

let store = null;
let editor = null;
let renderer = null;
let savedAt = 0;
let errorText = "";
let ticker = 0;
let ready = false;

// ---------------------------------------------------------------- status

function showStatus() {
  if (errorText) {
    els.status.textContent = errorText;
    els.status.classList.add("error");
    return;
  }
  els.status.classList.remove("error");
  els.status.textContent = savedAt ? savedLabel(savedAt) : "";
}

function startTicker() {
  if (ticker) return;
  ticker = window.setInterval(() => {
    if (!document.hidden) showStatus();
  }, TICK_MS);
}

function onSaved(ts) {
  savedAt = ts;
  errorText = "";
  showStatus();
  startTicker();
}

function onError(name) {
  errorText =
    name === "QuotaExceededError"
      ? "Storage full — changes may not be saved."
      : "Couldn't save changes.";
  showStatus();
}

/** A one-off message ("Note is full.") that the next successful save clears. */
function flash(message) {
  errorText = message;
  showStatus();
}

// ---------------------------------------------------------------- caret

/**
 * Focus the textarea without losing the caret: focusing an element that was
 * not focused can drop the selection to zero, which would make every toolbar
 * press act on the wrong line.
 */
function focusEditor() {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.focus();
  if (input.selectionStart !== start || input.selectionEnd !== end) {
    input.setSelectionRange(start, end);
  }
  editor.setSelection(start, end);
}

function syncCaret() {
  if (document.activeElement !== input) return;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  if (start === editor.sel.start && end === editor.sel.end) return;
  editor.setSelection(start, end);
  syncBar();
}

function keepCaretVisible() {
  const lh = renderer.lineHeight;
  const top = editor.caretLine() * lh;
  const view = input.clientHeight;
  if (top < input.scrollTop) input.scrollTop = top;
  else if (top + lh > input.scrollTop + view) input.scrollTop = Math.max(0, top + lh - view);
  editor.scroll = input.scrollTop;
  renderer.setScroll(input.scrollTop);
}

const sink = {
  setText(value, start, end) {
    if (input.value !== value) input.value = value;
    input.setSelectionRange(start, end);
    keepCaretVisible();
    syncBar();
  },
  changed() {
    renderer.render(editor.doc);
    paintChrome();
  },
  commit() {
    if (store) store.scheduleSave(editor.doc);
  },
  status(message) {
    flash(message);
  },
  selection() {
    syncBar();
  },
};

// ---------------------------------------------------------------- chrome

function buildRail() {
  for (let i = 0; i < SLOTS; i++) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tab";
    chip.dataset.i = String(i);
    chip.setAttribute("role", "tab");

    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(i + 1);

    const badge = document.createElement("span");
    badge.className = "badge";

    const prog = document.createElement("i");
    prog.className = "prog";

    chip.append(num, badge, prog);
    els.rail.appendChild(chip);
    chips.push(chip);
  }
}

function paintChrome() {
  const doc = editor.doc;
  els.postit.className = "postit color-" + colorName(doc.notes[doc.active].c);

  for (let i = 0; i < chips.length; i++) {
    const chip = chips[i];
    const counts = countTodos(doc.notes[i]);
    const selected = i === doc.active;
    chip.setAttribute("aria-selected", selected ? "true" : "false");
    chip.tabIndex = selected ? 0 : -1;
    chip.querySelector(".badge").textContent = counts.total ? String(counts.open) : "";
    chip.querySelector(".badge").hidden = !counts.total;
    const prog = chip.querySelector(".prog");
    prog.hidden = !counts.total;
    prog.style.transform = "scaleX(" + (counts.total ? counts.done / counts.total : 0) + ")";
    chip.setAttribute(
      "aria-label",
      "Note " + (i + 1) + (counts.total ? ", " + counts.open + " of " + counts.total + " items open" : ""),
    );
  }

  // The empty-state chip teaches the checklist, so it stays up while the note
  // is still blank — a box with no words is not blank, though.
  els.hint.hidden = !isBlank(editor.note());
  syncBar();
}

/** True while a note holds nothing but empty paragraphs. */
function isBlank(note) {
  if (note.l.some((l) => l.k !== "para")) return false;
  return editor.text().trim() === "";
}

function setPressed(button, on) {
  if (!button) return;
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.classList.toggle("on", Boolean(on));
}

function syncBar() {
  if (!editor) return;
  const kind = editor.activeKind();
  const marks = editor.activeMarks();
  setPressed(buttons.todo, kind === "todo");
  setPressed(buttons.head, kind === "head");
  for (const m of MARKS) setPressed(buttons[MARK_CMDS[m]], Boolean(marks[m]));
  if (buttons.indent) buttons.indent.disabled = !editor.canIndent();
  if (buttons.outdent) buttons.outdent.disabled = !editor.canOutdent();
}

// ---------------------------------------------------------------- commands

function runCommand(cmd) {
  editor.breakUndoGroup();
  switch (cmd) {
    case "todo":
    case "head":
      editor.toggleKindAtCaret(cmd);
      break;
    case "indent":
      editor.indent();
      break;
    case "outdent":
      editor.outdent();
      break;
    case "b":
    case "i":
    case "u":
    case "s":
    case "c":
      editor.toggleMark(cmd);
      break;
    case "undo":
      editor.undo();
      break;
    case "redo":
      editor.redo();
      break;
    default:
      return;
  }
  syncBar();
}

/** "- [ ] " and friends, typed at the start of a paragraph or a checklist item. */
function maybeConvertMarker() {
  if (editor.hasSelection()) return;
  const text = editor.text();
  const caret = editor.anchor();
  const i = editor.caretLine();
  const line = editor.note().l[i];
  if (!line) return;
  const { start, end } = lineSpanOf(text, i);
  const head = text.slice(start, end).slice(0, Math.max(0, caret - start));
  const indent = head.length - head.replace(/^ +/, "").length;
  const rest = head.slice(indent);

  if (line.k === "todo") {
    const m = rest.match(NEST_RULE);
    if (m) {
      editor.nestMarker(indent + m[0].length);
      return;
    }
  }
  for (const rule of MARKER_RULES) {
    const m = rest.match(rule.re);
    if (m) {
      editor.consumeMarker(rule.kind, indent + m[0].length);
      return;
    }
  }
}

// ---------------------------------------------------------------- input

function wireInput() {
  input.addEventListener("input", (e) => {
    if (!ready) return;
    const kept = editor.syncFromText(input.value, input.selectionStart, input.selectionEnd);
    if (!kept) {
      // Past the cap: put the last good value back rather than desync the model.
      input.value = editor.text();
      input.setSelectionRange(editor.sel.start, editor.sel.end);
      flash("Note is full.");
      return;
    }
    if (e.inputType === "insertText" || e.inputType === "insertCompositionText") {
      maybeConvertMarker();
    }
  });

  input.addEventListener("keydown", (e) => {
    if (!ready) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    if (mod && !e.altKey) {
      const plain = { b: "b", i: "i", u: "u" };
      if (!e.shiftKey && plain[key]) {
        e.preventDefault();
        editor.breakUndoGroup();
        editor.toggleMark(plain[key]);
        return;
      }
      const shifted = { x: "s", m: "c" };
      if (e.shiftKey && shifted[key]) {
        e.preventDefault();
        editor.breakUndoGroup();
        editor.toggleMark(shifted[key]);
        return;
      }
      if (e.shiftKey && (key === "h" || key === "c")) {
        e.preventDefault();
        runCommand(key === "h" ? "head" : "todo");
        return;
      }
      if (key === "z") {
        e.preventDefault();
        runCommand(e.shiftKey ? "redo" : "undo");
        return;
      }
    }

    if (e.key === "Tab") {
      e.preventDefault();
      editor.breakUndoGroup();
      if (e.shiftKey) editor.outdent();
      else editor.indent();
      return;
    }

    // Enter and Backspace are handled here rather than on beforeinput:
    // a keydown is the only event every engine reports, and an IME
    // composition must keep its own Return (isComposing).
    if (e.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey && !mod) {
      e.preventDefault();
      editor.breakUndoGroup();
      editor.insertLineBreak();
      return;
    }
    if (e.key === "Backspace" && !mod) {
      if (editor.backspaceStructural()) e.preventDefault();
      return;
    }

    // Any other navigation closes the typing group, so undo steps per gesture.
    if (/^(Arrow|Home|End|Page)/.test(e.key)) editor.breakUndoGroup();
  });

  // Firefox reports ⌘B/I/U as a beforeinput format type; Chrome and Safari
  // report the keystroke above. Handling both is belt and braces — whichever
  // arrives first cancels the other.
  input.addEventListener("beforeinput", (e) => {
    if (!ready) return;
    const kind = FORMAT_INPUTS[e.inputType];
    if (!kind) return;
    e.preventDefault();
    editor.breakUndoGroup();
    if (kind === "todo") editor.toggleKindAtCaret("todo");
    else editor.toggleMark(kind);
  });

  input.addEventListener("scroll", () => {
    editor.scroll = input.scrollTop;
    renderer.setScroll(input.scrollTop);
  });
  input.addEventListener("keyup", syncCaret);
  input.addEventListener("click", syncCaret);
  input.addEventListener("select", syncCaret);
  input.addEventListener("focus", syncBar);
  input.addEventListener("blur", () => editor.breakUndoGroup());
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === input) syncCaret();
  });
}

// ---------------------------------------------------------------- chrome wiring

function wireChrome() {
  els.rail.addEventListener("click", (e) => {
    const chip = e.target.closest(".tab");
    if (!chip) return;
    editor.breakUndoGroup();
    store.flush(editor.doc);
    editor.select(Number(chip.dataset.i));
    focusEditor();
  });

  els.rail.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const at = chips.indexOf(document.activeElement);
    if (at < 0) return;
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = chips[(at + step + chips.length) % chips.length];
    e.preventDefault();
    editor.breakUndoGroup();
    store.flush(editor.doc);
    editor.select(Number(next.dataset.i));
    focusEditor();
    next.focus();
  });

  for (const button of els.bar.querySelectorAll(".tb")) {
    buttons[button.dataset.cmd] = button;
  }

  // One delegated handler for the format bar and the empty-state chip.
  els.postit.addEventListener("click", (e) => {
    const button = e.target.closest("[data-cmd]");
    if (!button || !els.postit.contains(button)) return;
    e.preventDefault();
    focusEditor();
    runCommand(button.dataset.cmd);
  });

  els.bar.addEventListener("pointerdown", (e) => {
    const button = e.target.closest(".tb");
    if (button) button.classList.add("pressing");
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    els.bar.addEventListener(type, () => {
      for (const b of els.bar.querySelectorAll(".pressing")) b.classList.remove("pressing");
    });
  }

  // Checkboxes live in the paint layer, above the textarea: pointer events
  // reach them, and the press is answered on pointer-down (apple-design §1)
  // while the model flips on release.
  const paint = els.paint;
  paint.addEventListener("pointerdown", (e) => {
    const box = e.target.closest(".box");
    if (box) renderer.pressBox(Number(box.dataset.i));
  });
  const release = (e) => {
    const box = e.target.closest(".box");
    if (box) renderer.releaseBox(Number(box.dataset.i));
  };
  paint.addEventListener("pointerup", release);
  paint.addEventListener("pointercancel", release);
  paint.addEventListener("click", (e) => {
    const box = e.target.closest(".box");
    if (!box) return;
    e.preventDefault();
    editor.breakUndoGroup();
    editor.toggleCheck(Number(box.dataset.i));
  });

  // Best-effort flush when the page goes away; the postMessage is queued on
  // the parent at dispatch time, so it survives the child's teardown.
  const flush = () => {
    if (store && editor) store.flush(editor.doc);
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flush();
  });
}

function wireLayout() {
  if (typeof ResizeObserver !== "function") return;
  // The rail is 9 × 26px + 8 × 6px = 282px; the bar needs ~300px, ~240px tall.
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      document.body.classList.toggle("compact-rail", width < 300);
      document.body.classList.toggle("compact-bar", width < 300 || height < 240);
      document.body.classList.toggle("tiny", height < 160);
    }
  });
  ro.observe(document.body);
}

// ---------------------------------------------------------------- boot

function boot(doc) {
  editor = new Editor(doc, sink);
  renderer = createRenderer(els);
  buildRail();

  input.readOnly = false;
  input.value = editor.text();
  input.setSelectionRange(0, 0);

  wireInput();
  wireChrome();
  wireLayout();
  ready = true;

  renderer.render(editor.doc);
  paintChrome();
  showStatus();
}

store = createStore(createBridge(window.parent), { delay: SAVE_DELAY, onSaved, onError });
store
  .load()
  .then((doc) => boot(doc || emptyDoc()))
  .catch(() => boot(emptyDoc()));
