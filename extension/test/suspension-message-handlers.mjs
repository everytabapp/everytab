import assert from "node:assert/strict";
import { createSuspensionMessageHandlers } from
  "../js/background/suspension-message-handlers.js";
import { createMessageListener } from "../js/lib/message-handler-registry.js";

const calls = [];
const errors = [];
let rejectSuspend = false;
const handlers = createSuspensionMessageHandlers({
  async wake(tabId) {
    calls.push(["wake", tabId]);
    return tabId !== 8;
  },
  async adopt(tab) {
    calls.push(["adopt", tab]);
    return true;
  },
  async suspend(tabId) {
    calls.push(["suspend", tabId]);
    if (rejectSuspend) throw new Error("private suspension failure");
    return true;
  },
  async exempt(tabId, duration) {
    calls.push(["exempt", tabId, duration]);
    return { ok: true, duration };
  },
  async suspendOthers(windowId) {
    calls.push(["suspend-others", windowId]);
    return 4;
  }
});

assert.equal(handlers.length, 6, "the direct suspension protocol owns exactly six routes");
assert.equal(new Set(handlers.map(({ type }) => type)).size, 6,
  "each direct suspension route has one unique message identity");

const listener = createMessageListener(handlers, {
  onError: (error, type) => errors.push([type, error.message])
});
const invoke = (message, sender = {}) => new Promise((resolve) => {
  let keepAlive;
  keepAlive = listener(message, sender, (response) => {
    queueMicrotask(() => resolve({ keepAlive, response }));
  });
});

assert.deepEqual(await invoke({ type: "wake-tab", tabId: 7 }), {
  keepAlive: true,
  response: { ok: true }
});
assert.deepEqual(await invoke({ type: "wake-tab", tabId: 8 }), {
  keepAlive: true,
  response: { ok: false }
});
assert.deepEqual(calls.slice(-2), [["wake", 7], ["wake", 8]],
  "explicit wake routes the exact requested tab identity");

const exactSenderTab = { id: 11, windowId: 3, url: "chrome-extension://test/suspend.html" };
assert.deepEqual(await invoke({ type: "wake-suspended-page" }, { tab: exactSenderTab }), {
  keepAlive: true,
  response: { ok: true }
});
assert.deepEqual(calls.at(-1), ["wake", 11],
  "mounted wake trusts Chrome's sender tab identity, not message payload");

assert.deepEqual(await invoke({ type: "adopt-suspended-page" }, { tab: exactSenderTab }), {
  keepAlive: true,
  response: { ok: true }
});
assert.strictEqual(calls.at(-1)[1], exactSenderTab,
  "mounted adoption receives Chrome's complete sender tab record unchanged");

const callsBeforeInvalidSender = calls.length;
assert.deepEqual(await invoke({ type: "wake-suspended-page", tabId: 99 }, {}), {
  keepAlive: true,
  response: { ok: false }
});
assert.deepEqual(await invoke({ type: "adopt-suspended-page" }, { tab: { id: -1 } }), {
  keepAlive: true,
  response: { ok: false }
});
assert.equal(calls.length, callsBeforeInvalidSender,
  "missing or invalid sender provenance cannot mutate suspension state");

assert.deepEqual(await invoke({ type: "suspend-tab", tabId: 17 }), {
  keepAlive: true,
  response: { ok: true }
});
assert.deepEqual(await invoke({
  type: "exempt-tab-from-suspend",
  tabId: 17,
  duration: "day"
}), {
  keepAlive: true,
  response: { ok: true, duration: "day" }
});
assert.deepEqual(await invoke({
  type: "exempt-tab-from-suspend",
  tabId: 17,
  duration: "always"
}), {
  keepAlive: true,
  response: { ok: true, duration: "always" }
});
assert.deepEqual(calls.slice(-3), [
  ["suspend", 17],
  ["exempt", 17, "day"],
  ["exempt", 17, "always"]
]);

const callsBeforeInvalidDuration = calls.length;
assert.deepEqual(await invoke({
  type: "exempt-tab-from-suspend",
  tabId: 17,
  duration: "week"
}), {
  keepAlive: true,
  response: { ok: false }
});
assert.equal(calls.length, callsBeforeInvalidDuration,
  "only the shipped 24-hour and permanent exception durations are accepted");

assert.deepEqual(await invoke({ type: "suspend-others", windowId: 4 }), {
  keepAlive: true,
  response: { n: 4 }
});

rejectSuspend = true;
assert.deepEqual(await invoke({ type: "suspend-tab", tabId: 19 }), {
  keepAlive: true,
  response: { ok: false }
});
assert.deepEqual(errors, [["suspend-tab", "private suspension failure"]],
  "the shared registry contains suspension failures behind the public response shape");

console.log("PASS: suspension lifecycle messages have one directly tested handler contract");
