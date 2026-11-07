// Tests for the Bento host shim's decisions: what it routes where, and how it
// chunks an upload. The shim is a browser script, so this harness fakes the few
// globals it touches (window, fetch, URL, document) and loads it fresh per case.
//
// Run: node --test examples/extension/bento/test/host-shim.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "dist", "suwu-host.js");
const SRC = readFileSync(SHIM, "utf8");

/**
 * Load the shim with a fake browser. Returns the fake world so a test can
 * inspect what was posted and what the picker returned.
 */
function loadShim({ file = "/home/u/decks/Q3.bento.html", token = "tok" } = {}) {
  const calls = [];
  const downloads = [];
  const win = {
    __SUWU: { id: "bento", file, token, api: "/gqjs/api/bento/", static: "/gqjs/static/bento/" },
    localStorage: undefined,
    sessionStorage: undefined,
  };
  const world = {
    calls,
    downloads,
    posts: [],
    win,
  };

  // A controllable transport: tests flip `world.fail` to exercise error paths.
  const fakeFetch = (url, init) => {
    calls.push({ url, body: init.body });
    if (world.fail) {
      return Promise.resolve({
        ok: false,
        status: 413,
        text: () => Promise.resolve(JSON.stringify({ error: "document too large" })),
      });
    }
    world.posts.push({ url, body: init.body });
    const payload = JSON.stringify({ ok: true, bytes: init.body.length });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(payload),
    });
  };

  const doc = {
    createElement: () => ({ click() {}, remove() {}, set href(v) {}, set download(v) {} }),
    body: { appendChild() {} },
  };

  const fn = new Function(
    "window",
    "fetch",
    "document",
    "URL",
    "DOMException",
    "File",
    "Blob",
    `${SRC}\n return window;`,
  );
  const fakeURL = {
    createObjectURL: (blob) => {
      downloads.push(blob);
      return "blob:fake";
    },
    revokeObjectURL: () => {},
  };
  class FakeDOMException extends Error {
    constructor(message, name) {
      super(message);
      this.name = name;
    }
  }
  const fakeFile = class {
    constructor(parts, name) {
      this.name = name;
    }
  };
  const fakeBlob = class {
    constructor(parts) {
      this.parts = parts;
      this.text = () => Promise.resolve(parts.join(""));
    }
  };

  const returned = fn(win, fakeFetch, doc, fakeURL, FakeDOMException, fakeFile, fakeBlob);
  world.window = returned;
  return world;
}

test("announces no unbacked capabilities", () => {
  const w = loadShim();
  assert.deepEqual(w.window.__bentoHost.ops, []);
});

test("installs a memory storage fallback (the sandbox has none)", () => {
  const w = loadShim();
  // The fake window starts with `undefined` storage, which is what the sandbox
  // does when the property access throws; the shim must leave something usable.
  const store = w.window.localStorage;
  assert.ok(store, "localStorage should be replaced");
  store.setItem("a", "b");
  assert.equal(store.getItem("a"), "b");
  assert.equal(store.length >= 1, true);
});

test("in-place save writes to the opened deck", async () => {
  const w = loadShim();
  const handle = await w.window.showSaveFilePicker({ id: "bento-doc", suggestedName: "x.bento.html" });
  const writable = await handle.createWritable();
  await writable.write(new Blob(['<script type="application/bento+json" id="bento-doc">{}</script>']));
  await writable.close();

  assert.equal(w.posts.length, 1, "one part for a small document");
  const url = w.posts[0].url;
  assert.match(url, /^\/gqjs\/api\/bento\/save\?/);
  assert.match(url, /[?&]token=tok(&|$)/, "the scoped token must be a query parameter");
  assert.match(url, /file=%2Fhome%2Fu%2Fdecks%2FQ3.bento.html/);
  assert.match(url, /upload=/);
  assert.match(url, /index=0/);
  assert.match(url, /total=1/);
  assert.equal(w.downloads.length, 0, "in-place must not download");
});

