// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Incremental Vault replication.
 *
 * The public interface is deliberately small: inspect a selected folder, or
 * synchronize one Library against it. This module alone owns the on-disk
 * protocol, immutable chunk publication, manifest cursors, bootstrap
 * checkpoint, content-addressed assets, and crash ordering.
 */
import {
  VAULT_FORMAT_VERSION,
  DIGEST,
  classifyForeignEntry,
  createAssetWriter,
  entries,
  hydrateAssetManifest,
  isSafeName,
  optionalFileHandle,
  parseJson,
  placeholderNameFor,
  readFileHandle,
  readNamedFile,
  requiredCount,
  requiredName,
  seal,
  verifySeal,
  writeImmutable,
  writeJson,
  writeText
} from "./protocol-io.js";
import {
  VAULT_FAILURE_CODES,
  VaultSyncError,
  classifyVaultProtocolError,
  recordQuarantine,
  vaultFailureCode
} from "./failure-codes.js";
import { publishRecovery } from "./recovery-sync.js";
import { buildReadableIndex, buildReadableLibrary } from "./readable-views.js";
import { publishCheckpointBackup } from "./checkpoint-sync.js";
import { pullWithFreshManifest, readRemoteVaultState } from "./remote-manifest-retry.js";
import { retireVaultTransactions } from "./transaction-retention.js";

/** @typedef {import("../lib/storage/library-store.js").LibraryStore} LibraryStore */
/** @typedef {import("../lib/storage/recovery-store.js").RecoveryStore} RecoveryStore */
/**
 * Vault-facing Library capabilities. Checkpoint import is conditional because
 * a current peer does not enter that branch.
 * @typedef {Pick<LibraryStore,"readReplicationState"|"readSyncBatch"|"acknowledgeSync"|
 *   "applyRemoteBatch"|"createExactCheckpoint"|"readLocal"|"commit"> &
 *   {applyRemoteCheckpoint?:LibraryStore["applyRemoteCheckpoint"]}} VaultLibrary
 */
/** @typedef {Pick<RecoveryStore,"readReplicationState"|"exportRecoveryPack">} VaultRecovery */
/**
 * Dependencies and optional effects at the Vault sync seam.
 * @typedef {object} VaultSyncOptions
 * @property {VaultLibrary} library
 * @property {VaultRecovery} recovery
 * @property {number} [now]
 * @property {Crypto} [cryptoProvider]
 * @property {()=>string} [createId]
 * @property {(progress:Record<string,unknown>)=>void} [onProgress]
 * @property {(apply:()=>Promise<unknown>)=>Promise<unknown>} [commitRemoteApply]
 */

function hasMethods(value, names) {
  return value && names.every((name) => typeof value[name] === "function");
}

function needsRemoteCheckpoint(format, manifest, cursor, hasCursor) {
  const ownsBootstrap = manifest.deviceId === format.initializer.deviceId &&
    manifest.sourceId === format.initializer.sourceId;
  return cursor < manifest.baseSequence || (!hasCursor && ownsBootstrap);
}

export { VAULT_FORMAT_VERSION } from "./protocol-io.js";
const FORMAT_FILE = "format.json";
const MANIFEST_FILE = "manifest.json";
const DEVICES_DIR = "devices";
const TRANSACTIONS_DIR = "transactions";
const BASES_DIR = "bases";
const ASSETS_DIR = "assets";
const CHECKPOINTS_DIR = "checkpoints";
const READABLE_LIBRARY_FILE = "library.json";
const READABLE_INDEX_FILE = "index.md";
const READABLE_VIEWS_RECEIPT_FILE = "views.json";
const VAULT_LOCK = "everytab-vault-sync";
const MAX_MANIFEST_CHUNKS = 128;
const BASE_FILES = Object.freeze(["base-a.json", "base-b.json"]);

function sameStrings(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return b.length === right.length && a.length === b.length &&
    a.every((value, index) => value === b[index]);
}

function chunkFileName(fromSequence, throughSequence, digest) {
  const match = DIGEST.exec(digest);
  if (!match) throw new Error("Vault transaction digest is invalid");
  return `${String(fromSequence).padStart(12, "0")}-${String(throughSequence)
    .padStart(12, "0")}-${match[1]}.json`;
}

function verifyBaseDescriptor(descriptor, manifest) {
  if (!descriptor || !BASE_FILES.includes(descriptor.name) ||
      descriptor.throughSequence !== manifest.baseSequence ||
      !DIGEST.test(descriptor.contentHash ?? "") ||
      !DIGEST.test(descriptor.libraryContentHash ?? "")) {
    throw new Error(`Manifest base for ${manifest.deviceId} is invalid`);
  }
  return descriptor;
}

/**
 * An EveryTab envelope whose format version is above this build's is newer
 * data, not damage. The user can act on that only if the failure says so.
 */
function newerEveryTabEnvelope(value) {
  return value?.app === "everytab" && typeof value.kind === "string" &&
    value.kind.startsWith("vault-v2-") &&
    Number.isSafeInteger(value.formatVersion) && value.formatVersion > VAULT_FORMAT_VERSION;
}

function updateRequiredError(kind) {
  return new VaultSyncError("This Vault was written by a newer EveryTab", {
    code: VAULT_FAILURE_CODES.updateRequired, kind
  });
}

