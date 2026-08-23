import assert from "node:assert/strict";
import { createMessageListener } from "../js/lib/message-handler-registry.js";

const calls = [];
const errors = [];
const listener = createMessageListener([
  {
    type: "status",
    mode: "sync",
    validate: (message) => message.type === "status",
    handle: () => ({ ok: true }),
    failure: { ok: false }
  },
  {
    type: "move",
    mode: "async",
    validate: (message) => Number.isInteger(message.tabId),
    handle: async (message) => {
      calls.push(message.tabId);
      return { ok: true, tabId: message.tabId };
    },
    failure: { ok: false, reason: "invalid-or-failed" }
  },
  {
    type: "reject",
    mode: "async",
    validate: () => true,
    handle: async () => { throw new Error("private failure"); },
    failure: { ok: false }
  }
], {
  fallback: (message, _sender, sendResponse) => {
    if (message?.type !== "fallback") return false;
    sendResponse({ fallback: true });
    return true;
  },
  onError: (error, type) => errors.push([type, error.message])
});

const invoke = (message, sender = {}) => new Promise((resolve) => {
  let keepAlive;
  keepAlive = listener(message, sender, (response) => {
    queueMicrotask(() => resolve({ keepAlive, response }));
  });
  if (!keepAlive && message?.type === "unknown") {
    queueMicrotask(() => resolve({ keepAlive, response: undefined }));
  }
});

let syncResponse;
const syncKeepAlive = listener({ type: "status" }, {}, (response) => { syncResponse = response; });
assert.equal(syncKeepAlive, false);
assert.deepEqual(syncResponse, { ok: true });

const moved = await invoke({ type: "move", tabId: 7 });
assert.equal(moved.keepAlive, true);
assert.deepEqual(moved.response, { ok: true, tabId: 7 });
assert.deepEqual(calls, [7]);

const invalid = await invoke({ type: "move", tabId: "7" });
assert.equal(invalid.keepAlive, true);
assert.deepEqual(invalid.response, { ok: false, reason: "invalid-or-failed" });
assert.deepEqual(calls, [7], "an invalid message must not invoke its effect");

const rejected = await invoke({ type: "reject" });
assert.equal(rejected.keepAlive, true);
assert.deepEqual(rejected.response, { ok: false });
assert.deepEqual(errors, [["reject", "private failure"]]);

const fallback = await invoke({ type: "fallback" });
assert.equal(fallback.keepAlive, true);
assert.deepEqual(fallback.response, { fallback: true });
assert.deepEqual(await invoke({ type: "unknown" }), { keepAlive: false, response: undefined });

assert.throws(() => createMessageListener([
  { type: "same", mode: "sync", validate: () => true, handle: () => null, failure: null },
  { type: "same", mode: "sync", validate: () => true, handle: () => null, failure: null }
]), /Duplicate message handler/);
assert.throws(() => createMessageListener([
  { type: "broken", mode: "async", validate: null, handle: () => null, failure: null }
]), /Invalid message handler/);

console.log("PASS: typed message-handler registry");
