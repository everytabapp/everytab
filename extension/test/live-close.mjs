import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true, writable: true
});

const storage = createInterleavableStorage({ deviceId: "live-close-test" });
const live = new Map([
  [1, { id: 1, windowId: 20, index: 1, pinned: false,
    url: "https://one.example/", title: "One", incognito: false }],
  [2, { id: 2, windowId: 21, index: 3, pinned: false,
    url: "https://two.example/", title: "Two", incognito: false }],
  [3, { id: 3, url: "https://private.example/", title: "Private", incognito: true }]
]);
let journalAtRemove = null;
const createdTabProps = [];
const createdWindowProps = [];
globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://live-close/${path}` },
  storage: { local: storage.local, onChanged: storage.onChanged },
  tabs: {
    get: async (id) => {
      if (!live.has(id)) throw new Error("No tab");
      return structuredClone(live.get(id));
    },
    remove: async (ids) => {
      journalAtRemove = storage.snapshot().journal;
      for (const id of Array.isArray(ids) ? ids : [ids]) live.delete(id);
    },
    create: async (props) => {
      createdTabProps.push(structuredClone(props));
      return { id: 100 + createdTabProps.length };
    },
    move: async () => null
  },
  windows: {
    get: async (id) => {
      if ([20, 21, 77, 78, 88].includes(id)) return { id, type: "normal", incognito: false };
      throw new Error("No window");
    },
    create: async (props) => {
      createdWindowProps.push(structuredClone(props));
      return { id: 200 + createdWindowProps.length };
    }
  }
};

const { installBrowserMapStorageAuthority } = await import(
  "./storage-authority-fixture.mjs"
);
installBrowserMapStorageAuthority();

const { JOURNAL_KEY, listActions, recordAction, undoAction } =
  await import("../js/lib/journal.js");
const {
  closeLiveTabsById, closeTabsWithReceipt, closeUnsaveableTabsById,
  recoverPendingLiveCloses
} = await import("../js/lib/live-close.js");

const closed = await closeLiveTabsById([1, 2]);
assert.equal(closed.ok, true);
assert.equal(closed.closed, 2);
assert.equal(journalAtRemove?.[0]?.forwardReceipt?.status, "pending",
  "the durable recovery receipt exists before Chrome removes a tab");
let actions = await listActions();
assert.equal(actions[0].forwardReceipt.status, "complete");
assert.deepEqual(actions[0].reopen[0].map((tab) => tab.url),
  ["https://one.example/", "https://two.example/"]);

await storage.local.set({ [JOURNAL_KEY]: [] });
live.set(9, { id: 9, url: "https://still-open.example/", title: "Still open", incognito: false });
const failed = await closeTabsWithReceipt([
  { id: 9, url: "https://still-open.example/", title: "Still open", incognito: false }
], async () => { throw new Error("Chrome refused the close"); }, { label: "Close failed" });
assert.equal(failed.ok, false);
assert.equal((await listActions()).length, 0,
  "a prepared close that changed no browser tab leaves no phantom Undo action");

const pendingTabs = [
  { tabId: 10, ref: { url: "https://missing.example/", title: "Missing" } },
  { tabId: 11, ref: { url: "https://present.example/", title: "Present" } }
];
live.set(11, { id: 11, url: "https://present.example/", title: "Present", incognito: false });
await recordAction("Interrupted close", {
  reopen: [pendingTabs.map((tab) => tab.ref)]
}, {
  forwardReceipt: { kind: "close-tabs", status: "pending", tabs: pendingTabs }
});
await recoverPendingLiveCloses();
actions = await listActions();
assert.equal(actions[0].forwardReceipt.status, "complete");
assert.deepEqual(actions[0].forwardReceipt.tabs.map((tab) => tab.tabId), [10]);
assert.deepEqual(actions[0].reopen[0].map((tab) => tab.url), ["https://missing.example/"],
  "restart recovery offers Undo only for tabs that actually disappeared");

