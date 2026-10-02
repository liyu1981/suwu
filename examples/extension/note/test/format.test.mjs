/**
 * Note — format tests: the "Saved 2 min ago" clock and the plain-text export.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { relativeTime, savedLabel, toPlainText } from "../public/format.js";
import { makeLine, makeNote } from "../public/model.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 2, 4, 12, 0, 0);

test("relative time reads the way a person would say it", () => {
  assert.equal(relativeTime(0, NOW), "", "no timestamp, no label");
  assert.equal(relativeTime(NOW - 5 * 1000, NOW), "just now");
  assert.equal(relativeTime(NOW - 44 * 1000, NOW), "just now");
  assert.equal(relativeTime(NOW - MIN, NOW), "1 min");
  assert.equal(relativeTime(NOW - 12 * MIN, NOW), "12 min");
  assert.equal(relativeTime(NOW - HOUR, NOW), "1 hr");
  assert.equal(relativeTime(NOW - 5 * HOUR, NOW), "5 hr");
  assert.equal(relativeTime(NOW - DAY, NOW), "yesterday");
  assert.equal(relativeTime(NOW - 3 * DAY, NOW), "3 days");
  assert.equal(relativeTime(NOW - 40 * DAY, NOW), "Jan 23", "same year: month and day");
  assert.equal(
    relativeTime(NOW - 400 * DAY, NOW).includes(String(new Date(NOW - 400 * DAY).getFullYear())),
    true,
    "a different year carries the year",
  );
});

test("the resting status line is 'Saved <relative> ago'", () => {
  assert.equal(savedLabel(NOW, NOW), "Saved just now");
  assert.equal(savedLabel(NOW - 2 * MIN, NOW), "Saved 2 min ago");
  assert.equal(savedLabel(0, NOW), "");
});

test("plain text keeps the checklist markers and the indent", () => {
  const note = makeNote({
    l: [
      makeLine("milk", "todo"),
      makeLine("  eggs", "todo", 1),
      makeLine("  bread", "todo"),
      makeLine("a heading", "head"),
      makeLine("plain"),
    ],
  });
  assert.equal(toPlainText(note), ["- [ ] milk", "  - [x] eggs", "  - [ ] bread", "a heading", "plain"].join("\n"));
});
