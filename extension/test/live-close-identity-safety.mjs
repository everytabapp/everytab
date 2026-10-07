import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const storage = createInterleavableStorage({ deviceId: "live-close-identity" });
const live = new Map();
const removed = [];
const afterGet = new Map();
let afterQuery = null;

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: { local: storage.local, onChanged: storage.onChanged },
  tabs: {
    async get(id) {
      const tab = live.get(id);
      if (!tab) throw new Error("No tab");
      const snapshot = structuredClone(tab);
      const hook = afterGet.get(id);
      if (hook) {
        afterGet.delete(id);
        queueMicrotask(hook);
      }
      return snapshot;
    },
    async query(query = {}) {
      const tabs = [...live.values()].filter((tab) =>
        (query.windowId === undefined || tab.windowId === query.windowId) &&
        (query.url === undefined || tab.url === query.url));
      const snapshot = structuredClone(tabs);
      const hook = afterQuery;
      afterQuery = null;
      if (hook) queueMicrotask(hook);
      return snapshot;
    },
    async remove(ids) {
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        if (!live.has(id)) continue;
        removed.push({ id, url: live.get(id).url });
        live.delete(id);
      }
    },
    async create() { return { id: 900 }; },
    async update() { return null; }
  },
  windows: {
    async update() { return null; },
    async get(id) { return { id, type: "normal", incognito: false }; },
    async create() { return { id: 901 }; }
  }
};

const { installBrowserMapStorageAuthority } = await import(
  "./storage-authority-fixture.mjs"
);
installBrowserMapStorageAuthority();

const liveClose = await import("../js/lib/live-close.js");
const { closeLiveTabsById, closeTabsWithReceipt, closeUnchangedLiveTabs,
  closeUnchangedLiveTabsInBatches, closeUnsaveableTabsById, recoverPendingLiveCloses } = liveClose;
const { dumpTab, dumpWindow } = await import("../js/lib/actions.js");
const { closeDuplicates } = await import("../js/lib/dedup.js");
const { listActions, recordAction } = await import("../js/lib/journal.js");

const tab = (id, url, extra = {}) => ({
  id, windowId: 2, index: id, pinned: false, incognito: false,
  url, title: url, ...extra
});
const clear = async () => {
  live.clear();
  removed.length = 0;
  afterGet.clear();
  afterQuery = null;
  await storage.local.set({ inbox: {}, journal: [], counters: {} });
};

// Large duplicate cleanup must yield between bounded Chrome removals instead
// of delivering one 200+ tab event burst to every surface.
await clear();
const pacedTabs = Array.from({ length: 205 }, (_, index) =>
  tab(1000 + index, `https://paced-${index}.example/`));
for (const entry of pacedTabs) live.set(entry.id, entry);
const removeBatchSizes = [];
const yields = [];
const pacedTabsApi = {
  get: chrome.tabs.get,
  async remove(ids) {
    removeBatchSizes.push(ids.length);
    await chrome.tabs.remove(ids);
  }
};
const paced = await closeUnchangedLiveTabsInBatches(pacedTabs, pacedTabsApi, {
  batchSize: 20,
  yieldBetween: async () => { yields.push("yield"); }
});
assert.deepEqual(removeBatchSizes, [...Array(10).fill(20), 5]);
assert.equal(yields.length, 10, "205 closes yield between eleven bounded batches");
assert.equal(paced.closed.length, 205);

// The original no-Undo reproduction: an internal page becomes valuable after
// approval but before removal. The replacement must remain open.
await clear();
live.set(4, tab(4, "chrome://settings"));
afterGet.set(4, () => live.set(4, tab(4, "https://valuable.example/form")));
const unsafe = await closeUnsaveableTabsById([4]);
assert.equal(unsafe.reason, "changed");
assert.equal(live.get(4).url, "https://valuable.example/form");
assert.deepEqual(removed, []);

const captured = tab(5, "https://same.example/", { pendingUrl: "" });
for (const current of [
  { ...captured, url: "https://other.example/" },
  { ...captured, pendingUrl: "https://other.example/" },
  { ...captured, windowId: 3 },
  { ...captured, pinned: true },
  { ...captured, incognito: true }
]) {
  live.set(5, current);
  assert.deepEqual((await closeUnchangedLiveTabs([captured])).closed, []);
  assert.equal(live.has(5), true);
}

await clear();
live.set(6, tab(6, "https://captured.example/"));
afterGet.set(6, () => live.set(6, tab(6, "https://replacement.example/")));
const direct = await closeLiveTabsById([6]);
assert.equal(direct.ok, false);
assert.equal(live.get(6).url, "https://replacement.example/");
assert.equal((await listActions()).length, 0);

// Explicit close ledgers prevent a skipped tab that disappears independently
// from being attributed to this action or reopened by its Undo.
await clear();
const first = tab(7, "https://first.example/");
const second = tab(8, "https://second.example/");
live.set(7, first);
live.set(8, { ...second, url: "https://replacement.example/" });
const partial = await closeTabsWithReceipt([first, second], async () => {
  const outcome = await closeUnchangedLiveTabs([first, second]);
  live.delete(8);
  return outcome;
}, { label: "Closed 2 tabs" });
assert.equal(partial.closed, 1);
const partialEntry = (await listActions())[0];
assert.deepEqual(partialEntry.forwardReceipt.tabs.map(({ tabId }) => tabId), [7]);
assert.deepEqual(partialEntry.reopen[0].map(({ url }) => url), [first.url]);

