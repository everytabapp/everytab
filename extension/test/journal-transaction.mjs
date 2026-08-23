import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";

const storage = createInterleavableStorage({ deviceId: "journal-test-device" });
const locks = createMockLockManager();
Object.defineProperty(globalThis, "navigator", {
  value: { locks }, configurable: true, writable: true
});

let createdTabs = 0;
let createdWindows = 0;
globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://journal-test/${path}` },
  storage: { local: storage.local, onChanged: storage.onChanged },
  tabs: {
    create: async () => { createdTabs += 1; return { id: 1000 + createdTabs }; },
    move: async () => null
  },
  windows: { create: async () => { createdWindows += 1; return { id: 2000 + createdWindows }; } }
};

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
  tabs: [
    { url: "https://archive-one.example/", title: "Archive one" },
    { url: "https://archive-two.example/", title: "Archive two" }
  ],
  archivedAt: 200
};
await storage.local.set({
  [STORE_KEYS.archive]: { [archiveItem.id]: archiveItem },
  [JOURNAL_KEY]: []
});
const { restoreArchiveItem } = await import("../js/lib/archive.js");
assert.equal(await restoreArchiveItem(archiveItem), 2);
assert.equal(createdWindows, 1);
let archiveState = storage.snapshot();
assert.equal(archiveState[STORE_KEYS.archive][archiveItem.id].deletedAt > 0, true);
const archiveRestoreEntry = archiveState[JOURNAL_KEY][0];
assert.equal(archiveRestoreEntry.undoContractVersion, 1,
  "Archive Restore all uses the same sealed Journal path as row Restore");
await undoAction(archiveRestoreEntry.id);
archiveState = storage.snapshot();
assert.equal(archiveState[STORE_KEYS.archive][archiveItem.id].deletedAt, undefined,
  "Archive Restore all has one exact Undo");

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
