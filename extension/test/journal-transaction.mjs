import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const storage = createInterleavableStorage({ deviceId: "journal-test-device" });
const locks = createMockLockManager();
Object.defineProperty(globalThis, "navigator", {
  value: { locks }, configurable: true, writable: true
});

let createdTabs = 0;
let createdWindows = 0;
let failTabUrl = null;
const createdTabUrls = [];
globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://journal-test/${path}` },
  storage: { local: storage.local, onChanged: storage.onChanged },
  tabs: {
    create: async ({ url } = {}) => {
      if (url === failTabUrl) throw new Error("scripted tab-create failure");
      createdTabs += 1;
      createdTabUrls.push(url);
      return { id: 1000 + createdTabs };
    },
    move: async () => null
  },
  windows: { create: async () => { createdWindows += 1; return { id: 2000 + createdWindows }; } }
};
installBrowserMapStorageAuthority();

const { STORE_KEYS } = await import("../js/lib/types.js");
const { deleteSavedItem } = await import("../js/lib/saved-item-actions.js");
const { labelTabsFromItems } = await import("../js/lib/labels.js");
const {
  JOURNAL_KEY, listActions, recordAction, undoAction, recoverInterruptedUndos,
  clearJournalSafely
} = await import("../js/lib/journal.js");

const base = {
  id: "10000000-0000-4000-8000-000000000001",
  deviceId: "journal-test-device",
  createdAt: 100,
  modifiedAt: 100,
  schemaVersion: 1,
  kind: "tab",
  source: "manual",
  labels: [],
  tabs: [{ url: "https://example.com/", title: "Example" }]
};
await storage.local.set({ [STORE_KEYS.inbox]: { [base.id]: base }, [JOURNAL_KEY]: [] });

await labelTabsFromItems([{ item: base, indexes: [0] }], ["A"]);
const first = (await listActions())[0];
const afterA = storage.snapshot()[STORE_KEYS.inbox][base.id];
await labelTabsFromItems([{ item: afterA, indexes: [0] }], ["B"]);

const staleResult = await undoAction(first.id);
const staleState = storage.snapshot();
assert.equal(staleResult, null,
  "an older explicit Undo is refused after a later action changed the same record");
assert.deepEqual(staleState[STORE_KEYS.inbox][base.id].tabs[0].labels, ["A", "B"],
  "a stale Undo preserves every later label");
assert.equal(staleState[JOURNAL_KEY].find((entry) => entry.id === first.id)?.undoStatus, "stale",
  "the refused action becomes a terminal, truthful Activity entry");

const beforeDelete = storage.snapshot()[STORE_KEYS.inbox][base.id];
const setsBeforeDelete = storage.setLog.length;
const deleted = await deleteSavedItem(STORE_KEYS.inbox, beforeDelete, "Deleted Inbox item");
assert.equal(deleted.ok, true);
assert.deepEqual(storage.setLog.slice(setsBeforeDelete), [[JOURNAL_KEY, STORE_KEYS.inbox].sort()],
  "the tombstone and its exact inverse share one storage commit");
assert.equal(storage.snapshot()[STORE_KEYS.inbox][base.id].deletedAt > 0, true);
assert.equal((await undoAction(deleted.entry.id))?.undone, true);
assert.deepEqual(storage.snapshot()[STORE_KEYS.inbox][base.id].tabs[0].labels, ["A", "B"],
  "Undo restores the exact latest item that the atomic delete removed");

const archiveItem = {
  ...base,
  id: "10000000-0000-4000-8000-000000000002",
  kind: "window",
  modifiedAt: 200,
  labels: ["Research", "Read later"],
  tabs: [
    { url: "https://archive-one.example/", title: "Archive one",
      labels: ["Primary"], favIconUrl: "https://archive-one.example/icon.png" },
    { url: "https://archive-two.example/", title: "Archive two",
      labels: ["Secondary"] }
  ],
  archivedAt: 200,
  sourceWindowId: 72
};
await storage.local.set({
  [STORE_KEYS.archive]: { [archiveItem.id]: archiveItem },
  [JOURNAL_KEY]: []
});
const { openArchiveItem } = await import("../js/lib/archive.js");
assert.equal(await openArchiveItem(archiveItem), 2);
assert.equal(createdWindows, 1);
let archiveState = storage.snapshot();
assert.deepEqual(archiveState[STORE_KEYS.archive][archiveItem.id], archiveItem,
  "opening an archived item preserves its complete saved occurrence");
