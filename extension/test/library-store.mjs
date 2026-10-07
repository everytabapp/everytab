/** Interface-level Library and Recovery tests. */
import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import {
  MAX_RECOVERY_SNAPSHOTS, createRecoveryStore, normalizeRecoveryRetention
} from "../js/lib/storage/recovery-store.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { compareVersions, nextVersion } from "../js/lib/storage/version.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

assert.throws(() => createLibraryStore({
  adapter: { transaction: true },
  deviceId: "incomplete-library-adapter"
}), /Library storage adapter is required/,
"the Library constructor rejects a non-callable transaction capability");
assert.throws(() => createRecoveryStore({
  adapter: { transaction: true }
}), /Recovery storage adapter is required/,
"the Recovery constructor rejects a non-callable transaction capability");

const FAVICON = "data:image/png;base64,AQIDBA==";
const DEVICE_A = "device-a";
const DEVICE_B = "device-b";
let wallTime = 1_000;
const now = () => wallTime;

const libraryA = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: DEVICE_A,
  now
});
const commitEvents = [];
const unsubscribe = libraryA.subscribe((event) => commitEvents.push(event));

const first = await libraryA.transact([
  {
    type: "put",
    family: "inbox",
    id: "one",
    value: {
      id: "one",
      kind: "tab",
      tabs: [{ url: "https://one.example", title: "One", favIconUrl: FAVICON }],
      labels: ["work"]
    }
  },
  {
    type: "put",
    family: "inbox",
    id: "two",
    value: {
      id: "two",
      kind: "tab",
      tabs: [{ url: "https://two.example", title: "Two", favIconUrl: FAVICON }],
      labels: ["work", "read"]
    }
  }
]);
assert.equal(first.fromSequence, 1);
assert.equal(first.throughSequence, 2);
assert.equal(commitEvents.length, 1);
unsubscribe();
assert.ok(compareVersions(first.changes[1].entity.version, first.changes[0].entity.version) > 0);

const inbox = await libraryA.readFamily("inbox");
assert.equal(inbox.length, 2);
assert.equal(inbox.find(({ id }) => id === "one").value.tabs[0].favIconUrl, FAVICON);
assert.deepEqual(inbox.find(({ id }) => id === "two").value.labels, ["work", "read"]);

const initialBatch = await libraryA.readSyncBatch();
assert.equal(initialBatch.changes.length, 2);
assert.equal(initialBatch.assets.length, 1, "one content-addressed asset serves repeated favicons");
assert.ok(!JSON.stringify(initialBatch.changes).includes(FAVICON),
  "transaction chunks do not repeat embedded favicon bytes");
assert.equal(initialBatch.assets[0].dataUrl, FAVICON);

const libraryB = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: DEVICE_B,
  now
});
const applied = await libraryB.applyRemoteBatch(initialBatch);
assert.deepEqual(applied, {
  applied: 2, ignored: 0, sequence: 2, changedFamilies: ["inbox"]
});
assert.equal((await libraryB.readEntity("inbox", "two")).value.tabs[0].favIconUrl, FAVICON);
assert.equal((await libraryB.readSyncBatch()).changes.length, 0,
  "remote application never echoes into the local outbox");

wallTime = 900;
const deletion = await libraryA.transact([
  { type: "delete", family: "inbox", id: "one" }
]);
assert.equal(deletion.changes[0].entity.version.wallTime, 1_000,
  "logical time remains monotonic when the wall clock moves backwards");
assert.ok(deletion.changes[0].entity.version.logicalCounter >
  first.changes[1].entity.version.logicalCounter);
assert.equal(await libraryA.readEntity("inbox", "one"), null);
const tombstone = await libraryA.readEntity("inbox", "one", { includeDeleted: true });
assert.equal(tombstone.lifecycle, "deleted");
assert.equal(tombstone.value, undefined);
assert.equal(tombstone.assetDigests.length, 0);
assert.ok(!JSON.stringify(tombstone).includes("https://one.example"),
  "deletion retains no URL, title, Label, or favicon payload");

const deletionBatch = await libraryA.readSyncBatch({ afterSequence: 2 });
assert.equal(deletionBatch.changes.length, 1);
assert.equal(deletionBatch.assets.length, 0);
await libraryB.applyRemoteBatch(deletionBatch);
assert.equal(await libraryB.readEntity("inbox", "one"), null);
assert.equal((await libraryB.readEntity("inbox", "one", { includeDeleted: true })).lifecycle, "deleted");

