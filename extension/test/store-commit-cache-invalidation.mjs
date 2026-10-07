import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA, RECOVERY_STORES } from "../js/lib/storage/schema.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

/*
 * commitMaps commits the Library transaction first and performs ordered
 * Recovery deletions afterwards. When a Recovery deletion rejects, the Library
 * commit has already happened. This writer's per-context read cache must not
 * keep the pre-commit state in that case; the next read has to be fresh.
 */

const storage = createInterleavableStorage({});
globalThis.chrome = { storage: { local: storage.local, onChanged: storage.onChanged } };
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

let rejectDelete = false;
const libraryAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const recoveryAdapter = createMemoryIndexedDbAdapter(RECOVERY_SCHEMA);
const library = createLibraryStore({ adapter: libraryAdapter, deviceId: "cache-review" });
const recovery = createRecoveryStore({ adapter: {
  ...recoveryAdapter,
  transaction: (names, mode, work) => recoveryAdapter.transaction(names, mode, (tx) => work({
    ...tx,
    delete: async (store, id) => {
      if (rejectDelete && store === RECOVERY_STORES.snapshots) throw new Error("Recovery failure");
      return tx.delete(store, id);
    }
  }))
} });
const authority = createStorageAuthority({
  library, recovery, readBrowserLocal: (keys) => storage.local.get(keys)
});
setStorageAuthorityForTests(authority);

const { STORE_KEYS } = await import("../js/lib/types.js");
const { listItems, mutateStores, readStoreMap } = await import("../js/lib/store.js");
const { JOURNAL_KEY, appendedJournal, makeJournalEntry } = await import("../js/lib/journal.js");

const snapshot = {
  id: "00000000-0000-4000-8000-000000000077",
  deviceId: "cache-review", schemaVersion: 1, createdAt: 10, modifiedAt: 10,
  name: "Snapshot", auto: true, labels: [],
  windows: [[{ url: "https://snapshot.example/", title: "Snapshot tab" }]]
};
await recovery.captureSnapshot(snapshot, { id: snapshot.id, capturedAt: 10, retention: 200 });

// Populate this context's read cache with the pre-commit state.
assert.equal((await listItems(STORE_KEYS.sessions)).length, 1);
const journalBefore = await readStoreMap(JOURNAL_KEY);
assert.equal(Array.isArray(journalBefore) ? journalBefore.length : 0, 0,
  "the Undo journal starts empty in this context's cache");

// Tombstone the Snapshot and record the Undo entry in one mutation. The
// Library commit (journal) succeeds; the ordered Recovery deletion rejects.
rejectDelete = true;
await assert.rejects(mutateStores([STORE_KEYS.sessions, JOURNAL_KEY], (maps) => {
  const now = Date.now();
  const sessions = { ...maps[STORE_KEYS.sessions] };
  sessions[snapshot.id] = { ...sessions[snapshot.id], deletedAt: now, modifiedAt: now };
  const entry = makeJournalEntry("Deleted Snapshot", {
    puts: [{ store: STORE_KEYS.sessions, item: structuredClone(snapshot) }]
  });
  return {
    [STORE_KEYS.sessions]: sessions,
    [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
  };
}), /Recovery failure/, "the mutation reports the Recovery deletion failure");
rejectDelete = false;

const durable = await authority.readMaps([JOURNAL_KEY, STORE_KEYS.sessions]);
assert.equal(durable[JOURNAL_KEY].length, 1,
  "the Library commit carrying the journal entry completed before the Recovery failure");
assert.equal(durable[STORE_KEYS.sessions][snapshot.id]?.deletedAt, undefined,
  "the Recovery database still holds the Snapshot the deletion could not remove");

// This writer's next cached reads must match the durable state, not the
// pre-commit snapshot it read before the failed commit.
const journalAfter = await readStoreMap(JOURNAL_KEY);
assert.equal(journalAfter.length, 1,
  "the context's next journal read is fresh after a post-Library commit failure");
assert.equal(journalAfter[0].label, "Deleted Snapshot");
const sessionsAfter = await listItems(STORE_KEYS.sessions);
assert.equal(sessionsAfter.length, 1, "the live Snapshot remains listed from fresh state");

// A later successful commit still behaves normally.
await mutateStores([STORE_KEYS.sessions, JOURNAL_KEY], (maps) => {
  const now = Date.now();
  const sessions = { ...maps[STORE_KEYS.sessions] };
  sessions[snapshot.id] = { ...sessions[snapshot.id], deletedAt: now, modifiedAt: now };
  return { [STORE_KEYS.sessions]: sessions, [JOURNAL_KEY]: maps[JOURNAL_KEY] ?? [] };
});
assert.equal((await listItems(STORE_KEYS.sessions)).length, 0);
assert.equal(await recovery.readSnapshot(snapshot.id), null);

console.log("PASS: a commit that fails after the Library write never leaves this writer's cache stale");
