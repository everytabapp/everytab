/**
 * Regression gate for the one-time Vault favicon bootstrap.
 *
 * Cloud-backed File System Access handles have meaningful per-file latency.
 * Unique assets must therefore use bounded concurrency rather than multiplying
 * that latency by every favicon in the initial checkpoint.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  hydrateAssetManifest, readAssets, writeAssets
} from "../js/vault/protocol-io.js";

const ASSET_COUNT = 40;
const OPERATION_DELAY_MS = 8;
const MAX_BOOTSTRAP_MS = 320;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SlowFile {
  kind = "file";

  constructor(name, metrics) {
    this.name = name;
    this.metrics = metrics;
    this.content = "";
  }

  async getFile() {
    await this.metrics.operation();
    const content = this.content;
    return { text: async () => content };
  }

  async createWritable() {
    const file = this;
    let content = "";
    return {
      async write(value) {
        await file.metrics.operation();
        content += value;
      },
      async close() {
        await file.metrics.operation();
        file.content = content;
        file.metrics.writes += 1;
      }
    };
  }
}

class SlowDirectory {
  kind = "directory";

  constructor(metrics) {
    this.metrics = metrics;
    this.children = new Map();
  }

  async getFileHandle(name, { create = false } = {}) {
    await this.metrics.operation();
    const existing = this.children.get(name);
    if (existing) return existing;
    if (!create) {
      const error = new Error(`File ${name} not found`);
      error.name = "NotFoundError";
      throw error;
    }
    const file = new SlowFile(name, this.metrics);
    this.children.set(name, file);
    return file;
  }
}

const metrics = {
  active: 0,
  maxActive: 0,
  writes: 0,
  async operation() {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await pause(OPERATION_DELAY_MS);
    this.active -= 1;
  }
};
const directory = new SlowDirectory(metrics);
const assets = Array.from({ length: ASSET_COUNT }, (_, index) => ({
  digest: `sha256:${index.toString(16).padStart(64, "0")}`,
  dataUrl: `data:image/png;base64,${Buffer.from(`favicon-${index}`).toString("base64")}`
}));
const report = { assetsWritten: 0 };
const progress = [];

const startedAt = performance.now();
await writeAssets(directory, assets, report, (event) => progress.push(event));
const elapsed = performance.now() - startedAt;

assert.ok(metrics.maxActive > 1,
  `favicon bootstrap remained serial with max concurrency ${metrics.maxActive}`);
assert.ok(metrics.maxActive <= 8,
  `favicon bootstrap exceeded its eight-operation concurrency bound (${metrics.maxActive})`);
assert.ok(elapsed < MAX_BOOTSTRAP_MS,
  `favicon bootstrap took ${elapsed.toFixed(1)} ms, budget ${MAX_BOOTSTRAP_MS} ms`);
assert.equal(metrics.writes, ASSET_COUNT, "every unique favicon was written exactly once");
assert.equal(report.assetsWritten, ASSET_COUNT, "the sync report counted every written favicon");
assert.deepEqual(progress.map(({ completed }) => completed),
  Array.from({ length: ASSET_COUNT }, (_, index) => index + 1),
"progress remained monotonic while writes completed concurrently");

console.log(
  `PASS: ${ASSET_COUNT} Vault assets in ${elapsed.toFixed(1)} ms, max concurrency ${metrics.maxActive}`
);

metrics.active = 0;
metrics.maxActive = 0;
const readReport = { assetsRead: 0 };
const readStartedAt = performance.now();
const read = await readAssets(directory, assets.map(({ digest }) => digest), readReport);
const readElapsed = performance.now() - readStartedAt;
assert.deepEqual(read.map(({ digest }) => digest), assets.map(({ digest }) => digest),
  "concurrent favicon reads retain manifest order");
assert.equal(readReport.assetsRead, ASSET_COUNT);
assert.ok(metrics.maxActive > 1,
  `favicon restore remained serial with max concurrency ${metrics.maxActive}`);
assert.ok(metrics.maxActive <= 8,
  `favicon restore exceeded its eight-operation concurrency bound (${metrics.maxActive})`);
assert.ok(readElapsed < 220,
  `favicon restore took ${readElapsed.toFixed(1)} ms, budget 220 ms`);
console.log(
  `PASS: ${ASSET_COUNT} Vault asset reads in ${readElapsed.toFixed(1)} ms, ` +
  `max concurrency ${metrics.maxActive}`
);

const CACHED_RESTORE_ASSET_COUNT = 92;
const cachedRestoreAssets = Array.from({ length: CACHED_RESTORE_ASSET_COUNT }, (_, index) => ({
  digest: `sha256:${(index + 1_000).toString(16).padStart(64, "0")}`,
  dataUrl: `data:image/png;base64,${Buffer.from(`restore-${index}`).toString("base64")}`
}));
const cachedRestoreManifest = cachedRestoreAssets.map(({ dataUrl: _dataUrl, ...asset }) => asset);
let unexpectedVaultAssetReads = 0;
const unavailableDirectory = {
  async getFileHandle() {
    unexpectedVaultAssetReads += 1;
    throw new Error("A fully cached Restore must not open a Vault favicon file");
  }
};
const cachedRestoreStartedAt = performance.now();
const cachedRestore = await hydrateAssetManifest(
  unavailableDirectory,
  cachedRestoreManifest,
  { assetsRead: 0 },
  () => {},
  { cachedAssets: cachedRestoreAssets }
);
const cachedRestoreElapsed = performance.now() - cachedRestoreStartedAt;
assert.equal(unexpectedVaultAssetReads, 0,
  "92 locally available Restore favicons issue no cloud-folder reads");
assert.deepEqual(cachedRestore, cachedRestoreAssets,
  "cached Restore favicon hydration retains exact manifest order and payloads");
assert.ok(cachedRestoreElapsed < 25,
  `92 cached Restore favicons took ${cachedRestoreElapsed.toFixed(1)} ms, budget 25 ms`);
console.log(
  `PASS: ${CACHED_RESTORE_ASSET_COUNT} cached Restore favicons in ` +
  `${cachedRestoreElapsed.toFixed(1)} ms with zero Vault asset reads`
);
