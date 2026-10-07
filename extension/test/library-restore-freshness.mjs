/** Exact Restore must reject every saved-state change after its preview. */
import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { LIBRARY_SCHEMA, LIBRARY_STORES } from "../js/lib/storage/schema.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

const makeLibrary = (deviceId, adapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA)) =>
  createLibraryStore({ adapter, deviceId, now: () => 1_000,
    createId: () => `${deviceId}-source` });
const put = (id, title = id) => ({
  type: "put", family: "inbox", id,
  value: { id, kind: "tab", tabs: [{ url: `https://${id}.example`, title }], labels: [] }
});
const emptyCheckpoint = await makeLibrary("empty").createExactCheckpoint();
const restoreOptions = (preview) => ({
  expectedSequence: preview.currentSequence,
  expectedRestoreEpoch: preview.restoreEpoch,
  expectedStateHash: preview.currentStateHash,
  restoreId: "reviewed-restore"
});

async function importRemote(destination, remote, mode) {
  if (mode === "remote-batch") {
    return destination.applyRemoteBatch(await remote.readSyncBatch());
  }
  const state = await remote.readReplicationState();
  return destination.applyRemoteCheckpoint({
    deviceId: state.deviceId,
    sourceId: state.sourceId,
    throughSequence: state.sequence,
    checkpoint: await remote.createExactCheckpoint()
  });
}

// The remote variants leave the local outbox sequence and Restore epoch unchanged.
for (const mode of ["remote-batch", "remote-checkpoint", "local"]) {
  for (const change of ["add", "edit", "delete"]) {
    const destination = makeLibrary(`destination-${mode}-${change}`);
    const remote = makeLibrary(`remote-${mode}-${change}`);
    await remote.transact([put("original")]);
    await importRemote(destination, remote, "remote-batch");
    const preview = await destination.previewExactRestore(emptyCheckpoint);
    const mutation = change === "delete"
      ? { type: "delete", family: "inbox", id: "original" }
      : put(change === "add" ? "added" : "original", "Changed after review");
    if (mode === "local") await destination.transact([mutation]);
    else {
      await remote.transact([mutation]);
      await importRemote(destination, remote, mode);
      const fresh = await destination.previewExactRestore(emptyCheckpoint);
      assert.equal(fresh.currentSequence, preview.currentSequence);
      assert.equal(fresh.restoreEpoch, preview.restoreEpoch);
    }
    const before = await destination.createExactCheckpoint();
    const replication = await destination.readReplicationState();
    await assert.rejects(
      destination.replaceFromCheckpoint(emptyCheckpoint, restoreOptions(preview)),
      /changed after this Restore was reviewed/i,
      `${mode} ${change} must invalidate the reviewed removal list`
    );
    assert.deepEqual(await destination.createExactCheckpoint(), before);
    assert.deepEqual(await destination.readReplicationState(), replication);
    assert.equal(await destination.readPendingRestore(), null,
      "a rejected stale Restore must not create a safety point");
    const fresh = await destination.previewExactRestore(emptyCheckpoint);
    assert.match(fresh.currentStateHash, /^sha256:[0-9a-f]{64}$/);
    const accepted = await destination.replaceFromCheckpoint(emptyCheckpoint, restoreOptions(fresh));
    assert.equal(accepted.status, fresh.changed ? "restored" : "no-op",
      "reviewing again permits the intended replacement");
  }
}

// Changes during checkpoint verification/preparation must also be caught in the write transaction.
const base = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
let beforeReplacement = null;
const racing = makeLibrary("racing", {
  async transaction(stores, mode, work) {
    if (beforeReplacement && mode === "readwrite" && stores.includes(LIBRARY_STORES.outbox)) {
      const hook = beforeReplacement;
      beforeReplacement = null;
      await hook();
    }
    return base.transaction(stores, mode, work);
  }
});
const racingRemote = makeLibrary("racing-remote");
await racingRemote.transact([put("original")]);
await importRemote(racing, racingRemote, "remote-batch");
const racingPreview = await racing.previewExactRestore(emptyCheckpoint);
await racingRemote.transact([put("arrived-during-restore")]);
beforeReplacement = () => importRemote(racing, racingRemote, "remote-batch");
await assert.rejects(
  racing.replaceFromCheckpoint(emptyCheckpoint, restoreOptions(racingPreview)),
  /changed after this Restore was reviewed/i,
  "the last read-to-write race must reject before touching records or the safety point"
);
assert.ok(await racing.readEntity("inbox", "original"));
assert.ok(await racing.readEntity("inbox", "arrived-during-restore"));
assert.equal(await racing.readPendingRestore(), null);

// An old open page's preview cannot silently omit the new freshness proof.
const legacy = makeLibrary("legacy-preview");
await legacy.transact([put("original")]);
const legacyPreview = await legacy.previewExactRestore(emptyCheckpoint);
const { expectedStateHash: _missing, ...legacyOptions } = restoreOptions(legacyPreview);
await assert.rejects(legacy.replaceFromCheckpoint(emptyCheckpoint, legacyOptions), /review/i);
assert.ok(await legacy.readEntity("inbox", "original"));

// A newer remote version must invalidate review even when its value is identical.
const sameValue = makeLibrary("same-value");
const sameValueRemote = makeLibrary("same-value-remote");
await sameValueRemote.transact([put("original")]);
await importRemote(sameValue, sameValueRemote, "remote-batch");
const sameValuePreview = await sameValue.previewExactRestore(emptyCheckpoint);
await sameValueRemote.transact([put("original")]);
await importRemote(sameValue, sameValueRemote, "remote-batch");
await assert.rejects(
  sameValue.replaceFromCheckpoint(emptyCheckpoint, restoreOptions(sameValuePreview)),
  /changed after this Restore was reviewed/i
);

// Device-local bookkeeping and a redundant pull do not change the reviewed Library.
const unchanged = makeLibrary("unchanged");
const unchangedRemote = makeLibrary("unchanged-remote");
await unchangedRemote.transact([put("original")]);
await importRemote(unchanged, unchangedRemote, "remote-batch");
const unchangedPreview = await unchanged.previewExactRestore(emptyCheckpoint);
await unchanged.commit({ localSets: { "test-receipt": { completed: true } } });
await importRemote(unchanged, unchangedRemote, "remote-batch");
assert.equal((await unchanged.replaceFromCheckpoint(
  emptyCheckpoint, restoreOptions(unchangedPreview)
)).status, "restored");

console.log("PASS: exact Restore review rejects local and remote changes, including the final write race");
