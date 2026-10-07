/** Durable repair after a remote/Restore commit outlives its projection update. */
import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createMockLockManager } from "./e2-mocks.mjs";

const locks = createMockLockManager();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks } });
const browserLocal = {};
const published = [];
globalThis.chrome = { storage: {
  local: {
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .filter(key => Object.hasOwn(browserLocal, key)).map(key => [key, browserLocal[key]]));
    },
    async set(values) { Object.assign(browserLocal, structuredClone(values)); published.push(values); }
  },
  onChanged: { addListener() {}, removeListener() {} }
} };
const { commitLibraryChange, mutateNamedSessionStores } = await import("../js/lib/store.js");
const { publishStorageRevision, setStorageAuthorityForTests } = await import("../js/lib/storage/authority-runtime.js");
const PENDING = "storageV2PendingLibraryRevision";
const make = (adapter, deviceId) => createLibraryStore({ adapter, deviceId,
  now: () => 1_000, createId: () => `${deviceId}-source` });
const session = { id: "remote-session", name: "Remote Session", auto: false,
  windows: [[{ url: "https://remote.example", title: "Remote" }]], labels: [] };

for (const mode of ["batch", "checkpoint", "restore"]) {
  for (const failure of ["revision-write", "recovery-read"]) {
    const base = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
    let fail = false;
    const adapter = { transaction: (names, access, work) => base.transaction(names, access, tx =>
      work({ ...tx, put: async (name, value) => {
        if (fail && failure === "revision-write" && name === "local" &&
            value.key === "storageV2DurableRevision") throw new Error("injected revision failure");
        return tx.put(name, value);
      } })) };
    let destination = make(adapter, `destination-${mode}-${failure}`);
    const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
    const originalList = recovery.listSnapshots;
    recovery.listSnapshots = async options => {
      if (fail && failure === "recovery-read") throw new Error("injected recovery read failure");
      return originalList(options);
    };
    let authority = createStorageAuthority({ library: destination, recovery });
    const source = make(createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), "source");
    await source.transact([{ type: "put", family: "sessions", id: session.id, value: session }]);
    const batch = await source.readSyncBatch();
    const checkpoint = await source.createExactCheckpoint();
    const state = await source.readReplicationState();
    const preview = await destination.previewExactRestore(checkpoint);
    const apply = () => mode === "batch" ? destination.applyRemoteBatch(batch)
      : mode === "checkpoint" ? destination.applyRemoteCheckpoint({
        deviceId: state.deviceId, sourceId: state.sourceId,
        throughSequence: state.sequence, checkpoint
      }) : destination.replaceFromCheckpoint(checkpoint, {
        expectedSequence: preview.currentSequence, expectedRestoreEpoch: preview.restoreEpoch,
        expectedStateHash: preview.currentStateHash, restoreId: "repair-restore"
      });
    fail = true;
    await assert.rejects(commitLibraryChange(apply, { authority }), /injected/);
    assert.ok(await destination.readEntity("sessions", session.id),
      "the injected failure occurs after the record committed");
    const failedLocal = await destination.readLocal([PENDING, "sessionIdentityIndex"]);
    assert.deepEqual(failedLocal[PENDING], ["sessions"]);
    assert.equal(failedLocal.sessionIdentityIndex, undefined,
      "a failed companion revision cannot leave only half of its projection commit");
    fail = false;
    // New Library/authority instances deliberately retain only the persistent adapter state.
    await destination.close();
    destination = make(adapter, `destination-${mode}-${failure}`);
    authority = createStorageAuthority({ library: destination, recovery });
    if (failure === "revision-write") {
      await commitLibraryChange(async () => ({ changedFamilies: [] }), { authority });
    } else {
      // The same drain is used when a reopened runtime publishes its durable revision.
      await publishStorageRevision([], {}, { authority });
    }
    const local = await destination.readLocal(["sessionIdentityIndex", PENDING]);
    assert.equal(local.sessionIdentityIndex?.sessionsById[session.id]?.name, session.name,
      `${mode}/${failure}: a no-change retry after reopening must repair Session identity`);
    assert.equal(local[PENDING], undefined, "projection and pending-marker retirement commit together");
    const revision = await authority.readPendingRevision();
    assert.ok(revision.changedKeys.includes("sessions"));
    assert.equal(browserLocal.storageV2Revision.id, revision.id);
    const revisionId = revision.id;
    await commitLibraryChange(async () => ({ changedFamilies: [] }), { authority });
    assert.equal((await authority.readPendingRevision()).id, revisionId,
      "a settled no-change retry does not invent another revision");
  }
}

