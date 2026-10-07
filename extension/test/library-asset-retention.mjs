import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { LIBRARY_SCHEMA } from "../js/lib/storage/schema.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

const DAY = 24 * 60 * 60 * 1000;
const icon = (value) => `data:image/png;base64,${value}`;
const record = (url, favIconUrl) => ({
  type: "put", family: "inbox", id: "asset-row",
  value: { id: "asset-row", kind: "tab", tabs: [{ url, title: url, favIconUrl }], labels: [] }
});
const make = (adapter, now, deviceId = "asset-device") => createLibraryStore({
  adapter, deviceId, createId: () => "asset-source", now: () => now.value
});
const assets = (adapter) => adapter.transaction(["assets"], "readonly", (tx) => tx.getAll("assets"));
const scan = (library) => library.collectUnusedAssets();

const now = { value: 1000 * DAY };
const baseAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
let rootReads = 0;
const adapter = {
  transaction: (stores, mode, work) => baseAdapter.transaction(stores, mode, (tx) => work({
    ...tx,
    getAll: (store) => { rootReads += 1; return tx.getAll(store); }
  })),
  close: () => baseAdapter.close()
};
const library = make(adapter, now);
await library.transact([record("https://old.example", icon("AQID"))]);
await library.transact([record("https://new.example", icon("BAUG"))]);
await library.acknowledgeSync(2);
assert.equal((await assets(adapter)).length, 2);
assert.deepEqual(await scan(library), { skipped: false, removed: 0, retained: 2 });
rootReads = 0;
assert.deepEqual(await scan(library), { skipped: true, removed: 0, retained: null });
assert.equal(rootReads, 0, "same-day maintenance does not scan roots or assets");
now.value -= DAY;
assert.equal((await scan(library)).skipped, true, "clock rollback cannot accelerate collection");
now.value += DAY;
now.value += 7 * DAY;
assert.deepEqual(await scan(library), { skipped: false, removed: 1, retained: 1 });
assert.equal((await assets(adapter)).length, 1);

/* Each supported local shape is independently exercised as an asset root. */
async function checkLocalRoot(label, buildRoot) {
  const rootAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
  const rootNow = { value: now.value };
  const rootLibrary = make(rootAdapter, rootNow, `root-${label}`);
  const oldUrl = `https://${label}-old.example`;
  await rootLibrary.transact([record(oldUrl, icon("CQkJ"))]);
  await rootLibrary.transact([record(`https://${label}-new.example`, icon("DAwM"))]);
  await rootLibrary.acknowledgeSync(2);
  const oldDigest = (await assets(rootAdapter)).find(({ dataUrl }) => dataUrl === icon("CQkJ")).digest;
  await rootLibrary.commit({ localSets: { raw: buildRoot(oldDigest) } });
  await rootLibrary.collectUnusedAssets();
  rootNow.value += 7 * DAY;
  await rootLibrary.collectUnusedAssets();
  assert.ok((await assets(rootAdapter)).some(({ digest }) => digest === oldDigest),
    `${label} local root survives the grace window`);
  await rootLibrary.commit({ localSets: { raw: { cleared: true } } });
  rootNow.value += DAY;
  await rootLibrary.collectUnusedAssets();
  rootNow.value += 7 * DAY;
  assert.equal((await rootLibrary.collectUnusedAssets()).removed, 1,
    `${label} root removal starts a fresh grace period`);
}
await checkLocalRoot("nested", (digest) => ({ nested: { everytabAsset: digest } }));
await checkLocalRoot("map", (digest) => ({ digestMap: { [digest]: true } }));
await checkLocalRoot("map-value", (digest) => ({ digestMap: new Map([["asset", digest]]) }));
await checkLocalRoot("set-value", (digest) => ({ digestSet: new Set([digest]) }));

/* Unknown record formats break the grace proof without deleting anything. */
const unknownAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const unknownNow = { value: now.value };
const unknown = make(unknownAdapter, unknownNow, "unknown-device");
await unknown.transact([record("https://unknown-orphan.example", icon("Dg4O"))]);
await unknown.transact([record("https://unknown-live.example", icon("Dw8P"))]);
await unknown.acknowledgeSync(2);
assert.equal((await scan(unknown)).skipped, false, "establish an orphan candidate first");
await unknownAdapter.transaction(["entities"], "readwrite", (tx) => tx.put("entities", {
  family: "future-family", id: "future", lifecycle: "live", value: { schemaVersion: 1 },
  assetDigests: []
}));
unknownNow.value += 7 * DAY;
assert.deepEqual(await scan(unknown), { skipped: true, removed: 0, retained: null });
assert.equal((await assets(unknownAdapter)).length, 2);

/* Cyclic local values must not hang the collector. */
const cyclic = {};
cyclic.self = cyclic;
await unknown.commit({ localSets: { cycle: cyclic } });
await unknownAdapter.transaction(["entities"], "readwrite", (tx) =>
  tx.delete("entities", ["future-family", "future"]));
unknownNow.value += DAY;
assert.equal((await scan(unknown)).skipped, false);
unknownNow.value += DAY;
assert.equal((await scan(unknown)).removed, 0, "unsupported data broke the old grace proof");
unknownNow.value += 7 * DAY;
assert.equal((await scan(unknown)).removed, 1);
await unknownAdapter.transaction(["entities", "outbox"], "readwrite", async (tx) => {
  await tx.put("outbox", {
    deviceId: "unknown-device", sequence: 99,
    entity: { family: "future-outbox-family", id: "future", lifecycle: "deleted" }
  });
});
unknownNow.value += DAY;
assert.equal((await scan(unknown)).skipped, true);
await unknownAdapter.transaction(["outbox"], "readwrite", (tx) =>
  tx.delete("outbox", ["unknown-device", 99]));
