/** Unsupported Library records are rejected without committing or consuming sync. */
import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { LIBRARY_SCHEMA, LIBRARY_STORES } from "../js/lib/storage/schema.js";
import { contentHash } from "../js/lib/storage/canonical.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

function fixture(deviceId = "local") {
  const adapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
  const events = [];
  const library = createLibraryStore({ adapter, deviceId, now: () => 1000,
    onCommit: event => events.push(event) });
  const state = () => adapter.transaction(Object.values(LIBRARY_STORES), "readonly",
    async tx => Object.fromEntries(await Promise.all(Object.values(LIBRARY_STORES)
      .map(async name => [name, await tx.getAll(name)]))));
  return { adapter, library, events, state };
}
const put = (id, extra = {}) => ({ type: "put", family: "inbox", id,
  value: { id, schemaVersion: 1, tabs: [{ url: `https://${id}.example/` }], ...extra } });
const source = fixture("remote");
const icon = { favIconUrl: "data:image/png;base64,AQIDBA==" };
await source.library.transact([put("first", icon), put("second")]);
const goodBatch = await source.library.readSyncBatch();
const goodCheckpoint = await source.library.createExactCheckpoint();
async function reseal(entity) {
  entity.contentHash = await contentHash({ family: entity.family, id: entity.id,
    lifecycle: entity.lifecycle, ...(entity.lifecycle === "live" ? { value: entity.value } : {}) });
}
async function checkpointWith(change) {
  const checkpoint = structuredClone(goodCheckpoint);
  change(checkpoint.entities[1]);
  await reseal(checkpoint.entities[1]);
  const { contentHash: _, ...body } = checkpoint;
  checkpoint.contentHash = await contentHash(body);
  return checkpoint;
}
async function unchanged(target, action) {
  const before = await target.state();
  const events = target.events.length;
  await assert.rejects(action, /Unsupported saved-data/);
  assert.deepEqual(await target.state(), before, "every store stays unchanged");
  assert.equal(target.events.length, events, "no commit notification");
}

for (const [name, change] of [
  ["future version", entity => { entity.value.schemaVersion = 99; }],
  ["string version", entity => { entity.value.schemaVersion = "1"; }],
  ["null version", entity => { entity.value.schemaVersion = null; }],
  ["zero version", entity => { entity.value.schemaVersion = 0; }],
  ["fractional version", entity => { entity.value.schemaVersion = 1.5; }],
  ["unknown family", entity => { entity.family = "futureFamily"; }],
  ["unknown deletion family", entity => {
    entity.family = "futureFamily"; entity.lifecycle = "deleted";
    entity.deletedAt = 1000; delete entity.value;
  }]
]) {
  const batch = structuredClone(goodBatch);
  change(batch.changes[1].entity);
  await reseal(batch.changes[1].entity);
  const checkpoint = await checkpointWith(change);
  const target = fixture();
  await target.library.transact([put("existing")]);
  await unchanged(target, () => target.library.applyRemoteBatch(batch));
  await unchanged(target, () => target.library.applyRemoteCheckpoint({
    deviceId: "remote", sourceId: "source", throughSequence: 2, checkpoint }));
  await unchanged(target, () => target.library.previewExactRestore(checkpoint));
  await unchanged(target, () => target.library.replaceFromCheckpoint(checkpoint));
  const empty = fixture();
  await unchanged(empty, () => empty.library.seedExactCheckpoint(checkpoint));
  assert.equal((await target.library.applyRemoteBatch(goodBatch)).applied, 2,
    "rejected sequence remains available for a supported retry");
  assert.deepEqual(batch.changes[1].entity, checkpoint.entities[1],
    "input is preserved for a compatible client");
  console.log(`PASS ${name}`);
}

// Local input is checked before assets, journal state or outbox changes commit.
const local = fixture();
await unchanged(local, () => local.library.commit({
  operations: [put("first", icon), put("future", { schemaVersion: 99 })],
  localSets: { journal: ["must not commit"] }
}));
await unchanged(local, () => local.library.transact([
  { type: "delete", family: "futureFamily", id: "future" }
]));

// Simulate bytes left by a newer client, bypassing the older client's ingress.
const persisted = fixture();
const future = (await checkpointWith(entity => { entity.value.schemaVersion = 99; })).entities[1];
await persisted.adapter.transaction([LIBRARY_STORES.entities], "readwrite",
  tx => tx.put(LIBRARY_STORES.entities, future));
for (const read of [
  () => persisted.library.readEntity("inbox", "second"),
  () => persisted.library.readFamily("inbox"),
  () => persisted.library.readPortableState(),
  () => persisted.library.previewExactRestore(goodCheckpoint)
]) await unchanged(persisted, read);
for (const operation of [put("second"), { type: "delete", family: "inbox", id: "second" }]) {
  await unchanged(persisted, () => persisted.library.transact([put("first", icon), operation]));
}
await unchanged(persisted, () => persisted.library.applyRemoteBatch(goodBatch));
await unchanged(persisted, () => persisted.library.applyRemoteCheckpoint({
  deviceId: "remote", sourceId: "source", throughSequence: 2, checkpoint: goodCheckpoint }));
await unchanged(persisted, () => persisted.library.replaceFromCheckpoint(goodCheckpoint));
assert.deepEqual((await persisted.library.createExactCheckpoint()).entities, [future],
  "opaque exact backup remains possible without interpreting the record");

const unknown = fixture();
const unknownEntity = { ...future, family: "futureFamily" };
await reseal(unknownEntity);
await unknown.adapter.transaction([LIBRARY_STORES.entities], "readwrite",
  tx => tx.put(LIBRARY_STORES.entities, unknownEntity));
await unchanged(unknown, () => unknown.library.readEntity("futureFamily", "second"));
await unchanged(unknown, () => unknown.library.readFamily("futureFamily"));
await unchanged(unknown, () => unknown.library.readPortableState());
await unchanged(unknown, () => unknown.library.replaceFromCheckpoint(goodCheckpoint));

// Envelope-version validation still rejects before any writes.
for (const formatVersion of [2, "1", null]) {
  const empty = fixture();
  const checkpoint = { ...goodCheckpoint, formatVersion };
  const before = await empty.state();
  await assert.rejects(() => empty.library.seedExactCheckpoint(checkpoint), /checkpoint is invalid/);
  assert.deepEqual(await empty.state(), before);
}

// Missing declarations and additive fields are already part of the current contract.
const supported = fixture();
const missing = put("missing", { extensionField: { keep: true } });
delete missing.value.schemaVersion;
await supported.library.transact([missing, put("current")]);
assert.deepEqual((await supported.library.readEntity("inbox", "missing")).value, missing.value);
await supported.library.transact([{ type: "put", family: "labelMeta", id: "current",
  value: { value: { schemaVersion: 123 } } }]);
console.log("PASS persisted-data protection and supported records");