// A failed repair-intent write must roll back the remote record and cursor too.
const markerBase = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const markerDestination = make({ transaction: (names, mode, work) =>
  markerBase.transaction(names, mode, tx => work({ ...tx, put: async (name, value) => {
    if (name === "local" && value.key === PENDING) throw new Error("injected marker failure");
    return tx.put(name, value);
  } })) }, "marker-destination");
const markerSource = make(createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), "marker-source");
await markerSource.transact([{ type: "put", family: "sessions", id: session.id, value: session }]);
await assert.rejects(markerDestination.applyRemoteBatch(await markerSource.readSyncBatch()), /marker failure/);
assert.equal(await markerDestination.readEntity("sessions", session.id), null);
assert.deepEqual((await markerDestination.readReplicationState()).replicas, []);

// Consecutive committed families survive together until one complete repair.
const unionDestination = make(createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), "union-destination");
const unionSource = make(createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), "union-source");
await unionSource.transact([{ type: "put", family: "sessions", id: session.id, value: session }]);
await unionDestination.applyRemoteBatch(await unionSource.readSyncBatch());
await unionSource.transact([{ type: "put", family: "inbox", id: "second-family", value: { id: "second-family", tabs: [] } }]);
await unionDestination.applyRemoteBatch(await unionSource.readSyncBatch());
const unionAuthority = createStorageAuthority({ library: unionDestination,
  recovery: createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) }) });
await commitLibraryChange(async () => ({ changedFamilies: [] }), { authority: unionAuthority });
assert.ok((await unionAuthority.readPendingRevision()).changedKeys.includes("sessions"));
assert.ok((await unionAuthority.readPendingRevision()).changedKeys.includes("inbox"));

// An ordinary named edit must see repaired membership before its mutator runs.
const editDestination = make(createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), "edit-destination");
const editRecovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
const editAuthority = createStorageAuthority({ library: editDestination, recovery: editRecovery });
await editAuthority.commitLibraryRevision(["sessions"]); // Valid, empty membership index.
await editDestination.applyRemoteBatch(await markerSource.readSyncBatch());
setStorageAuthorityForTests(editAuthority);
await mutateNamedSessionStores(["sessions", "sessionIdentityIndex"], maps => {
  assert.equal(maps.sessionIdentityIndex.sessionsById[session.id]?.name, session.name,
    "a valid-looking stale index must be repaired before an ordinary mutation reads it");
  return { sessions: { ...maps.sessions, [session.id]: { ...maps.sessions[session.id], name: "Edited locally" } } };
});
assert.equal((await editDestination.readEntity("sessions", session.id)).value.name, "Edited locally");
assert.equal((await editDestination.readLocal([PENDING]))[PENDING], undefined);
setStorageAuthorityForTests(null);

// The reopen publication drain schedules a failed repair instead of blocking startup.
const retryDestination = make(createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), "retry-destination");
await retryDestination.applyRemoteBatch(await markerSource.readSyncBatch());
const retryRecovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
const retryList = retryRecovery.listSnapshots;
let rejectRepair = true;
retryRecovery.listSnapshots = options => {
  if (rejectRepair) throw new Error("injected startup repair failure");
  return retryList(options);
};
const retryAuthority = createStorageAuthority({ library: retryDestination, recovery: retryRecovery });
const nativeSetTimeout = globalThis.setTimeout;
const retries = [];
try {
  globalThis.setTimeout = (callback, delay) => { retries.push({ callback, delay }); return retries.length; };
  assert.equal(await publishStorageRevision([], {}, { authority: retryAuthority }), false);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].delay, 250);
  assert.deepEqual((await retryDestination.readLocal([PENDING]))[PENDING], ["sessions"]);
  rejectRepair = false;
  retries.shift().callback();
  await new Promise(resolve => nativeSetTimeout(resolve, 0));
  assert.equal((await retryDestination.readLocal([PENDING]))[PENDING], undefined);
  assert.equal((await retryDestination.readLocal(["sessionIdentityIndex"]))
    .sessionIdentityIndex.sessionsById[session.id].name, session.name);
} finally {
  globalThis.setTimeout = nativeSetTimeout;
}

let mutated = false;
await assert.rejects(commitLibraryChange(async () => {
  mutated = true;
  return { changedFamilies: ["inbox"] };
}, { authority: {} }), /Storage authority/);
assert.equal(mutated, false, "missing repair capabilities must be rejected before any mutation");
assert.ok(published.length > 0);
console.log("PASS: durable Library revision/index repair survives failure, reopen and no-change retry");