assert.equal(await libraryA.acknowledgeSync(2), 2);
const remainingBatch = await libraryA.readSyncBatch();
assert.equal(remainingBatch.changes.length, 1);
assert.equal(remainingBatch.changes[0].sequence, 3);
const replicationStateA = await libraryA.readReplicationState();
assert.equal(replicationStateA.deviceId, DEVICE_A);
assert.equal(replicationStateA.sequence, 3);
assert.match(replicationStateA.sourceId, /^[0-9a-f-]+$/i);
assert.equal((await libraryA.readReplicationState()).sourceId, replicationStateA.sourceId,
  "the replication source identity is stable for one Library database");
const replicationStateB = await libraryB.readReplicationState();
assert.deepEqual(replicationStateB.replicas, [{
  deviceId: DEVICE_A,
  sourceId: null,
  sequence: 3
}], "the Library exposes only compact remote cursors to the Vault module");

const checkpoint = await libraryA.createExactCheckpoint();
assert.equal(checkpoint.kind, "library-checkpoint");
assert.equal(checkpoint.entities.length, 2);
assert.equal(checkpoint.assets.length, 1);
assert.match(checkpoint.contentHash, /^sha256:[0-9a-f]{64}$/);
assert.ok(!JSON.stringify(checkpoint.entities).includes(FAVICON));

const checkpointFollower = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: "checkpoint-follower",
  now
});
assert.deepEqual(await checkpointFollower.applyRemoteCheckpoint({
  deviceId: DEVICE_A,
  sourceId: replicationStateA.sourceId,
  throughSequence: replicationStateA.sequence,
  checkpoint
}), { applied: 2, ignored: 0, sequence: 3, changedFamilies: ["inbox"] });
assert.equal(
  (await checkpointFollower.readEntity("inbox", "two")).value.tabs[0].favIconUrl,
  FAVICON,
  "a remote checkpoint hydrates content-addressed assets"
);
assert.equal(await checkpointFollower.readEntity("inbox", "one"), null,
  "a remote checkpoint carries compact deletions");
assert.equal((await checkpointFollower.readReplicationState()).replicas[0].sequence, 3,
  "checkpoint import advances the source cursor without creating local outbox work");
assert.equal((await checkpointFollower.readSyncBatch()).changes.length, 0);
assert.deepEqual(await checkpointFollower.applyRemoteCheckpoint({
  deviceId: DEVICE_A,
  sourceId: replicationStateA.sourceId,
  throughSequence: replicationStateA.sequence,
  checkpoint
}), { applied: 0, ignored: 2, sequence: 3, changedFamilies: [] },
"remote checkpoint replay is idempotent");

const portable = await libraryA.readPortableState();
assert.equal(portable.inbox.one.lifecycle, "deleted");
assert.deepEqual(portable.inbox.two.value.labels, ["work", "read"]);

const combined = await libraryA.commit({
  operations: [{
    type: "put",
    family: "inbox",
    id: "three",
    value: {
      id: "three",
      kind: "tab",
      tabs: [{ url: "https://three.example", title: "Three" }],
      labels: []
    }
  }],
  localSets: {
    journal: { entries: [{ id: "undo-three" }] },
    counters: { saved: 3 }
  }
});
assert.deepEqual(combined.localKeys, ["journal", "counters"]);
assert.deepEqual(await libraryA.readLocal(["journal", "missing", "counters"]), {
  journal: { entries: [{ id: "undo-three" }] },
  counters: { saved: 3 }
});
await libraryA.commit({ localSets: { journal: { entries: [] } }, localDeletes: ["counters"] });
assert.deepEqual(await libraryA.readLocal(["journal", "counters"]), {
  journal: { entries: [] }
});

const atomicBase = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const failingAdapter = {
  transaction(storeNames, mode, work) {
    return atomicBase.transaction(storeNames, mode, (transaction) => work({
      ...transaction,
      put: async (storeName, value) => {
        if (storeName === "local") throw new Error("simulated local failure");
        return transaction.put(storeName, value);
      }
    }));
  },
  close: () => atomicBase.close()
};
const atomicLibrary = createLibraryStore({
  adapter: failingAdapter,
  deviceId: "atomic-device",
  now
});
await assert.rejects(() => atomicLibrary.commit({
  operations: [{
    type: "put",
    family: "inbox",
    id: "atomic",
    value: { id: "atomic", kind: "tab", tabs: [], labels: [] }
  }],
  localSets: { journal: { entries: ["must-not-commit"] } }
}), /simulated local failure/);
assert.equal(await atomicLibrary.readEntity("inbox", "atomic"), null,
  "a failed companion write rolls back the entity and outbox transaction");
assert.deepEqual(await atomicLibrary.readLocal(["journal"]), {});