assert.deepEqual(archiveState[JOURNAL_KEY], [],
  "opening an archived item needs no Undo because it does not mutate saved data");

const { openTabsFromItems, restoreTabsFromItems } = await import("../js/lib/actions.js");
assert.equal(await openTabsFromItems([{ item: archiveItem, indexes: [0] }]), 1);
archiveState = storage.snapshot();
assert.deepEqual(archiveState[STORE_KEYS.archive][archiveItem.id], archiveItem,
  "the Archive row action preserves item labels, tab labels, and captured metadata");

const archiveOther = {
  ...base,
  id: "10000000-0000-4000-8000-000000000003",
  modifiedAt: 300,
  labels: ["Bulk"],
  tabs: [{ url: "https://archive-bulk.example/", title: "Archive bulk", labels: ["Chosen"] }],
  archivedAt: 300
};
await storage.local.set({
  [STORE_KEYS.archive]: { [archiveItem.id]: archiveItem, [archiveOther.id]: archiveOther },
  [JOURNAL_KEY]: []
});
assert.equal(await openTabsFromItems([
  { item: archiveItem, indexes: [1] },
  { item: archiveOther, indexes: [0] }
]), 2);
archiveState = storage.snapshot();
assert.deepEqual(archiveState[STORE_KEYS.archive], {
  [archiveItem.id]: archiveItem,
  [archiveOther.id]: archiveOther
}, "the Archive bulk action preserves every selected saved occurrence");
assert.deepEqual(archiveState[JOURNAL_KEY], [],
  "row and bulk Archive opens do not invent a no-op Undo entry");

const mixedUrlArchiveItem = {
  ...archiveOther,
  id: "10000000-0000-4000-8000-000000000004",
  kind: "window",
  tabs: [
    { url: "https://archive-valid-one.example/", title: "Valid one" },
    { url: "chrome://settings/", title: "Unsupported" },
    { url: "https://archive-valid-two.example/", title: "Valid two" }
  ]
};
const archiveWithMixedUrls = {
  [archiveItem.id]: archiveItem,
  [archiveOther.id]: archiveOther,
  [mixedUrlArchiveItem.id]: mixedUrlArchiveItem
};
await storage.local.set({
  [STORE_KEYS.archive]: archiveWithMixedUrls,
  [JOURNAL_KEY]: []
});
assert.equal(await openTabsFromItems([
  { item: mixedUrlArchiveItem, indexes: [0, 1, 2] }
]), 2, "Archive Open counts only the HTTP(S) URLs it actually opens");
archiveState = storage.snapshot();
assert.deepEqual(archiveState[STORE_KEYS.archive], archiveWithMixedUrls,
  "skipping an unsupported saved reference preserves the complete Archive occurrence");
assert.deepEqual(archiveState[JOURNAL_KEY], [],
  "skipping an unsupported saved reference does not create an Undo entry");

const partialFirst = {
  ...archiveOther,
  id: "10000000-0000-4000-8000-000000000006",
  tabs: [{ url: "https://archive-opened-before-error.example/", title: "Opened first" }]
};
const partialSecond = {
  ...archiveOther,
  id: "10000000-0000-4000-8000-000000000007",
  tabs: [{ url: "https://archive-create-error.example/", title: "Fails second" }]
};
const archiveBeforePartialFailure = {
  ...archiveWithMixedUrls,
  [partialFirst.id]: partialFirst,
  [partialSecond.id]: partialSecond
};
await storage.local.set({
  [STORE_KEYS.archive]: archiveBeforePartialFailure,
  [JOURNAL_KEY]: []
});
failTabUrl = partialSecond.tabs[0].url;
await assert.rejects(
  openTabsFromItems([
    { item: partialFirst, indexes: [0] },
    { item: partialSecond, indexes: [0] }
  ]),
  /scripted tab-create failure/
);
failTabUrl = null;
assert.equal(createdTabUrls.includes(partialFirst.tabs[0].url), true,
  "a valid first bulk source opens before the second source fails");
archiveState = storage.snapshot();
assert.deepEqual(archiveState[STORE_KEYS.archive], archiveBeforePartialFailure,
  "partial bulk failure preserves the entire Archive map exactly");
assert.deepEqual(archiveState[JOURNAL_KEY], [],
  "a failed Archive open has no saved-data mutation to undo");

