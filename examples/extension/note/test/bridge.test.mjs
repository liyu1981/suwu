/**
 * Note — the storage bridge's request routing.
 *
 * The page runs two bridges over one window: the browser store and the server
 * store. Both listen for `ext-store-result`, so a reply must only reach the
 * request that asked for it — otherwise a server read can "return" the cloud
 * preference object, the document fails to validate, and the note opens blank
 * (which is exactly what happened before request ids were shared and replies
 * were filtered by scope).
 *
 * `window` is stubbed: the module only touches it inside the factory.
 */

import test from "node:test";
import assert from "node:assert/strict";

const posted = [];
const listeners = [];
const parent = {
  postMessage(msg) {
    posted.push(msg);
  },
};
globalThis.window = {
  parent,
  addEventListener(type, fn) {
    if (type === "message") listeners.push(fn);
  },
};

const { MISSING, createBridge } = await import("../src/bridge.js");

/** Deliver a reply to every bridge listener, as the page would. */
function deliver(message) {
  const event = { source: parent, data: message };
  for (const fn of listeners) fn(event);
}

test("request ids are unique across bridges, not per bridge", async () => {
  posted.length = 0;
  const local = createBridge(parent);
  const server = createBridge(parent, { scope: "server" });
  const a = local.get("v2");
  const b = server.get("v2");
  assert.equal(posted.length, 2);
  assert.notEqual(posted[0].rid, posted[1].rid, "two bridges must not reuse rid 1");
  assert.equal(posted[0].scope, "local");
  assert.equal(posted[1].scope, "server");
  // Answer them out of order; each promise must get its own value.
  deliver({ type: "ext-store-result", rid: posted[1].rid, ok: true, value: "server doc", scope: "server" });
  deliver({ type: "ext-store-result", rid: posted[0].rid, ok: true, value: "local doc", scope: "local" });
  assert.equal(await b, "server doc");
  assert.equal(await a, "local doc");
});

test("a reply is only accepted for the scope that asked", async () => {
  posted.length = 0;
  const local = createBridge(parent);
  const server = createBridge(parent, { scope: "server" });
  const serverRead = server.get("v2");
  const localRead = local.get("cloud");
  const [serverMsg, localMsg] = posted;
  // A cloud-preference object aimed at the local bridge must not resolve the
  // server read, even if the rids were somehow equal.
  deliver({ type: "ext-store-result", rid: localMsg.rid, ok: true, value: { enabled: true }, scope: "local" });
  assert.deepEqual(await localRead, { enabled: true });
  deliver({ type: "ext-store-result", rid: serverMsg.rid, ok: true, value: { v: 2, notes: [] }, scope: "server" });
  assert.deepEqual(await serverRead, { v: 2, notes: [] });
});

test("a missing server record is its own answer, not an empty value", async () => {
  posted.length = 0;
  const server = createBridge(parent, { scope: "server" });
  const read = server.get("v2");
  deliver({ type: "ext-store-result", rid: posted[0].rid, ok: true, value: undefined, missing: true, scope: "server" });
  assert.equal(await read, MISSING);
});

test("a failed reply rejects with the host's error name", async () => {
  posted.length = 0;
  const server = createBridge(parent, { scope: "server" });
  const read = server.get("v2");
  deliver({ type: "ext-store-result", rid: posted[0].rid, ok: false, error: "ServerUnreachable", scope: "server" });
  await assert.rejects(read, (err) => err.name === "ServerUnreachable");
});

test("set sends the value and resolves on ok", async () => {
  posted.length = 0;
  const server = createBridge(parent, { scope: "server" });
  const write = server.set("v2", { v: 2 });
  assert.equal(posted[0].op, "set");
  assert.deepEqual(posted[0].value, { v: 2 });
  deliver({ type: "ext-store-result", rid: posted[0].rid, ok: true, scope: "server" });
  await write;
});