await storage.local.set({ [JOURNAL_KEY]: [] });
journalAtRemove = null;
const privateClose = await closeLiveTabsById([3]);
assert.equal(privateClose.ok, false);
assert.equal(live.has(3), true);
assert.equal((await listActions()).length, 0,
  "incognito tabs are neither closed nor persisted by the worker boundary");

live.set(4, { id: 4, windowId: 20, index: 0, pinned: false,
  url: "file:///Users/example/notes.html", title: "Local notes", incognito: false });
const localClose = await closeUnsaveableTabsById([4]);
assert.equal(localClose.ok, true);
assert.equal(live.has(4), false);
assert.equal((await listActions()).length, 0,
  "an explicitly confirmed local page closes without inventing a recoverable receipt");
live.set(5, { id: 5, windowId: 20, index: 0, pinned: false,
  url: "https://saveable.example/", title: "Saveable", incognito: false });
const bypass = await closeUnsaveableTabsById([5]);
assert.equal(bypass.reason, "forbidden");
assert.equal(live.has(5), true,
  "the non-recoverable route cannot bypass Undo for an ordinary web page");

await storage.local.set({ [JOURNAL_KEY]: [] });
live.set(20, { id: 20, windowId: 77, index: 4, pinned: true,
  url: "https://position.example/", title: "Position", incognito: false });
createdTabProps.length = 0;
const positioned = await closeLiveTabsById([20]);
assert.equal(positioned.ok, true);
const positionedUndos = await Promise.all([
  undoAction(positioned.undoId), undoAction(positioned.undoId)
]);
assert.equal(positionedUndos.filter(Boolean).length, 1,
  "a positioned close receipt still has exactly one Undo owner");
assert.deepEqual(createdTabProps, [{
  url: "https://position.example/", windowId: 77, index: 4,
  pinned: true, active: false
}], "Undo recreates a closed Open tab in its original window and position");

await storage.local.set({ [JOURNAL_KEY]: [] });
live.set(22, { id: 22, windowId: 77, index: 3, pinned: false,
  url: "https://third.example/", title: "Third", incognito: false });
live.set(23, { id: 23, windowId: 77, index: 1, pinned: false,
  url: "https://first.example/", title: "First", incognito: false });
live.set(24, { id: 24, windowId: 78, index: 2, pinned: false,
  url: "https://other-window.example/", title: "Other window", incognito: false });
createdTabProps.length = 0;
const multi = await closeLiveTabsById([22, 24, 23]);
await undoAction(multi.undoId);
assert.deepEqual(createdTabProps, [
  { url: "https://first.example/", windowId: 77, index: 1, pinned: false, active: false },
  { url: "https://third.example/", windowId: 77, index: 3, pinned: false, active: false },
  { url: "https://other-window.example/", windowId: 78, index: 2, pinned: false, active: false }
], "multi-tab Undo restores each original window and ascending tab-strip position");

await storage.local.set({ [JOURNAL_KEY]: [] });
live.set(25, { id: 25, windowId: 99, index: 0, pinned: false,
  url: "https://closed-window.example/", title: "Closed window", incognito: false });
createdWindowProps.length = 0;
const missingWindow = await closeLiveTabsById([25]);
await undoAction(missingWindow.undoId);
assert.deepEqual(createdWindowProps, [{ url: ["https://closed-window.example/"] }],
  "when the original window is gone, Undo creates one replacement window instead of using the current window");

await storage.local.set({ [JOURNAL_KEY]: [] });
live.set(21, { id: 21, windowId: 88, index: 2, pinned: false,
  url: "https://never-closed.example/", title: "Never closed", incognito: false });
const phantom = await closeTabsWithReceipt([live.get(21)], async () => {} , {
  label: "Closed one tab"
});
assert.equal(phantom.ok, false,
  "a resolved Chrome close that left the original tab alive is not undoable");
assert.equal((await listActions()).length, 0,
  "a still-live original cannot gain a second copy through Undo");

console.log("PASS: live tab closes use a persist-first, restart-safe receipt");
