/** Unsupported Recovery values remain opaque and cannot be pruned or rewritten. */
import assert from "node:assert/strict";
import { createRecoveryStore, makeRecoveryDeletionMarker } from "../js/lib/storage/recovery-store.js";
import { RECOVERY_SCHEMA, RECOVERY_STORES } from "../js/lib/storage/schema.js";
import { contentHash } from "../js/lib/storage/canonical.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

function fixture() {
  const adapter = createMemoryIndexedDbAdapter(RECOVERY_SCHEMA);
  const recovery = createRecoveryStore({ adapter, now: () => 1000 });
  const state = () => adapter.transaction(Object.values(RECOVERY_STORES), "readonly",
    async tx => Object.fromEntries(await Promise.all(Object.values(RECOVERY_STORES)
      .map(async name => [name, await tx.getAll(name)]))));
  return { adapter, recovery, state };
}
const value = (id, schemaVersion = 1) => ({ id, schemaVersion, auto: true,
  windows: [[{ url: `https://${id}.example/`, favIconUrl: "data:image/png;base64,AQIDBA==" }]] });
async function unchanged(target, action) {
  const before = await target.state();
  await assert.rejects(action, /Unsupported saved-data version/);
  assert.deepEqual(await target.state(), before);
}
const source = fixture();
await source.recovery.captureSnapshot(value("old"));
const goodPack = await source.recovery.exportRecoveryPack();

for (const version of [99, "1", null, 0, 1.5]) {
  const target = fixture();
  await target.recovery.captureSnapshot(value("existing"));
  await unchanged(target, () => target.recovery.captureSnapshot(value("future", version), { retention: 1 }));
  await unchanged(target, () => target.recovery.deleteSnapshot("existing", {
    marker: { ...makeRecoveryDeletionMarker("existing"), schemaVersion: version }
  }));
  const pack = structuredClone(goodPack);
  const snapshot = pack.snapshots[0];
  snapshot.value.schemaVersion = version;
  snapshot.contentHash = await contentHash({ id: snapshot.id, capturedAt: snapshot.capturedAt,
    value: snapshot.value });
  const { contentHash: _, ...body } = pack;
  pack.contentHash = await contentHash(body);
  const preserved = structuredClone(pack);
  const empty = fixture();
  await unchanged(empty, () => empty.recovery.seedRecoveryPack(pack));
  assert.deepEqual(pack, preserved);
  await empty.recovery.seedRecoveryPack(goodPack);
  assert.equal((await empty.recovery.listSnapshots()).length, 1);
}

// A newer client's existing snapshot can still be backed up, but not interpreted.
const persisted = fixture();
await persisted.recovery.seedRecoveryPack(goodPack);
await persisted.adapter.transaction([RECOVERY_STORES.snapshots], "readwrite", async tx => {
  const snapshot = await tx.get(RECOVERY_STORES.snapshots, "old");
  snapshot.value.schemaVersion = 99;
  snapshot.contentHash = await contentHash({ id: snapshot.id, capturedAt: snapshot.capturedAt,
    value: snapshot.value });
  await tx.put(RECOVERY_STORES.snapshots, snapshot);
});
for (const action of [
  () => persisted.recovery.readSnapshot("old"),
  () => persisted.recovery.listSnapshots(),
  () => persisted.recovery.captureSnapshot(value("old")),
  () => persisted.recovery.deleteSnapshot("old"),
  () => persisted.recovery.captureSnapshot(value("new"), { retention: 1 })
]) await unchanged(persisted, action);
assert.equal((await persisted.recovery.exportRecoveryPack()).snapshots[0].value.schemaVersion, 99);

// Unknown marker versions must not be hidden, replaced or evicted by another action.
const markers = fixture();
await markers.recovery.seedRecoveryPack(goodPack);
await markers.adapter.transaction([RECOVERY_STORES.meta], "readwrite", tx =>
  tx.put(RECOVERY_STORES.meta, { key: "snapshotDeletions", value: [
    { ...makeRecoveryDeletionMarker("deleted"), schemaVersion: 99 }
  ] }));
for (const action of [
  () => markers.recovery.readDeletionMarkers(),
  () => markers.recovery.captureSnapshot(value("new")),
  () => markers.recovery.deleteSnapshot("old")
]) await unchanged(markers, action);

const supported = fixture();
const missing = value("missing");
delete missing.schemaVersion;
await supported.recovery.captureSnapshot(missing);
assert.deepEqual((await supported.recovery.readSnapshot("missing")).value, missing);
const marker = makeRecoveryDeletionMarker("missing");
delete marker.schemaVersion;
assert.equal(await supported.recovery.deleteSnapshot("missing", { marker }), true);
assert.deepEqual(await supported.recovery.readDeletionMarkers(), [marker]);
console.log("PASS Recovery format rejection, unchanged stores, opaque export and supported records");
