/** Regression gate for bounded local IndexedDB favicon hydration. */
import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import {
  LIBRARY_SCHEMA, LIBRARY_STORES, RECOVERY_SCHEMA, RECOVERY_STORES
} from "../js/lib/storage/schema.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

const ASSET_COUNT = 40;
const MAX_ACTIVE_READS = 8;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const favicons = Array.from({ length: ASSET_COUNT }, (_, index) =>
  `data:image/png;base64,${Buffer.from(`local-favicon-${index}`).toString("base64")}`);

function measuredAdapter(schema, assetStore) {
  const base = createMemoryIndexedDbAdapter(schema);
  const metrics = { active: 0, maxActive: 0, reads: 0 };
  return {
    metrics,
    adapter: {
      close: () => base.close(),
      transaction: (stores, mode, work) => base.transaction(stores, mode, (transaction) =>
        work({
          ...transaction,
          async get(store, key) {
            if (store !== assetStore) return transaction.get(store, key);
            metrics.active += 1;
            metrics.maxActive = Math.max(metrics.maxActive, metrics.active);
            metrics.reads += 1;
            await pause(4);
            try {
              return await transaction.get(store, key);
            } finally {
              metrics.active -= 1;
            }
          }
        }))
    }
  };
}

function reset(metrics) {
  metrics.active = 0;
  metrics.maxActive = 0;
  metrics.reads = 0;
}

const libraryHarness = measuredAdapter(LIBRARY_SCHEMA, LIBRARY_STORES.assets);
const library = createLibraryStore({
  adapter: libraryHarness.adapter,
  deviceId: "bounded-library",
  now: () => 1_000
});
await library.transact([{
  type: "put",
  family: "inbox",
  id: "forty-favicons",
  value: {
    id: "forty-favicons",
    kind: "window",
    tabs: favicons.map((favIconUrl, index) => ({
      url: `https://library-${index}.example`,
      title: `Library ${index}`,
      favIconUrl
    }))
  }
}]);
reset(libraryHarness.metrics);
const entity = await library.readEntity("inbox", "forty-favicons");
assert.deepEqual(entity.value.tabs.map(({ favIconUrl }) => favIconUrl), favicons,
  "Library hydration preserves every exact favicon");
assert.equal(libraryHarness.metrics.reads, ASSET_COUNT,
  "Library reads every unique referenced favicon once");
assert.ok(libraryHarness.metrics.maxActive <= MAX_ACTIVE_READS,
  `Library issued ${libraryHarness.metrics.maxActive} concurrent favicon reads`);

const recoveryHarness = measuredAdapter(RECOVERY_SCHEMA, RECOVERY_STORES.assets);
const recovery = createRecoveryStore({
  adapter: recoveryHarness.adapter,
  now: () => 2_000,
  createId: () => "snapshot-forty-favicons"
});
await recovery.captureSnapshot({
  id: "snapshot-forty-favicons",
  windows: [{
    tabs: favicons.map((favIconUrl, index) => ({
      url: `https://recovery-${index}.example`,
      title: `Recovery ${index}`,
      favIconUrl
    }))
  }]
});
reset(recoveryHarness.metrics);
const snapshot = await recovery.readSnapshot("snapshot-forty-favicons");
assert.deepEqual(snapshot.value.windows[0].tabs.map(({ favIconUrl }) => favIconUrl), favicons,
  "Recovery hydration preserves every exact favicon");
assert.equal(recoveryHarness.metrics.reads, ASSET_COUNT,
  "Recovery reads every unique referenced favicon once");
assert.ok(recoveryHarness.metrics.maxActive <= MAX_ACTIVE_READS,
  `Recovery issued ${recoveryHarness.metrics.maxActive} concurrent favicon reads`);

console.log(
  `PASS: Library and Recovery hydrate ${ASSET_COUNT} local favicons with at most ` +
  `${MAX_ACTIVE_READS} concurrent IndexedDB reads`
);
