import assert from "node:assert/strict";
import { createMessageListener } from "../js/lib/message-handler-registry.js";
import { createInboxCaptureMessageHandlers } from
  "../js/background/inbox-capture-message-handlers.js";

const calls = [];
const errors = [];
let windowResult = { n: 4, undoId: "window-exact" };
let rejectTabSet = false;
let rejectTab = false;
let releaseWindow;
let windowStarted;
let latestActivityId = "older-action";
const handlers = createInboxCaptureMessageHandlers({
  capture: {
    async window(windowId) {
      calls.push(["window", windowId]);
      if (windowStarted) {
        windowStarted();
        await new Promise((resolve) => { releaseWindow = resolve; });
      }
      return windowResult;
    },
    async tab(tabId) {
      calls.push(["tab", tabId]);
      if (rejectTab) throw new Error("private tab capture failure");
      return { n: 1, undoId: "tab-exact" };
    },
    async tabs(tabIds, label) {
      calls.push(["tabs", tabIds, label]);
      if (rejectTabSet) throw new Error("private capture failure");
      return tabIds.length;
    }
  },
  journal: {
    async list() {
      calls.push(["journal"]);
      return [{ id: latestActivityId }];
    }
  }
});

assert.equal(handlers.length, 3, "the Inbox-capture protocol owns exactly three routes");
assert.equal(new Set(handlers.map(({ type }) => type)).size, 3,
  "each Inbox-capture route has one unique message identity");

const listener = createMessageListener(handlers, {
  onError: (error, type) => errors.push([type, error.message])
});
const invoke = (message) => new Promise((resolve) => {
  let keepAlive;
  keepAlive = listener(message, {}, (response) => {
    queueMicrotask(() => resolve({ keepAlive, response }));
  });
});

const started = new Promise((resolve) => { windowStarted = resolve; });
const pendingWindow = invoke({ type: "dump-window", windowId: 8 });
await started;
latestActivityId = "newer-unrelated-action";
releaseWindow();
windowStarted = null;
assert.deepEqual(await pendingWindow, {
  keepAlive: true,
  response: { n: 4, undoId: "window-exact" }
});
assert.deepEqual(calls.slice(-1), [["window", 8]],
  "an unrelated newer Activity entry cannot replace the capture's exact Undo identity");

windowResult = { n: 0, undoId: null };
const callsBeforeEmptyWindow = calls.length;
assert.deepEqual(await invoke({ type: "dump-window", windowId: 9 }), {
  keepAlive: true,
  response: { n: 0, undoId: null }
});
assert.deepEqual(calls.slice(callsBeforeEmptyWindow), [["window", 9]],
  "an empty capture does not consult unrelated journal state");

assert.deepEqual(await invoke({ type: "dump-tab", tabId: 13 }), {
  keepAlive: true,
  response: { n: 1, undoId: "tab-exact" }
});
assert.deepEqual(calls.slice(-1), [["tab", 13]]);

rejectTab = true;
assert.deepEqual(await invoke({ type: "dump-tab", tabId: 14 }), {
  keepAlive: true,
  response: { n: 0, undoId: null }
});
rejectTab = false;

assert.deepEqual(await invoke({ type: "dump-tabs", tabIds: [2, 5], label: "Research" }), {
  keepAlive: true,
  response: { n: 2 }
});
assert.deepEqual(calls.at(-1), ["tabs", [2, 5], "Research"],
  "a tab-set capture preserves its optional label and original response shape");

const callsBeforeInvalid = calls.length;
assert.deepEqual(await invoke({ type: "dump-tabs", tabIds: [2, -1] }), {
  keepAlive: true,
  response: { n: 0 }
});
assert.deepEqual(await invoke({ type: "dump-tabs", tabIds: [2], label: ["Research"] }), {
  keepAlive: true,
  response: { n: 0 }
});
assert.equal(calls.length, callsBeforeInvalid,
  "invalid tab identities and label shapes cannot reach capture storage");

rejectTabSet = true;
assert.deepEqual(await invoke({ type: "dump-tabs", tabIds: [21] }), {
  keepAlive: true,
  response: { n: 0 }
});
assert.deepEqual(errors, [
  ["dump-tab", "private tab capture failure"],
  ["dump-tabs", "private capture failure"]
],
  "the shared registry contains capture failures behind the public response shape");

console.log("PASS: Inbox-capture messages have one directly tested handler contract");
