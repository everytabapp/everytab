/** Fixed synthetic workloads; timings include production Library preparation and IDB completion. */
import { hydrateEmbeddedFavicons } from "../js/lib/storage/assets.js";
import { openLibraryStore, verifyLibraryCheckpoint } from "../js/lib/storage/library-store.js";

export const SCENARIOS = [
  { records: 1_000, icons: 64 }, { records: 10_000, icons: 64 },
  { records: 1_000, icons: 1_000 }, { records: 10_000, icons: 10_000 }
];
export const ROUNDS = 3;
const WARM_SAMPLES = 5;
const SEED_BATCH = 100;

function assert(condition, label) {
  if (!condition) throw new Error(label);
}

export function makeFixture({ records, icons }) {
  assert(Number.isSafeInteger(records) && records > 0 && Number.isSafeInteger(icons) &&
    icons > 0 && icons <= records, "Invalid fixture dimensions");
  // Valid SVG payloads, padded to make each source representation the same length.
  const favicons = Array.from({ length: icons }, (_, index) =>
    `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><!--${String(index).padStart(6, "0")}${"x".repeat(900)}--><rect width="16" height="16" fill="#4285f4"/></svg>`)}`);
  return Array.from({ length: records }, (_, index) => ({
    id: `saved-${String(index).padStart(6, "0")}`,
    createdAt: 1_700_000_000_000 + index,
    labels: [`label-${index % 16}`],
    tabs: [{ url: `https://fixture.invalid/page/${index}`, title: `Synthetic saved tab ${index}`,
      favIconUrl: favicons[index % icons], pinned: index % 5 === 0 }]
  }));
}

export function verifyRows(rows, expected) {
  assert(rows.length === expected.length, "Saved row count mismatch");
  const remaining = new Map(expected.map(value => [value.id, value]));
  for (const row of rows) {
    const value = remaining.get(row.id);
    assert(value && row.family === "inbox" && row.lifecycle === "live", "Saved identity mismatch");
    // Compare all public payload fields independently of enumeration order.
    assert(equalValue(row.value, value), "Saved payload or favicon mismatch");
    remaining.delete(row.id);
  }
  assert(remaining.size === 0, "Missing saved identities");
}

function equalValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && equalValue(left[key], right[key]));
}

export function verifyCheckpointRows(checkpoint, expected) {
  const assets = new Map(checkpoint.assets.map(asset => [asset.digest, asset]));
  verifyRows(checkpoint.entities.map(entity => ({
    ...entity, value: hydrateEmbeddedFavicons(entity.value, assets)
  })), expected);
}

export function summarize(samples) {
  assert(samples.length > 0 && samples.every(value => Number.isFinite(value) && value >= 0),
    "Invalid timing samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { samples, count: samples.length, minMs: sorted[0], maxMs: sorted.at(-1),
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 };
}

async function deleteDatabase(name) {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = () => reject(new Error("Fixture database deletion failed"));
    request.onblocked = () => reject(new Error("Fixture database deletion blocked"));
  });
}

export async function runBenchmark(onProgress = () => {}) {
  const results = [];
  let deletedDatabases = 0;
  // Alternate scenario order across independent rounds to expose some order effects.
  for (let round = 0; round < ROUNDS; round += 1) {
    const scenarios = round % 2 ? [...SCENARIOS].reverse() : SCENARIOS;
    for (const scenario of scenarios) {
      const expected = makeFixture(scenario);
      const databaseName = `everytab-benchmark-${crypto.randomUUID()}`;
      const open = () => openLibraryStore({ databaseName, deviceId: "synthetic-benchmark" });
      let library = open();
      const samples = {};
      const measure = async (label, work) => {
        const start = performance.now();
        const result = await work();
        (samples[label] ??= []).push(performance.now() - start);
        return result;
      };
      const fixtureBytes = new TextEncoder().encode(JSON.stringify(expected)).length;
      const operation = value => ({ type: "put", family: "inbox", id: value.id, value });
      // Build input objects outside the timing region. Seed is reported separately.
      const batches = [];
      for (let offset = 0; offset < expected.length; offset += SEED_BATCH) {
        batches.push(expected.slice(offset, offset + SEED_BATCH).map(operation));
      }
      try {
        onProgress({ round: round + 1, ...scenario, phase: "seed" });
        await measure("seed", async () => {
          for (const batch of batches) await library.transact(batch);
        });
        await library.close();
        library = open();
        onProgress({ round: round + 1, ...scenario, phase: "read" });
        verifyRows(await measure("reopenedFamilyRead", () => library.readFamily("inbox")), expected);
        for (let sample = 0; sample < WARM_SAMPLES; sample += 1) {
          verifyRows(await measure("warmFamilyRead", () => library.readFamily("inbox")), expected);
          const selected = expected[Math.floor(sample * (expected.length - 1) / (WARM_SAMPLES - 1))];
          verifyRows([await measure("warmEntityRead", () => library.readEntity("inbox", selected.id))], [selected]);
        }
        onProgress({ round: round + 1, ...scenario, phase: "update" });
        for (let sample = 0; sample < WARM_SAMPLES; sample += 1) {
          const index = Math.floor(sample * (expected.length - 1) / (WARM_SAMPLES - 1));
          expected[index] = { ...expected[index], labels: [...expected[index].labels, `edit-${sample}`] };
          const operations = [operation(expected[index])];
          const receipt = await measure("entityUpdate", () => library.transact(operations));
          assert(receipt.changes.length === 1 && receipt.changes[0].entity.id === expected[index].id,
            "Update receipt mismatch");
          verifyRows([await library.readEntity("inbox", expected[index].id)], [expected[index]]);
        }
        onProgress({ round: round + 1, ...scenario, phase: "checkpoint" });
        const checkpoint = await measure("checkpoint", () => library.createExactCheckpoint());
        await verifyLibraryCheckpoint(checkpoint);
        verifyCheckpointRows(checkpoint, expected);
        assert(checkpoint.entities.length === scenario.records && checkpoint.assets.length === scenario.icons,
          "Checkpoint cardinality mismatch");
        const expectedIcons = new Set(expected.map(value => value.tabs[0].favIconUrl));
        for (const asset of checkpoint.assets) assert(expectedIcons.delete(asset.dataUrl), "Checkpoint asset mismatch");
        assert(expectedIcons.size === 0, "Checkpoint asset missing");
        await library.close();
        library = open();
        verifyRows(await library.readFamily("inbox"), expected);
        results.push({ round: round + 1, ...scenario, fixtureBytes,
          timings: Object.fromEntries(Object.entries(samples).map(([label, values]) => [label, summarize(values)])) });
      } finally {
        await library.close();
        await deleteDatabase(databaseName);
        deletedDatabases += 1;
      }
    }
  }
  return { results, parameters: { rounds: ROUNDS, warmSamples: WARM_SAMPLES, seedBatch: SEED_BATCH,
    tabsPerRecord: 1, labels: 16, family: "inbox" }, cleanup: { deletedDatabases } };
}
