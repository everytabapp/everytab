/** The Recovery favicon receipt is a bounded cache, never a sync-blocking history. */
import assert from "node:assert/strict";
import { publishRecovery } from "../js/vault/recovery-sync.js";
import { createAssetWriter, seal, writeJson, readNamedFile } from "../js/vault/protocol-io.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

class Directory {
  kind = "directory";
  children = new Map();
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      this.children.set(name, new Directory());
    }
    return this.children.get(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      let content = "";
      this.children.set(name, {
        kind: "file",
        getFile: async () => new Blob([content]),
        createWritable: async () => {
          let next;
          return { write: async value => { next = value; }, close: async () => { content = next; } };
        }
      });
    }
    return this.children.get(name);
  }
  async *entries() { yield* this.children.entries(); }
  async removeEntry(name) { this.children.delete(name); }
}

for (const initialCount of [9_999, 10_000, 10_001]) {
  const root = new Directory();
  const directory = await (await root.getDirectoryHandle("recovery", { create: true }))
    .getDirectoryHandle("device", { create: true });
  const assets = await root.getDirectoryHandle("assets", { create: true });
  await directory.getDirectoryHandle("packs", { create: true });
  const identity = { vaultId: "vault", deviceId: "device", sourceId: "source" };
  const prior = await seal({ app: "everytab", kind: "vault-v2-recovery-manifest",
    formatVersion: 1, ...identity, sequence: 0, snapshots: [], packs: [],
    publishedAssetDigests: Array.from({ length: initialCount }, (_, index) =>
      `sha256:${index.toString(16).padStart(64, "0")}`), cleanupPending: false, updatedAt: 0 });
  await writeJson(directory, "manifest.json", prior);
  const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA),
    now: () => 1_000 });
  const report = { assetsWritten: 0, recoveryPacksPruned: 0 };
  const sync = () => publishRecovery({ root, recovery, format: { vaultId: "vault" },
    replication: { deviceId: "device", sourceId: "source" }, now: 1_000,
    cryptoProvider: globalThis.crypto, report, onProgress: () => {},
    assetWriter: createAssetWriter(assets) });
  // A previous version's oversized receipt must repair even with no new Snapshot.
  await sync();
  assert.ok(JSON.parse(await readNamedFile(directory, "manifest.json"))
    .publishedAssetDigests.length <= 10_000);
  for (let index = 0; index < 20; index++) {
    await recovery.captureSnapshot({ id: `snapshot-${index}`, auto: true,
      windows: [[{ url: `https://fixture-${index}.example`,
        favIconUrl: `data:image/png;base64,${btoa(`favicon-${index}`)}` }]] }, { retention: 18 });
    const result = await sync();
    assert.ok(result.publishedAssetDigests.length <= 10_000,
      "repeated publication must never write a receipt the next sync rejects");
    await sync();
  }
  assert.ok(report.recoveryCompacted || report.recoveryPacksPruned > 0);
  assert.equal(assets.children.size, 20, "receipt eviction must never delete actual asset files");
  const firstAssetName = assets.children.keys().next().value;
  const firstDigest = `sha256:${firstAssetName.replace(/\.bin$/, "")}`;
  const oldAssetText = await readNamedFile(assets, firstAssetName);
  const manifest = JSON.parse(await readNamedFile(directory, "manifest.json"));
  // Simulate a forgotten old hint while retaining its real immutable file.
  const { contentHash: _seal, ...cacheMiss } = manifest;
  cacheMiss.publishedAssetDigests = cacheMiss.publishedAssetDigests.filter(digest => digest !== firstDigest);
  await writeJson(directory, "manifest.json", await seal(cacheMiss));
  const writesBeforeReuse = report.assetsWritten;
  await recovery.captureSnapshot({ id: "reused-icon", auto: true,
    windows: [[{ url: "https://reused.example", favIconUrl: `data:image/png;base64,${btoa("favicon-0")}` }]] },
  { retention: 18 });
  await sync();
  assert.equal(report.assetsWritten, writesBeforeReuse,
    "an evicted receipt falls back to checking and reusing the existing asset file");
  assert.equal(await readNamedFile(assets, firstAssetName), oldAssetText);
}
console.log("PASS: Recovery asset receipts stay bounded and oversized existing receipts self-repair");