const libraryRehearsal = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: "checkpoint-rehearsal",
  now
});
assert.deepEqual(await libraryRehearsal.seedExactCheckpoint(checkpoint), {
  entities: 2,
  assets: 1
});
assert.deepEqual(await libraryRehearsal.readPortableState(), portable,
  "an exact checkpoint restores both live records and compact tombstones");
assert.equal((await libraryRehearsal.readSyncBatch()).changes.length, 0,
  "seeding an exact checkpoint does not invent local sync history");
await assert.rejects(() => libraryRehearsal.seedExactCheckpoint(checkpoint), /not empty/i);
const corruptCheckpoint = structuredClone(checkpoint);
corruptCheckpoint.entities[0].contentHash = "sha256:bad";
await assert.rejects(() => createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: "corrupt-checkpoint",
  now
}).seedExactCheckpoint(corruptCheckpoint), /content hash/i);

/* Exact Restore replaces only the portable Library and retains one local safety point. */
const restoreClock = { value: 2_000 };
const restoreSource = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: "restore-source",
  now: () => restoreClock.value
});
await restoreSource.transact([
  { type: "put", family: "inbox", id: "kept", value: {
    id: "kept", kind: "tab", tabs: [{ url: "https://restored.example", title: "Restored" }],
    labels: ["restored"]
  } },
  { type: "put", family: "sessions", id: "session-restored", value: {
    id: "session-restored", name: "Restored Session", auto: false,
    windows: [[{ url: "https://session.example", title: "Session" }]], labels: []
  } },
  { type: "delete", family: "archive", id: "old-deletion" }
]);
const restoreTarget = await restoreSource.createExactCheckpoint();

const restoreDestination = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: "restore-destination",
  now: () => restoreClock.value
});
await restoreDestination.transact([
  { type: "put", family: "inbox", id: "kept", value: {
    id: "kept", kind: "tab", tabs: [{ url: "https://changed.example", title: "Changed" }],
    labels: []
  } },
  { type: "put", family: "inbox", id: "local-only", value: {
    id: "local-only", kind: "tab", tabs: [{ url: "https://local.example", title: "Local" }],
    labels: []
  } }
]);
const restorePreviewProgress = [];
const restorePreview = await restoreDestination.previewExactRestore(restoreTarget, {
  onProgress: (progress) => restorePreviewProgress.push(progress)
});
assert.equal(restorePreview.added, 1);
assert.equal(restorePreview.updated, 1);
assert.equal(restorePreview.removed, 1);
assert.equal(restorePreview.watermarks, 1);
assert.deepEqual(restorePreview.targetFamilies, { inbox: 1, sessions: 1 });
assert.deepEqual(restorePreview.changes.map(({ kind, family, id, title, url }) => ({
  kind, family, id, title, url
})), [
  {
    kind: "updated", family: "inbox", id: "kept", title: "Restored",
    url: "https://restored.example"
  },
  {
    kind: "removed", family: "inbox", id: "local-only", title: "Local",
    url: "https://local.example"
  },
  {
    kind: "added", family: "sessions", id: "session-restored",
    title: "Restored Session", url: "https://session.example"
  },
  {
    kind: "watermark", family: "archive", id: "old-deletion",
    title: "old-deletion", url: ""
  }
], "Restore preview returns compact identities for every exact delta");
assert.ok(restorePreviewProgress.some(({ stage, target, completed, total }) =>
  stage === "checking" && target === "records" && completed === total && total > 0),
"Restore preview reports determinate record verification progress");
const restored = await restoreDestination.replaceFromCheckpoint(restoreTarget, {
  expectedSequence: restorePreview.currentSequence,
  expectedRestoreEpoch: restorePreview.restoreEpoch,
  expectedStateHash: restorePreview.currentStateHash,
  restoreId: "restore-one",
  source: { name: "2026-09-03-checkpoint.json", day: "2026-09-03" }
});
assert.equal(restored.status, "restored");
assert.equal((await restoreDestination.readEntity("inbox", "kept")).value.tabs[0].url,
  "https://restored.example");
assert.equal(await restoreDestination.readEntity("inbox", "local-only"), null,
  "exact Restore turns records absent from the checkpoint into newer compact deletions");
