import assert from "node:assert/strict";
import { createMessageListener } from "../js/lib/message-handler-registry.js";
import { createOpenTabMessageHandlers } from
  "../js/background/open-tab-message-handlers.js";

const calls = [];
const errors = [];
let rejectGather = false;
const handlers = createOpenTabMessageHandlers({
  async moveOne(tabId, destination) {
    calls.push(["move-one", tabId, destination]);
  },
  async moveSet(tabIds, destination) {
    calls.push(["move-set", tabIds, destination]);
    return { ok: true, moved: tabIds.length, destination };
  },
  async sortWindow(windowId, mode) {
    calls.push(["sort", windowId, mode]);
    return { ok: true, moved: 2 };
  },
  async gatherDomain(domain) {
    calls.push(["gather", domain]);
    if (rejectGather) throw new Error("private gather failure");
    return { ok: true, moved: 3 };
  }
});

assert.equal(handlers.length, 5, "the Open-tab protocol owns exactly five routes");
assert.equal(new Set(handlers.map(({ type }) => type)).size, 5,
  "each Open-tab route has one unique message identity");

const listener = createMessageListener(handlers, {
  onError: (error, type) => errors.push([type, error.message])
});
const invoke = (message) => new Promise((resolve) => {
  let keepAlive;
  keepAlive = listener(message, {}, (response) => {
    queueMicrotask(() => resolve({ keepAlive, response }));
  });
});

assert.deepEqual(await invoke({
  type: "move-tab", tabId: 4, windowId: 8, index: -1
}), { keepAlive: true, response: { ok: true } });
assert.deepEqual(calls.at(-1), ["move-one", 4, { windowId: 8, index: -1 }],
  "the compatibility route preserves Chrome's append index");

const destination = { kind: "window", windowId: 9, index: 3 };
assert.deepEqual(await invoke({ type: "move-tabs", tabIds: [2, 5], destination }), {
  keepAlive: true,
  response: { ok: true, moved: 2, destination }
});
assert.deepEqual(calls.at(-1), ["move-set", [2, 5], destination]);

assert.deepEqual(await invoke({ type: "sort-window", windowId: 9, mode: "domain" }), {
  keepAlive: true,
  response: { ok: true, moved: 2 }
});
assert.deepEqual(calls.at(-1), ["sort", 9, "domain"]);

assert.deepEqual(await invoke({ type: "gather-domain", domain: "example.com" }), {
  keepAlive: true,
  response: { ok: true, moved: 3 }
});
assert.deepEqual(calls.at(-1), ["gather", "example.com"]);

assert.deepEqual(await invoke({ type: "new-window-with-tab", tabId: 12 }), {
  keepAlive: true,
  response: { ok: true, moved: 1, destination: { kind: "new-window" } }
});
assert.deepEqual(calls.at(-1), ["move-set", [12], { kind: "new-window" }]);

const callsBeforeInvalid = calls.length;
for (const message of [
  { type: "move-tabs", tabIds: [2], destination: null },
  { type: "sort-window", windowId: 9, mode: "unknown" },
  { type: "gather-domain", domain: "  " },
  { type: "new-window-with-tab", tabId: -1 }
]) {
  const result = await invoke(message);
  assert.equal(result.keepAlive, true);
  assert.equal(result.response.ok, false);
}
assert.equal(calls.length, callsBeforeInvalid,
  "invalid Open-tab commands cannot reach browser or organization effects");

rejectGather = true;
assert.deepEqual(await invoke({ type: "gather-domain", domain: "example.com" }), {
  keepAlive: true,
  response: { ok: false, reason: "error", moved: 0 }
});
assert.deepEqual(errors, [["gather-domain", "private gather failure"]],
  "the shared registry contains organization failures behind the public result shape");

console.log("PASS: Open-tab messages have one directly tested handler contract");
