import assert from "node:assert/strict";

function chromeEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    async emit(...args) {
      await Promise.all(listeners.map((listener) => listener(...args)));
    },
    get size() { return listeners.length; }
  };
}

const onActivated = chromeEvent();
const onUpdated = chromeEvent();
const onCreated = chromeEvent();
const onRemoved = chromeEvent();
const alarms = [];
globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://everytab-test/${path}` },
  alarms: {
    async create(name, options) { alarms.push({ name, options }); }
  },
  tabs: { onActivated, onUpdated, onCreated, onRemoved }
};

const { installTabLifecycleOwner } = await import(
  "../js/background/tab-lifecycle-owner.js"
);

const calls = [];
let dedupAutoClose = false;
let duplicateTabIds = [];
let rejectCloseCleanup = false;
let rejectBadge = false;
const call = (type, detail) => {
  calls.push(detail === undefined ? { type } : { type, detail });
};
const reset = () => {
  calls.length = 0;
  alarms.length = 0;
};
const settleBadge = () => new Promise((resolve) => setTimeout(resolve, 10));

installTabLifecycleOwner({
  activity: {
    async recordActivation(tabId, windowId) {
      call("record-activation", { tabId, windowId });
    },
    async forgetTab(tabId) { call("forget-activity", tabId); }
  },
  newTabs: {
    recordCreation(tab) { call("record-creation", tab.id); },
    forget(tabId) { call("forget-new-tab", tabId); },
    async retireOlder(tab) { call("retire-older", tab.id); }
  },
  suspension: {
    async unregister(tabId) { call("unregister-suspended", tabId); },
    async queueCloseCleanup(tabId) {
      call("suspended-close-cleanup", tabId);
      if (rejectCloseCleanup) throw new Error("cleanup unavailable");
    }
  },
  focus: {
    async activate(tabId) { call("focus-activate", tabId); },
    async update(tabId, changeInfo, tab) {
      call("focus-update", { tabId, changeInfo, tab });
    },
    async remove(tabId) { call("focus-remove", tabId); }
  },
  duplicates: {
    alarmPrefix: "dedup-grace:",
    graceMs: 30_000,
    async readSettings() {
      call("read-settings");
      return { dedupAutoClose };
    },
    async findGroups() {
      call("find-duplicates");
      return [{ close: duplicateTabIds.map((id) => ({ id })) }];
    }
  },
  badge: {
    async refresh() {
      call("badge");
      if (rejectBadge) throw new Error("badge unavailable");
    },
    delayMs: 5
  },
  protection: {
    async removeTemporary(tabId) { call("remove-temporary-protection", tabId); }
  },
  scheduleAutoSaveCapSweep: () => call("auto-save-cap")
});

assert.deepEqual([
  onActivated.size, onUpdated.size, onCreated.size, onRemoved.size
], [1, 1, 1, 1], "one owner installs each tab lifecycle listener once");

await onActivated.emit({ tabId: 11, windowId: 2 });
assert.deepEqual(calls, [
  { type: "record-activation", detail: { tabId: 11, windowId: 2 } },
  { type: "focus-activate", detail: 11 }
], "activation records the exact tab/window transition and gives Focus its deliberate signal");
await settleBadge();
assert.deepEqual(calls.at(-1), { type: "badge" });

reset();
const mountedNewTab = {
  id: 12,
  active: true,
  pinned: false,
  incognito: false,
  url: "chrome-extension://everytab-test/newtab.html"
};
await onUpdated.emit(12, { status: "complete" }, mountedNewTab);
assert.deepEqual(calls, [
  { type: "retire-older", detail: 12 }
], "a completed active override reconciles its singleton without resetting time-away");
await settleBadge();

reset();
await onCreated.emit({ id: 13 });
assert.deepEqual(calls, [
  { type: "record-creation", detail: 13 },
  { type: "auto-save-cap" }
], "creation records New Tab order and schedules responsive cap maintenance");
await settleBadge();

reset();
const webTab = { id: 14, url: "https://example.com/page" };
await onUpdated.emit(14, { url: webTab.url }, webTab);
assert.deepEqual(calls.map(({ type }) => type), [
  "unregister-suspended", "read-settings", "focus-update"
], "a web navigation preserves time-away while retiring suspension and running policy");
assert.deepEqual(alarms, [], "deduplication Off never schedules a grace close");
await settleBadge();

reset();
dedupAutoClose = true;
duplicateTabIds = [14];
const beforeGrace = Date.now();
await onUpdated.emit(14, { url: webTab.url }, webTab);
assert.deepEqual(calls.map(({ type }) => type), [
  "unregister-suspended", "read-settings", "focus-update", "find-duplicates"
]);
assert.equal(alarms.length, 1);
assert.equal(alarms[0].name, "dedup-grace:14");
assert.ok(alarms[0].options.when >= beforeGrace + 30_000,
  "a confirmed extra copy receives the full duplicate grace period");
await settleBadge();

reset();
await onUpdated.emit(15, { url: "chrome://settings/" }, {
  id: 15,
  url: "chrome://settings/"
});
assert.deepEqual(calls.map(({ type }) => type), ["focus-update"],
  "non-web navigation preserves time-away and skips suspension or duplicate cleanup");
await settleBadge();

reset();
await onRemoved.emit(16);
assert.deepEqual(calls.map(({ type }) => type), [
  "remove-temporary-protection", "forget-new-tab", "forget-activity",
  "suspended-close-cleanup", "focus-remove"
], "removal reaches every independent cleanup owner");
await settleBadge();

reset();
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args);
rejectCloseCleanup = true;
await onRemoved.emit(17);
console.warn = originalWarn;
assert.deepEqual(calls.map(({ type }) => type), [
  "remove-temporary-protection", "forget-new-tab", "forget-activity",
  "suspended-close-cleanup", "focus-remove"
], "one failed cleanup cannot prevent the other tab-removal work");
assert.match(warnings[0]?.[0] ?? "", /suspended close cleanup failed/);
await settleBadge();

reset();
rejectCloseCleanup = false;
await onCreated.emit({ id: 18 });
await onActivated.emit({ tabId: 18, windowId: 3 });
await settleBadge();
assert.equal(calls.filter(({ type }) => type === "badge").length, 1,
  "a tab-event burst coalesces into one badge refresh");

reset();
console.warn = (...args) => warnings.push(args);
rejectBadge = true;
await onCreated.emit({ id: 19 });
await settleBadge();
console.warn = originalWarn;
assert.match(warnings.at(-1)?.[0] ?? "", /badge refresh failed/,
  "a rejected debounced badge refresh stays inside the lifecycle owner");

console.log("PASS: one background owner routes every tab lifecycle event");
