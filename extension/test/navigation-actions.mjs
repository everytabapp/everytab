import assert from "node:assert/strict";
import { createNavigationActions } from "../js/background/navigation-actions.js";

const calls = [];
const scheduled = [];
let restoreResult = true;
let notificationFailure = false;
const actions = createNavigationActions({
  async wakeTab(id) { calls.push(["wake", id]); throw new Error("already awake"); },
  async restoreSessionById(id) { calls.push(["restore", id]); return restoreResult; },
  async openDashboard(route) { calls.push(["dashboard", route]); },
  message: (key) => `localized:${key}`,
  now: () => 1234,
  schedule: (callback, delay) => { scheduled.push([callback, delay]); },
  runtime: { getURL: (path) => `chrome-extension://everytab/${path}` },
  tabs: {
    async query() { calls.push(["query"]); return []; },
    async update(id, properties) { calls.push(["update", id, properties]); },
    async create(properties) { calls.push(["create", properties]); }
  },
  windows: { async update(id, properties) { calls.push(["window", id, properties]); } },
  notifications: {
    async create(id, options) {
      calls.push(["notify", id, options]);
      if (notificationFailure) throw new Error("unavailable");
    },
    async clear(id) { calls.push(["clear", id]); }
  },
  warn: (...args) => calls.push(["warn", ...args])
});

await actions.focus({ tabId: 7, windowId: 9 });
assert.deepEqual(calls.slice(0, 3), [
  ["wake", 7], ["update", 7, { active: true }], ["window", 9, { focused: true }]
], "a failed wake does not prevent exact tab and window focus");

calls.length = 0;
assert.equal(await actions.activateStarred("chrome://settings"), false);
assert.deepEqual(calls, [], "an unsupported Starred address has no browser effects");
assert.equal(await actions.activateStarred("https://Example.com/path/#fragment"), true);
assert.deepEqual(calls, [
  ["query"], ["create", { url: "https://example.com/path" }]
], "a missing Starred page opens its canonical address");

calls.length = 0;
const matchingActions = createNavigationActions({
  async wakeTab() {}, async restoreSessionById() { return true; }, async openDashboard() {},
  message: (key) => key, runtime: { getURL: (path) => path },
  tabs: {
    async query() { return [{ id: 4, windowId: 6, url: "https://example.com/path#old" }]; },
    async update(id, properties) { calls.push(["update", id, properties]); },
    async create(properties) { calls.push(["create", properties]); }
  },
  windows: { async update(id, properties) { calls.push(["window", id, properties]); } },
  notifications: { async create() {}, async clear() {} }
});
assert.equal(await matchingActions.activateStarred("https://example.com/path#new"), true);
assert.deepEqual(calls, [
  ["update", 4, { active: true }], ["window", 6, { focused: true }]
], "an existing canonical Starred match is focused instead of duplicated");

calls.length = 0;
assert.equal(await actions.restoreSession("present"), true);
assert.deepEqual(calls, [["restore", "present"]]);
restoreResult = false;
assert.equal(await actions.restoreSession("gone"), false);
assert.deepEqual(calls.slice(-2).map(([name]) => name), ["restore", "notify"]);
assert.equal(calls.at(-1)[1], "session-missing-1234");
assert.equal(calls.at(-1)[2].title, "localized:notification_session_missing_title");
assert.equal(scheduled.at(-1)[1], 5_000);
await scheduled.at(-1)[0]();
await Promise.resolve();
assert.deepEqual(calls.at(-1), ["clear", "session-missing-1234"]);

notificationFailure = true;
assert.equal(await actions.restoreSession("still-gone"), false);
assert.equal(calls.at(-1)[0], "warn", "notification failure is contained and observable");

calls.length = 0;
assert.equal(await actions.openGroup("label", "deep work / later"), true);
assert.deepEqual(calls, [["dashboard", "label-group:deep%20work%20%2F%20later"]]);
assert.equal(await actions.openGroup("other", "group"), false);
assert.equal(await actions.openGroup("session", " "), false);
assert.equal(calls.length, 1, "invalid organization targets have no navigation effects");

console.log("PASS: shared navigation actions own browser focus and stale-target behavior");