assert.equal((await restoreDestination.readFamily("sessions")).length, 1);
assert.equal((await restoreDestination.readEntity(
  "archive", "old-deletion", { includeDeleted: true }
)).lifecycle, "deleted", "checkpoint deletion watermarks remain authoritative");
assert.equal((await restoreDestination.readPendingRestore()).id, "restore-one");
await assert.rejects(() => restoreDestination.replaceFromCheckpoint(restoreTarget, {
  expectedSequence: restored.throughSequence,
  expectedRestoreEpoch: restored.restoreEpoch,
  restoreId: "restore-two"
}), /previous Vault Restore/i, "one safety point must be resolved before another Restore");
const undoneRestore = await restoreDestination.undoExactRestore("restore-one");
assert.equal(undoneRestore.status, "undone");
assert.equal((await restoreDestination.readEntity("inbox", "kept")).value.tabs[0].url,
  "https://changed.example");
assert.equal((await restoreDestination.readEntity("inbox", "local-only")).value.tabs[0].url,
  "https://local.example");
assert.equal(await restoreDestination.readEntity("sessions", "session-restored"), null);
assert.equal(await restoreDestination.readPendingRestore(), null,
  "Undo removes the local safety point only after the inverse transaction commits");
const confirmedPreview = await restoreDestination.previewExactRestore(restoreTarget);
await restoreDestination.replaceFromCheckpoint(restoreTarget, {
  expectedSequence: confirmedPreview.currentSequence,
  expectedRestoreEpoch: confirmedPreview.restoreEpoch,
  expectedStateHash: confirmedPreview.currentStateHash,
  restoreId: "restore-confirmed"
});
assert.equal(await restoreDestination.confirmExactRestore("restore-confirmed"), true);
assert.equal(await restoreDestination.readPendingRestore(), null);
await assert.rejects(() => restoreDestination.undoExactRestore("restore-confirmed"),
  /no longer available/i);

const staleDestination = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: "restore-stale",
  now: () => restoreClock.value
});
const stalePreview = await staleDestination.previewExactRestore(restoreTarget);
await staleDestination.transact([{ type: "put", family: "starred", id: "newer", value: {
  id: "newer", url: "https://newer.example", title: "Newer", position: 0
} }]);
await assert.rejects(() => staleDestination.replaceFromCheckpoint(restoreTarget, {
  expectedSequence: stalePreview.currentSequence,
  expectedRestoreEpoch: stalePreview.restoreEpoch,
  expectedStateHash: stalePreview.currentStateHash,
  restoreId: "restore-stale"
}), /changed after this Restore was reviewed/i);
assert.equal((await staleDestination.readEntity("starred", "newer")).lifecycle, "live",
  "a stale confirmation cannot overwrite a newer local edit");

const restoreAtomicBase = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
let failRestoreOutbox = false;
const restoreAtomic = createLibraryStore({
  adapter: {
    transaction(storeNames, mode, work) {
      return restoreAtomicBase.transaction(storeNames, mode, (transaction) => work({
        ...transaction,
        put: async (storeName, value) => {
          if (failRestoreOutbox && storeName === "outbox") {
            throw new Error("simulated Restore interruption");
          }
          return transaction.put(storeName, value);
        }
      }));
    },
    close: () => restoreAtomicBase.close()
  },
  deviceId: "restore-atomic",
  now: () => restoreClock.value
});
await restoreAtomic.transact([{ type: "put", family: "inbox", id: "atomic-current", value: {
  id: "atomic-current", kind: "tab",
  tabs: [{ url: "https://atomic-current.example", title: "Atomic current" }], labels: []
} }]);
const atomicRestorePreview = await restoreAtomic.previewExactRestore(restoreTarget);
failRestoreOutbox = true;
await assert.rejects(() => restoreAtomic.replaceFromCheckpoint(restoreTarget, {
  expectedSequence: atomicRestorePreview.currentSequence,
  expectedRestoreEpoch: atomicRestorePreview.restoreEpoch,
  expectedStateHash: atomicRestorePreview.currentStateHash,
  restoreId: "restore-interrupted"
}), /simulated Restore interruption/);
assert.ok(await restoreAtomic.readEntity("inbox", "atomic-current"));
assert.equal(await restoreAtomic.readEntity("inbox", "kept"), null);
assert.equal(await restoreAtomic.readPendingRestore(), null,
  "an interrupted exact Restore commits neither replacement data nor its safety receipt");

const corrupted = structuredClone(initialBatch);
corrupted.changes[0].entity.value.tabs[0].title = "Tampered";
const isolated = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: "isolated",
  now
});
await assert.rejects(() => isolated.applyRemoteBatch(corrupted), /content hash/i);
assert.equal((await isolated.readFamily("inbox")).length, 0,
  "an invalid remote batch commits nothing");

const missingAsset = structuredClone(initialBatch);
missingAsset.assets = [];
await assert.rejects(() => isolated.applyRemoteBatch(missingAsset), /missing asset/i);
assert.equal((await isolated.readFamily("inbox")).length, 0,
  "a remote batch missing a referenced asset commits nothing");