await unknownAdapter.transaction(["entities"], "readwrite", (tx) => tx.put("entities", {
  family: "inbox", id: "bad-lifecycle", lifecycle: "future", assetDigests: []
}));
unknownNow.value += DAY;
assert.equal((await scan(unknown)).skipped, true);

/* An exact-Restore safety checkpoint is an asset root until Undo/Confirm. */
const pendingAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const pendingNow = { value: now.value };
const pending = make(pendingAdapter, pendingNow, "pending-device");
await pending.transact([record("https://pending-old.example", icon("ERER"))]);
const emptyPending = make(createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), pendingNow, "empty-pending");
const pendingCheckpoint = await emptyPending.createExactCheckpoint();
const pendingPreview = await pending.previewExactRestore(pendingCheckpoint);
await pending.replaceFromCheckpoint(pendingCheckpoint, {
  expectedSequence: pendingPreview.currentSequence,
  expectedRestoreEpoch: pendingPreview.restoreEpoch,
  expectedStateHash: pendingPreview.currentStateHash,
  restoreId: "pending-restore"
});
await pending.acknowledgeSync(2);
await pending.collectUnusedAssets();
pendingNow.value += 7 * DAY;
await pending.collectUnusedAssets();
assert.equal((await assets(pendingAdapter)).length, 1,
  "the pending Restore checkpoint keeps its favicon asset alive");
assert.equal((await pending.readPendingRestore()).id, "pending-restore");
await pending.undoExactRestore("pending-restore");
assert.equal((await pending.readEntity("inbox", "asset-row")).value.tabs[0].favIconUrl, icon("ERER"));

/* Pending sync history is an independent root; renewed use restarts the grace period. */
const historyAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const historyNow = { value: now.value };
const history = make(historyAdapter, historyNow, "history-device");
await history.transact([record("https://history-old.example", icon("AQID"))]);
await history.transact([record("https://history-new.example", icon("BAUG"))]);
await scan(history);
historyNow.value += 7 * DAY;
assert.equal((await scan(history)).removed, 0, "unacknowledged history keeps the old favicon");
assert.equal((await assets(historyAdapter)).length, 2);
await history.acknowledgeSync(2);
historyNow.value += DAY;
await scan(history); // Old icon is first unreferenced here.
historyNow.value += DAY;
await history.transact([record("https://history-reused.example", icon("AQID"))]);
await history.acknowledgeSync(3);
await scan(history);
historyNow.value += DAY;
await history.transact([record("https://history-current.example", icon("BAUG"))]);
await history.acknowledgeSync(4);
await scan(history); // Its first-unreferenced date must restart here.
historyNow.value += 5 * DAY;
assert.equal((await scan(history)).removed, 0);
historyNow.value += 2 * DAY;
assert.equal((await scan(history)).removed, 1);
assert.equal((await history.readEntity("inbox", "asset-row")).value.tabs[0].favIconUrl, icon("BAUG"));

/* A failed asset deletion rolls the whole transaction back. */
const failingBase = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
let failingAssetDeletes = 0;
const failingAdapter = {
  transaction: (stores, mode, work) => failingBase.transaction(stores, mode, (tx) => work({
    ...tx,
    delete: async (store, key) => {
      if (store === "assets") {
        failingAssetDeletes += 1;
        if (failingAssetDeletes === 2) throw new Error("asset deletion failed");
      }
      return tx.delete(store, key);
    }
  })),
  close: () => failingBase.close()
};
const failingNow = { value: now.value };
const failing = make(failingAdapter, failingNow, "failing-device");
await failing.transact([record("https://failing-old.example", icon("EBES"))]);
await failing.transact([record("https://failing-middle.example", icon("ExMT"))]);
await failing.transact([record("https://failing-new.example", icon("FhYW"))]);
await failing.acknowledgeSync(3);
await failing.collectUnusedAssets();
const failingBefore = await Promise.all(["entities", "assets", "outbox", "local", "meta"]
  .map((store) => failingBase.transaction([store], "readonly", (tx) => tx.getAll(store))));
failingNow.value += 7 * DAY;
await assert.rejects(() => failing.collectUnusedAssets(), /asset deletion failed/);
const failingAfter = await Promise.all(["entities", "assets", "outbox", "local", "meta"]
  .map((store) => failingBase.transaction([store], "readonly", (tx) => tx.getAll(store))));
assert.deepEqual(failingAfter, failingBefore, "failed collection rolls back every Library store");

/* A corrupt retention receipt fails closed without touching assets. */
const corruptAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const corruptNow = { value: now.value };
const corrupt = make(corruptAdapter, corruptNow, "corrupt-device");
await corrupt.transact([record("https://corrupt-old.example", icon("FhYW"))]);
await corrupt.transact([record("https://corrupt-new.example", icon("FxgY"))]);
await corrupt.acknowledgeSync(2);
await corrupt.collectUnusedAssets();
await corruptAdapter.transaction(["meta"], "readwrite", (tx) => tx.put("meta", {
  key: "library-asset-retention", value: { formatVersion: 1, lastScanAt: "bad", candidates: [] }
}));
corruptNow.value += 7 * DAY;
await assert.rejects(() => corrupt.collectUnusedAssets(), /asset-retention receipt is invalid/);
assert.equal((await assets(corruptAdapter)).length, 2);

console.log("PASS: Library asset retention");