const inboxItem = {
  ...archiveItem,
  id: "10000000-0000-4000-8000-000000000005",
  modifiedAt: 500,
  archivedAt: undefined
};
await storage.local.set({
  [STORE_KEYS.inbox]: { [inboxItem.id]: inboxItem },
  [JOURNAL_KEY]: []
});
assert.equal(await restoreTabsFromItems([{ item: inboxItem, indexes: [0] }]), 1);
const inboxState = storage.snapshot();
assert.deepEqual(inboxState[STORE_KEYS.inbox][inboxItem.id].tabs, [inboxItem.tabs[1]],
  "Inbox Restore remains consuming and keeps only the unselected remainder");
assert.equal(inboxState[JOURNAL_KEY].length, 1,
  "Inbox Restore retains its exact Undo journal entry");

await storage.local.set({ [JOURNAL_KEY]: [] });
createdTabs = 0;
const close = await recordAction("Closed one tab", {
  reopen: [[{ url: "https://closed.example/", title: "Closed" }]]
});
const concurrent = await Promise.all([undoAction(close.id), undoAction(close.id)]);
assert.equal(concurrent.filter(Boolean).length, 1,
  "only one concurrent caller can own an Undo");
assert.equal(createdTabs, 1,
  "one concurrent Undo request reopens the page exactly once");

await storage.local.set({ [JOURNAL_KEY]: [] });
const interrupted = await recordAction("Interrupted Undo", {
  reopen: [[{ url: "https://interrupted.example/", title: "Interrupted" }]]
});
const interruptedJournal = (await storage.local.get(JOURNAL_KEY))[JOURNAL_KEY];
interruptedJournal[0].undoClaim = {
  id: "claim-from-stopped-worker", at: Date.now(), phase: "effects"
};
await storage.local.set({ [JOURNAL_KEY]: interruptedJournal });
assert.equal(await recoverInterruptedUndos(), 1);
const recovered = (await listActions()).find((entry) => entry.id === interrupted.id);
assert.equal(recovered.undoStatus, "incomplete");
assert.equal(await undoAction(interrupted.id), null,
  "a browser-effect claim from a stopped worker is terminal and never replayed");
assert.equal(createdTabs, 1,
  "worker recovery cannot duplicate a browser reopen whose outcome is unknown");

const originalLockRequest = locks.request;
let undoRecoveryLocks = 0;
locks.request = (...args) => {
  undoRecoveryLocks += 1;
  return originalLockRequest(...args);
};
assert.equal(await recoverInterruptedUndos(), 0);
assert.equal(undoRecoveryLocks, 0,
  "startup with no interrupted Undo never acquires the shared Store lock");
locks.request = originalLockRequest;

// A positive preflight is only a hint. A different context can finish the
// claim before this worker obtains the exclusive repair lock.
const changedClaim = [{ ...interruptedJournal[0], undoStatus: undefined }];
await storage.local.set({ [JOURNAL_KEY]: changedClaim });
locks.request = async (...args) => {
  locks.request = originalLockRequest;
  await storage.local.set({ [JOURNAL_KEY]: [{
    ...changedClaim[0], undoStatus: "incomplete", undoClaim: undefined
  }] });
  return originalLockRequest(...args);
};
assert.equal(await recoverInterruptedUndos(), 0,
  "a real repair rechecks the latest claim under the lock");
locks.request = originalLockRequest;

await storage.local.set({
  [JOURNAL_KEY]: [{
    id: "forward-in-flight", at: Date.now(), label: "Closing one tab",
    puts: [], dels: [], reopen: [[{ url: "https://pending.example/" }]], moves: [],
    forwardReceipt: { kind: "close-tabs", status: "pending", tabs: [] }
  }]
});
assert.deepEqual(await clearJournalSafely(), { ok: false, reason: "busy" },
  "Activity cannot erase an in-flight close receipt");
assert.equal((await listActions()).length, 1,
  "a refused clear preserves the receipt for its owner or startup recovery");
const pendingJournal = (await storage.local.get(JOURNAL_KEY))[JOURNAL_KEY];
pendingJournal[0].forwardReceipt.status = "complete";
await storage.local.set({ [JOURNAL_KEY]: pendingJournal });
assert.deepEqual(await clearJournalSafely(), { ok: true });
assert.equal((await listActions()).length, 0,
  "Activity clears after every browser-effect receipt reaches a terminal state");

console.log("PASS: Journal stale guard and single-owner Undo transaction");
