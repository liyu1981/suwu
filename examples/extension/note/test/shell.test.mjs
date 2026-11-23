/**
 * Note — the render stub and the module must agree on the DOM.
 *
 * `index.js` is served by the gqjs sandbox (the shell), `src/main.js` is the
 * bundled module. They only meet through element ids, so a rename on one side is
 * a page that silently stops wiring a control — this test reads both files and
 * compares the ids the module looks up with the ones the shell declares.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const shell = readFileSync(new URL("index.js", root), "utf8");
const main = readFileSync(new URL("src/main.js", root), "utf8");

const declared = new Set([...shell.matchAll(/\bid="([a-z0-9-]+)"/g)].map((m) => m[1]));
const looked = [...main.matchAll(/getElementById\("([a-z0-9-]+)"\)/g)].map((m) => m[1]);

test("every element the module wires exists in the shell", () => {
  assert.ok(looked.length >= 8, `only ${looked.length} ids found in main.js`);
  for (const id of looked) {
    assert.ok(declared.has(id), `main.js looks up #${id}, which index.js does not declare`);
  }
});

test("the server switch and the merge prompt are in the shell", () => {
  for (const id of ["cloud", "ask", "ask-merge", "ask-ok", "ask-cancel", "foot"]) {
    assert.ok(declared.has(id), `the shell has no #${id}`);
  }
  // The prompt is off by default and starts hidden: the box only opens it.
  assert.match(shell, /id="ask"[^>]*\bhidden\b/, "the merge prompt must start hidden");
  assert.match(shell, /id="ask-merge">/, "the merge choice defaults to unchecked");
  assert.ok(
    !/id="ask-merge"[^>]*checked/.test(shell),
    "the merge choice must not be checked by default",
  );
});
