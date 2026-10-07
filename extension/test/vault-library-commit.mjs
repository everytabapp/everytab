/** External Library commits share the product write/revision boundary. */
import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createMockLockManager } from "./e2-mocks.mjs";

const locks = createMockLockManager();
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { locks }
});

const published = [];
globalThis.chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async ({ storageV2Revision }) => {
        assert.equal(locks.heldBy("everytab-store"), "vault",
          "the revision is published before the remote Store lock is released");
        published.push(structuredClone(storageV2Revision));
      }
    },
    onChanged: { addListener() {}, removeListener() {} }
  }
};

const {
  commitLibraryChange,
  withStoreLock
} = await import("../js/lib/store.js");

let wallTime = 100;
const makeLibrary = (deviceId) => createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId,
  now: () => wallTime
});
const destination = makeLibrary("destination");
const recovery = createRecoveryStore({
  adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA),
  now: () => wallTime
});
const authority = createStorageAuthority({ library: destination, recovery });
const source = makeLibrary("source");
const value = (id) => ({
  id,
  deviceId: "device",
  createdAt: wallTime,
  modifiedAt: wallTime,
  schemaVersion: 1,
  kind: "tab",
  source: "manual",
  labels: [],
  tabs: [{ url: `https://${id}.example`, title: id }]
});
await destination.transact([{ type: "put", family: "inbox", id: "base", value: value("base") }]);
wallTime = 200;
await source.transact([{ type: "put", family: "inbox", id: "remote", value: value("remote") }]);
const remoteBatch = await source.readSyncBatch();

let releaseLocal;
let localRead;
const localReadDone = new Promise((resolve) => { localRead = resolve; });
const localGate = new Promise((resolve) => { releaseLocal = resolve; });
locks.setDefaultContext("local");
const localCommit = withStoreLock(async () => {
  const maps = await authority.readMaps(["inbox"]);
  localRead();
  await localGate;
  maps.inbox.local = value("local");
  await authority.commitMaps({ inbox: maps.inbox });
});
await localReadDone;

locks.setDefaultContext("vault");
const remoteCommit = commitLibraryChange(
  () => destination.applyRemoteBatch(remoteBatch),
  { authority }
);
assert.equal(locks.queuedCount("everytab-store"), 1,
  "a remote Vault apply queues behind an in-flight whole-map mutation");
releaseLocal();
await Promise.all([localCommit, remoteCommit]);

const final = (await authority.readMaps(["inbox"])).inbox;
assert.deepEqual(Object.keys(final).sort(), ["base", "local", "remote"],
  "serializing the remote apply prevents a stale local map from deleting it");
const durable = await authority.readPendingRevision();
assert.deepEqual(durable.changedKeys, ["inbox"]);
assert.equal(published.at(-1).id, durable.id,
  "the exact durable revision is the pulse published inside the Store lock");

/* Exact Restore rebuilds Session read models before its revision is visible. */
wallTime = 300;
const restoreDestination = makeLibrary("restore-destination");
const restoreRecovery = createRecoveryStore({
  adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA),
  now: () => wallTime
});
const restoreAuthority = createStorageAuthority({
  library: restoreDestination,
  recovery: restoreRecovery
});
const session = (id, name, url) => ({
  id,
  deviceId: "device",
  createdAt: wallTime,
  modifiedAt: wallTime,
  schemaVersion: 1,
  name,
  auto: false,
  labels: [],
  windows: [[{ url, title: name }]]
});
await restoreDestination.transact([{
  type: "put",
  family: "sessions",
  id: "before",
  value: session("before", "Before", "https://before.example")
}]);
await restoreAuthority.commitRemoteRevision(["sessions"]);
const restoreSource = makeLibrary("restore-source");
await restoreSource.transact([{
  type: "put",
  family: "sessions",
  id: "after",
  value: session("after", "After", "https://after.example")
}]);
const checkpoint = await restoreSource.createExactCheckpoint();
const preview = await restoreDestination.previewExactRestore(checkpoint);
const publicationsBeforeRestore = published.length;
locks.setDefaultContext("vault");
const restored = await locks.request(
  "everytab-vault-sync",
  { ifAvailable: true },
  (lock) => {
    assert.ok(lock);
    return commitLibraryChange(
      () => restoreDestination.replaceFromCheckpoint(checkpoint, {
        expectedSequence: preview.currentSequence,
        expectedRestoreEpoch: preview.restoreEpoch,
        expectedStateHash: preview.currentStateHash,
        restoreId: "restore-session"
      }),
      { authority: restoreAuthority }
    );
  }
);
assert.equal(restored.status, "restored");
const restoredIndex = (await restoreDestination.readLocal(["sessionIdentityIndex"]))
  .sessionIdentityIndex;
assert.equal(restoredIndex.sessionsById.after.name, "After");
assert.equal(restoredIndex.sessionsById.before, undefined,
  "Restore replaces the compact Session membership index with post-Restore state");
const restoreRevision = await restoreAuthority.readPendingRevision();
assert.ok(restoreRevision.changedKeys.includes("sessions") &&
  restoreRevision.changedKeys.includes("sessionIdentityIndex") &&
  restoreRevision.changedKeys.includes("sessionNavigationRevision"));
assert.deepEqual(
  restoreRevision.logicalChanges.sessionNavigationRevision.newValue.namedSessions,
  [{ id: "after", name: "After", tabCount: 1, modifiedAt: 300 }],
  "Restore publishes bounded navigation from the authoritative replacement"
);
assert.equal(published.length, publicationsBeforeRestore + 1);
assert.equal(published.at(-1).id, restoreRevision.id);

console.log("PASS: Vault commits share the Store authority boundary");