async function verifyFormat(format, cryptoProvider) {
  if (newerEveryTabEnvelope(format)) throw updateRequiredError("format");
  await verifySeal(format, "Vault format", cryptoProvider);
  if (format.app !== "everytab" || format.kind !== "vault-v2-format" ||
      format.formatVersion !== VAULT_FORMAT_VERSION || format.storageVersion !== 2 ||
      !["initializing", "ready"].includes(format.status)) {
    throw new Error("The selected folder is not a supported Vault");
  }
  requiredName(format.vaultId, "Vault identity");
  requiredName(format.initializer?.deviceId, "Vault initializer device");
  requiredName(format.initializer?.sourceId, "Vault initializer source");
  if (format.status === "ready") {
    requiredName(format.bootstrap?.checkpointId, "Vault bootstrap checkpoint");
    requiredCount(format.bootstrap?.throughSequence, "Vault bootstrap sequence");
    if (!DIGEST.test(format.bootstrap?.contentHash ?? "")) {
      throw new Error("Vault bootstrap digest is invalid");
    }
  }
  return format;
}

async function readFormat(root, cryptoProvider) {
  const text = await readNamedFile(root, FORMAT_FILE, { optional: true });
  return text === null ? null : verifyFormat(parseJson(text, FORMAT_FILE), cryptoProvider);
}

/** Read-only folder check used before persisting a File System Access handle. */
export async function inspectVaultRoot(
  root,
  { cryptoProvider = globalThis.crypto, onProgress = () => {} } = {}
) {
  if (!hasMethods(root, ["entries", "getDirectoryHandle", "getFileHandle"])) {
    throw new Error("A writable folder is required");
  }
  const rootEntries = await entries(root, ({ completed }) =>
    onProgress({ stage: "scanning", target: "vault", completed }));
  const formatHandle = rootEntries.find(({ name }) => name === FORMAT_FILE)?.handle;
  if (!formatHandle) {
    if (rootEntries.length === 0) return { state: "empty" };
    // An evicted Vault is healthy data that is not on this device yet. Never
    // describe it as unrecognized; the "new empty folder" advice would lose it.
    const evicted = rootEntries.some(({ name }) => name === placeholderNameFor(FORMAT_FILE)) ||
      rootEntries.every(({ name }) => classifyForeignEntry(name) === "placeholder");
    if (evicted) {
      return {
        state: "placeholder",
        message: "The Vault files are not downloaded on this device",
        failureCode: VAULT_FAILURE_CODES.placeholderFile,
        fileKind: "format"
      };
    }
    return { state: "unrecognized", message: "Choose a new empty folder for the Vault" };
  }
  try {
    const format = await verifyFormat(
      parseJson(await readFileHandle(formatHandle, FORMAT_FILE), FORMAT_FILE),
      cryptoProvider
    );
    onProgress({ stage: "reading", target: "vault", completed: 1, total: 1 });
    return { state: format.status === "ready" ? "ready" : "initializing", format };
  } catch (error) {
    const failureCode = vaultFailureCode(error);
    return {
      state: "invalid",
      message: error?.message ?? String(error),
      ...(failureCode ? { failureCode, fileKind: error.fileKind ?? "format" } : {})
    };
  }
}

function inspectionError(inspection) {
  return inspection.failureCode
    ? new VaultSyncError(inspection.message, {
      code: inspection.failureCode, kind: inspection.fileKind
    })
    : new Error(inspection.message);
}

async function verifyManifest(manifest, { vaultId, deviceId }, cryptoProvider) {
  if (newerEveryTabEnvelope(manifest)) throw updateRequiredError("manifest");
  await verifySeal(manifest, `Manifest for ${deviceId}`, cryptoProvider);
  if (manifest.app !== "everytab" || manifest.kind !== "vault-v2-device-manifest" ||
      manifest.formatVersion !== VAULT_FORMAT_VERSION || manifest.vaultId !== vaultId ||
      manifest.deviceId !== deviceId) {
    throw new Error(`Manifest for ${deviceId} is invalid`);
  }
  requiredName(manifest.sourceId, `Replication source for ${deviceId}`);
  const baseSequence = requiredCount(manifest.baseSequence, `Base sequence for ${deviceId}`);
  const throughSequence = requiredCount(
    manifest.throughSequence, `Published sequence for ${deviceId}`
  );
  if (!Array.isArray(manifest.chunks) || throughSequence < baseSequence) {
    throw new Error(`Manifest sequence for ${deviceId} is invalid`);
  }
  if (manifest.baseCheckpoint !== undefined) {
    verifyBaseDescriptor(manifest.baseCheckpoint, manifest);
  }
  let cursor = baseSequence;
  for (const descriptor of manifest.chunks) {
    const fromSequence = requiredCount(descriptor?.fromSequence, "Chunk start sequence");
    const chunkThrough = requiredCount(descriptor?.throughSequence, "Chunk end sequence");
    if (fromSequence !== cursor + 1 || chunkThrough < fromSequence ||
        !DIGEST.test(descriptor?.contentHash ?? "") ||
        descriptor.name !== chunkFileName(fromSequence, chunkThrough, descriptor.contentHash)) {
      throw new Error(`Manifest chunks for ${deviceId} are not contiguous`);
    }
    cursor = chunkThrough;
  }
  if (cursor !== throughSequence) {
    throw new Error(`Manifest head for ${deviceId} does not match its chunks`);
  }
  return manifest;
}

async function createManifest({ vaultId, deviceId, sourceId, baseSequence, now }, cryptoProvider) {
  return seal({
    app: "everytab",
    kind: "vault-v2-device-manifest",
    formatVersion: VAULT_FORMAT_VERSION,
    vaultId,
    deviceId,
    sourceId,
    baseSequence,
    throughSequence: baseSequence,
    chunks: [],
    updatedAt: now
  }, cryptoProvider);
}

