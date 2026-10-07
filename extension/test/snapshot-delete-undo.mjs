import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import * as recoveryModule from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, LIBRARY_STORES, RECOVERY_SCHEMA, RECOVERY_STORES } from "../js/lib/storage/schema.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

const storage = createInterleavableStorage({});
const { createRecoveryStore, MAX_RECOVERY_DELETION_MARKERS } = recoveryModule;
globalThis.chrome = { storage: { local: storage.local, onChanged: storage.onChanged } };
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
let rejectJournal = false;
let rejectDelete = false;
const libraryAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const recoveryAdapter = createMemoryIndexedDbAdapter(RECOVERY_SCHEMA);
const library = createLibraryStore({ adapter: {
  ...libraryAdapter,
  transaction: (names, mode, work) => libraryAdapter.transaction(names, mode, (tx) => work({
    ...tx,
    put: async (store, value) => {
      if (rejectJournal && store === LIBRARY_STORES.local && value.key === "journal") throw new Error("Journal failure");
      return tx.put(store, value);
    }
  }))
}, deviceId: "snapshot-review" });
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
const { listItems } = await import("../js/lib/store.js");
const { deleteSavedItem } = await import("../js/lib/saved-item-actions.js");
const { listActions, undoActionResult } = await import("../js/lib/journal.js");

const snapshot = {
  id: "00000000-0000-4000-8000-000000000099",
  deviceId: "snapshot-review", schemaVersion: 1, createdAt: 10, modifiedAt: 10,
  name: "Snapshot", auto: true,
  labels: ["kept"],
  windows: [[{
    url: "https://snapshot.example/", title: "Snapshot tab",
    labels: ["reference"], favIconUrl: "data:image/png;base64,AQIDBA=="
  }]]
};
await recovery.captureSnapshot(snapshot, { id: snapshot.id, capturedAt: 10, retention: 200 });
const fresh = (await listItems(STORE_KEYS.sessions)).find((item) => item.id === snapshot.id);
const deleted = await deleteSavedItem(STORE_KEYS.sessions, fresh, "Deleted Snapshot");
assert.equal(deleted.ok, true);
assert.equal(await recovery.readSnapshot(snapshot.id), null);
assert.equal((await recovery.listSnapshots()).length, 0);
assert.equal((await listItems(STORE_KEYS.sessions)).length, 0);
assert.equal((await recovery.exportRecoveryPack()).snapshots.length, 0);
const result = await undoActionResult(deleted.entry.id);
assert.equal(result.status, "undone", "Immediate Snapshot Delete Undo must restore its saved windows");
assert.deepEqual((await recovery.readSnapshot(snapshot.id)).value.windows, snapshot.windows);
assert.equal((await recovery.readDeletionMarkers()).length, 0);
const realNow = Date.now;
Date.now = () => 0;
assert.equal(recoveryModule.makeRecoveryDeletionMarker("epoch").deletedAt, 1,
  "logical maps use a positive deletedAt to distinguish a deletion");
Date.now = realNow;
await assert.rejects(recovery.deleteSnapshot(snapshot.id, {
  marker: { ...recoveryModule.makeRecoveryDeletionMarker(snapshot.id), deletedAt: 0 }
}), /deletion identity/);

const capture = (value, retention = 200) => recovery.captureSnapshot(value, {
  id: value.id, capturedAt: value.createdAt, retention
});
const current = async () => (await authority.readMaps([STORE_KEYS.sessions])).sessions[snapshot.id];
const remove = async () => deleteSavedItem(STORE_KEYS.sessions, await current(), "Deleted Snapshot");

// Unrelated captures do not invalidate Undo; the marker belongs to this ID.
const deletion = await remove();
await capture({ ...snapshot, id: "other-snapshot" });
assert.equal((await undoActionResult(deletion.entry.id)).status, "undone");

// Replacement and repeated deletion in the same clock tick cannot satisfy
// an older receipt. A raw Recovery deletion also advances the identity.
const actualNow = Date.now;
Date.now = () => 1000;
try {
  const first = await remove();
  const firstMarker = await current();
  await capture(snapshot);
  await recovery.deleteSnapshot(snapshot.id);
  const secondMarker = await current();
  assert.equal(firstMarker.deletedAt, secondMarker.deletedAt);
  assert.notEqual(firstMarker.deletionRevision, secondMarker.deletionRevision);
  assert.equal((await undoActionResult(first.entry.id)).status, "stale");
  assert.equal(await recovery.readSnapshot(snapshot.id), null);
} finally { Date.now = actualNow; }