// If the completion write fails after Chrome closes one exact target, the
// failure fallback persists that narrow ledger. Startup must not widen it when
// a skipped replacement disappears independently before recovery.
await clear();
const settlementClosed = tab(30, "https://settlement-closed.example/");
const settlementSkipped = tab(31, "https://settlement-skipped.example/");
live.set(30, settlementClosed);
live.set(31, { ...settlementSkipped, url: "https://replacement.example/" });
const nativeStorageSet = chrome.storage.local.set;
let rejectedCompletion = false;
chrome.storage.local.set = async (values) => {
  if (!rejectedCompletion && values.journal?.some((entry) =>
    entry.forwardReceipt?.status === "complete")) {
    rejectedCompletion = true;
    throw new Error("transient completion failure");
  }
  return nativeStorageSet(values);
};
await assert.rejects(closeTabsWithReceipt(
  [settlementClosed, settlementSkipped],
  () => closeUnchangedLiveTabs([settlementClosed, settlementSkipped]),
  { label: "Closed 2 tabs" }
));
chrome.storage.local.set = nativeStorageSet;
let interruptedEntry = (await listActions())[0];
assert.equal(interruptedEntry.forwardReceipt.status, "pending");
assert.deepEqual(interruptedEntry.forwardReceipt.confirmedTabs.map(({ tabId }) => tabId), [30]);
live.delete(31);
await recoverPendingLiveCloses();
interruptedEntry = (await listActions())[0];
assert.deepEqual(interruptedEntry.forwardReceipt.tabs.map(({ tabId }) => tabId), [30]);
assert.deepEqual(interruptedEntry.reopen[0].map(({ url }) => url), [settlementClosed.url]);

// A save/close persists the reviewed page but leaves its newly navigated live
// replacement open. Its saved-data inverse remains Undoable with no reopen.
await clear();
const saved = tab(10, "https://saved.example/");
live.set(10, saved);
live.set(11, tab(11, "https://window-survivor.example/"));
afterGet.set(10, () => live.set(10, tab(10, "https://edited-form.example/")));
const dumpResult = await dumpTab(10);
assert.equal(live.get(10).url, "https://edited-form.example/");
const savedItems = Object.values(storage.snapshot().inbox)
  .filter((item) => item && !item.deletedAt);
assert.deepEqual(savedItems[0].tabs.map(({ url }) => url), [saved.url]);
const savedEntry = (await listActions())[0];
assert.deepEqual(dumpResult, { n: 1, undoId: savedEntry.id });
assert.equal(savedEntry.dels.length, 1);
assert.deepEqual(savedEntry.reopen, []);
assert.deepEqual(savedEntry.forwardReceipt.tabs, []);

// Whole-window capture returns the identity of its own persisted operation,
// not whichever Activity entry happens to be newest when closing settles.
await clear();
live.set(40, tab(40, "https://window-first.example/"));
live.set(41, tab(41, "https://window-second.example/"));
const windowDumpResult = await dumpWindow(2);
const windowEntry = (await listActions())[0];
assert.deepEqual(windowDumpResult, { n: 2, undoId: windowEntry.id });
assert.equal(windowEntry.dels.length, 1);

// Insert another real journal receipt while Chrome removal is pending. Both
// capture operations must retain their own ID even though it is no longer newest.
const originalRemove = chrome.tabs.remove;
for (const capture of [() => dumpTab(40), () => dumpWindow(2)]) {
  await clear();
  live.set(40, tab(40, "https://capture.example/"));
  live.set(41, tab(41, "https://survivor.example/"));
  let unrelated;
  chrome.tabs.remove = async ids => {
    unrelated ??= await recordAction("Unrelated browser action", {
      reopen: [[{ url: "https://unrelated.example/", title: "Unrelated" }]]
    });
    return originalRemove(ids);
  };
  try {
    const receipt = await capture();
    const actions = await listActions();
    assert.equal(actions[0].id, unrelated.id);
    assert.notEqual(receipt.undoId, unrelated.id);
    assert.equal(actions.find(entry => entry.id === receipt.undoId).dels.length, 1);
  } finally {
    chrome.tabs.remove = originalRemove;
  }
}
await clear();
assert.deepEqual(await dumpWindow(2), { n: 0, undoId: null });
live.set(40, tab(40, "chrome://extensions/"));
assert.deepEqual(await dumpTab(40), { n: 0, undoId: null });
assert.deepEqual(await listActions(), []);

// The duplicate relation itself is re-scanned after receipt persistence; an
// unchanged candidate is not closed after its only survivor navigates away.
await clear();
live.set(20, tab(20, "https://duplicate.example/", { active: false }));
live.set(21, tab(21, "https://duplicate.example/", { active: true }));
afterQuery = () => live.set(21, tab(21, "https://now-unique.example/", { active: true }));
assert.equal(await closeDuplicates({ tabId: 20 }), 0);
assert.equal(live.get(20).url, "https://duplicate.example/");
assert.deepEqual(removed, []);
assert.equal((await listActions()).length, 0);

console.log("PASS: live close paths revalidate exact identity before remove");
