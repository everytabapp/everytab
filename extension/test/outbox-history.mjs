import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { LIBRARY_SCHEMA } from "../js/lib/storage/schema.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

const FAVICON = "data:image/png;base64,AQIDBA==";
const record = (id, url, extra = {}) => ({
  type: "put", family: "inbox", id,
  value: { id, kind: "tab", tabs: [{ url, title: id, ...extra }], labels: [] }
});
const make = (adapter, deviceId = "history-device") => createLibraryStore({
  adapter, deviceId, createId: () => "history-source", now: () => 100
});
const snapshot = (adapter) => adapter.transaction(
  LIBRARY_SCHEMA.stores.map(({ name }) => name), "readonly", async (tx) =>
    Object.fromEntries(await Promise.all(LIBRARY_SCHEMA.stores.map(async ({ name }) =>
      [name, await tx.getAll(name)])))
);

/* Below the fixed policy limit, no compaction watermark is reported. */
const belowAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const below = make(belowAdapter);
for (let index = 0; index < 100; index += 1) {
  await below.transact([record("same-session", `https://edit-${index}.example`)]);
}
const belowBatch = await below.readSyncBatch({ afterSequence: 0 });
assert.equal(belowBatch.compactedThroughSequence, 0);
assert.equal(belowBatch.changes.length, 100);
assert.equal(await below.acknowledgeSync(40), 40);
assert.equal((await below.readSyncBatch({ afterSequence: 0 })).changes.length, 60);
await below.transact(Array.from({ length: 196 }, (_, index) =>
  record("same-session", `https://after-ack-${index}.example`)));
assert.equal((await below.readSyncBatch({ maxOperations: 300 })).changes.length, 256);
await below.transact([record("same-session", "https://after-ack-cap.example")]);
assert.equal((await below.readSyncBatch()).compactedThroughSequence, 297);
assert.equal(await below.acknowledgeSync(297), 0);
assert.equal((await below.readSyncBatch()).compactedThroughSequence, 297);

/* More than 256 edits clear redundant history but retain the current record. */
const boundedAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const bounded = make(boundedAdapter);
for (let index = 0; index < 1000; index += 1) {
  await bounded.transact([record("same-session", `https://edit-${index}.example`)]);
}
const boundedBatch = await bounded.readSyncBatch({ afterSequence: 0 });
assert.equal(boundedBatch.compactedThroughSequence, 771,
  "the watermark advances each time the fixed history window is exceeded");
assert.equal((await bounded.readSyncBatch({ afterSequence: 0, maxOperations: 300 })).changes.length, 229);
assert.equal((await bounded.readEntity("inbox", "same-session")).value.tabs[0].url,
  "https://edit-999.example");
assert.equal((await bounded.readReplicationState()).sequence, 1000);
const reopened = make(boundedAdapter);
assert.equal((await reopened.readReplicationState()).sequence, 1000);
assert.equal((await reopened.readEntity("inbox", "same-session")).value.tabs[0].url,
  "https://edit-999.example");

const tombstoneAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const tombstone = make(tombstoneAdapter, "tombstone-device");
await tombstone.transact([record("gone", "https://gone.example")]);
for (let index = 0; index < 256; index += 1) {
  await tombstone.transact([record("gone", `https://gone-edit-${index}.example`)]);
}
await tombstone.transact([{ type: "delete", family: "inbox", id: "gone" }]);
assert.equal((await tombstone.readSyncBatch({ afterSequence: 0 })).compactedThroughSequence, 257);
assert.equal((await tombstone.readEntity("inbox", "gone", { includeDeleted: true })).lifecycle, "deleted");

/* A single oversized record also compacts its outbox, preserving favicon data. */
const oversizedAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const oversized = make(oversizedAdapter, "oversized-device");
await oversized.transact([record("large", "https://large.example", {
  favIconUrl: FAVICON, title: "x".repeat(9 * 1024 * 1024)
})]);
assert.equal((await oversized.readSyncBatch({ afterSequence: 0 })).compactedThroughSequence, 1);
assert.equal((await oversized.readSyncBatch({ afterSequence: 0 })).changes.length, 0);
assert.equal((await oversized.readEntity("inbox", "large")).value.tabs[0].favIconUrl, FAVICON);

/* Transaction rollback restores records, local journal, outbox and watermark. */
const rollbackAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const rollback = make(rollbackAdapter, "rollback-device");
await rollback.commit({ operations: [record("journal-row", "https://before.example")],
  localSets: { journal: { state: "before" } }
});
for (let index = 1; index < 256; index += 1) {
  await rollback.transact([record("journal-row", `https://before-${index}.example`)]);
}
await assert.rejects(
  () => rollback.commit({
    operations: [record("journal-row", "https://failed.example")],
    localSets: { journal: { state: "failed" } },
    finalizeLocalSets: () => { throw new Error("finalizer failed"); }
  }),
  /finalizer failed/
);
assert.equal((await rollback.readReplicationState()).sequence, 256);
assert.equal((await rollback.readSyncBatch({ afterSequence: 0, maxOperations: 300 })).changes.length, 256);
assert.deepEqual(await rollback.readLocal(["journal"]), { journal: { state: "before" } });
assert.equal((await rollback.readEntity("inbox", "journal-row")).value.tabs[0].url,
  "https://before-255.example");