async function verifyChunk(chunk, descriptor, manifest, cryptoProvider) {
  if (newerEveryTabEnvelope(chunk)) throw updateRequiredError("transaction");
  await verifySeal(chunk, `Transaction ${descriptor.name}`, cryptoProvider);
  if (chunk.app !== "everytab" || chunk.kind !== "vault-v2-transaction" ||
      chunk.formatVersion !== VAULT_FORMAT_VERSION || chunk.vaultId !== manifest.vaultId ||
      chunk.deviceId !== manifest.deviceId || chunk.sourceId !== manifest.sourceId ||
      chunk.fromSequence !== descriptor.fromSequence ||
      chunk.throughSequence !== descriptor.throughSequence ||
      chunk.contentHash !== descriptor.contentHash || !Array.isArray(chunk.changes) ||
      !Array.isArray(chunk.assetManifest)) {
    throw new Error(`Transaction ${descriptor.name} does not match its manifest`);
  }
  const referenced = chunk.changes.flatMap(({ entity }) => entity?.assetDigests ?? []);
  const supplied = chunk.assetManifest.map(({ digest }) => digest);
  if (!sameStrings(referenced, supplied) || supplied.some((digest) => !DIGEST.test(digest))) {
    throw new Error(`Transaction ${descriptor.name} asset manifest is invalid`);
  }
  return chunk;
}

