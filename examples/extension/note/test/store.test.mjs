/**
 * Note — store tests: the debounced writer, the v1 → v2 migration on load, and
 * the error paths. The transport is injected, so the bridge stays out of it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { LEGACY_RECORD, RECORD, SLOTS, emptyDoc, makeLine, textOf } from "../public/model.js";
import { createStore } from "../public/store.js";

function fakeTransport(initial = {}) {
  const data = new Map(Object.entries(initial));
  const writes = [];
  let failWith = null;
  return {
    data,
    writes,
    failNext(error) {
      failWith = error;
    },
    get(key) {
      if (failWith) {
        const err = failWith;
        failWith = null;
        return Promise.reject(err);
      }
      return Promise.resolve(data.has(key) ? data.get(key) : undefined);
    },
    set(key, value) {
      if (failWith) {
        const err = failWith;
        failWith = null;
        return Promise.reject(err);
      }
      writes.push({ key, value });
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

function opts(extra = {}) {
  return { delay: 0, ...extra };
}

test("load reads a v2 record and leaves v1 alone", async () => {
  const doc = emptyDoc();
  doc.notes[0].l = [makeLine("kept", "todo", 1)];
  doc.active = 3;
  const transport = fakeTransport({ [RECORD]: doc });
  const store = createStore(transport, opts());
  const loaded = await store.load();
  assert.equal(loaded.active, 3);
  assert.equal(textOf(loaded.notes[0]), "kept");
  assert.equal(transport.writes.length, 0, "nothing to migrate");
});

test("load migrates a v1 record, writes v2, and keeps v1 as the rollback path", async () => {
  const legacy = { active: 1, texts: ["one", "two", "", "", "", "", ""] };
  const transport = fakeTransport({ [LEGACY_RECORD]: legacy });
  const store = createStore(transport, opts());
  const loaded = await store.load();
  assert.equal(loaded.active, 1);
  assert.equal(loaded.notes.length, SLOTS);
  assert.equal(textOf(loaded.notes[0]), "one");
  assert.equal(textOf(loaded.notes[7]), "", "the two new slots start empty");
  assert.equal(transport.writes.length, 1);
  assert.equal(transport.writes[0].key, RECORD);
  assert.equal(transport.data.get(LEGACY_RECORD), legacy, "v1 is never overwritten");
});

test("a corrupt record is replaced, not thrown on", async () => {
  const transport = fakeTransport({ [RECORD]: { v: 2, notes: "nope" } });
  const errors = [];
  const store = createStore(transport, opts({ onError: (name) => errors.push(name) }));
  const loaded = await store.load();
  assert.equal(loaded.notes.length, SLOTS);
  assert.equal(textOf(loaded.notes[0]), "");
  assert.deepEqual(errors, []);
});

test("an unreachable store still yields a usable document", async () => {
  const transport = fakeTransport();
  transport.failNext(Object.assign(new Error("x"), { name: "NoParent" }));
  const errors = [];
  const store = createStore(transport, opts({ onError: (name) => errors.push(name) }));
  const loaded = await store.load();
  assert.equal(loaded.notes.length, SLOTS);
  assert.deepEqual(errors, ["NoParent"]);
});

test("a save reports a timestamp and clears the error state", async () => {
  const saved = [];
  const errors = [];
  const transport = fakeTransport();
  const store = createStore(transport, {
    delay: 0,
    now: () => 1234,
    onSaved: (ts) => saved.push(ts),
    onError: (name) => errors.push(name),
  });
  await store.scheduleSave(emptyDoc());
  assert.deepEqual(saved, [1234]);
  assert.deepEqual(errors, []);
});

test("rapid edits collapse into one write", async () => {
  const transport = fakeTransport();
  const store = createStore(transport, opts({ delay: 20 }));
  const a = emptyDoc();
  const b = emptyDoc();
  b.notes[0].l = [makeLine("later")];
  const first = store.scheduleSave(a);
  store.scheduleSave(a);
  await store.scheduleSave(b);
  await first;
  assert.equal(transport.writes.length, 1, "debounced into a single write");
  assert.equal(textOf(transport.writes[0].value.notes[0]), "later", "the last state wins");
});

test("flush writes immediately and drains the debounce", async () => {
  const transport = fakeTransport();
  const store = createStore(transport, opts({ delay: 50 }));
  const doc = emptyDoc();
  doc.notes[0].l = [makeLine("now")];
  store.scheduleSave(doc);
  await store.flush(doc);
  assert.equal(transport.writes.length, 1);
  assert.equal(textOf(transport.writes[0].value.notes[0]), "now");
});

test("a quota failure is reported by name and does not throw", async () => {
  const transport = fakeTransport();
  transport.failNext(Object.assign(new Error("full"), { name: "QuotaExceededError" }));
  const errors = [];
  const store = createStore(transport, opts({ onError: (name) => errors.push(name) }));
  await store.scheduleSave(emptyDoc());
  assert.deepEqual(errors, ["QuotaExceededError"]);
  // The next save still goes through and clears the state.
  await store.scheduleSave(emptyDoc());
  assert.equal(transport.writes.length, 1);
});
