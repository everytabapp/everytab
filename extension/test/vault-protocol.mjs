/** Vault protocol tests at the deep sync interface. */
import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { commitLibraryChange } from "../js/lib/store.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import {
  inspectVaultRoot, syncVault
} from "../js/vault/protocol-sync.js";
import { seal } from "../js/vault/protocol-io.js";
import { noChangeVaultSync } from "../../tools/diagnostics/storage-audit.js";
import {
  confirmVaultRestore,
  listVaultRestorePoints,
  listVaultRestorePointsWithReport,
  previewVaultRestorePoint,
  restoreVaultRestorePoint,
  undoVaultRestore
} from "../js/vault/restore.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

class MemFile {
  kind = "file";
  constructor(name, metrics, content = "", parentName = "") {
    this.name = name;
    this.metrics = metrics;
    this.content = content;
    this.parentName = parentName;
  }
  async getFile() {
    assert.ok(!activeLocks.includes("everytab-store"),
      "Vault file reads stay outside the Store lock");
    this.metrics.reads += 1;
    if (this.parentName === "transactions") {
      this.metrics.transactionReads = (this.metrics.transactionReads ?? 0) + 1;
    }
    const captured = this.content;
    if (this.metrics.onReadName === this.name &&
        (!this.metrics.onReadPredicate || this.metrics.onReadPredicate(this))) {
      const hook = this.metrics.onRead;
      delete this.metrics.onReadName;
      delete this.metrics.onRead;
      delete this.metrics.onReadPredicate;
      await hook?.(this);
    }
    if (this.parentName === "assets") {
      this.metrics.assetReads = (this.metrics.assetReads ?? 0) + 1;
    }
    return {
      text: async () => typeof captured === "string"
        ? captured
        : new TextDecoder().decode(captured),
      arrayBuffer: async () => {
        const bytes = typeof captured === "string"
          ? new TextEncoder().encode(captured)
          : captured;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
    };
  }
  async createWritable() {
    assert.ok(!activeLocks.includes("everytab-store"),
      "Vault file writes stay outside the Store lock");
    const chunks = [];
    return {
      write: async (value) => { chunks.push(value); },
      close: async () => {
        if (this.name === "manifest.json") {
          this.metrics.manifestWrites = (this.metrics.manifestWrites ?? 0) + 1;
          if (this.metrics.failManifestWriteAt === this.metrics.manifestWrites) {
            delete this.metrics.failManifestWriteAt;
            throw new Error("Injected rollover manifest failure");
          }
        }
        if (this.metrics.failNextWriteName === this.name) {
          delete this.metrics.failNextWriteName;
          throw new Error(`Injected write failure for ${this.name}`);
        }
        if (this.metrics.onBeforeWriteCloseName === this.name) {
          const hook = this.metrics.onBeforeWriteClose;
          delete this.metrics.onBeforeWriteCloseName;
          delete this.metrics.onBeforeWriteClose;
          await hook?.();
        }
        this.content = chunks.every((value) => typeof value === "string")
          ? chunks.join("")
          : new Uint8Array(await new Blob(chunks).arrayBuffer());
        this.metrics.writes += 1;
      }
    };
  }
}

class MemDir {
  kind = "directory";
  constructor(name = "vault", metrics = { reads: 0, writes: 0, scans: 0 }) {
    this.name = name;
    this.metrics = metrics;
    this.children = new Map();
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    assert.ok(!activeLocks.includes("everytab-store"),
      "Vault directory access stays outside the Store lock");
    const existing = this.children.get(name);
    if (existing?.kind === "directory") return existing;
    if (existing || !create) throw new Error(`Directory ${name} not found`);
    const directory = new MemDir(name, this.metrics);
    this.children.set(name, directory);
    this.metrics.writes += 1;
    return directory;
  }
  async getFileHandle(name, { create = false } = {}) {
    assert.ok(!activeLocks.includes("everytab-store"),
      "Vault file access stays outside the Store lock");
    const existing = this.children.get(name);
    if (existing?.kind === "file") return existing;
    if (existing || !create) throw new Error(`File ${name} not found`);
    const file = new MemFile(name, this.metrics, "", this.name);
    this.children.set(name, file);
    return file;
  }
  async removeEntry(name) {
    assert.ok(!activeLocks.includes("everytab-store"),
      "Vault cleanup stays outside the Store lock");
    if (!this.children.has(name)) throw new Error(`Entry ${name} not found`);
    if (this.name === "transactions") {
      this.metrics.transactionRemoveAttempts =
        (this.metrics.transactionRemoveAttempts ?? 0) + 1;
      if (this.metrics.failTransactionRemoveAt === this.metrics.transactionRemoveAttempts) {
        delete this.metrics.failTransactionRemoveAt;
        throw new Error(`Injected transaction removal failure for ${name}`);
      }
    }
    this.children.delete(name);
    this.metrics.writes += 1;
    if (this.name === "transactions" && this.metrics.onTransactionRemoved) {
      await this.metrics.onTransactionRemoved({ directory: this, name });
    }
  }
  async *entries() {
    assert.ok(!activeLocks.includes("everytab-store"),
      "Vault scans stay outside the Store lock");
    this.metrics.scans += 1;
    if (this.name === "transactions") {
      this.metrics.transactionScans = (this.metrics.transactionScans ?? 0) + 1;
    }
    yield* this.children.entries();
  }
}

const activeLocks = [];
const lockTraces = [];
let vaultLockAvailable = true;
const locks = {
  async request(name, options, work) {
    if (name === "everytab-vault-sync") {
      assert.equal(options.ifAvailable, true);
      if (!vaultLockAvailable) return work(null);
    }
    if (name === "everytab-store") {
      assert.equal(options.mode, "exclusive");
      assert.ok(activeLocks.includes("everytab-vault-sync"),
        "exact Restore acquires the Store lock only while holding the Vault lock");
    }
    activeLocks.push(name);
    lockTraces.push(activeLocks.join(" > "));
    try {
      return await work({ name });
    } finally {
      activeLocks.splice(activeLocks.lastIndexOf(name), 1);
    }
  }
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { locks }
});
const publishedRevisions = [];
globalThis.chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async ({ storageV2Revision }) => {
        assert.ok(activeLocks.includes("everytab-store"),
          "exact Restore publishes its durable revision before releasing the Store lock");
        publishedRevisions.push(structuredClone(storageV2Revision));
      }
    },
    onChanged: { addListener() {}, removeListener() {} }
  }
};

