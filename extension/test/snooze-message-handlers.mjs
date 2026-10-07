import assert from "node:assert/strict";
import { createMessageListener } from "../js/lib/message-handler-registry.js";
import { createSnoozeMessageHandlers } from
  "../js/background/snooze-message-handlers.js";

let releaseDelivery;
const deliveryReady = new Promise((resolve) => { releaseDelivery = resolve; });
const calls = [];
const errors = [];
let createTabResult = {
  id: "tab-snooze", tabs: [{ url: "https://example.com" }], undoId: "undo-tab-exact"
};
let rejectWindow = false;
let selectedError = null;
const handlers = createSnoozeMessageHandlers({
  deliveryReady,
  async getTab(tabId) {
    calls.push(["get-tab", tabId]);
    return { id: tabId, title: "Example" };
  },
  async createTab(tab, dueAt, recurrence) {
    calls.push(["create-tab", tab, dueAt, recurrence]);
    return createTabResult;
  },
  async createWindow(windowId, dueAt, recurrence) {
    calls.push(["create-window", windowId, dueAt, recurrence]);
    if (rejectWindow) throw new Error("private Snooze failure");
    return { id: "window-snooze", tabs: [{}, {}, {}], undoId: "undo-window-exact" };
  },
  async deliver(id, options) {
    calls.push(["deliver", id, options]);
    if (id === "missing-session") return { status: "unavailable", reason: "session-unavailable" };
    return { status: id === "missing" ? "missing" : "delivered" };
  },
  async deliverSelections(selections) {
    calls.push(["deliver-selected", selections]);
    if (selectedError) throw selectedError;
    return { status: "delivered", opened: 1 };
  }
});

assert.equal(handlers.length, 4, "creation and manual delivery each have tab and bundle routes");
assert.equal(new Set(handlers.map(({ type }) => type)).size, 4,
  "each direct Snooze route has one unique message identity");

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
  type: "snooze-tab", tabId: 7, dueAt: 1234, recurrence: "daily"
}), {
  keepAlive: true,
  response: { ok: true, undoId: "undo-tab-exact" }
});
assert.deepEqual(calls.slice(-2), [
  ["get-tab", 7],
  ["create-tab", { id: 7, title: "Example" }, 1234, "daily"]
], "tab Snooze returns the exact Undo identity from its creation result");

createTabResult = null;
const callsBeforeEmpty = calls.length;
assert.deepEqual(await invoke({ type: "snooze-tab", tabId: 8, dueAt: 1235 }), {
  keepAlive: true,
  response: { ok: false, undoId: null }
});
assert.deepEqual(calls.slice(callsBeforeEmpty).map(([name]) => name), ["get-tab", "create-tab"],
  "an empty Snooze result does not consult unrelated journal state");

assert.deepEqual(await invoke({ type: "snooze-window", windowId: 3, dueAt: 2000 }), {
  keepAlive: true,
  response: { ok: true, undoId: "undo-window-exact", n: 3 }
});
assert.deepEqual(calls.at(-1), ["create-window", 3, 2000, undefined]);

const expected = { id: "snooze-one", url: "https://example.com", title: "Example",
  createdAt: 1, modifiedAt: 1, dueAt: 5000, schemaVersion: 1, deviceId: "test" };
const delivery = invoke({ type: "wake-snooze", id: expected.id, expected });
const selections = [{ snooze: expected, indexes: [0] }];
const selectedDelivery = invoke({ type: "wake-snooze-tabs", selections });
await Promise.resolve();
assert.notEqual(calls.at(-1)?.[0], "deliver",
  "manual delivery waits for interrupted Snooze recovery");
assert.ok(!calls.some(([name]) => name === "deliver-selected"),
  "bulk Wake waits for worker recovery before claiming browser effects");
releaseDelivery();
assert.deepEqual(await delivery, {
  keepAlive: true,
  response: { ok: true, status: "delivered" }
});
assert.deepEqual(calls.find(([name]) => name === "deliver"), ["deliver", "snooze-one", { manual: true, expected }],
  "manual delivery carries the reviewed record across recovery readiness");
assert.deepEqual(await selectedDelivery, { keepAlive: true,
  response: { ok: true, status: "delivered", opened: 1 } });
assert.deepEqual(calls.find(([name]) => name === "deliver-selected"),
  ["deliver-selected", selections], "bulk Wake carries exact records and selected indexes");
selectedError = Object.assign(new Error("private persistence failure"),
  { reason: "uncertain", opened: 1 });
assert.deepEqual((await invoke({ type: "wake-snooze-tabs", selections })).response,
  { ok: false, status: "uncertain", opened: 1 },
  "partial completion survives the message boundary without exposing internal errors");
assert.deepEqual((await invoke({ type: "wake-snooze", id: "missing",
  expected: { ...expected, id: "missing" } })).response,
  { ok: false, status: "missing" });
assert.deepEqual((await invoke({ type: "wake-snooze", id: "missing-session",
  expected: { ...expected, id: "missing-session" } })).response,
  { ok: false, status: "unavailable", reason: "session-unavailable" },
  "missing Session feedback survives the worker boundary without reporting delivery");

const callsBeforeInvalid = calls.length;
for (const message of [
  { type: "snooze-tab", tabId: -1, dueAt: 10 },
  { type: "snooze-window", windowId: 3, dueAt: Number.NaN },
  { type: "wake-snooze", id: " " },
  { type: "wake-snooze", id: "snooze-one" },
  { type: "wake-snooze", id: "snooze-one", expected: [] },
  { type: "wake-snooze", id: "snooze-one", expected: { id: "another" } },
  { type: "wake-snooze-tabs", selections: [] },
  { type: "wake-snooze-tabs", selections: [{ snooze: expected, indexes: [-1] }] },
  { type: "wake-snooze-tabs", selections: [{ indexes: [0] }] }
]) await invoke(message);
assert.equal(calls.length, callsBeforeInvalid,
  "invalid targets and due times cannot reach Snooze effects");

rejectWindow = true;
assert.deepEqual(await invoke({ type: "snooze-window", windowId: 3, dueAt: 3000 }), {
  keepAlive: true,
  response: { ok: false, undoId: null, n: 0 }
});
assert.deepEqual(errors, [["snooze-window", "private Snooze failure"]],
  "the shared registry contains Snooze failures behind the public result shape");

console.log("PASS: direct Snooze messages have one directly tested handler contract");