assert.equal((await rollback.readSyncBatch()).compactedThroughSequence, 0);

/* A pre-counter database is bounded on its next write; other device rows stay. */
const uncountedAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const uncounted = make(uncountedAdapter);
await uncounted.transact([record("uncounted", "https://uncounted.example")]);
await uncountedAdapter.transaction(["meta", "outbox"], "readwrite", async (tx) => {
  const template = (await tx.getAll("outbox"))[0];
  await tx.delete("meta", "outbox-history");
  for (let sequence = 2; sequence <= 300; sequence += 1) {
    await tx.put("outbox", { ...template, sequence });
  }
  await tx.put("outbox", { ...template, deviceId: "another-device", sequence: 1 });
  await tx.put("meta", { key: "sequence", value: 300 });
});
await uncounted.transact([record("uncounted", "https://counted.example")]);
assert.equal((await uncounted.readSyncBatch()).compactedThroughSequence, 301);
assert.equal((await uncounted.readSyncBatch()).changes.length, 0);
assert.equal((await snapshot(uncountedAdapter)).outbox[0].deviceId, "another-device");
assert.equal((await snapshot(uncountedAdapter)).outbox.length, 1);

/* Corrupt proof of trimming fails closed in reads and both mutation paths. */
await uncountedAdapter.transaction(["meta"], "readwrite", async (tx) => {
  const row = await tx.get("meta", "outbox-history");
  row.value.compactedThroughSequence = 302;
  await tx.put("meta", row);
});
const corruptBefore = await snapshot(uncountedAdapter);
await assert.rejects(() => uncounted.readSyncBatch(), /watermark is ahead/);
await assert.rejects(() => uncounted.acknowledgeSync(301), /watermark is ahead/);
await assert.rejects(() => uncounted.transact([record("uncounted", "https://refused.example")]),
  /watermark is ahead/);
assert.deepEqual(await snapshot(uncountedAdapter), corruptBefore);

/* Exact Restore compaction keeps the safety point while preserving all data. */
const restoreSourceAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const restoreSource = make(restoreSourceAdapter, "restore-source");
await restoreSource.transact(Array.from({ length: 257 }, (_, index) => ({
  type: "put", family: "inbox", id: `restore-${index}`,
  value: {
    id: `restore-${index}`, kind: "tab",
    tabs: [{ url: `https://restore-${index}.example`, title: `Restore ${index}`,
      favIconUrl: FAVICON }], labels: ["kept"]
  }
})));
const restoreCheckpoint = await restoreSource.createExactCheckpoint();
const emptyRestore = make(createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), "empty-restore");
const emptyCheckpoint = await emptyRestore.createExactCheckpoint();
const restoreTarget = make(createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), "restore-target");
await restoreTarget.seedExactCheckpoint(restoreCheckpoint);
const restorePreview = await restoreTarget.previewExactRestore(emptyCheckpoint);
await restoreTarget.replaceFromCheckpoint(emptyCheckpoint, {
  expectedSequence: restorePreview.currentSequence,
  expectedRestoreEpoch: restorePreview.restoreEpoch,
  expectedStateHash: restorePreview.currentStateHash,
  restoreId: "restore-history"
});
assert.equal((await restoreTarget.readSyncBatch({ afterSequence: 0 })).changes.length, 0);
assert.equal((await restoreTarget.readSyncBatch({ afterSequence: 0 })).compactedThroughSequence, 257);
assert.equal((await restoreTarget.readPendingRestore()).id, "restore-history");
await restoreTarget.undoExactRestore("restore-history");
assert.equal(await restoreTarget.readPendingRestore(), null);
assert.equal((await restoreTarget.readSyncBatch({ afterSequence: 0 })).compactedThroughSequence, 514);
const restoredRecord = await restoreTarget.readEntity("inbox", "restore-256");
assert.equal(restoredRecord.lifecycle, "live");
assert.deepEqual(restoredRecord.value.labels, ["kept"]);
assert.equal(restoredRecord.value.tabs[0].favIconUrl, FAVICON);
assert.deepEqual((await restoreTarget.readFamily("inbox")).map(({ value }) => value),
  (await restoreSource.readFamily("inbox")).map(({ value }) => value));

console.log("PASS: bounded Library outbox history");
