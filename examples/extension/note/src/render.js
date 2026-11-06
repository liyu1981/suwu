/**
 * Note — the painted clone.
 *
 * The <textarea> is the only input surface: its glyphs are transparent and a
 * sibling layer above it paints the same characters with the same font
 * metrics, so the browser wraps both identically and the caret can never drift
 * from the paint. Indentation is leading whitespace *in the text itself* (see
 * model.js) — that is what keeps the two layers in lockstep, and it is why a
 * line is one block in the paint layer: checkbox positions need no measuring.
 *
 * The checkbox spring is interruptible: re-targeting mid-flight keeps the
 * velocity, so a second press reverses from the current on-screen value
 * (apple-design §3–§4).
 *
 * Public file: never put secrets here (docs/EXTENSION_API_PLAN.md §2.8).
 */

import { INDENT, depthOf } from "./model.js";

/** Must equal --line-height in style.css. */
export const LINE_HEIGHT = 24;
const BOX = 15; // painted checkbox edge
const HIT = 25; // checkbox hit target (button box, incl. 5px transparent border)
const GAP = 6; // visible box → text gap; the rest of the button's 5px padding
  // makes up the difference, so the button sits at `indent − (BOX + GAP + 5)`.
const STRIKE_MS = 180;
const STRIKE_H = 1.5;

const MARK_CLASS = { b: "m-b", i: "m-i", u: "m-u", s: "m-s", c: "m-c" };

/** A damped spring on one scalar, driven by rAF and re-targetable. */
function createSpring(apply) {
  let value = 0;
  let target = 0;
  let velocity = 0;
  let raf = 0;
  let last = 0;

  function frame(now) {
    const dt = Math.min(0.034, Math.max(0.001, (now - last) / 1000));
    last = now;
    // response 0.3s, damping 0.8 — a light bounce, the apple-design default
    // for an interaction that carries momentum.
    const omega = (2 * Math.PI) / 0.3;
    const zeta = 0.8;
    const accel = -2 * zeta * omega * velocity - omega * omega * (value - target);
    velocity += accel * dt;
    value += velocity * dt;
    if (Math.abs(value - target) < 0.002 && Math.abs(velocity) < 0.02) {
      value = target;
      velocity = 0;
      apply(value);
      raf = 0;
      return;
    }
    apply(value);
    raf = requestAnimationFrame(frame);
  }

  return {
    to(next) {
      target = next;
      if (!raf) {
        last = typeof performance !== "undefined" ? performance.now() : Date.now();
        raf = requestAnimationFrame(frame);
      }
    },
    jump(next) {
      value = next;
      target = next;
      velocity = 0;
      apply(value);
    },
  };
}

