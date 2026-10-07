import assert from "node:assert/strict";
import { createMessageListener } from "../js/lib/message-handler-registry.js";
import { createNavigationMessageHandlers } from
  "../js/background/navigation-message-handlers.js";

const calls = [];
const errors = [];
let rejectOpen = false;
let rejectClose = false;
const handlers = createNavigationMessageHandlers({
  async focus(target) { calls.push(["focus", { ...target }]); },
  async restoreSession(sessionId) {
    calls.push(["restore", sessionId]);
    return sessionId !== "missing";
  },
  async openGroup(kind, groupId) {
    calls.push(["group", kind, groupId]);
    return true;
  },
  async openUrl(url) {
    calls.push(["open", url]);
    if (rejectOpen) throw new Error("private navigation failure");
  },
  async search(query) { calls.push(["search", query]); },
  async activateStarred(url) {
    calls.push(["starred", url]);
    return true;
  },
  async closeTab(tabId) {
    calls.push(["close", tabId]);
    if (rejectClose) throw new Error("already gone");
  },
  async refreshBadge() { calls.push(["badge"]); }
});

assert.equal(handlers.length, 7, "navigation owns exactly seven public routes");
assert.equal(new Set(handlers.map(({ type }) => type)).size, 7,
  "each navigation route has one unique message identity");

const listener = createMessageListener(handlers, {
  onError: (error, type) => errors.push([type, error.message])
});
const invoke = (message, sender = {}) => new Promise((resolve) => {
  let keepAlive;
  keepAlive = listener(message, sender, (response) => {
    queueMicrotask(() => resolve({ keepAlive, response }));
  });
});

assert.deepEqual(await invoke({ type: "focus-tab", tabId: 4, windowId: 8 }), {
  keepAlive: true, response: { ok: true }
});
assert.deepEqual(calls.at(-1), ["focus", { type: "focus-tab", tabId: 4, windowId: 8 }]);

assert.deepEqual((await invoke({ type: "restore-session", sessionId: "saved" })).response,
  { ok: true });
assert.deepEqual((await invoke({ type: "restore-session", sessionId: "missing" })).response,
  { ok: false });
assert.deepEqual((await invoke({
  type: "open-organization-group", organizationKind: "label", groupId: "research"
})).response, { ok: true });
assert.deepEqual(calls.at(-1), ["group", "label", "research"]);

assert.deepEqual((await invoke({ type: "open-url", url: "https://example.com/path" })).response,
  { ok: true });
assert.deepEqual((await invoke(
  { type: "search-web", text: "  local tabs  ", disposition: "CURRENT_TAB" },
  { tab: { id: 17 } }
)).response, { ok: true });
assert.deepEqual(calls.at(-1), ["search", { text: "local tabs", tabId: 17 }],
  "current-tab search requires exact sender provenance");
await invoke({ type: "search-web", text: "new result", disposition: "CURRENT_TAB" });
assert.deepEqual(calls.at(-1), ["search", {
  text: "new result", disposition: "NEW_TAB"
}], "search without sender provenance falls back to a new tab");

assert.deepEqual((await invoke({
  type: "activate-starred", url: "http://example.com"
})).response, { ok: true });

assert.deepEqual((await invoke({
  type: "switch-to-existing", tabId: 20, windowId: 6, closeTabId: 21
})).response, { ok: true });
assert.deepEqual(calls.slice(-3).map(([name]) => name), ["focus", "close", "badge"],
  "switching focuses the target, retires the source, then reconciles the badge");
rejectClose = true;
assert.deepEqual((await invoke({
  type: "switch-to-existing", tabId: 22, closeTabId: 23
})).response, { ok: true });
assert.equal(calls.at(-1)[0], "badge", "an already-gone source tab does not fail the switch");

const callsBeforeInvalid = calls.length;
for (const message of [
  { type: "focus-tab", tabId: 4 },
  { type: "restore-session", sessionId: " " },
  { type: "open-organization-group", organizationKind: "other", groupId: "research" },
  { type: "open-url", url: "chrome://settings" },
  { type: "search-web", text: "" },
  { type: "activate-starred", url: "file:///tmp/example" },
  { type: "switch-to-existing", tabId: -1 }
]) await invoke(message);
assert.equal(calls.length, callsBeforeInvalid,
  "invalid navigation targets cannot reach browser effects");

rejectOpen = true;
assert.deepEqual(await invoke({ type: "open-url", url: "https://example.com" }), {
  keepAlive: true,
  response: { ok: false }
});
assert.deepEqual(errors, [["open-url", "private navigation failure"]]);

console.log("PASS: Search and navigation messages have one directly tested handler contract");
