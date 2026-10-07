/** Complete-sync performance gate for first-publication favicon work. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { syncVault } from "../js/vault/protocol-sync.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

const ASSET_COUNT = 400;
const ASSET_OPERATION_DELAY_MS = 8;
const MAX_SYNC_MS = 1_900;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SlowFile {
  kind = "file";

  constructor(name, metrics, slow = false) {
    this.name = name;
    this.metrics = metrics;
    this.slow = slow;
    this.content = "";
  }

  async operation() {
    if (!this.slow) return;
    await this.metrics.operation();
  }

  async getFile() {
    await this.operation();
    const content = this.content;
    return {
      text: async () => typeof content === "string"
        ? content
        : new TextDecoder().decode(content),
      arrayBuffer: async () => {
        const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
    };
  }

  async createWritable() {
    const file = this;
    const chunks = [];
    return {
      async write(value) {
        await file.operation();
        chunks.push(value);
      },
      async close() {
        await file.operation();
        file.content = chunks.every((value) => typeof value === "string")
          ? chunks.join("")
          : new Uint8Array(await new Blob(chunks).arrayBuffer());
        file.metrics.assetWrites += file.slow ? 1 : 0;
      }
    };
  }
}

class SlowDirectory {
  kind = "directory";

  constructor(name, metrics, slowAssets = false) {
    this.name = name;
    this.metrics = metrics;
    this.slowAssets = slowAssets;
    this.children = new Map();
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    const existing = this.children.get(name);
    if (existing?.kind === "directory") return existing;
    if (existing || !create) {
      const error = new Error(`Directory ${name} not found`);
      error.name = "NotFoundError";
      throw error;
    }
    const directory = new SlowDirectory(name, this.metrics, name === "assets");
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(name, { create = false } = {}) {
    if (this.slowAssets) await this.metrics.operation();
    const existing = this.children.get(name);
    if (existing?.kind === "file") return existing;
    if (existing || !create) {
      const error = new Error(`File ${name} not found`);
      error.name = "NotFoundError";
      throw error;
    }
    const file = new SlowFile(name, this.metrics, this.slowAssets);
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name) {
    if (!this.children.delete(name)) throw new Error(`Entry ${name} not found`);
  }

  async *entries() {
    yield* this.children.entries();
  }
}

const metrics = {
  active: 0,
  maxActive: 0,
  assetOperations: 0,
  assetWrites: 0,
  async operation() {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.assetOperations += 1;
    await pause(ASSET_OPERATION_DELAY_MS);
    this.active -= 1;
  }
};

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    locks: {
      async request(_name, { ifAvailable }, work) {
        assert.equal(ifAvailable, true);
        return work({ name: "everytab-vault-sync" });
      }
    }
  }
});

const now = { value: 1_000 };
const library = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: "scale-device",
  createId: () => "scale-source",
  now: () => now.value
});
const recovery = createRecoveryStore({
  adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA),
  now: () => now.value
});
const tabs = Array.from({ length: ASSET_COUNT }, (_, index) => ({
  url: `https://scale-${index}.example`,
  title: `Scale ${index}`,
  favIconUrl: `data:image/png;base64,${Buffer.from(`favicon-${index}`).toString("base64")}`
}));
await library.transact(tabs.map((tab, index) => ({
  type: "put",
  family: "inbox",
  id: `scale-${index}`,
  value: {
    id: `scale-${index}`,
    kind: "tab",
    tabs: [tab],
    labels: []
  }
})));
await recovery.captureSnapshot({ windows: [tabs] }, { retention: 200, id: "scale-snapshot" });

const root = new SlowDirectory("scale-vault", metrics);
const ids = ["scale-vault-id", "scale-checkpoint-id"];
const startedAt = performance.now();
const report = await syncVault(root, {
  library,
  recovery,
  now: now.value,
  createId: () => ids.shift()
});
const elapsed = performance.now() - startedAt;

assert.equal(report.assetsWritten, ASSET_COUNT,
  "overlapping Library and Recovery favicons are written once");
assert.equal(root.children.get("assets").children.size, ASSET_COUNT,
  "every unique favicon has one content-addressed file");
assert.ok(metrics.maxActive > 1, "favicon publication uses bounded concurrency");
assert.ok(metrics.maxActive <= 8,
  `favicon publication exceeded eight workers (${metrics.maxActive})`);
assert.ok(metrics.assetOperations <= ASSET_COUNT * 3,
  `bootstrap repeated ${metrics.assetOperations - (ASSET_COUNT * 3)} asset operations`);
assert.ok(elapsed < MAX_SYNC_MS,
  `400-asset bootstrap took ${elapsed.toFixed(1)} ms, budget ${MAX_SYNC_MS} ms`);

const bootstrapAssetOperations = metrics.assetOperations;
let compacted = null;
let sawCompaction = false;
for (let index = 1; index <= 17; index += 1) {
  now.value += 1;
  await recovery.captureSnapshot({ windows: [tabs] }, {
    retention: 200,
    id: `scale-follow-up-${index}`
  });
  compacted = await syncVault(root, {
    library,
    recovery,
    now: now.value
  });
  sawCompaction ||= compacted.recoveryCompacted;
}
assert.equal(sawCompaction, true,
  "the fixture reaches the bounded Recovery compaction path");
assert.equal(metrics.assetOperations, bootstrapAssetOperations,
  "Recovery increments and compaction trust their sealed published-asset receipt");

console.log(
  `PASS: ${ASSET_COUNT} shared Vault favicons in ${elapsed.toFixed(1)} ms, ` +
  `${metrics.assetOperations} asset operations, max concurrency ${metrics.maxActive}`
);
