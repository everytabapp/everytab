import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

const storage = createInterleavableStorage({});
globalThis.chrome = { storage: { local: storage.local, onChanged: storage.onChanged } };
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const library = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), deviceId: "journal-safety",
  now: () => 1_000
});
const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
const authority = createStorageAuthority({
  library, recovery, readBrowserLocal: (keys) => storage.local.get(keys)
});
setStorageAuthorityForTests(authority);
const { deleteSavedItem } = await import("../js/lib/saved-item-actions.js");
const { mutateStores, mutateNamedSessionStores } = await import("../js/lib/store.js");
const { JOURNAL_KEY, makeJournalEntry, appendedJournal, listActions, recordAction } =
  await import("../js/lib/journal.js");
const { ARCHIVE_OVERLAY_KEY } = await import("../js/lib/types.js");
const { undoActionResult } = await import("../js/lib/journal.js");

const record = {
  id: "00000000-0000-4000-8000-000000000001", deviceId: "other-device",
  createdAt: 1, modifiedAt: 2, schemaVersion: 1,
  kind: "tab", source: "manual", labels: ["keep"],
  tabs: [{ url: "https://kept.example/", title: "Kept", labels: ["reference"] }]
};
const put = (value) => library.transact([{ type: "put", family: "inbox", id: value.id, value }]);
const read = () => authority.readItem("inbox", record.id);

await put(record);
const deletion = await deleteSavedItem("inbox", await read(), "Deleted saved item");
assert.equal(deletion.ok, true);
assert.equal((await undoActionResult(deletion.entry.id)).status, "undone",
  "Undo must match the deletion marker actually persisted by the Library");
const restored = await read();
assert.deepEqual(restored.tabs, record.tabs);
assert.deepEqual(restored.labels, record.labels);
assert.equal(restored.deviceId, record.deviceId);

// A later delete of the same record must not match an older Undo, even when
// both physical deletion markers share the same wall clock and device.
const firstDelete = await deleteSavedItem("inbox", await read(), "First delete");
const firstMarker = await read();
await put(record);
await library.transact([{ type: "delete", family: "inbox", id: record.id }]);
const laterMarker = await read();
assert.equal(firstMarker.deletedAt, laterMarker.deletedAt);
assert.equal((await undoActionResult(firstDelete.entry.id)).status, "stale",
  "an older Undo cannot revive a record deleted again in the same millisecond");
assert.ok((await read()).deletedAt);

// A receipt-only commit has no written record maps. Keep the descriptors
// already sealed by the Store from its additional read-only target maps.
await put(record);
const receipt = await recordAction("Receipt", { puts: [{ store: "inbox", item: record }] });
assert.equal((await undoActionResult(receipt.id)).status, "undone",
  "a journal-only commit cannot replace its live target descriptor with absence");

// Named-Session and Archive-overlay mutations use alternate logical map keys.
// Their Undo must still be sealed against the records that a later read sees.
for (const [family, key, commit] of [
  ["sessions", "sessions", mutateNamedSessionStores],
  ["archive", ARCHIVE_OVERLAY_KEY, mutateStores]
]) {
  const value = family === "sessions"
    ? { ...record, name: "Saved", auto: false, windows: [record.tabs] }
    : { ...record, archivedAt: 10 };
  await library.transact([{ type: "put", family, id: value.id, value }]);
  const fresh = await authority.readItem(family, value.id);
  await commit([key, JOURNAL_KEY], (maps) => ({
    [key]: { ...(maps[key] ?? {}), [value.id]: { ...fresh, deletedAt: 500, modifiedAt: 500 } },
    [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], makeJournalEntry("Deleted", {
      puts: [{ store: family, item: fresh }]
    }))
  }));
  assert.equal((await undoActionResult((await listActions())[0].id)).status, "undone",
    `${family} Undo uses the committed deletion representation`);
  assert.deepEqual((await authority.readItem(family, value.id)).labels, value.labels);
}

// The finalizer must also preserve read-only targets in a mixed commit. The
// Store saw Archive to seal the receipt; commitMaps receives only changed keys.
await put(record);
const archiveBefore = await authority.readItem("archive", record.id);
const priorJournal = await listActions();
await mutateStores(["inbox", "archive", JOURNAL_KEY], (maps) => ({
  inbox: { ...maps.inbox, [record.id]: { ...maps.inbox[record.id], deletedAt: 700, modifiedAt: 700 } },
  [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], makeJournalEntry("Mixed receipt", {
    puts: [
      { store: "inbox", item: maps.inbox[record.id] },
      { store: "archive", item: maps.archive[record.id] }
    ]
  }))
}));
const mixedJournal = await listActions();
assert.deepEqual(mixedJournal.slice(1), priorJournal, "earlier entries are not resealed");
assert.equal((await undoActionResult(mixedJournal[0].id)).status, "undone");
assert.deepEqual((await read()).tabs, record.tabs);
assert.deepEqual((await authority.readItem("archive", record.id)).tabs, archiveBefore.tabs);

// Finalizer validation and failure must roll back records, versions, outbox,
// and local companion state together. No second repair write is acceptable.
const atomic = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), deviceId: "atomic", now: () => 100
});
await atomic.commit({ localSets: { receipt: { before: true } } });
for (const finalizeLocalSets of [
  () => { throw new Error("injected finalizer failure"); },
  () => ({ receipt: {}, extra: true }),
  () => ({}),
  () => Promise.resolve({ receipt: {} }),
  () => ({ receipt: undefined })
]) {
  await assert.rejects(atomic.commit({
    operations: [{ type: "put", family: "inbox", id: record.id, value: record }],
    localSets: { receipt: { pending: true } },
    finalizeLocalSets
  }));
  assert.equal(await atomic.readEntity("inbox", record.id), null);
  assert.deepEqual(await atomic.readLocal(["receipt"]), { receipt: { before: true } });
  assert.equal((await atomic.readSyncBatch()).changes.length, 0);
}
const finalized = await atomic.commit({
  operations: [{ type: "delete", family: "inbox", id: record.id }],
  localSets: { receipt: { pending: true } },
  finalizeLocalSets: ({ changes, localSets }) => {
    const version = structuredClone(changes[0].entity.version);
    changes[0].entity.id = "cannot-change-the-record";
    return { ...localSets, receipt: { version } };
  }
});
assert.equal(finalized.throughSequence, 1, "failed commits do not consume sequence numbers");
const storedDeletion = await atomic.readEntity("inbox", record.id, { includeDeleted: true });
assert.equal(storedDeletion.id, record.id);
assert.deepEqual((await atomic.readLocal(["receipt"])).receipt.version, storedDeletion.version);

console.log("PASS: production Library deletion Undo and same-clock stale protection");
