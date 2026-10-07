import assert from "node:assert/strict";
import { createMessageListener } from "../js/lib/message-handler-registry.js";
import { createSessionMessageHandlers } from
  "../js/background/session-message-handlers.js";

const calls = [];
const errors = [];
let rejectRename = false;
const handlers = createSessionMessageHandlers({
  tabs: {
    async create(tabIds, name, organization) {
      calls.push(["create-tabs", tabIds, name, organization]);
      return { id: "created-tabs", name: name || "New Session" };
    },
    async add(sessionId, tabIds) {
      calls.push(["add-tabs", sessionId, tabIds]);
      return { id: sessionId, name: "Existing Session" };
    }
  },
  windows: {
    async create(windowId, name, organization) {
      calls.push(["create-window", windowId, name, organization]);
      return { id: "created-window", name: name || "New Session" };
    },
    async add(sessionId, windowId) {
      calls.push(["add-window", sessionId, windowId]);
      return { id: sessionId, name: "Existing Session" };
    }
  },
  async rename(sessionId, name) {
    calls.push(["rename", sessionId, name]);
    if (rejectRename) throw new Error("private rename failure");
    return sessionId === "missing" ? null : { id: sessionId, name };
  }
});

assert.equal(handlers.length, 3, "the saved-Session protocol owns exactly three routes");
assert.equal(new Set(handlers.map(({ type }) => type)).size, 3,
  "each saved-Session route has one unique message identity");

const listener = createMessageListener(handlers, {
  onError: (error, type) => errors.push([type, error.message])
});
const invoke = (message) => new Promise((resolve) => {
  let keepAlive;
  keepAlive = listener(message, {}, (response) => {
    queueMicrotask(() => resolve({ keepAlive, response }));
  });
});

const organization = { groupIds: ["group-one"], createNames: ["New group"] };
assert.deepEqual(await invoke({
  type: "save-tabs-session",
  tabIds: [3, 5],
  name: "Research",
  organization
}), {
  keepAlive: true,
  response: { id: "created-tabs", name: "Research" }
});
assert.deepEqual(calls.at(-1), ["create-tabs", [3, 5], "Research", organization],
  "new tab selections retain their name and complete organization assignment");

assert.deepEqual(await invoke({
  type: "save-tabs-session",
  tabIds: [7],
  sessionId: "existing"
}), {
  keepAlive: true,
  response: { id: "existing", name: "Existing Session" }
});
assert.deepEqual(calls.at(-1), ["add-tabs", "existing", [7]],
  "an existing Session identity selects add rather than create");

assert.deepEqual(await invoke({
  type: "save-window-session",
  windowId: 11,
  name: "Morning",
  organization: null
}), {
  keepAlive: true,
  response: { id: "created-window", name: "Morning" }
});
assert.deepEqual(calls.at(-1), ["create-window", 11, "Morning", null]);

assert.deepEqual(await invoke({
  type: "save-window-session",
  windowId: 12,
  sessionId: "existing"
}), {
  keepAlive: true,
  response: { id: "existing", name: "Existing Session" }
});
assert.deepEqual(calls.at(-1), ["add-window", "existing", 12]);

const callsBeforeMalformedOrganization = calls.length;
assert.deepEqual(await invoke({
  type: "save-tabs-session",
  tabIds: [7],
  organization: { groupIds: ["group-one"] }
}), {
  keepAlive: true,
  response: { id: null, name: null }
});
assert.equal(calls.length, callsBeforeMalformedOrganization,
  "partial organization assignments cannot reach Session storage");

assert.deepEqual(await invoke({
  type: "rename-session",
  id: "existing",
  name: "Renamed"
}), {
  keepAlive: true,
  response: { ok: true, name: "Renamed" }
});
assert.deepEqual(await invoke({
  type: "rename-session",
  id: "missing",
  name: "Unavailable"
}), {
  keepAlive: true,
  response: { ok: false, name: null }
});

const callsBeforeInvalidRename = calls.length;
assert.deepEqual(await invoke({ type: "rename-session", id: "", name: "No" }), {
  keepAlive: true,
  response: { ok: false, name: null }
});
assert.equal(calls.length, callsBeforeInvalidRename,
  "rename requires a non-empty Session identity");

rejectRename = true;
assert.deepEqual(await invoke({
  type: "rename-session",
  id: "existing",
  name: "Rejected"
}), {
  keepAlive: true,
  response: { ok: false, name: null }
});
assert.deepEqual(errors, [["rename-session", "private rename failure"]],
  "the shared registry contains Session failures behind the public response shape");

console.log("PASS: saved-Session messages have one directly tested handler contract");