const FAVICON = "data:image/png;base64,AQIDBA==";
const RECOVERY_FAVICON = "data:image/png;base64,BQYHCA==";
const recoveryByLibrary = new WeakMap();
const authorityByLibrary = new WeakMap();
const makeLibrary = (deviceId, sourceId, now) => {
  const library = createLibraryStore({
    adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
    deviceId,
    createId: () => sourceId,
    now: () => now.value
  });
  const recovery = createRecoveryStore({
    adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA),
    now: () => now.value
  });
  recoveryByLibrary.set(library, recovery);
  authorityByLibrary.set(library, createStorageAuthority({ library, recovery }));
  return library;
};
const sync = (root, options) => syncVault(root, {
  ...options,
  recovery: options.recovery ?? recoveryByLibrary.get(options.library),
  commitRemoteApply: options.commitRemoteApply ?? (authorityByLibrary.has(options.library)
    ? (apply) => commitLibraryChange(apply, { authority: authorityByLibrary.get(options.library) })
    : undefined)
});
const record = (id, url, favicon = undefined) => ({
  type: "put",
  family: "inbox",
  id,
  value: {
    id,
    kind: "tab",
    tabs: [{ url, title: id, ...(favicon ? { favIconUrl: favicon } : {}) }],
    labels: []
  }
});
const arrangement = (url) => ({
  windows: [[{ url, title: url, favIconUrl: RECOVERY_FAVICON }]]
});
const makeJoinScenario = async (name) => {
  const source = makeLibrary(`${name}-a`, `${name}-source-a`, { value: 100 });
  await source.transact([record(`${name}-shared`, `https://${name}-shared.example`)]);
  const root = new MemDir(`everytab-vault-${name}`);
  await sync(root, { library: source, now: 100 });
  const joining = makeLibrary(`${name}-b`, `${name}-source-b`, { value: 101 });
  await joining.seedExactCheckpoint(await source.createExactCheckpoint());
  await joining.transact([
    record(`${name}-live`, `https://${name}-live.example`, FAVICON),
    { type: "delete", family: "inbox", id: `${name}-deleted` }
  ]);
  const early = await joining.readReplicationState();
  await joining.acknowledgeSync(early.sequence);
  await joining.transact([
    record(`${name}-live`, `https://${name}-live-edited.example`, FAVICON)
  ]);
  return { root, source, joining };
};
const json = (directory, name) => JSON.parse(directory.children.get(name).content);
const childNames = (directory) => [...directory.children.keys()].sort();
const compressedJson = async (directory, name) => {
  const file = directory.children.get(name);
  const stream = new Blob([file.content]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
};

/* Required Library capabilities fail before the Vault lock or filesystem. */
const incompleteAcknowledgeBase = makeLibrary(
  "incomplete-ack-device", "incomplete-ack-source", { value: 30 }
);
const incompleteAcknowledgeRoot = new MemDir("incomplete-acknowledge");
await assert.rejects(() => sync(incompleteAcknowledgeRoot, {
  library: { ...incompleteAcknowledgeBase, acknowledgeSync: undefined },
  recovery: recoveryByLibrary.get(incompleteAcknowledgeBase),
  now: 30
}), /Storage Library is required/);
assert.deepEqual(incompleteAcknowledgeRoot.metrics, { reads: 0, writes: 0, scans: 0 },
"missing acknowledgement capability rejects before any Vault effect");

/* A second page skips without touching the folder while another sync owns the lock. */
const skippedTime = { value: 40 };
const skippedLibrary = makeLibrary("skipped-device", "skipped-source", skippedTime);
const skippedRoot = new MemDir("everytab-vault-skipped");
vaultLockAvailable = false;
const skipped = await sync(skippedRoot, { library: skippedLibrary, now: skippedTime.value });
vaultLockAvailable = true;
assert.equal(skipped.skipped, true);
assert.equal(skipped.pulled, 0);
assert.equal(skipped.pushed, 0);
assert.deepEqual(skippedRoot.metrics, { reads: 0, writes: 0, scans: 0 },
  "a skipped sync does not touch the Vault folder");

/* A populated current profile initializes through one bounded checkpoint. */
const populatedTime = { value: 50 };
const populated = makeLibrary("populated-device", "populated-source", populatedTime);
await populated.transact([record("kept", "https://kept.example", FAVICON)]);
const populatedExact = await populated.createExactCheckpoint();
const populatedRoot = new MemDir("everytab-vault-populated");
const populatedProgress = [];
const bootstrap = await sync(populatedRoot, {
  library: populated,
  now: 60,
  onProgress: (progress) => populatedProgress.push(progress),
  createId: (() => {
    const ids = ["vault-populated", "checkpoint-populated"];
    return () => ids.shift();
  })()
});
assert.equal(bootstrap.checkpointWritten, true);
assert.equal(bootstrap.pushed, 1);
assert.equal((await populated.readSyncBatch()).changes.length, 0,
  "the verified bootstrap checkpoint acknowledges the pre-existing outbox");
const populatedFormat = json(populatedRoot, "format.json");
assert.equal(populatedFormat.status, "ready");
const populatedCheckpoint = json(
  populatedRoot.children.get("checkpoints").children.get("checkpoint-populated"),
  "library.json"
);
assert.equal(populatedCheckpoint.entities.length, 1);
assert.equal(populatedCheckpoint.assetManifest.length, 1);
assert.ok(!JSON.stringify(populatedCheckpoint).includes(FAVICON),
  "the checkpoint references rather than repeats embedded favicon bytes");
assert.equal(populatedRoot.children.get("assets").children.size, 1);
assert.ok(populatedProgress.some(({ target, completed, total }) =>
  target === "assets" && completed === 1 && total === 1),
"favicon transfers report progress so the Vault watchdog remains alive");
assert.ok(populatedRoot.children.has("library.json"),
  "bootstrap publishes the root readable Library view");
assert.ok(populatedRoot.children.has("index.md"),
  "bootstrap publishes the root Markdown browsing view");
assert.ok(populatedRoot.children.has("views.json"),
  "a completed receipt follows both generated views");
assert.ok(populatedRoot.children.has("maintenance.json"),
  "a completed receipt follows the first daily backup reference");
const populatedBackups = populatedRoot.children.get("backups");
assert.equal(populatedBackups.children.size, 1,
  "bootstrap creates one daily backup reference without duplicating its checkpoint");
const populatedBackupName = childNames(populatedBackups)[0];
const populatedBackup = json(populatedBackups, populatedBackupName);
assert.equal(populatedBackup.kind, "vault-v2-daily-backup");
assert.equal(populatedBackup.checkpoint.checkpointId, "checkpoint-populated");
assert.equal(populatedRoot.children.get("checkpoints").children.size, 1);
const populatedReadable = json(populatedRoot, "library.json");
assert.equal(populatedReadable.kind, "vault-v2-readable-library");
assert.equal(populatedReadable.families.inbox.kept.tabs[0].favIconUrl, FAVICON,
  "the readable Library is self-contained rather than exposing private asset markers");
assert.ok(populatedRoot.children.get("index.md").content.includes("# EveryTab Vault"));
assert.ok(populatedRoot.children.get("index.md").content.includes("Inbox: 1 item, 1 tab"));

/* Checkpoint import is conditional, but its branch preflight precedes writes. */
const incompleteCheckpointBase = makeLibrary(
  "incomplete-checkpoint-device", "incomplete-checkpoint-source", { value: 65 }
);
const incompleteCheckpointLibrary = {
  ...incompleteCheckpointBase,
  applyRemoteCheckpoint: undefined
};
const checkpointPreflightWrites = populatedRoot.metrics.writes;
await assert.rejects(() => sync(populatedRoot, {
  library: incompleteCheckpointLibrary,
  recovery: recoveryByLibrary.get(incompleteCheckpointBase),
  now: 65
}), /cannot import a Vault checkpoint/);
assert.equal(populatedRoot.metrics.writes, checkpointPreflightWrites,
"missing checkpoint import rejects before creating a local manifest or publishing Recovery");
await sync(populatedRoot, {
  library: { ...populated, applyRemoteCheckpoint: undefined },
  recovery: recoveryByLibrary.get(populated),
  now: 65
});

/* Daily references drive a verified, exact, reversible Library-only Restore. */
const restorePoints = await listVaultRestorePoints(populatedRoot);
assert.equal(restorePoints.length, 1);
assert.equal(restorePoints[0].name, populatedBackupName);
const restoreTime = { value: 75 };
const restoreLibrary = makeLibrary("restore-device", "restore-source", restoreTime);
const restoreRecovery = recoveryByLibrary.get(restoreLibrary);
await restoreLibrary.transact([
  record("kept", "https://changed-after-backup.example", FAVICON),
  record("local-only", "https://local-only.example")
]);
await restoreRecovery.captureSnapshot(arrangement("https://recovery-stays.example"), {
  retention: 200,
  id: "recovery-stays"
});
const restoreReviewProgress = [];
const restoreAssetReadsBefore = populatedRoot.metrics.assetReads ?? 0;
const reviewedRestore = await previewVaultRestorePoint(populatedRoot, {
  library: restoreLibrary,
  name: populatedBackupName,
  onProgress: (progress) => restoreReviewProgress.push(progress)
});
assert.equal(reviewedRestore.summary.updated, 1);
assert.equal(reviewedRestore.summary.removed, 1);
assert.equal(populatedRoot.metrics.assetReads ?? 0, restoreAssetReadsBefore,
  "Restore review reuses matching local favicons instead of reading Vault asset files");
assert.ok(restoreReviewProgress.some(({ stage, target, completed, total }) =>
  stage === "checking" && target === "records" && completed === total && total > 0),
"Vault Restore review exposes determinate record verification progress");
const uncachedRestoreLibrary = makeLibrary(
  "restore-uncached-device", "restore-uncached-source", { value: 75 }
);
const uncachedAssetReadsBefore = populatedRoot.metrics.assetReads ?? 0;
await previewVaultRestorePoint(populatedRoot, {
  library: uncachedRestoreLibrary,
  name: populatedBackupName
});
assert.equal(populatedRoot.metrics.assetReads, uncachedAssetReadsBefore + 1,
  "Restore review still reads and verifies a favicon absent from the local asset store");
await restoreLibrary.transact([record("newer", "https://newer.example")]);
await assert.rejects(() => restoreVaultRestorePoint(populatedRoot, {
  library: restoreLibrary,
  authority: authorityByLibrary.get(restoreLibrary),
  preview: reviewedRestore,
  createId: () => "stale-restore"
}), /changed after this Restore was reviewed/i);
assert.ok(await restoreLibrary.readEntity("inbox", "newer"),
  "a stale Vault Restore changes nothing");

const beforeRemoteRestore = await previewVaultRestorePoint(populatedRoot, {
  library: restoreLibrary,
  name: populatedBackupName
});
const restoreRemote = makeLibrary("restore-remote", "restore-remote-source", { value: 76 });
await restoreRemote.transact([record("remote-newer", "https://remote-newer.example")]);
await restoreLibrary.applyRemoteBatch(await restoreRemote.readSyncBatch());
await assert.rejects(() => restoreVaultRestorePoint(populatedRoot, {
  library: restoreLibrary,
  authority: authorityByLibrary.get(restoreLibrary),
  preview: beforeRemoteRestore,
  createId: () => "remote-stale-restore"
}), /changed after this Restore was reviewed/i);
assert.ok(await restoreLibrary.readEntity("inbox", "remote-newer"),
  "the Vault boundary carries the reviewed state fingerprint through remote changes");

const freshRestore = await previewVaultRestorePoint(populatedRoot, {
  library: restoreLibrary,
  name: populatedBackupName
});
const restoreApplyAssetReadsBefore = populatedRoot.metrics.assetReads ?? 0;
const restoredPoint = await restoreVaultRestorePoint(populatedRoot, {
  library: restoreLibrary,
  authority: authorityByLibrary.get(restoreLibrary),
  preview: freshRestore,
  createId: () => "vault-restore-one"
});
assert.equal(restoredPoint.status, "restored");
assert.equal(populatedRoot.metrics.assetReads, restoreApplyAssetReadsBefore,
  "Restore application also reuses locally verified favicons");
assert.equal((await restoreLibrary.readEntity("inbox", "kept")).value.tabs[0].url,
  "https://kept.example");
assert.equal(await restoreLibrary.readEntity("inbox", "local-only"), null);
assert.equal((await restoreRecovery.listSnapshots({ limit: 10 }))[0].id, "recovery-stays",
  "exact Vault Restore does not read or replace device-local Recovery");
assert.equal((await restoreLibrary.readPendingRestore()).id, "vault-restore-one");
const restoreRevision = await authorityByLibrary.get(restoreLibrary).readPendingRevision();
assert.deepEqual(restoreRevision.changedKeys, ["inbox"],
  "exact Restore durably receipts the family it replaced");
assert.equal(publishedRevisions.at(-1).id, restoreRevision.id);
assert.ok(lockTraces.includes("everytab-vault-sync > everytab-store"));
await undoVaultRestore({
  library: restoreLibrary,
  authority: authorityByLibrary.get(restoreLibrary),
  restoreId: "vault-restore-one"
});
assert.equal((await restoreLibrary.readEntity("inbox", "kept")).value.tabs[0].url,
  "https://changed-after-backup.example");
assert.ok(await restoreLibrary.readEntity("inbox", "local-only"));

const confirmPreview = await previewVaultRestorePoint(populatedRoot, {
  library: restoreLibrary,
  name: populatedBackupName
});
const confirmedPoint = await restoreVaultRestorePoint(populatedRoot, {
  library: restoreLibrary,
  authority: authorityByLibrary.get(restoreLibrary),
  preview: confirmPreview,
  createId: () => "vault-restore-confirm"
});
assert.equal(await confirmVaultRestore({
  library: restoreLibrary,
  restoreId: confirmedPoint.restoreId
}), true);
assert.equal(await restoreLibrary.readPendingRestore(), null);

const originalBackupText = populatedBackups.children.get(populatedBackupName).content;
const damagedBackup = JSON.parse(originalBackupText);
damagedBackup.day = "1999-01-01";
populatedBackups.children.get(populatedBackupName).content = JSON.stringify(damagedBackup);
const damagedListing = await listVaultRestorePointsWithReport(populatedRoot);
assert.deepEqual(damagedListing.points, [],
  "a damaged daily reference is not offered as a Restore point");
assert.deepEqual(damagedListing.skipped,
  [{ code: "vault-damaged-backup", kind: "backup", count: 1 }],
  "the damaged reference is counted by allowlisted code and kind, not thrown");
assert.ok(populatedBackups.children.has(populatedBackupName),
  "listing never deletes a damaged reference");
populatedBackups.children.get(populatedBackupName).content = originalBackupText;

const populatedFollower = makeLibrary("populated-follower", "follower-source", { value: 70 });
const followerProgress = [];
const followedBootstrap = await sync(populatedRoot, {
  library: populatedFollower,
  now: 70,
  onProgress: (progress) => followerProgress.push(progress)
});
assert.equal(followedBootstrap.checkpointRead, true);
assert.equal(followedBootstrap.pulled, 1);
assert.equal(
  (await populatedFollower.readEntity("inbox", "kept")).value.tabs[0].favIconUrl,
  FAVICON,
  "a second device joins a populated Vault through its verified bootstrap checkpoint"
);
assert.ok(followerProgress.some(({ target, completed, total }) =>
  target === "assets" && completed === 1 && total === 1),
"checkpoint favicon reads also keep the Vault watchdog alive");

/* A joining Library can publish a sealed current-state base after its early
 * outbox has already been acknowledged or is no longer available. */
const joinTimeA = { value: 72 };
const joinA = makeLibrary("join-device-a", "join-source-a", joinTimeA);
await joinA.transact([record("join-shared", "https://join-shared.example")]);
const joinRoot = new MemDir("everytab-vault-join-existing");
await sync(joinRoot, { library: joinA, now: joinTimeA.value });
const joinB = makeLibrary("join-device-b", "join-source-b", { value: 73 });
await joinB.seedExactCheckpoint(await joinA.createExactCheckpoint());
await joinB.transact([
  record("join-live", "https://join-live.example", FAVICON),
  { type: "delete", family: "inbox", id: "join-deleted" }
]);
const joinEarly = await joinB.readReplicationState();
await joinB.acknowledgeSync(joinEarly.sequence);
await joinB.transact([record("join-live", "https://join-live-edited.example", FAVICON)]);
const joinBManifestBefore = joinRoot.children.get("devices").children.get("join-device-b");
assert.equal(joinBManifestBefore, undefined);
await sync(joinRoot, { library: joinB, now: 74 });
const joinBManifest = joinRoot.children.get("devices").children.get("join-device-b");
const joinBManifestBody = json(joinBManifest, "manifest.json");
assert.equal(joinBManifestBody.baseSequence, 3,
  "joining publishes a base at the current sequence without old outbox entries");
assert.equal(joinBManifestBody.chunks.length, 0);
const joinAState = await joinA.readFamily("inbox", { includeDeleted: true });
await sync(joinRoot, { library: joinA, now: 75 });
const joinC = makeLibrary("join-device-c", "join-source-c", { value: 76 });
await sync(joinRoot, { library: joinC, now: 76 });
assert.deepEqual(
  await joinC.readFamily("inbox", { includeDeleted: true }),
  await joinA.readFamily("inbox", { includeDeleted: true }),
  "the joining base lets existing and new devices converge on exact current state"
);
assert.equal(joinAState.length, 1);
assert.equal((await joinA.readEntity("inbox", "join-live")).value.tabs[0].favIconUrl, FAVICON);
assert.equal((await joinA.readEntity("inbox", "join-live")).value.tabs[0].url,
  "https://join-live-edited.example");
assert.ok(await joinA.readEntity("inbox", "join-shared"), "the seeded current record survives the join");
assert.equal((await joinA.readEntity("inbox", "join-deleted", { includeDeleted: true })).lifecycle, "deleted");
assert.equal((await joinC.readEntity("inbox", "join-live")).value.tabs[0].url,
  "https://join-live-edited.example");
const joinNoChange = await sync(joinRoot, { library: joinB, now: 77 });
assert.equal(joinNoChange.pushed, 0);
assert.equal(joinNoChange.chunksWritten, 0);
// The first pass sees the new follower's manifest and refreshes readable views.
const settledJoin = await sync(joinRoot, { library: joinB, now: 78 });
assert.equal(noChangeVaultSync({ ...settledJoin, ok: true, storageVersion: 2 }), true);

/* Base and replacement-manifest failures retain the empty manifest and outbox. */
const baseFailure = await makeJoinScenario("join-base-failure");
baseFailure.root.metrics.failNextWriteName = "base-a.json";
await assert.rejects(
  () => sync(baseFailure.root, { library: baseFailure.joining, now: 110 }),
  /Injected write failure for base-a\.json/
);
const baseFailureDevice = baseFailure.root.children.get("devices").children.get("join-base-failure-b");
assert.equal(json(baseFailureDevice, "manifest.json").throughSequence, 0);
assert.equal((await baseFailure.joining.readSyncBatch({ afterSequence: 0 })).changes.length, 1);
await sync(baseFailure.root, { library: baseFailure.joining, now: 111 });
assert.equal(json(baseFailureDevice, "manifest.json").baseSequence, 3);
assert.equal((await baseFailure.joining.readSyncBatch({ afterSequence: 0 })).changes.length, 0);

const manifestFailure = await makeJoinScenario("join-manifest-failure");
manifestFailure.root.metrics.failManifestWriteAt =
  (manifestFailure.root.metrics.manifestWrites ?? 0) + 2;
await assert.rejects(
  () => sync(manifestFailure.root, { library: manifestFailure.joining, now: 120 }),
  /Injected rollover manifest failure/
);
const manifestFailureDevice = manifestFailure.root.children.get("devices")
  .children.get("join-manifest-failure-b");
assert.equal(json(manifestFailureDevice, "manifest.json").throughSequence, 0);
assert.equal((await manifestFailure.joining.readSyncBatch({ afterSequence: 0 })).changes.length, 1);
await sync(manifestFailure.root, { library: manifestFailure.joining, now: 121 });
assert.equal(json(manifestFailureDevice, "manifest.json").baseSequence, 3);
assert.equal((await manifestFailure.joining.readSyncBatch()).changes.length, 0);

/* A commit during checkpoint capture rejects safely and is retried as a base. */
const captureRace = await makeJoinScenario("join-capture-race");
const originalCapture = captureRace.joining.createExactCheckpoint;
let captureEdit = true;
const captureLibrary = {
  ...captureRace.joining,
  createExactCheckpoint: async () => {
    const checkpoint = await originalCapture();
    if (captureEdit) {
      captureEdit = false;
      await captureRace.joining.transact([
        record("join-capture-race-during", "https://join-capture-race-during.example")
      ]);
    }
    return checkpoint;
  }
};
await assert.rejects(
  () => sync(captureRace.root, {
    library: captureLibrary,
    recovery: recoveryByLibrary.get(captureRace.joining),
    now: 130
  }),
  /changed while preparing/
);
assert.equal((await captureRace.joining.readSyncBatch({ afterSequence: 0 })).changes.length, 2);
assert.equal(json(captureRace.root.children.get("devices")
  .children.get("join-capture-race-b"), "manifest.json").throughSequence, 0);
await sync(captureRace.root, { library: captureRace.joining, now: 131 });
assert.equal((await captureRace.joining.readSyncBatch({ afterSequence: 0 })).changes.length, 0);

/* A commit during base-file settlement remains pending for the next sync. */
const writeRace = await makeJoinScenario("join-write-race");
await writeRace.joining.acknowledgeSync(3);
writeRace.root.metrics.onBeforeWriteCloseName = "base-a.json";
writeRace.root.metrics.onBeforeWriteClose = async () => {
  await writeRace.joining.transact([
    record("join-write-race-during", "https://join-write-race-during.example")
  ]);
};
await sync(writeRace.root, { library: writeRace.joining, now: 140 });
assert.equal((await writeRace.joining.readSyncBatch({ afterSequence: 0 })).changes.length, 1);
const writeRacePush = await sync(writeRace.root, { library: writeRace.joining, now: 141 });
assert.equal(writeRacePush.chunksWritten, 1);
assert.equal((await writeRace.joining.readSyncBatch({ afterSequence: 0 })).changes.length, 0);
const writeRaceFollower = makeLibrary("write-race-follower", "write-race-follower-source", { value: 142 });
await sync(writeRace.root, { library: writeRaceFollower, now: 142 });
assert.equal((await writeRaceFollower.readEntity("inbox", "join-write-race-during"))
  .value.tabs[0].url, "https://join-write-race-during.example");

/* An established device can roll directly to a base after its outbox trims. */
const offlineTime = { value: 150 };
const offlineA = makeLibrary("offline-device-a", "offline-source-a", offlineTime);
await offlineA.transact([
  record("offline-live", "https://offline-before.example", FAVICON),
  record("offline-gone", "https://offline-gone.example")
]);
const offlineRoot = new MemDir("everytab-vault-offline-history");
await sync(offlineRoot, { library: offlineA, now: offlineTime.value });
const offlineB = makeLibrary("offline-device-b", "offline-source-b", { value: 151 });
await sync(offlineRoot, { library: offlineB, now: 151 });
for (let index = 0; index < 257; index += 1) {
  await offlineA.transact([
    record("offline-live", `https://offline-edit-${index}.example`, FAVICON)
  ]);
}
await offlineA.transact([{ type: "delete", family: "inbox", id: "offline-gone" }]);
offlineRoot.metrics.failManifestWriteAt =
  (offlineRoot.metrics.manifestWrites ?? 0) + 1;
await assert.rejects(
  () => sync(offlineRoot, { library: offlineA, now: 152 }),
  /Injected rollover manifest failure/
);
const offlineDevice = offlineRoot.children.get("devices").children.get("offline-device-a");
assert.equal(json(offlineDevice, "manifest.json").baseSequence, 2);
assert.equal((await offlineA.readSyncBatch({ afterSequence: 0 })).changes.length, 1,
  "a failed base manifest write leaves post-trim changes pending");
const offlineRetry = await sync(offlineRoot, { library: offlineA, now: 153 });
assert.equal(offlineRetry.checkpointWritten, true);
assert.equal((await offlineA.readSyncBatch({ afterSequence: 0 })).changes.length, 0);
assert.equal(json(offlineDevice, "manifest.json").baseSequence, 260);
await sync(offlineRoot, { library: offlineB, now: 154 });
const offlineC = makeLibrary("offline-device-c", "offline-source-c", { value: 154 });
await sync(offlineRoot, { library: offlineC, now: 155 });
for (const peer of [offlineB, offlineC]) {
  assert.equal((await peer.readEntity("inbox", "offline-live")).value.tabs[0].url,
    "https://offline-edit-256.example");
  assert.equal((await peer.readEntity("inbox", "offline-live")).value.tabs[0].favIconUrl, FAVICON);
  assert.equal((await peer.readEntity("inbox", "offline-gone", { includeDeleted: true })).lifecycle,
    "deleted");
}

/* A trim injected between chunks must remain visible as unsynced local state. */
const midSync = makeLibrary("mid-sync-device", "mid-sync-source", { value: 160 });
const midSyncRoot = new MemDir("everytab-vault-mid-sync-trim");
await sync(midSyncRoot, { library: midSync, now: 160 });
await midSync.transact(Array.from({ length: 256 }, (_, index) =>
  record(`mid-sync-${index}`, `https://mid-sync-${index}.example`)));
let midSyncInjected = false;
midSyncRoot.metrics.onBeforeWriteCloseName = "manifest.json";
midSyncRoot.metrics.onBeforeWriteClose = async () => {
  midSyncInjected = true;
  await midSync.transact(Array.from({ length: 257 }, (_, index) =>
    record(`mid-sync-new-${index}`, `https://mid-sync-new-${index}.example`)));
};
await assert.rejects(() => sync(midSyncRoot, { library: midSync, now: 161 }),
  /changed while preparing/);
const midSyncState = await midSync.readReplicationState();
assert.equal(midSyncInjected, true);
assert.equal(midSyncState.sequence, 513);
assert.equal((await midSync.readSyncBatch({ afterSequence: 0 })).compactedThroughSequence, 513);
assert.ok(midSyncState.sequence > 256,
  "a mid-sync trim remains visible as newer local state after refusal");
const midSyncRetry = await sync(midSyncRoot, { library: midSync, now: 162 });
assert.equal(midSyncRetry.checkpointWritten, true);
assert.equal(json(midSyncRoot.children.get("devices").children.get("mid-sync-device"),
  "manifest.json").baseSequence, 513);

/* An unexplained interior outbox gap cannot advance the device manifest. */
const gapLibrary = makeLibrary("interior-gap-device", "interior-gap-source", { value: 170 });
const gapRoot = new MemDir("everytab-vault-interior-gap");
await gapLibrary.transact([record("gap-seed", "https://gap-seed.example")]);
await sync(gapRoot, { library: gapLibrary, now: 170 });
await gapLibrary.transact([
  record("gap-one", "https://gap-one.example"),
  record("gap-two", "https://gap-two.example"),
  record("gap-three", "https://gap-three.example")
]);
const originalGapBatch = gapLibrary.readSyncBatch;
const gapLibraryView = {
  ...gapLibrary,
  readSyncBatch: async (options) => {
    const batch = await originalGapBatch(options);
    if (batch.changes.length < 3) return batch;
    return { ...batch, changes: [batch.changes[0], batch.changes[2]] };
  }
};
await assert.rejects(
  () => sync(gapRoot, {
    library: gapLibraryView,
    recovery: recoveryByLibrary.get(gapLibrary),
    now: 171
  }),
  /does not continue|gap/i
);
assert.equal(json(gapRoot.children.get("devices").children.get("interior-gap-device"),
  "manifest.json").throughSequence, 1);
const emptyGapView = {
  ...gapLibrary,
  readSyncBatch: async (options) => ({
    ...await originalGapBatch(options), changes: [],
    fromSequence: options.afterSequence, throughSequence: options.afterSequence
  })
};
await assert.rejects(() => sync(gapRoot, {
  library: emptyGapView, recovery: recoveryByLibrary.get(gapLibrary), now: 172
}), /does not continue/);
assert.equal(json(gapRoot.children.get("devices").children.get("interior-gap-device"),
  "manifest.json").throughSequence, 1);

/* The staged current profile starts with entities but sequence zero. */
const seeded = makeLibrary("seeded-device", "seeded-source", { value: 80 });
await seeded.seedExactCheckpoint(populatedExact);
assert.equal((await seeded.readReplicationState()).sequence, 0);
const seededRoot = new MemDir("everytab-vault-seeded");
const seededIds = ["vault-seeded", "checkpoint-seeded"];
await sync(seededRoot, {
  library: seeded,
  now: 80,
  createId: () => seededIds.shift()
});
const seededFollower = makeLibrary("seeded-follower", "seeded-follower-source", { value: 81 });
const seededPull = await sync(seededRoot, {
  library: seededFollower,
  now: 81
});
assert.equal(seededPull.checkpointRead, true);
assert.equal((await seededFollower.readFamily("inbox")).length, 1,
  "a sequence-zero staged Library still bootstraps a new device from its checkpoint");

/* Empty bootstrap, then bounded immutable chunks shared by two devices. */
const root = new MemDir("everytab-vault");
const timeA = { value: 100 };
const timeB = { value: 200 };
const libraryA = makeLibrary("device-a", "source-a", timeA);
const libraryB = makeLibrary("device-b", "source-b", timeB);
const recoveryA = recoveryByLibrary.get(libraryA);
await recoveryA.captureSnapshot(arrangement("https://recover-one.example"), {
  retention: 2,
  id: "recover-one"
});
const ids = ["vault-shared", "checkpoint-shared"];
const first = await sync(root, {
  library: libraryA,
  now: 100,
  createId: () => ids.shift()
});
assert.equal(first.checkpointWritten, true);
assert.equal(first.recoveryPackWritten, true);
assert.equal(first.recoverySnapshotsWritten, 1);
assert.deepEqual(await inspectVaultRoot(root).then(({ state }) => state), "ready");
const recoveryDeviceA = root.children.get("recovery").children.get("device-a");
const firstRecoveryManifest = json(recoveryDeviceA, "manifest.json");
assert.equal(firstRecoveryManifest.sequence, 1);
assert.equal(firstRecoveryManifest.packs.length, 1);
assert.equal(firstRecoveryManifest.snapshots.length, 1);
assert.equal(firstRecoveryManifest.cleanupPending, false);
assert.equal(firstRecoveryManifest.publishedAssetDigests.length, 1,
  "a sealed Recovery manifest receipts every published favicon");
const firstRecoveryEnvelope = await compressedJson(
  recoveryDeviceA.children.get("packs"),
  firstRecoveryManifest.packs[0].name
);
assert.equal(firstRecoveryEnvelope.snapshots.length, 1);
assert.equal(firstRecoveryEnvelope.assetManifest.length, 1);
assert.ok(!JSON.stringify(firstRecoveryEnvelope).includes(RECOVERY_FAVICON),
  "a compressed Recovery pack references rather than repeats embedded favicon bytes");

const {
  publishedAssetDigests: _publishedAssetDigests,
  contentHash: _recoveryManifestHash,
  ...legacyRecoveryManifestBody
} = firstRecoveryManifest;
recoveryDeviceA.children.get("manifest.json").content = `${JSON.stringify(
  await seal(legacyRecoveryManifestBody, globalThis.crypto), null, 2
)}\n`;

await libraryA.transact([
  record("one", "https://one.example", FAVICON),
  record("two", "https://two.example", FAVICON)
]);
const pushed = await sync(root, { library: libraryA, now: 101 });
assert.equal(pushed.pushed, 2);
assert.equal(pushed.chunksWritten, 1);
assert.equal(pushed.viewsWritten, true,
  "a Library change regenerates both readable views");
assert.equal(pushed.assetsWritten, 1,
  "one content-addressed asset serves both records");
const deviceA = root.children.get("devices").children.get("device-a");
const manifestA = json(deviceA, "manifest.json");
assert.equal(manifestA.baseSequence, 0);
assert.equal(manifestA.throughSequence, 2);
assert.equal(deviceA.children.get("transactions").children.size, 1);

const pulled = await sync(root, { library: libraryB, now: 201 });
assert.equal(pulled.pulled, 2);
assert.equal(pulled.chunksRead, 1);
assert.equal((await libraryB.readFamily("inbox")).length, 2);
assert.equal((await libraryB.readEntity("inbox", "one")).value.tabs[0].favIconUrl, FAVICON);

timeB.value = 300;
await libraryB.transact([record("two", "https://two-new.example")]);
const bPush = await sync(root, { library: libraryB, now: 301 });
assert.equal(bPush.pushed, 1);
const aPull = await sync(root, { library: libraryA, now: 302 });
assert.equal(aPull.pulled, 1);
assert.equal((await libraryA.readEntity("inbox", "two")).value.tabs[0].url,
  "https://two-new.example", "whole-record versions converge across devices");

/* A remote commit is receipted before later derived filesystem work can fail. */
timeB.value = 310;
await libraryB.transact([record("pull-before-failure", "https://pull-before-failure.example")]);
await sync(root, { library: libraryB, now: 310 });
const committedRemoteFamilies = [];
const revisionsBeforePullFailure = publishedRevisions.length;
await root.removeEntry("index.md");
root.metrics.failNextWriteName = "index.md";
await assert.rejects(
  () => sync(root, {
    library: libraryA,
    now: 311,
    commitRemoteApply: async (apply) => {
      const applied = await commitLibraryChange(apply, {
        authority: authorityByLibrary.get(libraryA)
      });
      committedRemoteFamilies.push(...applied.changedFamilies);
      return applied;
    }
  }),
  /Injected write failure for index\.md/
);
assert.deepEqual(committedRemoteFamilies, ["inbox"],
  "the exact pulled family crosses its durable commit boundary before view publication");
assert.ok(await libraryA.readEntity("inbox", "pull-before-failure"),
  "the injected failure occurs after the remote Library commit");
const failedPullRevision = await authorityByLibrary.get(libraryA).readPendingRevision();
assert.deepEqual(failedPullRevision.changedKeys, ["inbox"]);
assert.equal(publishedRevisions.length, revisionsBeforePullFailure + 1,
  "the failed sync still publishes the remote revision before touching derived files");
assert.equal(publishedRevisions.at(-1).id, failedPullRevision.id);
await sync(root, { library: libraryA, now: 312 });

root.metrics.reads = 0;
root.metrics.writes = 0;
root.metrics.scans = 0;
let recoveryExports = 0;
let readableCheckpointExports = 0;
const countedRecoveryA = {
  ...recoveryA,
  exportRecoveryPack: async (...args) => {
    recoveryExports += 1;
    return recoveryA.exportRecoveryPack(...args);
  }
};
const countedLibraryA = {
  ...libraryA,
  createExactCheckpoint: async (...args) => {
    readableCheckpointExports += 1;
    return libraryA.createExactCheckpoint(...args);
  }
};
const unchanged = await sync(root, {
  library: countedLibraryA,
  recovery: countedRecoveryA,
  now: 400
});
assert.deepEqual(unchanged.syncedState, {
  librarySequence: (await libraryA.readReplicationState()).sequence,
  recoverySequence: (await recoveryA.readReplicationState()).sequence
}, "a completed sync receipts the exact local Library and Recovery heads");
assert.equal(unchanged.pulled, 0);
assert.equal(unchanged.pushed, 0);
assert.equal(unchanged.chunksRead, 0);
assert.equal(unchanged.chunksWritten, 0);
assert.equal(unchanged.viewsWritten, false);
assert.equal(unchanged.backedUp, false);
assert.equal(noChangeVaultSync({
  ok: true,
  storageVersion: 2,
  ...unchanged
}), true, "the storage audit recognizes a real no-change Vault receipt");
assert.equal(readableCheckpointExports, 0,
  "a current readable-view receipt avoids reopening the complete Library");
assert.equal(root.metrics.writes, 0, "a no-change sync writes no Vault file or directory");
assert.equal(root.metrics.scans, 2,
  "a no-change sync enumerates only the Vault root and device manifests directory");
assert.equal(recoveryExports, 0,
  "a no-change sync reads only Recovery metadata and does not export Snapshot bodies");
assert.equal(root.children.get("devices").children.get("device-a")
  .children.get("transactions").children.size, 1,
"immutable device history is not duplicated on a no-change sync");

/* A local commit after publication is not falsely receipted as synced. */
const raceTime = { value: 410 };
const raceLibrary = makeLibrary("race-device", "race-source", raceTime);
const raceRecovery = recoveryByLibrary.get(raceLibrary);
await raceLibrary.transact([record("race-base", "https://race-base.example")]);
await raceRecovery.captureSnapshot(arrangement("https://race-recovery.example"), {
  retention: 2,
  id: "race-recovery"
});
const raceRoot = new MemDir("everytab-vault-publication-race");
const raceIds = ["vault-race", "checkpoint-race"];
const raceBootstrap = await sync(raceRoot, {
  library: raceLibrary,
  recovery: raceRecovery,
  now: 410,
  createId: () => raceIds.shift()
});
let replicationReads = 0;
const lateLibrary = {
  ...raceLibrary,
  readReplicationState: async () => {
    replicationReads += 1;
    if (replicationReads === 2) {
      await raceLibrary.transact([record("late", "https://late.example")]);
      await raceRecovery.captureSnapshot(arrangement("https://late-recovery.example"), {
        retention: 2,
        id: "recover-late"
      });
    }
    return raceLibrary.readReplicationState();
  }
};
const publicationRace = await sync(raceRoot, {
  library: lateLibrary,
  recovery: raceRecovery,
  now: 411
});
assert.deepEqual(publicationRace.syncedState, raceBootstrap.syncedState,
  "a post-publication commit cannot be included in the completed sync receipt");
assert.notDeepEqual(publicationRace.syncedState, {
  librarySequence: (await raceLibrary.readReplicationState()).sequence,
  recoverySequence: (await raceRecovery.readReplicationState()).sequence
}, "post-publication Library and Recovery work remains detectably pending");

/* Daily backups are tiny checkpoint references with bounded retention. */
const DAY = 24 * 60 * 60 * 1_000;
const dailyTime = { value: Date.UTC(2026, 0, 1, 12) };
const dailyLibrary = makeLibrary("daily-device", "daily-source", dailyTime);
const dailyRecovery = recoveryByLibrary.get(dailyLibrary);
await dailyLibrary.transact([record("daily-zero", "https://daily-zero.example")]);
const dailyRoot = new MemDir("everytab-vault-daily");
const dailyIds = ["vault-daily", "checkpoint-daily-bootstrap"];
const dailyInitial = await sync(dailyRoot, {
  library: dailyLibrary,
  recovery: dailyRecovery,
  now: dailyTime.value,
  createId: () => dailyIds.shift()
});
assert.equal(dailyInitial.backedUp, true);
assert.equal(dailyRoot.children.get("backups").children.size, 1);
assert.equal(dailyRoot.children.get("checkpoints").children.size, 1,
  "the first daily reference reuses the verified bootstrap checkpoint");

dailyTime.value += 1;
await dailyLibrary.transact([record("daily-one", "https://daily-one.example")]);
const sameDayChange = await sync(dailyRoot, {
  library: dailyLibrary,
  recovery: dailyRecovery,
  now: dailyTime.value
});
assert.equal(sameDayChange.backedUp, false,
  "a Library change does not create repeated backups within one UTC day");
assert.equal(sameDayChange.checkpointWritten, false,
  "a Library change does not create repeated checkpoints within one UTC day");

let dailyCheckpointExports = 0;
const countedDailyLibrary = {
  ...dailyLibrary,
  createExactCheckpoint: async (...args) => {
    dailyCheckpointExports += 1;
    return dailyLibrary.createExactCheckpoint(...args);
  }
};
dailyTime.value += DAY;
const nextDay = await sync(dailyRoot, {
  library: countedDailyLibrary,
  recovery: dailyRecovery,
  now: dailyTime.value
});
assert.equal(nextDay.backedUp, true);
assert.equal(nextDay.checkpointWritten, true,
  "the next daily backup checkpoints Library changes made since the previous restore point");
assert.equal(dailyCheckpointExports, 1,
  "the daily checkpoint exports the complete Library once");
assert.equal(dailyRoot.children.get("backups").children.size, 2);
assert.equal(dailyRoot.children.get("checkpoints").children.size, 2);

dailyCheckpointExports = 0;
dailyTime.value += DAY;
const unchangedNextDay = await sync(dailyRoot, {
  library: countedDailyLibrary,
  recovery: dailyRecovery,
  now: dailyTime.value
});
assert.equal(unchangedNextDay.backedUp, true);
assert.equal(unchangedNextDay.checkpointWritten, false,
  "an unchanged day points to the latest verified checkpoint");
assert.equal(dailyCheckpointExports, 0,
  "an unchanged daily backup does not reopen the complete Library");
assert.equal(dailyRoot.children.get("checkpoints").children.size, 2);

for (let offset = 3; offset <= 8; offset += 1) {
  dailyTime.value = Date.UTC(2026, 0, 1 + offset, 12);
  await dailyLibrary.transact([
    record(`daily-${offset}`, `https://daily-${offset}.example`)
  ]);
  await sync(dailyRoot, {
    library: dailyLibrary,
    recovery: dailyRecovery,
    now: dailyTime.value
  });
}
const retainedBackupNames = childNames(dailyRoot.children.get("backups"));
assert.equal(retainedBackupNames.length, 7,
  "only the newest seven daily backup references are retained");
assert.ok(retainedBackupNames.every((name) => !name.startsWith("2026-01-01-")),
  "the oldest daily reference is pruned only after a newer one is durable");
assert.equal(dailyRoot.children.get("checkpoints").children.size, 8,
  "seven restore points plus the permanent bootstrap checkpoint remain bounded");

const dailyReceipt = json(dailyRoot, "maintenance.json");
const latestBackupName = retainedBackupNames.at(-1);
assert.equal(dailyReceipt.latestBackup.name, latestBackupName);
assert.equal(dailyReceipt.retainedDays, 7);
const latestBackupText = dailyRoot.children.get("backups")
  .children.get(latestBackupName).content;
assert.ok(new TextEncoder().encode(latestBackupText).byteLength < 8 * 1024,
  "a daily backup is a small verified checkpoint reference, not a repeated Library dump");

/* A reference written before the completion receipt is adopted on retry. */
const interruptedRoot = new MemDir("everytab-vault-interrupted-daily");
const interruptedLibrary = makeLibrary(
  "interrupted-device", "interrupted-source", { value: Date.UTC(2026, 1, 1, 12) }
);
const interruptedRecovery = recoveryByLibrary.get(interruptedLibrary);
const interruptedIds = ["vault-interrupted", "checkpoint-interrupted-bootstrap"];
await sync(interruptedRoot, {
  library: interruptedLibrary,
  recovery: interruptedRecovery,
  now: Date.UTC(2026, 1, 1, 12),
  createId: () => interruptedIds.shift()
});
const interruptedReceipt = json(interruptedRoot, "maintenance.json");
interruptedRoot.metrics.failNextWriteName = "maintenance.json";
await assert.rejects(
  () => sync(interruptedRoot, {
    library: interruptedLibrary,
    recovery: interruptedRecovery,
    now: Date.UTC(2026, 1, 2, 12)
  }),
  /Injected write failure for maintenance\.json/
);
assert.equal(json(interruptedRoot, "maintenance.json").contentHash,
  interruptedReceipt.contentHash,
  "an interrupted daily publication cannot advertise an incomplete maintenance cycle");
assert.equal(interruptedRoot.children.get("backups").children.size, 2,
  "the daily reference is durable before its completion receipt");
const resumedDaily = await sync(interruptedRoot, {
  library: interruptedLibrary,
  recovery: interruptedRecovery,
  now: Date.UTC(2026, 1, 2, 12)
});
assert.equal(resumedDaily.backedUp, false,
  "retry adopts the already durable daily reference instead of duplicating it");
assert.equal(json(interruptedRoot, "maintenance.json").latestBackup.day, "2026-02-02");

/* Derived readable views recover without becoming Vault authority. */
await root.removeEntry("index.md");
const repairedViews = await sync(root, {
  library: countedLibraryA,
  recovery: countedRecoveryA,
  now: 400
});
assert.equal(repairedViews.pushed, 0);
assert.equal(repairedViews.pulled, 0);
assert.equal(repairedViews.viewsWritten, true,
  "a missing derived view is rebuilt even when the Library did not change");
assert.equal(readableCheckpointExports, 1,
  "repair exports the complete Library exactly once");
assert.ok(root.children.get("index.md").content.includes("# EveryTab Vault"));
readableCheckpointExports = 0;
const settledViews = await sync(root, {
  library: countedLibraryA,
  recovery: countedRecoveryA,
  now: 400
});
assert.equal(settledViews.viewsWritten, false,
  "a repaired readable view becomes a no-change sync again");
assert.equal(readableCheckpointExports, 0,
  "the settled repair receipt prevents another complete Library export");

const settledReceiptHash = json(root, "views.json").inputHash;
timeA.value = 400;
await libraryA.transact([record("three", "https://three.example")]);
root.metrics.failNextWriteName = "index.md";
await assert.rejects(
  () => sync(root, { library: countedLibraryA, recovery: countedRecoveryA, now: 400 }),
  /Injected write failure for index\.md/
);
assert.equal(json(root, "views.json").inputHash, settledReceiptHash,
  "an interrupted derived write cannot advertise an incomplete readable pair");
readableCheckpointExports = 0;
const resumedViews = await sync(root, {
  library: countedLibraryA,
  recovery: countedRecoveryA,
  now: 400
});
assert.equal(resumedViews.viewsWritten, true,
  "the next sync repairs a derived pair interrupted after Library publication");
assert.equal(readableCheckpointExports, 1);
assert.notEqual(json(root, "views.json").inputHash, settledReceiptHash,
  "the completion receipt advances only after both readable files settle");
readableCheckpointExports = 0;

/* Recovery publishes one bounded full pack only when its small sequence changes. */
timeA.value = 401;
await recoveryA.captureSnapshot(arrangement("https://recover-two.example"), {
  retention: 2,
  id: "recover-two"
});
const recoveryUpdate = await sync(root, {
  library: countedLibraryA,
  recovery: countedRecoveryA,
  now: 401
});
assert.equal(recoveryUpdate.pushed, 0);
assert.equal(recoveryUpdate.viewsWritten, false,
  "Recovery-only changes do not regenerate the Library views");
assert.equal(readableCheckpointExports, 0,
  "Recovery-only changes do not export the Library");
assert.equal(recoveryUpdate.recoveryPackWritten, true);
assert.equal(recoveryUpdate.recoverySnapshotsWritten, 1,
  "an ordinary Recovery sync writes only the new Snapshot");
assert.equal(recoveryExports, 1);
timeA.value = 402;
await recoveryA.captureSnapshot(arrangement("https://recover-three.example"), {
  retention: 2,
  id: "recover-three"
});
const recoveryPrune = await sync(root, {
  library: libraryA,
  recovery: countedRecoveryA,
  now: 402
});
assert.equal(recoveryPrune.recoveryPackWritten, true);
assert.equal(recoveryPrune.recoverySnapshotsWritten, 1);
assert.equal(recoveryPrune.recoveryPacksPruned, 1);
const currentRecoveryManifest = json(recoveryDeviceA, "manifest.json");
assert.ok(currentRecoveryManifest.publishedAssetDigests.length >= 1,
  "the first changed sync upgrades a legacy Recovery manifest with an asset receipt");
assert.equal(currentRecoveryManifest.packs.length, 2,
  "each device keeps only the current and previous Recovery pack");
assert.equal(recoveryDeviceA.children.get("packs").children.size, 2,
  "obsolete Recovery pack files are removed after the new manifest commits");

/* Small incremental packs compact before their file count can grow without bound. */
const compactTime = { value: 500 };
const compactLibrary = makeLibrary("compact-device", "compact-source", compactTime);
const compactRecovery = recoveryByLibrary.get(compactLibrary);
const compactRoot = new MemDir("everytab-vault-recovery-compaction");
const compactIds = ["vault-compact", "checkpoint-compact"];
await sync(compactRoot, {
  library: compactLibrary,
  now: compactTime.value,
  createId: () => compactIds.shift()
});
let compactReport = null;
for (let index = 1; index <= 17; index += 1) {
  compactTime.value += 1;
  await compactRecovery.captureSnapshot(
    { windows: [[{ url: `https://compact-${index}.example`, title: `compact-${index}` }]] },
    { retention: 20, id: `compact-${index}` }
  );
  compactReport = await sync(compactRoot, {
    library: compactLibrary,
    now: compactTime.value
  });
}
assert.equal(compactReport.recoveryCompacted, true);
assert.equal(compactReport.recoverySnapshotsWritten, 17,
  "compaction rewrites the bounded retained set, not historical deleted Snapshots");
const compactRecoveryDevice = compactRoot.children.get("recovery").children.get("compact-device");
const compactManifest = json(compactRecoveryDevice, "manifest.json");
assert.equal(compactManifest.packs.length, 1);
assert.equal(compactManifest.snapshots.length, 17);
assert.equal(compactRecoveryDevice.children.get("packs").children.size, 1,
  "compaction removes superseded immutable packs after the manifest is durable");

/* Mature Recovery transfers stay bounded and become incremental after bootstrap. */
const matureTime = { value: 1_000 };
const matureLibrary = makeLibrary("mature-device", "mature-source", matureTime);
const matureRecovery = recoveryByLibrary.get(matureLibrary);
const matureTabs = Array.from({ length: 72 }, (_, index) => ({
  url: `https://mature.example/${index}`,
  title: `Mature tab ${index}`,
  favIconUrl: RECOVERY_FAVICON
}));
for (let index = 0; index < 200; index += 1) {
  matureTime.value += 1;
  await matureRecovery.captureSnapshot({ windows: [matureTabs] }, {
    retention: 200,
    id: `mature-${String(index).padStart(3, "0")}`
  });
}
const matureRoot = new MemDir("everytab-vault-mature-recovery");
const matureIds = ["vault-mature", "checkpoint-mature"];
const matureStarted = performance.now();
const matureInitial = await sync(matureRoot, {
  library: matureLibrary,
  now: matureTime.value,
  createId: () => matureIds.shift()
});
const matureElapsed = performance.now() - matureStarted;
assert.equal(matureInitial.recoverySnapshotsWritten, 200);
const matureDevice = matureRoot.children.get("recovery").children.get("mature-device");
const matureManifest = json(matureDevice, "manifest.json");
const maturePack = matureDevice.children.get("packs").children.get(
  matureManifest.packs[0].name
);
assert.ok(maturePack.content.byteLength < 20 * 1024 * 1024,
  `compressed Recovery bootstrap exceeded 20 MiB: ${maturePack.content.byteLength}`);
assert.ok(matureElapsed < 5_000,
  `mature Recovery bootstrap took ${matureElapsed.toFixed(1)} ms`);

matureTime.value += 1;
await matureRecovery.captureSnapshot({ windows: [matureTabs] }, {
  retention: 200,
  id: "mature-new"
});
const matureIncrement = await sync(matureRoot, {
  library: matureLibrary,
  now: matureTime.value
});
assert.equal(matureIncrement.recoverySnapshotsWritten, 1,
  "one new mature Snapshot produces one incremental Recovery payload");
const matureUpdatedManifest = json(matureDevice, "manifest.json");
const incrementalPack = matureDevice.children.get("packs").children.get(
  matureUpdatedManifest.packs[0].name
);
assert.ok(incrementalPack.content.byteLength < 1024 * 1024,
  `one-Snapshot Recovery increment exceeded 1 MiB: ${incrementalPack.content.byteLength}`);

/* One large local commit is split at the Library's bounded batch contract. */
const boundedRoot = new MemDir("everytab-vault-bounded");
const bounded = makeLibrary("bounded-device", "bounded-source", { value: 700 });
const boundedIds = ["vault-bounded", "checkpoint-bounded"];
await sync(boundedRoot, {
  library: bounded,
  now: 700,
  createId: () => boundedIds.shift()
});
await bounded.transact(Array.from({ length: 256 }, (_, index) =>
  record(`bounded-${String(index).padStart(3, "0")}`, `https://bounded-${index}.example`)
));
const boundedPush = await sync(boundedRoot, { library: bounded, now: 701 });
assert.equal(boundedPush.pushed, 256);
assert.equal(boundedPush.chunksWritten, 2);
const boundedDevice = boundedRoot.children.get("devices").children.get("bounded-device");
const boundedManifest = json(boundedDevice, "manifest.json");
assert.deepEqual(
  boundedManifest.chunks.map(({ fromSequence, throughSequence }) =>
    throughSequence - fromSequence + 1),
  [128, 128],
  "a large outbox is published as bounded contiguous immutable chunks"
);

/* A failed second chunk can retry from the durable first-chunk cursor. */
const readerChunkFollower = makeLibrary("reader-chunk-follower", "reader-chunk-source", { value: 710 });
const readerSecondChunk = boundedDevice.children.get("transactions")
  .children.get(boundedManifest.chunks[1].name);
const readerSecondChunkText = readerSecondChunk.content;
readerSecondChunk.content = "{}";
boundedRoot.metrics.onReadName = readerSecondChunk.name;
boundedRoot.metrics.onRead = async () => {
  readerSecondChunk.content = readerSecondChunkText;
  const { contentHash: _boundedHash, ...boundedBody } = boundedManifest;
  const refreshed = await seal({ ...boundedBody, updatedAt: 711 }, globalThis.crypto);
  boundedDevice.children.get("manifest.json").content = `${JSON.stringify(refreshed, null, 2)}\n`;
};
const readerChunkRetry = await sync(boundedRoot, { library: readerChunkFollower, now: 710 });
assert.equal(readerChunkRetry.chunksRead, 2,
  "the retry reports both the first chunk and repaired second chunk once");
assert.equal(readerChunkRetry.pulled, 256);
assert.equal((await readerChunkFollower.readFamily("inbox")).length, 256);
assert.equal(
  (await readerChunkFollower.readReplicationState()).replicas.find(({ deviceId }) =>
    deviceId === "bounded-device").sequence,
  256,
  "the retry does not duplicate the already-applied first chunk"
);

/* Long-lived device manifests roll to a verified base instead of growing forever. */
const rolloverTime = { value: 800 };
const rolloverLibrary = makeLibrary("rollover-device", "rollover-source", rolloverTime);
const rolloverRoot = new MemDir("everytab-vault-library-rollover");
const rolloverIds = ["vault-rollover", "checkpoint-rollover-bootstrap"];
await sync(rolloverRoot, {
  library: rolloverLibrary,
  now: rolloverTime.value,
  createId: () => rolloverIds.shift()
});
for (let index = 1; index <= 128; index += 1) {
  rolloverTime.value += 1;
  await rolloverLibrary.transact([
    record(`rollover-${index}`, `https://rollover-${index}.example`)
  ]);
  await sync(rolloverRoot, {
    library: rolloverLibrary,
    now: rolloverTime.value
  });
}
rolloverTime.value += 1;
await rolloverLibrary.transact([
  record("rollover-129", "https://rollover-129.example")
]);
rolloverRoot.metrics.failManifestWriteAt = rolloverRoot.metrics.manifestWrites + 2;
await assert.rejects(
  () => sync(rolloverRoot, {
    library: rolloverLibrary,
    now: rolloverTime.value
  }),
  /Injected rollover manifest failure/,
  "interruption after the alternate base settles leaves the old manifest authoritative"
);
const rolloverDevice = rolloverRoot.children.get("devices").children.get("rollover-device");
const interruptedRolloverManifest = json(rolloverDevice, "manifest.json");
assert.equal(interruptedRolloverManifest.baseSequence, 0);
assert.equal(interruptedRolloverManifest.chunks.length, 129,
  "a failed replacement keeps every old descriptor readable");
assert.equal(rolloverDevice.children.get("bases").children.size, 1,
  "the inactive base can remain safely unreferenced after interruption");

const rolloverReport = await sync(rolloverRoot, {
  library: rolloverLibrary,
  now: rolloverTime.value
});
const firstRolloverAt = rolloverTime.value;
const rolloverManifest = json(rolloverDevice, "manifest.json");
assert.ok(rolloverManifest.baseSequence > 0,
  "a long-lived Library manifest advances to a verified checkpoint base");
assert.ok(rolloverManifest.chunks.length <= 128,
  "a long-lived Library manifest retains at most 128 incremental descriptors");
assert.equal(rolloverReport.libraryCompacted, true);
assert.equal(rolloverReport.checkpointWritten, true);
assert.equal(rolloverDevice.children.get("transactions").children.size, 129,
  "rollover does not delete immutable history without a distributed cleanup proof");
const rolloverVaultId = json(rolloverRoot, "format.json").vaultId;
const rolloverRetentionKey = `vault-transaction-retention:${rolloverVaultId}`;
const firstRetentionReceipt = (await rolloverLibrary.readLocal([rolloverRetentionKey]))[
  rolloverRetentionKey
];
assert.ok(firstRetentionReceipt, "a covered owner scan must record its retention proof");
assert.deepEqual({
  formatVersion: firstRetentionReceipt.formatVersion,
  vaultId: firstRetentionReceipt.vaultId,
  deviceId: firstRetentionReceipt.deviceId,
  sourceId: firstRetentionReceipt.sourceId,
  baseSequence: firstRetentionReceipt.baseSequence,
  lastScanAt: firstRetentionReceipt.lastScanAt
}, {
  formatVersion: 1,
  vaultId: rolloverVaultId,
  deviceId: "rollover-device",
  sourceId: "rollover-source",
  baseSequence: 129,
  lastScanAt: firstRolloverAt
}, "the first covered absence scan is stored only in the owning Library");
assert.equal(firstRetentionReceipt.candidates.length, 129);
assert.ok(firstRetentionReceipt.candidates.every(({ name, contentHash, unreferencedAt }) =>
  name.endsWith(`${contentHash.slice("sha256:".length)}.json`) &&
  unreferencedAt === firstRolloverAt));

rolloverRoot.metrics.reads = 0;
rolloverRoot.metrics.writes = 0;
rolloverRoot.metrics.scans = 0;
rolloverRoot.metrics.transactionReads = 0;
rolloverRoot.metrics.transactionScans = 0;
const rolloverNoChange = await sync(rolloverRoot, {
  library: rolloverLibrary,
  now: rolloverTime.value + 1
});
assert.equal(rolloverNoChange.libraryCompacted, false);
assert.equal(rolloverRoot.metrics.writes, 0,
  "a compact manifest preserves the zero-write no-change path");
assert.equal(rolloverRoot.metrics.transactionReads, 0,
  "a same-day no-change sync does not reread transaction files");
assert.equal(rolloverRoot.metrics.transactionScans, 0,
  "a same-day no-change sync does not rescan the transaction directory");

rolloverTime.value += 2;
await rolloverLibrary.transact([
  record("rollover-130", "https://rollover-130.example")
]);
await sync(rolloverRoot, { library: rolloverLibrary, now: rolloverTime.value });
const appendedRolloverManifest = json(rolloverDevice, "manifest.json");
assert.equal(appendedRolloverManifest.baseSequence, 129);
assert.deepEqual(
  appendedRolloverManifest.chunks.map(({ fromSequence, throughSequence }) =>
    [fromSequence, throughSequence]),
  [[130, 130]],
  "new chunks continue contiguously from the rolled base"
);

const rolloverFollower = makeLibrary(
  "rollover-follower", "rollover-follower-source", { value: 1_000 }
);
const rolloverPull = await sync(rolloverRoot, {
  library: rolloverFollower,
  now: 1_000
});
assert.equal(rolloverPull.checkpointRead, true,
  "a new device hydrates a rolled replication base");
assert.equal(rolloverPull.chunksRead, 1,
  "a new device reads only changes after the rolled base");
assert.equal((await rolloverFollower.readFamily("inbox")).length, 130);

const rolloverBaseFile = rolloverDevice.children.get("bases")
  .children.get(appendedRolloverManifest.baseCheckpoint.name);
const validRolloverBase = rolloverBaseFile.content;
const tamperedRolloverBase = JSON.parse(validRolloverBase);
tamperedRolloverBase.entities = [];
rolloverBaseFile.content = `${JSON.stringify(tamperedRolloverBase, null, 2)}\n`;
const tamperFollower = makeLibrary(
  "rollover-tamper-follower", "rollover-tamper-source", { value: 1_001 }
);
await assert.rejects(
  () => sync(rolloverRoot, { library: tamperFollower, now: 1_001 }),
  /Replication base.*content hash does not match/,
  "a remote device rejects a modified replication base before applying it"
);
rolloverBaseFile.content = validRolloverBase;

const firstBaseName = appendedRolloverManifest.baseCheckpoint.name;
for (let index = 131; index <= 258; index += 1) {
  rolloverTime.value += 1;
  const rolloverRecord = record(
    `rollover-${index}`,
    `https://rollover-${index}.example`,
    index === 258 ? FAVICON : undefined
  );
  if (index === 258) rolloverRecord.value.labels = ["Later reading"];
  await rolloverLibrary.transact([rolloverRecord]);
  await sync(rolloverRoot, {
    library: rolloverLibrary,
    now: rolloverTime.value
  });
}
const secondRolloverManifest = json(rolloverDevice, "manifest.json");
assert.notEqual(secondRolloverManifest.baseCheckpoint.name, firstBaseName,
  "the next rollover writes the inactive base slot");
assert.equal(rolloverDevice.children.get("bases").children.size, 2,
  "complete replication bases remain bounded to two alternating slots");
assert.equal(secondRolloverManifest.baseSequence, 258);
assert.equal(secondRolloverManifest.chunks.length, 0);

/* A stale manifest/base pair retries against the newer durable base head. */
const rolloverManifestFile = rolloverDevice.children.get("manifest.json");
const currentRolloverManifestText = rolloverManifestFile.content;
const firstRolloverBaseFile = rolloverDevice.children.get("bases").children.get(firstBaseName);
const firstRolloverBaseText = firstRolloverBaseFile.content;
const staleRolloverManifest = appendedRolloverManifest;
rolloverManifestFile.content = `${JSON.stringify(staleRolloverManifest, null, 2)}\n`;
firstRolloverBaseFile.content = "{}";
rolloverRoot.metrics.onReadName = "manifest.json";
rolloverRoot.metrics.onReadPredicate = (file) => file === rolloverManifestFile;
rolloverRoot.metrics.onRead = async () => {
  rolloverManifestFile.content = currentRolloverManifestText;
};
const staleBaseFollower = makeLibrary("stale-base-follower", "stale-base-source", { value: 1_010 });
const staleBasePull = await sync(rolloverRoot, { library: staleBaseFollower, now: 1_010 });
assert.equal(staleBasePull.checkpointRead, true);
assert.equal(staleBasePull.viewsWritten, true,
  "readable views are rebuilt from the manifest that completed the retry");
const retryFormat = json(rolloverRoot, "format.json");
const retryViewInput = await seal({
  app: "everytab", kind: "vault-v2-readable-view-input", formatVersion: 1,
  vaultId: retryFormat.vaultId, bootstrapContentHash: retryFormat.bootstrap.contentHash,
  deviceHeads: [...rolloverRoot.children.get("devices").children.values()]
    .map((directory) => json(directory, "manifest.json"))
    .map(({ deviceId, sourceId, throughSequence, contentHash }) =>
      ({ deviceId, sourceId, throughSequence, contentHash }))
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
}, globalThis.crypto);
assert.equal(json(rolloverRoot, "views.json").inputHash, retryViewInput.contentHash,
  "the view receipt seals the refreshed head, not the stale captured manifest");
assert.equal((await staleBaseFollower.readFamily("inbox")).length, 258,
  "a stale base read retries and converges on the newer sealed base");
firstRolloverBaseFile.content = firstRolloverBaseText;
rolloverManifestFile.content = currentRolloverManifestText;

/* Covered owner chunks need two observations and seven days before retirement. */
const DAY_MS = 24 * 60 * 60 * 1000;
const RETIREMENT_GRACE_MS = 7 * DAY_MS;
const rolloverTransactions = rolloverDevice.children.get("transactions");
const obsoleteChunkCopies = childNames(rolloverTransactions).slice(0, 3).map((name) => ({
  name,
  content: rolloverTransactions.children.get(name).content
}));
assert.equal(obsoleteChunkCopies.length, 3);

const unknownTransactionName = "keep-this-note.txt";
const unknownTransaction = new MemFile(
  unknownTransactionName, rolloverRoot.metrics, "not an EveryTab transaction", "transactions"
);
rolloverTransactions.children.set(unknownTransactionName, unknownTransaction);
const conflictingTransactionName =
  `000000000001-000000000001-${"0".repeat(64)}.json`;
const conflictingTransaction = new MemFile(
  conflictingTransactionName,
  rolloverRoot.metrics,
  obsoleteChunkCopies[0].content,
  "transactions"
);
rolloverTransactions.children.set(conflictingTransactionName, conflictingTransaction);

const orphanSource = JSON.parse(obsoleteChunkCopies[0].content);
const resealWithinBaseOrphan = async (mutateEntity) => {
  const entity = structuredClone(orphanSource.changes[0].entity);
  mutateEntity(entity);
  const entityBody = entity.lifecycle === "deleted"
    ? { family: entity.family, id: entity.id, lifecycle: "deleted" }
    : { family: entity.family, id: entity.id, lifecycle: "live", value: entity.value };
  entity.contentHash = (await seal(entityBody, globalThis.crypto)).contentHash;
  const { contentHash: _sourceHash, ...chunkBody } = orphanSource;
  chunkBody.changes = [{ sequence: orphanSource.fromSequence, entity }];
  const chunk = await seal(chunkBody, globalThis.crypto);
  const name = `${String(chunk.fromSequence).padStart(12, "0")}-${
    String(chunk.throughSequence).padStart(12, "0")}-${
    chunk.contentHash.slice("sha256:".length)}.json`;
  const file = new MemFile(
    name, rolloverRoot.metrics, `${JSON.stringify(chunk, null, 2)}\n`, "transactions"
  );
  rolloverTransactions.children.set(name, file);
  return { name, file };
};
const absentFromBaseOrphan = await resealWithinBaseOrphan((entity) => {
  entity.id = "retention-absent-from-base";
  entity.value.id = entity.id;
});
const newerThanBaseOrphan = await resealWithinBaseOrphan((entity) => {
  entity.version.wallTime += 1_000_000;
  entity.versionKey = [
    entity.version.wallTime, entity.version.logicalCounter, entity.version.deviceId
  ];
});
const sameVersionConflictOrphan = await resealWithinBaseOrphan((entity) => {
  entity.value.tabs[0].url = "https://same-version-conflict.example";
});

const staleFollowerTransactions = rolloverRoot.children.get("devices").children
  .get("stale-base-follower").children.get("transactions");
const otherDeviceTransaction = new MemFile(
  "other-device-note.txt", rolloverRoot.metrics, "belongs to another device", "transactions"
);
staleFollowerTransactions.children.set(otherDeviceTransaction.name, otherDeviceTransaction);
const assetSentinel = new MemFile(
  "transaction-retention-sentinel", rolloverRoot.metrics, "shared asset stays", "assets"
);
rolloverRoot.children.get("assets").children.set(assetSentinel.name, assetSentinel);
const backupSentinel = new MemFile(
  "transaction-retention-sentinel", rolloverRoot.metrics, "backup stays", "backups"
);
rolloverRoot.children.get("backups").children.set(backupSentinel.name, backupSentinel);
const recoverySentinel = new MemFile(
  "transaction-retention-sentinel", rolloverRoot.metrics, "recovery stays", "recovery"
);
rolloverRoot.children.get("recovery").children.set(recoverySentinel.name, recoverySentinel);

const firstDailyRetentionAt = rolloverTime.value + DAY_MS;
rolloverTime.value = firstDailyRetentionAt;
await rolloverLibrary.transact([
  record("rollover-pending", "https://pending-after-base.example")
]);
const firstDailyRetention = await sync(rolloverRoot, {
  library: rolloverLibrary,
  now: firstDailyRetentionAt
});
assert.equal(firstDailyRetention.chunksPruned, 0,
  "a first daily scan records absence without deleting covered history");
const pendingManifest = json(rolloverDevice, "manifest.json");
assert.equal(pendingManifest.baseSequence, 258);
assert.deepEqual(pendingManifest.chunks.map(({ fromSequence, throughSequence }) =>
  [fromSequence, throughSequence]), [[259, 259]]);
const pendingChunkName = pendingManifest.chunks[0].name;
const dailyRetentionReceipt = (await rolloverLibrary.readLocal([rolloverRetentionKey]))[
  rolloverRetentionKey
];
assert.equal(dailyRetentionReceipt.lastScanAt, firstDailyRetentionAt);
assert.equal(dailyRetentionReceipt.baseSequence, 258);
assert.equal(dailyRetentionReceipt.candidates.length, 258);
assert.ok(!dailyRetentionReceipt.candidates.some(({ name }) => name === pendingChunkName),
  "the current manifest chunk is never an obsolete candidate");
assert.ok(!dailyRetentionReceipt.candidates.some(({ name }) =>
  name === absentFromBaseOrphan.name || name === newerThanBaseOrphan.name ||
  name === sameVersionConflictOrphan.name),
"within-base chunks without an equal-or-newer base entity never earn absence proof");
assert.deepEqual([...new Set(dailyRetentionReceipt.candidates.map(({ unreferencedAt }) =>
  unreferencedAt))].sort((left, right) => left - right),
  [firstRolloverAt, firstDailyRetentionAt],
  "the second scan preserves the first absence time and starts grace for newly covered chunks");

const pendingChunk = json(rolloverTransactions, pendingChunkName);
const { contentHash: _pendingHash, ...uncoveredBody } = pendingChunk;
uncoveredBody.fromSequence = 260;
uncoveredBody.throughSequence = 260;
uncoveredBody.changes = pendingChunk.changes.map((change) => ({ ...change, sequence: 260 }));
const uncoveredChunk = await seal(uncoveredBody, globalThis.crypto);
const uncoveredTransactionName =
  `000000000260-000000000260-${uncoveredChunk.contentHash.slice("sha256:".length)}.json`;
const uncoveredTransaction = new MemFile(
  uncoveredTransactionName,
  rolloverRoot.metrics,
  `${JSON.stringify(uncoveredChunk, null, 2)}\n`,
  "transactions"
);
rolloverTransactions.children.set(uncoveredTransactionName, uncoveredTransaction);
const lateOfflineFollower = makeLibrary(
  "late-offline-follower", "late-offline-source", { value: firstDailyRetentionAt }
);

const beforeGraceAt = firstDailyRetentionAt + DAY_MS;
const beforeGraceReport = await sync(rolloverRoot, {
  library: rolloverLibrary,
  now: beforeGraceAt
});
assert.equal(beforeGraceReport.chunksPruned, 0,
  "a repeated scan before seven days retains every covered candidate");
assert.equal((await rolloverLibrary.readLocal([rolloverRetentionKey]))[
  rolloverRetentionKey
].candidates.length, 258);

const pruneAt = firstDailyRetentionAt + RETIREMENT_GRACE_MS;
const pruneReport = await sync(rolloverRoot, {
  library: rolloverLibrary,
  now: pruneAt
});
assert.equal(pruneReport.chunksPruned, 258,
  "the second qualifying scan reports the exact number of covered chunks removed");
assert.equal(noChangeVaultSync({
  ...pruneReport, ok: true, storageVersion: 2
}), false, "transaction retirement is visible as sync work in the storage audit");
assert.ok(rolloverTransactions.children.has(pendingChunkName),
  "a manifest-referenced pending chunk survives covered-history retirement");
assert.equal(rolloverTransactions.children.get(unknownTransactionName), unknownTransaction);
assert.equal(rolloverTransactions.children.get(conflictingTransactionName), conflictingTransaction);
assert.equal(rolloverTransactions.children.get(absentFromBaseOrphan.name),
  absentFromBaseOrphan.file, "a valid chunk whose entity is absent from the base survives");
assert.equal(rolloverTransactions.children.get(newerThanBaseOrphan.name),
  newerThanBaseOrphan.file, "a valid chunk newer than the base entity survives");
assert.equal(rolloverTransactions.children.get(sameVersionConflictOrphan.name),
  sameVersionConflictOrphan.file,
  "a valid same-version chunk with different content from the base survives");
assert.equal(rolloverTransactions.children.get(uncoveredTransactionName), uncoveredTransaction,
  "a sealed but base-uncovered chunk is retained");

const offlineCursor = (await rolloverFollower.readReplicationState()).replicas
  .find(({ deviceId }) => deviceId === "rollover-device");
assert.equal(offlineCursor.sequence, 130, "the established peer has been offline since the first base");
const offlineEdit = record("offline-only", "https://offline-edit.example");
offlineEdit.value.labels = ["Offline work"];
await rolloverFollower.transact([offlineEdit]);
const resumedPeer = await sync(rolloverRoot, { library: rolloverFollower, now: pruneAt + 1 });
assert.equal(resumedPeer.checkpointRead, true);
assert.equal((await rolloverFollower.readFamily("inbox")).length, 260);
assert.deepEqual((await rolloverFollower.readEntity("inbox", "offline-only")).value.labels,
  ["Offline work"], "checkpoint catch-up preserves the established peer's unsynced work");
assert.equal((await rolloverFollower.readEntity("inbox", "rollover-258")).value.tabs[0].favIconUrl,
  FAVICON);
assert.deepEqual((await rolloverFollower.readEntity("inbox", "rollover-258")).value.labels,
  ["Later reading"]);

const latePull = await sync(rolloverRoot, {
  library: lateOfflineFollower,
  now: pruneAt + 1
});
assert.equal(latePull.checkpointRead, true,
  "a peer that was offline during retirement joins from the covering base");
assert.equal((await lateOfflineFollower.readEntity("inbox", "rollover-258")).value.tabs[0].url,
  "https://rollover-258.example");
assert.deepEqual((await lateOfflineFollower.readEntity("inbox", "rollover-258")).value.labels,
  ["Later reading"]);
assert.equal(
  (await lateOfflineFollower.readEntity("inbox", "rollover-258")).value.tabs[0].favIconUrl,
  FAVICON
);
assert.equal((await lateOfflineFollower.readEntity("inbox", "rollover-pending"))
  .value.tabs[0].url, "https://pending-after-base.example",
"the same late peer continues exactly through the retained pending chunk");

/* A corrupt covering base clears yesterday's proof and cannot authorize deletion. */
rolloverTransactions.children.set(obsoleteChunkCopies[0].name, new MemFile(
  obsoleteChunkCopies[0].name,
  rolloverRoot.metrics,
  obsoleteChunkCopies[0].content,
  "transactions"
));
const corruptObserveAt = pruneAt + DAY_MS;
await sync(rolloverRoot, { library: rolloverLibrary, now: corruptObserveAt });
const currentRetentionManifest = json(rolloverDevice, "manifest.json");
const currentBaseFile = rolloverDevice.children.get("bases").children
  .get(currentRetentionManifest.baseCheckpoint.name);
const currentBaseText = currentBaseFile.content;
currentBaseFile.content = "{}";
const corruptDeleteAt = corruptObserveAt + RETIREMENT_GRACE_MS;
const corruptResult = await sync(rolloverRoot, {
  library: rolloverLibrary,
  now: corruptDeleteAt
}).catch((error) => error);
assert.ok(corruptResult instanceof Error,
  "a corrupt covering base fails the retention scan closed");
assert.ok(rolloverTransactions.children.has(obsoleteChunkCopies[0].name));
assert.deepEqual((await rolloverLibrary.readLocal([rolloverRetentionKey]))[
  rolloverRetentionKey
].candidates, [], "an interrupted verification cannot preserve old absence proof");
currentBaseFile.content = currentBaseText;

/* A partial file-system failure makes the remainder earn a fresh grace period. */
rolloverTransactions.children.set(obsoleteChunkCopies[1].name, new MemFile(
  obsoleteChunkCopies[1].name,
  rolloverRoot.metrics,
  obsoleteChunkCopies[1].content,
  "transactions"
));
const retryObserveAt = corruptDeleteAt + DAY_MS;
await sync(rolloverRoot, { library: rolloverLibrary, now: retryObserveAt });
assert.equal((await rolloverLibrary.readLocal([rolloverRetentionKey]))[
  rolloverRetentionKey
].candidates.length, 2);
const partialDeleteAt = retryObserveAt + RETIREMENT_GRACE_MS;
rolloverRoot.metrics.failTransactionRemoveAt =
  (rolloverRoot.metrics.transactionRemoveAttempts ?? 0) + 2;
await assert.rejects(
  () => sync(rolloverRoot, { library: rolloverLibrary, now: partialDeleteAt }),
  /Injected transaction removal failure/
);
const partialNames = obsoleteChunkCopies.slice(0, 2).map(({ name }) => name);
assert.equal(partialNames.filter((name) => rolloverTransactions.children.has(name)).length, 1,
  "a completed removal stays complete while the failed remainder is retained");
assert.deepEqual((await rolloverLibrary.readLocal([rolloverRetentionKey]))[
  rolloverRetentionKey
].candidates, []);
const partialRetryObserveAt = partialDeleteAt + DAY_MS;
await sync(rolloverRoot, { library: rolloverLibrary, now: partialRetryObserveAt });
const partialRetryDelete = await sync(rolloverRoot, {
  library: rolloverLibrary,
  now: partialRetryObserveAt + RETIREMENT_GRACE_MS
});
assert.equal(partialRetryDelete.chunksPruned, 1,
  "the remaining file is safely removable only after a new full grace period");

/* A changed owner head after one removal cancels every remaining deletion. */
for (const chunk of obsoleteChunkCopies.slice(0, 2)) {
  rolloverTransactions.children.set(chunk.name, new MemFile(
    chunk.name, rolloverRoot.metrics, chunk.content, "transactions"
  ));
}
const headRaceObserveAt = partialRetryObserveAt + RETIREMENT_GRACE_MS + DAY_MS;
await sync(rolloverRoot, { library: rolloverLibrary, now: headRaceObserveAt });
rolloverRoot.metrics.onTransactionRemoved = async () => {
  delete rolloverRoot.metrics.onTransactionRemoved;
  const current = json(rolloverDevice, "manifest.json");
  const { contentHash: _currentHash, ...body } = current;
  const changed = await seal({ ...body, updatedAt: current.updatedAt + 1 }, globalThis.crypto);
  rolloverManifestFile.content = `${JSON.stringify(changed, null, 2)}\n`;
};
const headRaceDeleteAt = headRaceObserveAt + RETIREMENT_GRACE_MS;
const headRaceReport = await sync(rolloverRoot, {
  library: rolloverLibrary,
  now: headRaceDeleteAt
});
assert.equal(headRaceReport.chunksPruned, 1);
assert.equal(partialNames.filter((name) => rolloverTransactions.children.has(name)).length, 1,
  "a changed manifest head cancels the remaining stale deletion plan");
assert.equal(noChangeVaultSync({
  ...headRaceReport, ok: true, storageVersion: 2
}), false);

/* Replacing a candidate after verification but before deletion cancels the plan. */
const fileRaceName = partialNames.find((name) => rolloverTransactions.children.has(name));
const fileRaceObserveAt = headRaceDeleteAt + DAY_MS;
await sync(rolloverRoot, { library: rolloverLibrary, now: fileRaceObserveAt });
assert.equal((await rolloverLibrary.readLocal([rolloverRetentionKey]))[
  rolloverRetentionKey
].candidates.length, 1);
let ownerManifestReads = 0;
rolloverRoot.metrics.onReadName = "manifest.json";
rolloverRoot.metrics.onReadPredicate = (file) => {
  if (file !== rolloverManifestFile) return false;
  ownerManifestReads += 1;
  return ownerManifestReads === 2;
};
rolloverRoot.metrics.onRead = async () => {
  rolloverTransactions.children.get(fileRaceName).content = "{}";
};
const fileRaceReport = await sync(rolloverRoot, {
  library: rolloverLibrary,
  now: fileRaceObserveAt + RETIREMENT_GRACE_MS
});
assert.equal(fileRaceReport.chunksPruned, 0);
assert.equal(rolloverTransactions.children.get(fileRaceName).content, "{}",
  "a candidate replaced before the final file read is retained without stale deletion");

assert.equal(staleFollowerTransactions.children.get(otherDeviceTransaction.name),
  otherDeviceTransaction, "owner retention never scans or deletes another device's files");
assert.equal(rolloverRoot.children.get("assets").children.get(assetSentinel.name), assetSentinel);
assert.equal(rolloverRoot.children.get("backups").children.get(backupSentinel.name), backupSentinel);
assert.equal(rolloverRoot.children.get("recovery").children.get(recoverySentinel.name),
  recoverySentinel, "transaction retention does not broaden into other Vault roots");

/* Missing, regressed, or unknown retention authority never preserves stale proof. */
const { retireVaultTransactions } = await import("../js/vault/transaction-retention.js");
const proofTime = { value: 4_000_000_000 };
const proofLibrary = makeLibrary("proof-device", "proof-source", proofTime);
const proofVaultId = "proof-vault";
const proofKey = `vault-transaction-retention:${proofVaultId}`;
const proofCandidate = {
  name: obsoleteChunkCopies[0].name,
  contentHash: `sha256:${obsoleteChunkCopies[0].name.slice(-69, -5)}`,
  unreferencedAt: proofTime.value - RETIREMENT_GRACE_MS
};
const proofReceipt = (baseSequence) => ({
  formatVersion: 1,
  vaultId: proofVaultId,
  deviceId: "proof-device",
  sourceId: "proof-source",
  baseSequence,
  lastScanAt: proofTime.value - 1,
  candidates: [proofCandidate]
});
const directRetention = (manifest) => retireVaultTransactions({
  library: proofLibrary,
  manifest,
  deviceDirectory: new MemDir("proof-device"),
  now: proofTime.value,
  cryptoProvider: globalThis.crypto,
  readManifest: async () => { throw new Error("manifest must not be read"); },
  readCheckpoint: async () => { throw new Error("checkpoint must not be read"); },
  report: { chunksPruned: 0 }
});
await proofLibrary.commit({ localSets: { [proofKey]: proofReceipt(300) } });
await assert.rejects(() => directRetention({
  vaultId: proofVaultId,
  deviceId: "proof-device",
  sourceId: "proof-source",
  baseSequence: 0,
  chunks: []
}), /base moved backwards/);
assert.deepEqual((await proofLibrary.readLocal([proofKey]))[proofKey], {
  ...proofReceipt(300),
  lastScanAt: proofTime.value,
  candidates: []
}, "losing the covering base clears proof immediately but retains its high watermark");

proofTime.value += 1;
await proofLibrary.commit({ localSets: { [proofKey]: proofReceipt(300) } });
await assert.rejects(() => directRetention({
  vaultId: proofVaultId,
  deviceId: "proof-device",
  sourceId: "proof-source",
  baseSequence: 299,
  baseCheckpoint: { name: "base-a.json" },
  chunks: []
}), /base moved backwards/);
assert.deepEqual((await proofLibrary.readLocal([proofKey]))[proofKey], {
  ...proofReceipt(300),
  lastScanAt: proofTime.value,
  candidates: []
}, "a regressed base also clears proof before the daily cooldown can skip the scan");

const unknownProof = { formatVersion: 2, opaque: "keep exactly" };
await proofLibrary.commit({ localSets: { [proofKey]: unknownProof } });
await assert.rejects(() => directRetention({
  vaultId: proofVaultId,
  deviceId: "proof-device",
  sourceId: "proof-source",
  baseSequence: 300,
  baseCheckpoint: { name: "base-a.json" },
  chunks: []
}), /receipt is invalid/);
assert.deepEqual((await proofLibrary.readLocal([proofKey]))[proofKey], unknownProof,
  "an unknown receipt is rejected without rewriting user-local state");

/* A new Library cannot reuse an old device sequence under the same identity. */
const replacementA = makeLibrary("device-a", "replacement-source", { value: 500 });
await assert.rejects(
  () => sync(root, { library: replacementA, now: 500 }),
  /earlier local Library copy|replication source/i
);

/* Legacy or arbitrary non-empty folders are never initialized or modified. */
const legacy = new MemDir("legacy");
legacy.children.set("settings.json", new MemFile("settings.json", legacy.metrics, "{}"));
const legacyInspection = await inspectVaultRoot(legacy);
assert.equal(legacyInspection.state, "unrecognized");
await assert.rejects(
  () => sync(legacy, { library: libraryA, now: 600 }),
  /new empty folder/i
);
assert.equal(legacy.children.size, 1);
assert.equal(legacy.children.get("settings.json").content, "{}");

/* A no-change sync repairs an earlier committed cursor whose index write failed. */
const repairRoot = new MemDir("repair-vault");
const repairSource = makeLibrary("repair-source", "repair-source-id", { value: 1_000 });
const repairDestination = makeLibrary("repair-destination", "repair-destination-id", { value: 1_000 });
await repairSource.transact([{ type: "put", family: "sessions", id: "repair-session", value: {
  id: "repair-session", name: "Repair Session", auto: false,
  windows: [[{ url: "https://repair.example", title: "Repair" }]], labels: []
} }]);
await sync(repairRoot, { library: repairSource, now: 1_000 });
const originalRepairCommit = repairDestination.commit;
let failRepairRevision = true;
let repairProjectionWrites = 0;
repairDestination.commit = async (options) => {
  if (options.localSets?.storageV2DurableRevision) {
    if (failRepairRevision) throw new Error("Injected repair revision failure");
    repairProjectionWrites += 1;
  }
  return originalRepairCommit(options);
};
await assert.rejects(sync(repairRoot, { library: repairDestination, now: 1_001 }), /repair revision failure/);
assert.ok(await repairDestination.readEntity("sessions", "repair-session"));
failRepairRevision = false;
const repairedSync = await sync(repairRoot, { library: repairDestination, now: 1_002 });
assert.equal(repairedSync.pulled, 0, "the retry has already consumed the source cursor");
assert.equal((await repairDestination.readLocal(["sessionIdentityIndex"]))
  .sessionIdentityIndex.sessionsById["repair-session"].name, "Repair Session");
assert.equal(repairProjectionWrites, 1);
const cleanRepairRevision = (await authorityByLibrary.get(repairDestination).readPendingRevision()).id;
await sync(repairRoot, { library: repairDestination, now: 1_003 });
assert.equal(repairProjectionWrites, 1, "a clean no-change sync performs no index/revision writes");
assert.equal((await authorityByLibrary.get(repairDestination).readPendingRevision()).id, cleanRepairRevision);

// Keep the cross-context Store/Vault interleaving in the hosted Vault gate.
await import("./vault-library-commit.mjs");

console.log("PASS: incremental Vault protocol");