const forgedVersion = structuredClone(initialBatch);
forgedVersion.changes[0].entity.version.deviceId = "some-other-device";
await assert.rejects(() => isolated.applyRemoteBatch(forgedVersion), /version is invalid/i);
const forgedReferences = structuredClone(initialBatch);
forgedReferences.changes[0].entity.assetDigests = [];
await assert.rejects(() => isolated.applyRemoteBatch(forgedReferences), /asset references/i);
await assert.rejects(() => libraryA.transact([
  { type: "put", family: "inbox", id: "invalid-json", value: { broken: undefined } }
]), /JSON-compatible/i);

const v1 = nextVersion(null, null, "clock-test", 100);
const secondVersion = nextVersion(v1, null, "clock-test", 50);
assert.ok(compareVersions(secondVersion, v1) > 0);

/* Recovery remains physically and behaviorally separate from the Library. */
let recoveryTime = 10;
let recoveryId = 0;
const recovery = createRecoveryStore({
  adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA),
  now: () => recoveryTime,
  createId: () => `snapshot-${++recoveryId}`
});
const arrangement = (url) => ({
  windows: [[{ url, title: url, favIconUrl: FAVICON }]]
});

await recovery.captureSnapshot(arrangement("https://one.example"), { retention: 2 });
recoveryTime += 1;
await recovery.captureSnapshot(arrangement("https://two.example"), { retention: 2 });
recoveryTime += 1;
const thirdCapture = await recovery.captureSnapshot(
  arrangement("https://three.example"), { retention: 2 }
);
assert.deepEqual(thirdCapture.pruned, ["snapshot-1"]);
assert.equal(await recovery.readSnapshot("snapshot-1"), null);
const snapshots = await recovery.listSnapshots({ limit: 10 });
assert.deepEqual(snapshots.map(({ id }) => id), ["snapshot-3", "snapshot-2"]);
assert.equal(snapshots[0].value.windows[0][0].favIconUrl, FAVICON);
assert.deepEqual(await recovery.readReplicationState(), {
  sequence: 3,
  retention: 2,
  newestSnapshotId: "snapshot-3",
  snapshotCount: 2,
  snapshots: [
    { id: "snapshot-3", sequence: 3 },
    { id: "snapshot-2", sequence: 2 }
  ]
}, "Recovery exposes one small replication cursor without reading Snapshot bodies");

const recoveryPack = await recovery.exportRecoveryPack();
assert.equal(recoveryPack.snapshots.length, 2);
assert.equal(recoveryPack.assets.length, 1,
  "retained recovery snapshots share one content-addressed favicon");
assert.ok(!JSON.stringify(recoveryPack.snapshots).includes(FAVICON));
assert.match(recoveryPack.contentHash, /^sha256:[0-9a-f]{64}$/);
const recoveryRehearsal = createRecoveryStore({
  adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA),
  now: () => 100
});
assert.deepEqual(await recoveryRehearsal.seedRecoveryPack(recoveryPack, { retention: 2 }), {
  snapshots: 2,
  assets: 1
});
assert.deepEqual(await recoveryRehearsal.listSnapshots({ limit: 10 }), snapshots,
  "a Recovery pack restores its exact retained Snapshot values and order");
await assert.rejects(
  () => recoveryRehearsal.seedRecoveryPack(recoveryPack, { retention: 2 }),
  /not empty/i
);
const corruptPack = structuredClone(recoveryPack);
corruptPack.snapshots[0].contentHash = "sha256:bad";
await assert.rejects(() => createRecoveryStore({
  adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA)
}).seedRecoveryPack(corruptPack), /content hash/i);
assert.equal(normalizeRecoveryRetention(0), MAX_RECOVERY_SNAPSHOTS,
  "legacy unlimited retention maps to the explicit hard safety cap");
assert.equal(await recovery.deleteSnapshot("snapshot-2"), true);
assert.equal(await recovery.deleteSnapshot("snapshot-2"), false);
assert.equal((await recovery.readReplicationState()).sequence, 4,
  "deleting a retained Snapshot advances the Recovery replication cursor");
const afterDelete = await recovery.exportRecoveryPack();
assert.deepEqual(afterDelete.snapshots.map(({ id }) => id), ["snapshot-3"]);
assert.equal(afterDelete.assets.length, 1);
assert.equal(await recovery.deleteSnapshot("snapshot-3"), true);
assert.equal((await recovery.exportRecoveryPack()).assets.length, 0,
  "deleting the final recovery reference removes its private asset");

console.log("PASS: storage Library and Recovery interfaces");