async function deviceDirectories(devicesDirectory, onProgress) {
  return (await entries(devicesDirectory, ({ completed }) =>
    onProgress({ stage: "scanning", target: "library", completed })))
    .filter(({ handle }) => handle.kind === "directory")
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function readDeviceManifest(
  deviceDirectory,
  { vaultId, deviceId, optional = false },
  cryptoProvider
) {
  const text = await readNamedFile(deviceDirectory, MANIFEST_FILE, { optional, kind: "manifest" });
  if (text === null) return null;
  return verifyManifest(parseJson(text, MANIFEST_FILE), { vaultId, deviceId }, cryptoProvider);
}

/**
 * Another device's manifest is authoritative only for that device. When it
 * cannot be verified, or is an eviction placeholder, that device is skipped
 * and counted; every other device still syncs. Newer EveryTab data and this
 * device's own manifest keep failing closed.
 */
async function readForeignManifest(deviceDirectory, { vaultId, deviceId }, cryptoProvider, report) {
  let manifest;
  try {
    manifest = await readDeviceManifest(
      deviceDirectory, { vaultId, deviceId, optional: true }, cryptoProvider
    );
  } catch (error) {
    if (vaultFailureCode(error) === VAULT_FAILURE_CODES.updateRequired) throw error;
    recordQuarantine(report, VAULT_FAILURE_CODES.foreignManifestUnreadable, "manifest");
    return null;
  }
  if (manifest) return manifest;
  if (await optionalFileHandle(deviceDirectory, placeholderNameFor(MANIFEST_FILE))) {
    recordQuarantine(report, VAULT_FAILURE_CODES.placeholderFile, "manifest");
  }
  return null;
}

async function initializeVault({
  root, library, replication, now, cryptoProvider, createId, report, onProgress
}) {
  const vaultId = requiredName(createId(), "Vault identity");
  const checkpointId = requiredName(createId(), "Vault checkpoint identity");
  const initializing = await seal({
    app: "everytab",
    kind: "vault-v2-format",
    formatVersion: VAULT_FORMAT_VERSION,
    storageVersion: 2,
    status: "initializing",
    vaultId,
    createdAt: now,
    initializer: {
      deviceId: replication.deviceId,
      sourceId: replication.sourceId
    }
  }, cryptoProvider);
  await writeJson(root, FORMAT_FILE, initializing);
  onProgress({ stage: "initializing", target: "format" });

  const devices = await root.getDirectoryHandle(DEVICES_DIR, { create: true });
  const assetsDirectory = await root.getDirectoryHandle(ASSETS_DIR, { create: true });
  const assetWriter = createAssetWriter(assetsDirectory, { directoryStartsEmpty: true });
  const checkpoints = await root.getDirectoryHandle(CHECKPOINTS_DIR, { create: true });
  await root.getDirectoryHandle("recovery", { create: true });
  await root.getDirectoryHandle("backups", { create: true });

  const checkpoint = await library.createExactCheckpoint();
  await assetWriter.write(checkpoint.assets, report, onProgress);
  const checkpointBody = await seal({
    app: "everytab",
    kind: "vault-v2-checkpoint",
    formatVersion: VAULT_FORMAT_VERSION,
    vaultId,
    checkpointId,
    createdAt: now,
    sourceDeviceId: replication.deviceId,
    sourceId: replication.sourceId,
    throughSequence: replication.sequence,
    libraryCreatedAt: checkpoint.createdAt,
    libraryContentHash: checkpoint.contentHash,
    entities: checkpoint.entities,
    assetManifest: checkpoint.assets.map(({ dataUrl: _dataUrl, ...asset }) => asset)
  }, cryptoProvider);
  const checkpointDirectory = await checkpoints.getDirectoryHandle(checkpointId, { create: true });
  await writeJson(checkpointDirectory, "library.json", checkpointBody);
  report.checkpointWritten = true;
  report.pushed += checkpoint.entities.length;
  onProgress({ stage: "checkpoint", target: "library", completed: checkpoint.entities.length });

  const localDirectory = await devices.getDirectoryHandle(replication.deviceId, { create: true });
  await localDirectory.getDirectoryHandle(TRANSACTIONS_DIR, { create: true });
  const manifest = await createManifest({
    vaultId,
    deviceId: replication.deviceId,
    sourceId: replication.sourceId,
    baseSequence: replication.sequence,
    now
  }, cryptoProvider);
  await writeJson(localDirectory, MANIFEST_FILE, manifest);

  const { contentHash: _initializingHash, ...initializingBody } = initializing;
  const sealedReady = await seal({
    ...initializingBody,
    status: "ready",
    bootstrap: {
      checkpointId,
      contentHash: checkpointBody.contentHash,
      throughSequence: replication.sequence
    }
  }, cryptoProvider);
  await writeJson(root, FORMAT_FILE, sealedReady);
  await library.acknowledgeSync(replication.sequence);
  return {
    format: sealedReady,
    devices,
    assetsDirectory,
    assetWriter,
    localManifest: manifest,
    bootstrapCheckpoint: checkpoint,
    bootstrapDescriptor: {
      checkpointId,
      vaultId,
      sourceDeviceId: replication.deviceId,
      inputHash: null,
      contentHash: checkpointBody.contentHash,
      libraryContentHash: checkpoint.contentHash,
      createdAt: now
    }
  };
}

async function readableViewInput(format, manifests, cryptoProvider) {
  return seal({
    app: "everytab",
    kind: "vault-v2-readable-view-input",
    formatVersion: VAULT_FORMAT_VERSION,
    vaultId: format.vaultId,
    bootstrapContentHash: format.bootstrap.contentHash,
    deviceHeads: manifests
      .map((manifest) => ({
        deviceId: manifest.deviceId,
        sourceId: manifest.sourceId,
        throughSequence: manifest.throughSequence,
        contentHash: manifest.contentHash
      }))
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
  }, cryptoProvider);
}

async function readableViewsAreCurrent(root, input, cryptoProvider) {
  const text = await readNamedFile(root, READABLE_VIEWS_RECEIPT_FILE, { optional: true });
  if (text === null) return false;
  try {
    const receipt = await verifySeal(
      parseJson(text, READABLE_VIEWS_RECEIPT_FILE),
      "Vault readable views receipt",
      cryptoProvider
    );
    if (receipt.app !== "everytab" || receipt.kind !== "vault-v2-readable-views" ||
        receipt.formatVersion !== VAULT_FORMAT_VERSION || receipt.vaultId !== input.vaultId ||
        receipt.inputHash !== input.contentHash) {
      return false;
    }
    const [libraryView, indexView] = await Promise.all([
      optionalFileHandle(root, READABLE_LIBRARY_FILE),
      optionalFileHandle(root, READABLE_INDEX_FILE)
    ]);
    return Boolean(libraryView && indexView);
  } catch {
    return false;
  }
}

async function publishReadableViews({
  root,
  library,
  format,
  manifests,
  checkpoint = null,
  now,
  cryptoProvider,
  report,
  onProgress
}) {
  const input = await readableViewInput(format, manifests, cryptoProvider);
  if (await readableViewsAreCurrent(root, input, cryptoProvider)) {
    return { input, checkpoint, written: false };
  }
  const exact = checkpoint ?? await library.createExactCheckpoint();
  const readable = buildReadableLibrary(exact, {
    vaultId: format.vaultId,
    inputHash: input.contentHash,
    generatedAt: now
  });
  const index = buildReadableIndex(readable);

  // Both derived files settle before the small receipt advertises this input.
  // A stopped or failed write leaves the older receipt behind, so the next
  // sync regenerates the pair. Neither file is ever read as sync authority.
  await writeJson(root, READABLE_LIBRARY_FILE, readable);
  await writeText(root, READABLE_INDEX_FILE, index);
  const receipt = await seal({
    app: "everytab",
    kind: "vault-v2-readable-views",
    formatVersion: VAULT_FORMAT_VERSION,
    vaultId: format.vaultId,
    inputHash: input.contentHash,
    libraryContentHash: exact.contentHash,
    generatedAt: now
  }, cryptoProvider);
  await writeJson(root, READABLE_VIEWS_RECEIPT_FILE, receipt);
  report.viewsWritten = true;
  onProgress({ stage: "views", target: "library" });
  return { input, checkpoint: exact, written: true };
}

async function readBootstrapCheckpoint({
  root, format, manifest, assetsDirectory, cryptoProvider, report, onProgress
}) {
  if (manifest.deviceId !== format.initializer.deviceId ||
      manifest.sourceId !== format.initializer.sourceId ||
      manifest.baseSequence !== format.bootstrap.throughSequence) {
    throw new Error("Vault bootstrap manifest does not match its initializer");
  }
  const checkpoints = await root.getDirectoryHandle(CHECKPOINTS_DIR);
  const directory = await checkpoints.getDirectoryHandle(format.bootstrap.checkpointId);
  const envelope = await verifySeal(
    parseJson(
      await readNamedFile(directory, "library.json", { kind: "checkpoint" }),
      "Vault bootstrap checkpoint"
    ),
    "Vault bootstrap checkpoint",
    cryptoProvider
  );
  if (envelope.app !== "everytab" || envelope.kind !== "vault-v2-checkpoint" ||
      envelope.formatVersion !== VAULT_FORMAT_VERSION || envelope.vaultId !== format.vaultId ||
      envelope.checkpointId !== format.bootstrap.checkpointId ||
      envelope.sourceDeviceId !== manifest.deviceId ||
      envelope.sourceId !== manifest.sourceId ||
      envelope.throughSequence !== manifest.baseSequence ||
      envelope.contentHash !== format.bootstrap.contentHash ||
      !Number.isSafeInteger(envelope.libraryCreatedAt) || envelope.libraryCreatedAt < 0 ||
      !DIGEST.test(envelope.libraryContentHash ?? "") ||
      !Array.isArray(envelope.entities) || !Array.isArray(envelope.assetManifest)) {
    throw new Error("Vault bootstrap checkpoint does not match its format");
  }
  const assets = await hydrateAssetManifest(
    assetsDirectory, envelope.assetManifest, report, onProgress
  );
  return {
    app: "everytab",
    kind: "library-checkpoint",
    formatVersion: 1,
    createdAt: envelope.libraryCreatedAt,
    entities: envelope.entities,
    assets,
    contentHash: envelope.libraryContentHash
  };
}

async function readDeviceBaseCheckpoint({
  deviceDirectory, format, manifest, assetsDirectory, cryptoProvider, report, onProgress
}) {
  const descriptor = verifyBaseDescriptor(manifest.baseCheckpoint, manifest);
  const bases = await deviceDirectory.getDirectoryHandle(BASES_DIR);
  const envelope = await verifySeal(
    parseJson(
      await readNamedFile(bases, descriptor.name, { kind: "checkpoint" }), descriptor.name
    ),
    `Replication base for ${manifest.deviceId}`,
    cryptoProvider
  );
  if (envelope.app !== "everytab" || envelope.kind !== "vault-v2-replication-base" ||
      envelope.formatVersion !== VAULT_FORMAT_VERSION || envelope.vaultId !== format.vaultId ||
      envelope.deviceId !== manifest.deviceId || envelope.sourceId !== manifest.sourceId ||
      envelope.throughSequence !== manifest.baseSequence ||
      envelope.contentHash !== descriptor.contentHash ||
      envelope.libraryContentHash !== descriptor.libraryContentHash ||
      !Number.isSafeInteger(envelope.libraryCreatedAt) || envelope.libraryCreatedAt < 0 ||
      !Array.isArray(envelope.entities) || !Array.isArray(envelope.assetManifest)) {
    throw new Error(`Replication base for ${manifest.deviceId} does not match its manifest`);
  }
  const assets = await hydrateAssetManifest(
    assetsDirectory, envelope.assetManifest, report, onProgress
  );
  return {
    app: "everytab",
    kind: "library-checkpoint",
    formatVersion: 1,
    createdAt: envelope.libraryCreatedAt,
    entities: envelope.entities,
    assets,
    contentHash: envelope.libraryContentHash
  };
}

async function applyBootstrapCheckpoint({
  root, library, format, manifest, deviceDirectory, assetsDirectory,
  cryptoProvider, report, onProgress, commitRemoteApply
}) {
  if (typeof library.applyRemoteCheckpoint !== "function") {
    throw new Error("The Storage Library cannot import a Vault checkpoint");
  }
  const checkpoint = await readRemoteVaultState((reportProgress) => manifest.baseCheckpoint
    ? readDeviceBaseCheckpoint({
        deviceDirectory, format, manifest, assetsDirectory,
        cryptoProvider, report, onProgress: reportProgress
      })
    : readBootstrapCheckpoint({
        root, format, manifest, assetsDirectory, cryptoProvider, report, onProgress: reportProgress
      }), onProgress);
  const applied = await commitRemoteApply(() => library.applyRemoteCheckpoint({
    deviceId: manifest.deviceId,
    sourceId: manifest.sourceId,
    throughSequence: manifest.baseSequence,
    checkpoint
  }));
  for (const family of applied.changedFamilies ?? []) report.changedFamilies.add(family);
  report.pulled += applied.applied;
  report.checkpointRead = true;
  onProgress({
    stage: "checkpoint",
    target: "library",
    completed: applied.sequence,
    total: manifest.throughSequence
  });
  return applied.sequence;
}

async function resumeOrRejectInitialization(format, replication) {
  if (format.initializer.deviceId !== replication.deviceId ||
      format.initializer.sourceId !== replication.sourceId) {
    throw new Error("This Vault has an incomplete initialization from another Library");
  }
  throw new Error("This Vault initialization did not finish. Choose a new empty folder");
}

async function publishLocal({
  library, format, manifest, deviceDirectory, assetWriter,
  replication, now, cryptoProvider, report, onProgress
}) {
  if (manifest.sourceId !== replication.sourceId) {
    throw new Error("This Vault belongs to an earlier local Library copy. Choose a new empty folder");
  }
  if (manifest.throughSequence > replication.sequence) {
    throw new Error("The Vault manifest is ahead of this local Library");
  }
  await library.acknowledgeSync(manifest.throughSequence);
  const transactions = await deviceDirectory.getDirectoryHandle(TRANSACTIONS_DIR);
  let current = manifest;
  while (true) {
    const batch = await library.readSyncBatch({
      afterSequence: current.throughSequence,
      throughSequence: replication.sequence
    });
    // Only an explicit trim watermark permits replacing an established head.
    // New peers can also have acknowledged early history in another Vault.
    const historyTrimmed = (batch.compactedThroughSequence ?? 0) > current.throughSequence;
    const joiningWithoutHistory = current.throughSequence === 0 && replication.sequence > 0 &&
      (batch.changes.length === 0 || batch.fromSequence !== 1);
    if (historyTrimmed || joiningWithoutHistory) {
      const published = await publishLocalBase({
        library, format, manifest: current, deviceDirectory, assetWriter,
        throughSequence: replication.sequence,
        now, cryptoProvider, report, onProgress
      });
      if (!published.checkpoint) {
        throw new Error("Saved data changed while preparing the Vault checkpoint. Try sync again");
      }
      await library.acknowledgeSync(published.manifest.throughSequence);
      report.pushed += published.checkpoint.entities.length;
      return published.manifest;
    }
    if (batch.changes.length === 0 && current.throughSequence === replication.sequence) break;
    if (batch.fromSequence !== current.throughSequence + 1 ||
        batch.changes.some((change, index) => change.sequence !== current.throughSequence + index + 1)) {
      throw new Error("The local Library outbox does not continue its Vault manifest");
    }
    await assetWriter.write(batch.assets, report, onProgress);
    const chunk = await seal({
      app: "everytab",
      kind: "vault-v2-transaction",
      formatVersion: VAULT_FORMAT_VERSION,
      vaultId: format.vaultId,
      deviceId: replication.deviceId,
      sourceId: replication.sourceId,
      fromSequence: batch.fromSequence,
      throughSequence: batch.throughSequence,
      changes: batch.changes,
      assetManifest: batch.assets.map(({ dataUrl: _dataUrl, ...asset }) => asset)
    }, cryptoProvider);
    const name = chunkFileName(batch.fromSequence, batch.throughSequence, chunk.contentHash);
    const text = `${JSON.stringify(chunk, null, 2)}\n`;
    await writeImmutable(transactions, name, text);
    const nextBody = {
      ...current,
      throughSequence: batch.throughSequence,
      chunks: [...current.chunks, {
        name,
        fromSequence: batch.fromSequence,
        throughSequence: batch.throughSequence,
        contentHash: chunk.contentHash
      }],
      updatedAt: now
    };
    delete nextBody.contentHash;
    current = await seal(nextBody, cryptoProvider);
    await writeJson(deviceDirectory, MANIFEST_FILE, current);
    await library.acknowledgeSync(batch.throughSequence);
    report.pushed += batch.changes.length;
    report.chunksWritten += 1;
    onProgress({
      stage: "publishing",
      target: "library",
      completed: batch.throughSequence,
      total: replication.sequence
    });
  }
  return current;
}

async function rollLocalManifest(options) {
  if (options.manifest.chunks.length <= MAX_MANIFEST_CHUNKS) {
    return { manifest: options.manifest, checkpoint: null };
  }
  return publishLocalBase(options);
}

async function publishLocalBase({
  library,
  format,
  manifest,
  throughSequence = manifest.throughSequence,
  deviceDirectory,
  assetWriter,
  now,
  cryptoProvider,
  report,
  onProgress
}) {
  const checkpoint = await library.createExactCheckpoint();
  const currentReplication = await library.readReplicationState();
  if (currentReplication.deviceId !== manifest.deviceId ||
      currentReplication.sourceId !== manifest.sourceId) {
    throw new Error("The local Library identity changed during Vault sync");
  }
  // The Vault lock does not block local edits. Publish only if this checkpoint
  // covers the requested head; otherwise leave the manifest for a later retry.
  if (currentReplication.sequence !== throughSequence) {
    return { manifest, checkpoint: null };
  }

  await assetWriter.write(checkpoint.assets, report, onProgress);
  const bases = await deviceDirectory.getDirectoryHandle(BASES_DIR, { create: true });
  const currentName = manifest.baseCheckpoint?.name ?? null;
  const name = currentName === BASE_FILES[0] ? BASE_FILES[1] : BASE_FILES[0];
  const envelope = await seal({
    app: "everytab",
    kind: "vault-v2-replication-base",
    formatVersion: VAULT_FORMAT_VERSION,
    vaultId: format.vaultId,
    deviceId: manifest.deviceId,
    sourceId: manifest.sourceId,
    throughSequence,
    libraryCreatedAt: checkpoint.createdAt,
    libraryContentHash: checkpoint.contentHash,
    entities: checkpoint.entities,
    assetManifest: checkpoint.assets.map(({ dataUrl: _dataUrl, ...asset }) => asset)
  }, cryptoProvider);

  // The inactive base slot settles first. Only the following manifest write
  // makes it authoritative, so interruption always leaves one valid base.
  await writeJson(bases, name, envelope);
  const settledBase = await verifySeal(
    parseJson(await readNamedFile(bases, name), name),
    `Replication base for ${manifest.deviceId}`,
    cryptoProvider
  );
  if (settledBase.contentHash !== envelope.contentHash) {
    throw new Error(`Replication base for ${manifest.deviceId} did not settle exactly`);
  }
  const nextBody = {
    ...manifest,
    baseSequence: throughSequence,
    throughSequence,
    baseCheckpoint: {
      name,
      throughSequence,
      contentHash: envelope.contentHash,
      libraryContentHash: checkpoint.contentHash
    },
    chunks: [],
    updatedAt: now
  };
  delete nextBody.contentHash;
  const next = await seal(nextBody, cryptoProvider);
  await writeJson(deviceDirectory, MANIFEST_FILE, next);
  report.checkpointWritten = true;
  report.libraryCompacted = manifest.chunks.length > 0;
  onProgress({
    stage: "checkpoint",
    target: "library",
    completed: throughSequence,
    total: throughSequence
  });
  return { manifest: next, checkpoint };
}

async function pullRemote({
  root, library, format, manifest, deviceDirectory, assetsDirectory,
  cursor, hasCursor, cryptoProvider, report, onProgress, commitRemoteApply
}) {
  if (needsRemoteCheckpoint(format, manifest, cursor, hasCursor)) {
    cursor = await applyBootstrapCheckpoint({
      root, library, format, manifest, deviceDirectory, assetsDirectory,
      cryptoProvider, report, onProgress, commitRemoteApply
    });
  }
  const transactions = await readRemoteVaultState(() =>
    deviceDirectory.getDirectoryHandle(TRANSACTIONS_DIR));
  for (const descriptor of manifest.chunks) {
    if (descriptor.throughSequence <= cursor) continue;
    if (descriptor.fromSequence !== cursor + 1) {
      throw new Error(`Remote transaction cursor for ${manifest.deviceId} has a gap`);
    }
    const { chunk, assets } = await readRemoteVaultState(async (reportProgress) => {
      const text = await readNamedFile(transactions, descriptor.name, { kind: "transaction" });
      const chunk = await verifyChunk(
        parseJson(text, descriptor.name), descriptor, manifest, cryptoProvider
      );
      const assets = await hydrateAssetManifest(
        assetsDirectory, chunk.assetManifest, report, reportProgress
      );
      return { chunk, assets };
    }, onProgress);
    const applied = await commitRemoteApply(() => library.applyRemoteBatch({
      deviceId: chunk.deviceId,
      sourceId: chunk.sourceId,
      changes: chunk.changes,
      assets
    }));
    for (const family of applied.changedFamilies ?? []) report.changedFamilies.add(family);
    cursor = applied.sequence;
    report.pulled += applied.applied;
    report.chunksRead += 1;
    onProgress({
      stage: "pulling",
      target: manifest.deviceId,
      completed: cursor,
      total: manifest.throughSequence
    });
  }
}

/**
 * Synchronize one Library with a selected Vault folder. A skipped
 * result means another EveryTab page owns the one sync lock; no work occurred.
 * @param {FileSystemDirectoryHandle} root
 * @param {VaultSyncOptions} options
 */
export async function syncVault(root, {
  library,
  recovery,
  now = Date.now(),
  cryptoProvider = globalThis.crypto,
  createId = () => cryptoProvider.randomUUID(),
  onProgress = () => {},
  commitRemoteApply = (apply) => apply()
} = {}) {
  if (!hasMethods(root, ["entries", "getDirectoryHandle", "getFileHandle"])) {
    throw new Error("A writable folder is required");
  }
  if (!hasMethods(library, ["readReplicationState", "readSyncBatch", "acknowledgeSync",
    "applyRemoteBatch", "createExactCheckpoint", "readLocal", "commit"])) {
    throw new Error("A Storage Library is required");
  }
  if (!hasMethods(recovery, ["readReplicationState", "exportRecoveryPack"])) {
    throw new Error("A Recovery store is required");
  }
  if (typeof createId !== "function" || typeof onProgress !== "function" ||
      typeof commitRemoteApply !== "function") {
    throw new Error("Vault sync callbacks are invalid");
  }
  if (typeof navigator.locks?.request !== "function") {
    throw new Error("Chrome Web Locks are required for Vault sync");
  }
  return navigator.locks.request(VAULT_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      return {
        pulled: 0, pushed: 0, chunksRead: 0, chunksWritten: 0,
        assetsRead: 0, assetsWritten: 0, checkpointWritten: false,
        checkpointRead: false, recoveryPackWritten: false,
        recoverySnapshotsWritten: 0, recoveryPacksPruned: 0,
        recoveryCompacted: false, libraryCompacted: false,
        viewsWritten: false, backedUp: false,
        backupsPruned: 0, checkpointsPruned: 0, chunksPruned: 0, skipped: true
      };
    }
    const report = {
      pulled: 0,
      pushed: 0,
      chunksRead: 0,
      chunksWritten: 0,
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
      chunksPruned: 0,
      conflictCopies: 0,
      // Skipped non-authoritative files as allowlisted {code, kind, count}
      // entries. Never a file name or content; see failure-codes.js.
      quarantined: [],
      // Kept as a Set while pulling so repeated chunks remain O(1). Converted
      // to a small JSON-safe array before the public sync receipt is returned.
      changedFamilies: new Set()
    };
    // An earlier pull may have committed its cursor before its local index or
    // notification failed. Flush that durable repair even on a no-change sync.
    // The existing callback owns the Store lock while this scope owns Vault.
    await commitRemoteApply(async () => ({ changedFamilies: [] }));
    const replication = await library.readReplicationState();
    requiredName(replication.deviceId, "Local device identity");
    requiredName(replication.sourceId, "Local replication source");
    requiredCount(replication.sequence, "Local Library sequence");
    onProgress({ stage: "connecting", target: "format" });

    const inspection = await inspectVaultRoot(root, { cryptoProvider, onProgress });
    if (["unrecognized", "invalid", "placeholder"].includes(inspection.state)) {
      throw inspectionError(inspection);
    }
    if (inspection.state === "initializing") {
      await resumeOrRejectInitialization(inspection.format, replication);
    }
    let format;
    let devices;
    let assetsDirectory;
    let assetWriter;
    let localManifest;
    let bootstrapCheckpoint = null;
    let bootstrapDescriptor = null;
    if (inspection.state === "empty") {
      ({
        format, devices, assetsDirectory, assetWriter, localManifest,
        bootstrapCheckpoint, bootstrapDescriptor
      } =
        await initializeVault({
        root, library, replication, now, cryptoProvider, createId, report, onProgress
      }));
    } else {
      format = inspection.format;
      devices = await root.getDirectoryHandle(DEVICES_DIR);
      onProgress({ stage: "connecting", target: "library" });
      assetsDirectory = await root.getDirectoryHandle(ASSETS_DIR);
      onProgress({ stage: "connecting", target: "assets" });
      assetWriter = createAssetWriter(assetsDirectory);
    }

    const knownManifests = [];
    const deviceEntries = await deviceDirectories(devices, onProgress);
    let manifestsRead = 0;
    for (const { name, handle } of deviceEntries) {
      manifestsRead++;
      // Only device identities are valid names here. A sync service's conflict
      // copy or renamed duplicate is counted and left in place, never read.
      if (!isSafeName(name)) {
        recordQuarantine(report, VAULT_FAILURE_CODES.conflictCopy, "directory");
        continue;
      }
      const manifest = name === replication.deviceId
        ? await readDeviceManifest(
          handle, { vaultId: format.vaultId, deviceId: name, optional: true }, cryptoProvider
        )
        : await readForeignManifest(
          handle, { vaultId: format.vaultId, deviceId: name }, cryptoProvider, report
        );
      if (manifest) knownManifests.push({ manifest, directory: handle });
      onProgress({ stage: "reading", target: "library", completed: manifestsRead, total: deviceEntries.length });
    }
    const cursors = new Map(replication.replicas.map((replica) => [replica.deviceId, replica]));
    const requiresCheckpointImport = knownManifests.some(({ manifest }) => {
      if (manifest.deviceId === replication.deviceId) return false;
      const cursor = cursors.get(manifest.deviceId);
      return needsRemoteCheckpoint(
        format, manifest, cursor?.sequence ?? 0, Boolean(cursor)
      );
    });
    if (requiresCheckpointImport && typeof library.applyRemoteCheckpoint !== "function") {
      throw new Error("The Storage Library cannot import a Vault checkpoint");
    }
    const localEntry = knownManifests.find(({ manifest }) =>
      manifest.deviceId === replication.deviceId);
    if (localEntry) {
      localManifest = localEntry.manifest;
    } else if (!localManifest) {
      const directory = await devices.getDirectoryHandle(replication.deviceId, { create: true });
      await directory.getDirectoryHandle(TRANSACTIONS_DIR, { create: true });
      localManifest = await createManifest({
        vaultId: format.vaultId,
        deviceId: replication.deviceId,
        sourceId: replication.sourceId,
        baseSequence: 0,
        now
      }, cryptoProvider);
      await writeJson(directory, MANIFEST_FILE, localManifest);
      knownManifests.push({ manifest: localManifest, directory });
    }

    const localDirectory = knownManifests.find(({ manifest }) =>
      manifest.deviceId === replication.deviceId)?.directory ??
      await devices.getDirectoryHandle(replication.deviceId);
    localManifest = await publishLocal({
      library, format, manifest: localManifest, deviceDirectory: localDirectory,
      assetWriter, replication, now, cryptoProvider, report, onProgress
    });

    const recoveryManifest = await publishRecovery({
      root,
      recovery,
      format,
      replication,
      now,
      cryptoProvider,
      report,
      onProgress,
      assetWriter
    });

    for (const entry of knownManifests) {
      const { manifest, directory } = entry;
      if (manifest.deviceId === replication.deviceId) continue;
      const localCursor = cursors.get(manifest.deviceId);
      if (localCursor?.sourceId && localCursor.sourceId !== manifest.sourceId) {
        throw new Error(`Replication source for ${manifest.deviceId} changed`);
      }
      entry.manifest = await pullWithFreshManifest({
        manifest,
        readManifest: () => readDeviceManifest(directory, {
          vaultId: format.vaultId, deviceId: manifest.deviceId
        }, cryptoProvider),
        pull: async (current, attempt) => {
          const cursor = attempt === 0 ? localCursor :
            (await library.readReplicationState()).replicas
              .find(({ deviceId }) => deviceId === current.deviceId);
          if (cursor?.sourceId && cursor.sourceId !== current.sourceId) {
            throw new Error(`Replication source for ${current.deviceId} changed`);
          }
          await pullRemote({
            root, library, format, manifest: current, deviceDirectory: directory,
            assetsDirectory, cursor: cursor?.sequence ?? 0, hasCursor: Boolean(cursor),
            cryptoProvider, report, onProgress, commitRemoteApply
          });
        }
      });
    }
    const rolled = await rollLocalManifest({
      library,
      format,
      manifest: localManifest,
      deviceDirectory: localDirectory,
      assetWriter,
      now,
      cryptoProvider,
      report,
      onProgress
    });
    localManifest = rolled.manifest;
    const finalManifests = knownManifests.map(({ manifest }) =>
      manifest.deviceId === replication.deviceId ? localManifest : manifest
    );
    const readable = await publishReadableViews({
      root,
      library,
      format,
      manifests: finalManifests,
      checkpoint: bootstrapCheckpoint ?? rolled.checkpoint,
      now,
      cryptoProvider,
      report,
      onProgress
    });
    if (bootstrapDescriptor) bootstrapDescriptor.inputHash = readable.input.contentHash;
    const finalReplication = await library.readReplicationState();
    await publishCheckpointBackup({
      root,
      library,
      assetsDirectory,
      format,
      replication: finalReplication,
      input: readable.input,
      exact: readable.checkpoint,
      bootstrapDescriptor,
      now,
      cryptoProvider,
      createId,
      report,
      onProgress,
      assetWriter
    });
    await retireVaultTransactions({
      library, manifest: localManifest, deviceDirectory: localDirectory,
      now, cryptoProvider, report, onProgress,
      readManifest: () => readDeviceManifest(localDirectory, {
        vaultId: format.vaultId, deviceId: replication.deviceId
      }, cryptoProvider),
      readCheckpoint: () => readDeviceBaseCheckpoint({
        deviceDirectory: localDirectory, format, manifest: localManifest,
        assetsDirectory, cryptoProvider, report, onProgress
      })
    });
    // Receipt the exact heads actually published by this completed sync.
    // A chrome.storage revision pulse is only a UI notification and can be
    // published after the underlying commit was already synced. These durable
    // sequences let health checks distinguish that harmless ordering from real
    // Library or Recovery work created after the sync. Deliberately use the
    // two verified Vault manifests, not a fresh local read: a concurrent local
    // commit after publication must remain visibly pending.
    report.syncedState = {
      librarySequence: localManifest.throughSequence,
      recoverySequence: recoveryManifest.sequence
    };
    // The Vault identity lets the folder picker tell "same Vault again" from
    // "a different populated Vault" before it merges two libraries.
    report.vaultId = format.vaultId;
    report.changedFamilies = [...report.changedFamilies].sort();
    onProgress({ stage: "complete", target: "" });
    return report;
  }).catch((error) => {
    // Saved-data guards deep in the Library name newer data with fixed text.
    // Carry that as the allowlisted update-required code; other errors pass.
    throw classifyVaultProtocolError(error);
  });
}
