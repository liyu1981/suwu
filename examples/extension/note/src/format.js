/**
 * Note — small pure helpers: relative time, plain-text export.
 *
 * Public file: never put secrets here (docs/EXTENSION_API_PLAN.md §2.8).
 */

import { depthOf, INDENT } from "./model.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now" | "1 min" | "12 min" | "1 hr" | "yesterday" | "Mar 4" */
export function relativeTime(ts, now = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = now - ts;
  if (d < 45 * 1000) return "just now";
  if (d < HOUR) return `${Math.max(1, Math.floor(d / MIN))} min`;
  if (d < DAY) return `${Math.floor(d / HOUR)} hr`;
  if (d < 2 * DAY) return "yesterday";
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} days`;
  const date = new Date(ts);
  const month = date.toLocaleDateString(undefined, { month: "short" });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return sameYear ? `${month} ${date.getDate()}` : `${month} ${date.getDate()}, ${date.getFullYear()}`;
}

/** The resting status line: "Saved just now", "Saved 2 min ago". */
export function savedLabel(ts, now = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const rel = relativeTime(ts, now);
  if (!rel) return "";
  return rel === "just now" ? "Saved just now" : `Saved ${rel} ago`;
}

/** The note as plain text: marks stripped, checklist markers restored. */
export function toPlainText(note) {
  return note.l
    .map((line) => {
      const depth = depthOf(line.t);
      if (line.k !== "todo") return line.t;
      const body = line.t.slice(depth * INDENT.length);
      return INDENT.repeat(depth) + (line.c ? "- [x] " : "- [ ] ") + body;
    })
    .join("\n");
}