await capture(snapshot);
const replaced = await remove();
const newer = { ...snapshot, windows: [[{ url: "https://newer.example/", labels: ["keep"] }]] };
await capture(newer);
assert.equal((await undoActionResult(replaced.entry.id)).status, "stale");
assert.deepEqual((await recovery.readSnapshot(snapshot.id)).value, newer);

// Recreating and then evicting the same ID must not revive the old deletion.
const evicted = await remove();
await capture(newer);
await capture({ ...snapshot, id: "retention-winner" }, 1);
assert.equal(await recovery.readSnapshot(snapshot.id), null);
assert.equal((await undoActionResult(evicted.entry.id)).status, "stale");

// The two databases cannot share one transaction. Failed Library persistence
// must prevent deletion; failed Recovery deletion must keep the snapshot live.
await capture(snapshot);
const beforeFailure = await listActions();
rejectJournal = true;
await assert.rejects(remove(), /Journal failure/);
rejectJournal = false;
assert.deepEqual(await listActions(), beforeFailure);
assert.deepEqual((await recovery.readSnapshot(snapshot.id)).value, snapshot);
rejectDelete = true;
const recoveryRows = () => recoveryAdapter.transaction(Object.values(RECOVERY_STORES), "readonly", async (tx) =>
  Promise.all(Object.values(RECOVERY_STORES).map((store) => tx.getAll(store))));
const beforeRecoveryFailure = await recoveryRows();
await assert.rejects(remove(), /Recovery failure/);
rejectDelete = false;
assert.deepEqual(await recoveryRows(), beforeRecoveryFailure, "failed deletion rolls back assets, order and markers too");
assert.deepEqual((await recovery.readSnapshot(snapshot.id)).value, snapshot);
const freshMaps = await authority.readMaps(["journal", "sessions"]);
const failedReceipt = freshMaps.journal[0];
const { journalStaleStores } = await import("../js/lib/journal-state.js");
assert.deepEqual(journalStaleStores(failedReceipt, freshMaps), ["sessions"]);
const retried = await remove();
assert.equal((await undoActionResult(retried.entry.id)).status, "undone");

// Undo's Recovery capture precedes its Library receipt update. If that later
// write fails, the recovered copy remains, and the unchanged receipt is stale.
const inverseFailure = await remove();
rejectJournal = true;
await assert.rejects(undoActionResult(inverseFailure.entry.id), /Journal failure/);
rejectJournal = false;
assert.deepEqual((await recovery.readSnapshot(snapshot.id)).value.windows, snapshot.windows);
assert.equal((await undoActionResult(inverseFailure.entry.id)).status, "stale");

// A named Session must remain visible even if a former Snapshot shares its ID.
const collision = await remove();
const named = { ...snapshot, auto: false, name: "Named Session" };
await library.transact([{ type: "put", family: "sessions", id: named.id, value: named }]);
assert.deepEqual(await current(), named);
assert.equal((await undoActionResult(collision.entry.id)).status, "stale");
await library.transact([{ type: "delete", family: "sessions", id: named.id }]);
// Use a different ID for the remaining cap test, avoiding that named tombstone.
snapshot.id = "snapshot-marker-cap";
await capture(snapshot);

// Bounded markers contain no URLs/assets, stay out of Vault packs and can
// expire safely: an old receipt then becomes stale rather than guessing.
const expired = await remove();
for (let index = 0; index <= MAX_RECOVERY_DELETION_MARKERS; index++) {
  const value = { ...snapshot, id: `bounded-${index}` };
  await capture(value);
  await recovery.deleteSnapshot(value.id);
}
const markers = await recovery.readDeletionMarkers();
assert.equal(markers.length, MAX_RECOVERY_DELETION_MARKERS);
assert.ok(markers.every((marker) => !marker.windows && !marker.tabs && !marker.favIconUrl));
assert.equal((await undoActionResult(expired.entry.id)).status, "stale");
assert.equal(JSON.stringify(await recovery.exportRecoveryPack()).includes("deletionRevision"), false);

// Malformed local metadata cannot disable captures or Session reads. Dropping
// unusable markers is conservative: matching an old Undo becomes impossible.
for (const value of [{ invalid: true }, [null, { id: "bad" }]]) {
  await recoveryAdapter.transaction([RECOVERY_STORES.meta], "readwrite", (tx) =>
    tx.put(RECOVERY_STORES.meta, { key: "snapshotDeletions", value }));
  assert.deepEqual(await recovery.readDeletionMarkers(), []);
  await capture(snapshot);
  assert.deepEqual((await current()).windows, snapshot.windows);
  await recovery.deleteSnapshot(snapshot.id);
  assert.equal((await recovery.readDeletionMarkers()).length, 1);
}
console.log("PASS: Snapshot Delete Undo");