export function createRenderer(els) {
  const { layer, paint, a11y, editor } = els;

  const measurer = document.createElement("span");
  measurer.className = "ln-t measurer";
  measurer.setAttribute("aria-hidden", "true");
  editor.appendChild(measurer);

  const indentCache = new Map();
  let paintCache = []; // { key, el, box, text }
  let a11yCache = [];
  let scrollTop = 0;
  let reduced = false;

  try {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced = mq.matches;
    if (mq.addEventListener) {
      mq.addEventListener("change", (e) => {
        reduced = e.matches;
      });
    }
  } catch {
    reduced = false;
  }

  /** Width of one indent level, measured in the real font. */
  function indentPx(depth) {
    if (indentCache.has(depth)) return indentCache.get(depth);
    measurer.textContent = " ".repeat(depth * INDENT.length);
    const w = measurer.getBoundingClientRect().width;
    indentCache.set(depth, w);
    return w;
  }

  function applyScroll() {
    layer.style.transform = `translate3d(0, ${-scrollTop}px, 0)`;
  }

  /**
   * Paint the line's text as one segment per uniform formatting run, so
   * overlapping marks (bold *and* italic over the same words) share a single
   * span with several classes instead of painting the text once per mark.
   */
  function paintText(parent, text, marks) {
    if (!marks || !marks.length) {
      parent.appendChild(document.createTextNode(text));
      return;
    }
    const points = new Set([0, text.length]);
    for (const [s, e] of marks) {
      points.add(Math.max(0, Math.min(text.length, s)));
      points.add(Math.max(0, Math.min(text.length, e)));
    }
    const edges = Array.from(points).sort((a, b) => a - b);
    for (let i = 0; i < edges.length - 1; i++) {
      const s = edges[i];
      const e = edges[i + 1];
      if (e <= s) continue;
      const classes = [];
      for (const [ms, me, kind] of marks) {
        if (ms <= s && me >= e && MARK_CLASS[kind]) classes.push(MARK_CLASS[kind]);
      }
      const chunk = text.slice(s, e);
      if (!classes.length) {
        parent.appendChild(document.createTextNode(chunk));
        continue;
      }
      const span = document.createElement("span");
      span.className = classes.join(" ");
      span.textContent = chunk;
      parent.appendChild(span);
    }
  }

  function makeBox(line, index) {
    const box = document.createElement("button");
    box.type = "button";
    box.className = "box";
    box.setAttribute("role", "checkbox");
    box.setAttribute("tabindex", "-1");
    box.dataset.i = String(index);
    const spring = createSpring((v) => box.style.setProperty("--p", String(v)));
    spring.jump(line.c ? 1 : 0);
    box._spring = spring;
    box._checked = Boolean(line.c);
    return box;
  }

  /**
   * The box lives in the editor's left gutter, immediately left of the text —
   * which is why the left offset is negative for an unindented item. --pad-l
   * must stay wide enough to hold the hit target (32px ≥ 26 + a margin).
   */
  function positionBox(box, line) {
    box.style.left = `${indentPx(depthOf(line.t)) - (BOX + GAP + 5)}px`;
    box.style.top = `${(LINE_HEIGHT - HIT) / 2}px`;
  }

  function boxLabel(line) {
    const text = line.t.slice(depthOf(line.t) * INDENT.length);
    return text || "Checklist item";
  }

  /**
   * The strikethrough a checked row gets. It is drawn as one bar per visual
   * row (from getClientRects, so wrapped lines are covered) and scales in
   * from the left; unchecking retracts it before the element goes away.
   */
  function updateStrike(el, textEl, line) {
    const bars = el._bars || [];
    if (!line.c) {
      el._checked = false;
      textEl.classList.remove("c-on");
      if (!bars.length) return;
      for (const bar of bars) {
        bar.style.transform = "scaleX(0)";
        window.setTimeout(() => bar.remove(), reduced ? 0 : STRIKE_MS);
      }
      el._bars = [];
      return;
    }

    const wasChecked = el._checked;
    el._checked = true;
    textEl.classList.add("c-on");
    for (const bar of bars) bar.remove();

    const host = el.getBoundingClientRect();
    const fresh = [];
    for (const r of textEl.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const bar = document.createElement("i");
      bar.className = "strike";
      bar.style.left = `${r.left - host.left}px`;
      bar.style.top = `${r.top - host.top + r.height / 2 - STRIKE_H / 2}px`;
      bar.style.width = `${r.width}px`;
      el.appendChild(bar);
      fresh.push(bar);
    }
    el._bars = fresh;

    if (wasChecked || reduced) {
      for (const bar of fresh) bar.style.transform = "scaleX(1)";
      return;
    }
    for (const bar of fresh) bar.style.transform = "scaleX(0)";
    requestAnimationFrame(() => {
      for (const bar of fresh) bar.style.transform = "scaleX(1)";
    });
  }

  function lineKey(line) {
    return `${line.k}|${line.c}|${line.t}|${line.m.map((m) => m.join(",")).join(";")}`;
  }

  function buildLine(line, index) {
    const el = document.createElement("div");
    el.className = line.k === "head" ? "ln head" : "ln";
    el.dataset.i = String(index);
    el._checked = Boolean(line.c);

    const textEl = document.createElement("span");
    textEl.className = "ln-t";
    paintText(textEl, line.t, line.k === "head" ? [] : line.m);
    if (line.c) textEl.classList.add("c-on");
    el.appendChild(textEl);

    let box = null;
    if (line.k === "todo") {
      box = makeBox(line, index);
      positionBox(box, line);
      el.appendChild(box);
    }
    el._text = textEl;
    el._box = box;
    return { key: lineKey(line), el, box, text: textEl };
  }

  /** The screen-reader mirror: same content, real list and checkbox roles. */
  function a11yLine(line, index) {
    const item = document.createElement("div");
    item.setAttribute("role", "listitem");
    item.dataset.i = String(index);
    if (line.k === "todo") {
      const box = document.createElement("span");
      box.className = "a11y-box";
      box.setAttribute("role", "checkbox");
      box.setAttribute("aria-checked", line.c ? "true" : "false");
      box.textContent = line.c ? "☑ " : "☐ ";
      item.appendChild(box);
    }
    const depth = depthOf(line.t);
    const text = document.createElement("span");
    text.className = "a11y-t";
    text.textContent = " ".repeat(depth * 2) + line.t.slice(depth * INDENT.length);
    item.appendChild(text);
    return { key: lineKey(line), el: item };
  }

  /**
   * Reconcile a container with a list of entries: reuse nodes by identity,
   * insert the new ones before the first stale node, drop the leftovers.
   * One pass over the DOM, no index bookkeeping that can desynchronize.
   */
  function syncNodes(parent, fresh) {
    let i = 0;
    let node = parent.firstChild;
    while (node) {
      if (i < fresh.length && node === fresh[i].el) {
        i++;
        node = node.nextSibling;
        continue;
      }
      if (i < fresh.length) {
        parent.insertBefore(fresh[i].el, node);
        i++;
        continue;
      }
      const next = node.nextSibling;
      parent.removeChild(node);
      node = next;
    }
    while (i < fresh.length) parent.appendChild(fresh[i++].el);
  }

  function renderPaint(lines) {
    const fresh = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const key = lineKey(line);
      const entry = paintCache[i];
      if (entry && entry.key === key) fresh.push(entry);
      else fresh.push(buildLine(line, i));
    }
    syncNodes(paint, fresh);
    paintCache = fresh;
    return fresh;
  }

  function renderA11y(lines) {
    const fresh = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const key = lineKey(line);
      const entry = a11yCache[i];
      if (entry && entry.key === key) fresh.push(entry);
      else fresh.push(a11yLine(line, i));
    }
    syncNodes(a11y, fresh);
    a11yCache = fresh;
  }

  /** Repaint the active note. Nodes are reused per index, so a keystroke rebuilds one line. */
  function render(doc) {
    const lines = doc.notes[doc.active].l;
    const fresh = renderPaint(lines);
    for (let i = 0; i < fresh.length; i++) {
      const line = lines[i];
      const entry = fresh[i];
      if (entry.box) {
        const checked = Boolean(line.c);
        entry.box.dataset.i = String(i);
        entry.box.setAttribute("aria-checked", checked ? "true" : "false");
        entry.box.setAttribute("aria-label", boxLabel(line));
        if (entry.box._checked !== checked) {
          entry.box._checked = checked;
          entry.box._spring.to(checked ? 1 : 0);
        }
        positionBox(entry.box, line);
      }
      updateStrike(entry.el, entry.text, line);
    }
    renderA11y(lines);
    applyScroll();
  }

  /** Pointer-down feedback on a box: answer the finger before release. */
  function pressBox(i) {
    const entry = paintCache[i];
    if (entry && entry.box) entry.box.classList.add("pressing");
  }

  function releaseBox(i) {
    const entry = paintCache[i];
    if (entry && entry.box) entry.box.classList.remove("pressing");
  }

  function setScroll(top) {
    scrollTop = top;
    applyScroll();
  }

  function destroy() {
    measurer.remove();
  }

  return {
    render,
    setScroll,
    pressBox,
    releaseBox,
    destroy,
    lineHeight: LINE_HEIGHT,
    boxSize: BOX,
    reducedMotion: () => reduced,
  };
}
