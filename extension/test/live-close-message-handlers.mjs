import assert from "node:assert/strict";
import { createMessageListener } from "../js/lib/message-handler-registry.js";
import { createLiveCloseMessageHandlers } from
  "../js/background/live-close-message-handlers.js";

let releaseRecovery;
const ready = new Promise((resolve) => { releaseRecovery = resolve; });
const calls = [];
const errors = [];
let rejectUnsaveable = false;
const handlers = createLiveCloseMessageHandlers({
  ready,
  async tabs(tabIds) {
    calls.push(["tabs", tabIds]);
    return { ok: true, closed: tabIds.length };
  },
  async unsaveableTabs(tabIds) {
    calls.push(["unsaveable", tabIds]);
    if (rejectUnsaveable) throw new Error("private close failure");
    return { ok: true, closed: tabIds.length };
  },
  async window(windowId, expected) {
    calls.push(["window", windowId, expected]);
    return { ok: true, ...expected };
  }
});

assert.equal(handlers.length, 3, "the direct live-close protocol owns exactly three routes");
assert.equal(new Set(handlers.map(({ type }) => type)).size, 3,
  "each direct live-close route has one unique message identity");

const listener = createMessageListener(handlers, {
  onError: (error, type) => errors.push([type, error.message])
});
const invoke = (message) => new Promise((resolve) => {
  let keepAlive;
  keepAlive = listener(message, {}, (response) => {
    queueMicrotask(() => resolve({ keepAlive, response }));
  });
});

const recoverableClose = invoke({ type: "close-tabs", tabIds: [3, 4] });
await Promise.resolve();
assert.deepEqual(calls, [], "recoverable closes wait for interrupted action recovery");
releaseRecovery();
assert.deepEqual(await recoverableClose, {
  keepAlive: true,
  response: { ok: true, closed: 2 }
});
assert.deepEqual(calls.at(-1), ["tabs", [3, 4]]);

assert.deepEqual(await invoke({ type: "close-unsaveable-tabs", tabIds: [7] }), {
  keepAlive: true,
  response: { ok: true, closed: 1 }
});
assert.deepEqual(calls.at(-1), ["unsaveable", [7]],
  "unsaveable Chrome pages retain their direct close path");

assert.deepEqual(await invoke({
  type: "close-window",
  windowId: 11,
  expectedTabCount: 3,
  expectedTabIds: [1, 2, 3],
  expectedPinnedTabIds: [1]
}), {
  keepAlive: true,
  response: { ok: true, tabCount: 3, tabIds: [1, 2, 3], pinnedTabIds: [1] }
});
assert.deepEqual(calls.at(-1), ["window", 11, {
  tabCount: 3,
  tabIds: [1, 2, 3],
  pinnedTabIds: [1]
}], "whole-window close preserves the reviewed identity exactly");

const callsBeforeInvalid = calls.length;
assert.deepEqual(await invoke({ type: "close-tabs", tabIds: [2, -1] }), {
  keepAlive: true,
  response: { ok: false, reason: "error", closed: 0 }
});
assert.deepEqual(await invoke({
  type: "close-window",
  windowId: 11,
  expectedTabCount: 3.5,
  expectedTabIds: [1, 2, 3]
}), {
  keepAlive: true,
  response: { ok: false, reason: "error" }
});
assert.equal(calls.length, callsBeforeInvalid,
  "invalid close identities cannot reach browser effects");

rejectUnsaveable = true;
assert.deepEqual(await invoke({ type: "close-unsaveable-tabs", tabIds: [8] }), {
  keepAlive: true,
  response: { ok: false, reason: "error", closed: 0 }
});
assert.deepEqual(errors, [["close-unsaveable-tabs", "private close failure"]],
  "the shared registry contains close failures behind the public result shape");

console.log("PASS: direct live-close messages have one tested handler contract");