test("a large document is uploaded in parts and never in one request", async () => {
  const w = loadShim();
  const handle = await w.window.showSaveFilePicker({ id: "bento-doc" });
  const writable = await handle.createWritable();
  const big = "x".repeat(512 * 1024 * 2 + 10); // just over two parts
  await writable.write(new Blob([big]));
  await writable.close();

  assert.equal(w.posts.length, 3, "expected three parts");
  for (const [i, p] of w.posts.entries()) {
    assert.ok(p.body.length <= 512 * 1024, `part ${i} exceeds the part size`);
    assert.match(p.url, new RegExp(`index=${i}`));
    assert.match(p.url, /total=3/);
  }
  const joined = w.posts.map((p) => p.body).join("");
  assert.equal(joined, big, "parts must reassemble byte-for-byte");
});

test("part splitting never breaks a surrogate pair", async () => {
  const w = loadShim();
  const handle = await w.window.showSaveFilePicker({ id: "bento-doc" });
  const writable = await handle.createWritable();
  // A 4-byte emoji (surrogate pair) placed exactly on a part boundary.
  const text = "a".repeat(512 * 1024 - 1) + "😀" + "b";
  await writable.write(new Blob([text]));
  await writable.close();

  const joined = w.posts.map((p) => p.body).join("");
  assert.equal(joined, text);
  for (const p of w.posts) {
    for (let i = 0; i < p.body.length; i++) {
      const c = p.body.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = p.body.charCodeAt(i + 1);
        assert.ok(next >= 0xdc00 && next <= 0xdfff, "a part starts or ends between a surrogate pair");
      }
    }
  }
});

test("save a copy targets a sibling file, never the open deck", async () => {
  const w = loadShim();
  const handle = await w.window.showSaveFilePicker({ id: "bento-copy", suggestedName: "Q3 copy.bento.html" });
  assert.equal(handle.name, "Q3.bento.html", "the handle names the open deck (upstream expects that)");
  const writable = await handle.createWritable();
  await writable.write(new Blob(["<html></html>"]));
  await writable.close();

  const url = w.posts[0].url;
  assert.match(url, /file=%2Fhome%2Fu%2Fdecks%2FQ3_copy\.bento\.html/);
  assert.doesNotMatch(url, /Q3\.bento\.html/, "a copy must not target the original");
});

test("share and backup exports download instead of writing", async () => {
  for (const id of ["bento-share", "bento-backup"]) {
    const w = loadShim();
    const handle = await w.window.showSaveFilePicker({ id, suggestedName: "share.bento.html" });
    const writable = await handle.createWritable();
    await writable.write(new Blob(["<html></html>"]));
    await writable.close();
    assert.equal(w.posts.length, 0, `${id} must not reach the server`);
    assert.equal(w.downloads.length, 1, `${id} should download`);
  }
});

test("in-place save without an opened file hands back a download", async () => {
  // A new deck opened from the shell has no directory to write into; the honest
  // outcome is a file the user can put somewhere and reopen in Suwu.
  const w = loadShim({ file: "" });
  const handle = await w.window.showSaveFilePicker({ id: "bento-doc", suggestedName: "Untitled.bento.html" });
  const writable = await handle.createWritable();
  await writable.write(new Blob(["<html></html>"]));
  await writable.close();
  assert.equal(w.posts.length, 0, "nothing to upload without a server file");
  assert.equal(w.downloads.length, 1, "the deck should download instead");
});

test("an upload error surfaces as a rejected close()", async () => {
  const w = loadShim();
  const handle = await w.window.showSaveFilePicker({ id: "bento-doc" });
  const writable = await handle.createWritable();
  w.fail = true; // the transport now answers 413
  await writable.write(new Blob(["<html></html>"]));
  await assert.rejects(() => writable.close(), /document too large/);
});
