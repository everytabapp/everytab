/** Read-only Vault steady-state audit contract. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildVaultSteadyStateReport,
  measureVaultStorage,
  noChangeVaultSync
} from "../../tools/diagnostics/storage-audit.js";

class MemFile {
  kind = "file";
  constructor(size, metrics) {
    this.size = size;
    this.metrics = metrics;
  }
  async getFile() {
    this.metrics.metadataReads += 1;
    this.metrics.activeMetadataReads += 1;
    this.metrics.maxMetadataReads = Math.max(
      this.metrics.maxMetadataReads,
      this.metrics.activeMetadataReads
    );
    await Promise.resolve();
    this.metrics.activeMetadataReads -= 1;
    return { size: this.size };
  }
}

class MemDirectory {
  kind = "directory";
  constructor(metrics) {
    this.metrics = metrics;
    this.children = new Map();
  }
  file(name, size) {
    this.children.set(name, new MemFile(size, this.metrics));
    return this;
  }
  directory(name) {
    const child = new MemDirectory(this.metrics);
    this.children.set(name, child);
    return child;
  }
  async *entries() {
    this.metrics.directoryReads += 1;
    yield* this.children.entries();
  }
}

const metrics = {
  directoryReads: 0,
  metadataReads: 0,
  activeMetadataReads: 0,
  maxMetadataReads: 0
};
const root = new MemDirectory(metrics);
root.file("format.json", 100)
  .file("library.json", 1_000)
  .file("index.md", 300)
  .file("views.json", 200)
  .file("maintenance.json", 150)
  .file("private-user-name.json", 25);
root.directory("devices").directory("private-device-id")
  .file("manifest.json", 80);
root.children.get("devices").children.get("private-device-id")
  .directory("transactions").file("private-transaction-name.json", 500);
root.directory("recovery").directory("private-device-id")
  .file("manifest.json", 90);
root.children.get("recovery").children.get("private-device-id")
  .directory("packs").file("private-recovery-pack.json.gz", 2_000);
root.directory("assets").file("private-favicon-digest.bin", 400);
root.directory("checkpoints").directory("private-checkpoint-id")
  .file("library.json", 4_000);
root.directory("backups").file("private-backup-name.json", 100);

const measured = await measureVaultStorage(root);
assert.deepEqual(measured.areas.protocol, {
  byteLength: 100, fileCount: 1, directoryCount: 0
});
assert.deepEqual(measured.areas.libraryChanges, {
  byteLength: 580, fileCount: 2, directoryCount: 3
});
assert.deepEqual(measured.areas.recovery, {
  byteLength: 2_090, fileCount: 2, directoryCount: 3
});
assert.deepEqual(measured.areas.favicons, {
  byteLength: 400, fileCount: 1, directoryCount: 1
});
assert.deepEqual(measured.areas.restorePoints, {
  byteLength: 4_250, fileCount: 3, directoryCount: 3
});
assert.deepEqual(measured.areas.readableViews, {
  byteLength: 1_500, fileCount: 3, directoryCount: 0
});
assert.deepEqual(measured.areas.other, {
  byteLength: 25, fileCount: 1, directoryCount: 0
});
assert.equal(measured.byteLength, 8_945);
assert.equal(measured.fileCount, 13);
assert.equal(metrics.metadataReads, 13, "audit reads file metadata once");
assert.equal(metrics.maxMetadataReads, 4, "audit bounds file metadata reads to four");

const zeroMeta = {
  lastSyncAt: 123,
  ok: true,
  storageVersion: 2,
  pulled: 0,
  pushed: 0,
  chunksRead: 0,
  chunksWritten: 0,
  chunksPruned: 0,
  assetsRead: 0,
  assetsWritten: 0,
  checkpointWritten: false,
  checkpointRead: false,
  recoveryPackWritten: false,
  recoverySnapshotsWritten: 0,
  recoveryPacksPruned: 0,
  recoveryCompacted: false,
  libraryCompacted: false,
  viewsWritten: false,
  backedUp: false,
  backupsPruned: 0,
  checkpointsPruned: 0,
  conflictCopies: 0,
  skipped: false
};
assert.equal(noChangeVaultSync(zeroMeta), true);
assert.equal(noChangeVaultSync({ ...zeroMeta, chunksRead: 1 }), false);
assert.equal(noChangeVaultSync({ ...zeroMeta, chunksPruned: 1 }), false);
assert.equal(noChangeVaultSync({ ...zeroMeta, backedUp: true }), false);
assert.equal(noChangeVaultSync({ ...zeroMeta, skipped: undefined }), true,
  "successful Vault receipts omit skipped");
assert.equal(noChangeVaultSync({ ...zeroMeta, skipped: true }), false);

let lockRequests = 0;
const lockManager = {
  async request(name, options, work) {
    lockRequests += 1;
    assert.equal(name, "everytab-vault-sync");
    assert.deepEqual(options, { ifAvailable: true });
    return work({ name });
  }
};
const report = await buildVaultSteadyStateReport(root, {
  syncMeta: zeroMeta,
  inspect: async () => ({ state: "ready", privateVaultId: "must-not-leak" }),
  estimateStorage: async () => ({ usage: 12_345, quota: 99_999 }),
  lockManager,
  now: () => 456
});
assert.equal(lockRequests, 1, "audit shares the Vault sync lock");
assert.equal(report.status, "verified");
assert.equal(report.vault.withinRetainedBudget, true);
assert.equal(report.vault.expectedTargetMet, true);
assert.deepEqual(report.browserStorage, {
  scope: "extension-origin-total", usage: 12_345, quota: 99_999
});
const serialized = JSON.stringify(report);
for (const secret of [
  "private-user-name",
  "private-device-id",
  "private-transaction-name",
  "private-recovery-pack",
  "private-favicon-digest",
  "private-checkpoint-id",
  "private-backup-name",
  "must-not-leak"
]) {
  assert.equal(serialized.includes(secret), false, `report leaked ${secret}`);
}

const changed = await buildVaultSteadyStateReport(root, {
  syncMeta: { ...zeroMeta, pushed: 1, chunksWritten: 1 },
  inspect: async () => ({ state: "ready" })
});
assert.equal(changed.status, "attention");
assert.equal(changed.lastSync.noChange, false);

await assert.rejects(() => buildVaultSteadyStateReport(root, {
  syncMeta: zeroMeta,
  inspect: async () => ({ state: "ready" }),
  lockManager: { request: async (_name, _options, work) => work(null) }
}), /sync is running/);

const vaultSurfaceSource = await readFile(
  new URL("../js/ui/vault-surface.js", import.meta.url), "utf8"
);
assert.doesNotMatch(vaultSurfaceSource, /v2-storage-audit|Storage check|Check storage/,
  "the engineering audit must not be exposed as an end-user Vault control");

console.log("PASS: Vault steady-state audit is read-only, strict, and privacy-safe");
