import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const storage = createInterleavableStorage({
  deviceId: "snooze-live-order", snoozes: {}, snoozePlacements: {}, journal: []
});
const nativeSet = storage.local.set;
const live = new Map();
const events = [];
const createdTabs = [];
let failAtomicCommit = false;
let failAlarm = false;
let partialRemove = false;
let journalAtRemove = null;
let snoozesAtRemove = null;

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: {
    local: {
      get: storage.local.get,
      async set(values) {
        if (failAtomicCommit && values.snoozes && values.journal) {
          events.push("commit-failed");
          throw new Error("journal commit failed");
        }
        if (values.snoozes && values.journal) events.push("commit");
        else if (values.journal) events.push("settle");
        return nativeSet(values);
      }
    },
    onChanged: storage.onChanged
  },
  alarms: {
    async create(name, info) {
      events.push("alarm");
      if (failAlarm) throw new Error("alarm unavailable");
      return { name, info };
    },
    async clear() { return true; }
  },
  tabs: {
    async get(id) {
      const tab = live.get(id);
      if (!tab) throw new Error("gone");
      return structuredClone(tab);
    },
    async query({ windowId } = {}) {
      return [...live.values()].filter((tab) => windowId === undefined || tab.windowId === windowId)
        .map((tab) => structuredClone(tab));
    },
    async remove(ids) {
      events.push("remove");
      journalAtRemove = storage.snapshot().journal;
      snoozesAtRemove = storage.snapshot().snoozes;
      const targets = Array.isArray(ids) ? ids : [ids];
      for (let index = 0; index < targets.length; index += 1) {
        live.delete(targets[index]);
        if (partialRemove && index === 0) throw new Error("partial close");
      }
    },
    async create(props) {
      createdTabs.push(structuredClone(props));
      return { id: 900 + createdTabs.length, ...props };
    },
    async update() { return null; },
    async move() { return null; }
  },
  windows: {
    async getAll() { return [{ id: 1 }, { id: 2 }]; },
    async get(id) { return { id, type: "normal", incognito: false }; },
    async create({ url }) { return { id: 90, tabs: (Array.isArray(url) ? url : [url])
      .map((value, index) => ({ id: 950 + index, url: value })) }; }
  }
};

const { installBrowserMapStorageAuthority } = await import(
  "./storage-authority-fixture.mjs"
);
installBrowserMapStorageAuthority();
const { createLiveSnoozeWithReceipt, sweepOverdueSnoozes } = await import("../js/lib/snooze.js");
const { closeUnchangedLiveTabs, finishPendingLiveClose,
  recoverPendingLiveCloses } = await import("../js/lib/live-close.js");
const { createSnoozeActions } = await import("../js/background/snooze-actions.js");
const { listActions, undoActionResult } = await import("../js/lib/journal.js");

const actions = createSnoozeActions({
  createWithCloseReceipt: createLiveSnoozeWithReceipt,
  finishCloseReceipt: finishPendingLiveClose,
  capturePlacement: async () => null,
  openDashboard: async () => { events.push("dashboard"); },
  tabs: chrome.tabs,
  windows: chrome.windows
});
const tab = (id, url, extra = {}) => ({
  id, windowId: 2, index: id, pinned: false, incognito: false,
  url, title: url, ...extra
});
const reset = async () => {
  live.clear();
  events.length = 0;
  createdTabs.length = 0;
  failAtomicCommit = false;
  failAlarm = false;
  partialRemove = false;
  journalAtRemove = null;
  snoozesAtRemove = null;
  await nativeSet({ snoozes: {}, snoozePlacements: {}, journal: [] });
};

await reset();
const failedTab = tab(7, "https://valuable.example/form");
live.set(7, failedTab);
failAtomicCommit = true;
await assert.rejects(actions.tab(failedTab, Date.now() + 60_000));
assert.equal(live.has(7), true);
assert.deepEqual(storage.snapshot().snoozes, {});
assert.deepEqual(events, ["commit-failed"],
  "a failed atomic Snooze/Journal commit runs neither alarm nor close");

await reset();
const successTab = tab(10, "https://ordered.example/");
live.set(10, successTab);
live.set(11, tab(11, "https://survivor.example/"));
const successful = await actions.tab(successTab, Date.now() + 120_000);
assert.ok(events.indexOf("commit") < events.indexOf("alarm") &&
  events.indexOf("alarm") < events.indexOf("remove"));
assert.equal(journalAtRemove[0].forwardReceipt.status, "pending");
assert.ok(snoozesAtRemove[successful.id]);
let entry = (await listActions())[0];
assert.equal(successful.undoId, entry.id,
  "the action returns the exact receipt it created without rereading Journal recency");
assert.equal(entry.forwardReceipt.status, "complete");
assert.deepEqual(entry.forwardReceipt.tabs.map(({ tabId }) => tabId), [10]);
const undone = await undoActionResult(entry.id);
assert.equal(undone.status, "undone");
assert.ok(storage.snapshot().snoozes[successful.id].deletedAt);
assert.equal(createdTabs[0].url, successTab.url);

await reset();
const first = tab(20, "https://first-window.example/");
const second = tab(21, "https://second-window.example/");
live.set(20, first);
live.set(21, second);
partialRemove = true;
const partial = await actions.window(2, Date.now() + 180_000);
entry = (await listActions())[0];
assert.deepEqual(partial.tabs.map(({ url }) => url), [first.url, second.url],
  "the persisted Snooze keeps the complete reviewed window snapshot");
assert.deepEqual(entry.forwardReceipt.tabs.map(({ tabId }) => tabId), [20]);
assert.deepEqual(entry.reopen[0].map(({ url }) => url), [first.url]);
assert.equal(live.has(21), true);

await reset();
const interruptedTab = tab(30, "https://restart.example/");
live.set(30, interruptedTab);
const interrupted = await createLiveSnoozeWithReceipt({
  url: interruptedTab.url, title: interruptedTab.title, dueAt: Date.now() + 240_000
}, [interruptedTab], { label: "Snoozed restart tab" });
live.delete(30);
await recoverPendingLiveCloses();
entry = (await listActions()).find((candidate) => candidate.id === interrupted.entryId);
assert.equal(entry.forwardReceipt.status, "complete");
assert.deepEqual(entry.forwardReceipt.tabs.map(({ tabId }) => tabId), [30]);
assert.ok(storage.snapshot().snoozes[interrupted.snooze.id]);

await reset();
const alarmTab = tab(40, "https://alarm-recovery.example/");
live.set(40, alarmTab);
failAlarm = true;
await assert.rejects(actions.tab(alarmTab, Date.now() + 300_000));
assert.equal(live.has(40), true);
entry = (await listActions())[0];
assert.equal(entry.forwardReceipt.status, "pending");
assert.ok(Object.values(storage.snapshot().snoozes).some((item) => !item.deletedAt));
failAlarm = false;
await recoverPendingLiveCloses();
await sweepOverdueSnoozes();
entry = (await listActions())[0];
assert.equal(entry.forwardReceipt.status, "complete");
assert.deepEqual(entry.reopen, []);
assert.equal(events.at(-1), "alarm",
  "startup completion leaves the tab open and reasserts the committed Snooze alarm");

console.log("PASS: live Snooze persists record and close receipt before alarm or browser close");
