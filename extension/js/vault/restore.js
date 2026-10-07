// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Verified daily Restore points for a Vault. */
import {
  DIGEST,
  VAULT_FORMAT_VERSION,
  classifyForeignEntry,
  entries,
  hydrateAssetManifest,
  optionalFileHandle,
  parseJson,
  readNamedFile,
  requiredName,
  verifySeal
} from "./protocol-io.js";
import { VAULT_FAILURE_CODES, recordQuarantine } from "./failure-codes.js";
import { inspectVaultRoot } from "./protocol-sync.js";
import { commitLibraryChange } from "../lib/store.js";

const BACKUPS_DIR = "backups";
const CHECKPOINTS_DIR = "checkpoints";
const ASSETS_DIR = "assets";
const CHECKPOINT_FILE = "library.json";
const VAULT_LOCK = "everytab-vault-sync";
const BACKUP_NAME = /^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;

function requiredTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function verifyDescriptor(value, vaultId, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.vaultId !== vaultId || !DIGEST.test(value.contentHash ?? "") ||
      !DIGEST.test(value.libraryContentHash ?? "") ||
      !DIGEST.test(value.inputHash ?? "")) {
    throw new Error(`${label} is invalid`);
  }
  requiredName(value.checkpointId, `${label} identity`);
  requiredName(value.sourceDeviceId, `${label} device`);
  requiredTimestamp(value.createdAt, `${label} time`);
  return value;
}

async function readyFormat(root, cryptoProvider) {
  const inspection = await inspectVaultRoot(root, { cryptoProvider });
  if (inspection.state !== "ready") {
    throw new Error(inspection.message ?? "The Vault is not ready");
  }
  return inspection.format;
}

async function readBackup(backups, name, format, cryptoProvider) {
  const match = BACKUP_NAME.exec(name);
  if (!match) throw new Error("The selected Vault Restore point is invalid");
  const backup = await verifySeal(
    parseJson(await readNamedFile(backups, name), name),
    `Daily backup ${name}`,
    cryptoProvider
  );
  if (backup.app !== "everytab" || backup.kind !== "vault-v2-daily-backup" ||
      backup.formatVersion !== VAULT_FORMAT_VERSION || backup.vaultId !== format.vaultId ||
      backup.name !== name || backup.day !== match[1] ||
      backup.checkpoint?.checkpointId !== match[2]) {
    throw new Error(`Daily backup ${name} is invalid`);
  }
  requiredTimestamp(backup.createdAt, "Daily backup time");
  verifyDescriptor(backup.checkpoint, format.vaultId, "Daily backup checkpoint");
  return backup;
}

async function readCheckpoint(root, format, backup, {
  library,
  cryptoProvider,
  onProgress = () => {}
}) {
  const checkpoints = await root.getDirectoryHandle(CHECKPOINTS_DIR);
  const directory = await checkpoints.getDirectoryHandle(backup.checkpoint.checkpointId);
  const envelope = await verifySeal(
    parseJson(
      await readNamedFile(directory, CHECKPOINT_FILE, { kind: "checkpoint" }),
      `${backup.checkpoint.checkpointId}/${CHECKPOINT_FILE}`
    ),
    `Vault checkpoint ${backup.checkpoint.checkpointId}`,
    cryptoProvider
  );
  if (envelope.app !== "everytab" || envelope.kind !== "vault-v2-checkpoint" ||
      envelope.formatVersion !== VAULT_FORMAT_VERSION || envelope.vaultId !== format.vaultId ||
      envelope.checkpointId !== backup.checkpoint.checkpointId ||
      envelope.sourceDeviceId !== backup.checkpoint.sourceDeviceId ||
      envelope.contentHash !== backup.checkpoint.contentHash ||
      envelope.libraryContentHash !== backup.checkpoint.libraryContentHash ||
      !Number.isSafeInteger(envelope.libraryCreatedAt) || envelope.libraryCreatedAt < 0 ||
      !Array.isArray(envelope.entities) || !Array.isArray(envelope.assetManifest)) {
    throw new Error("The Vault checkpoint does not match its daily Restore point");
  }
  if (envelope.inputHash !== undefined &&
      envelope.inputHash !== backup.checkpoint.inputHash) {
    throw new Error("The Vault checkpoint input does not match its daily Restore point");
  }
  const digests = envelope.assetManifest.map(({ digest }) => digest);
  const cachedAssets = library?.readRestoreAssets
    ? await library.readRestoreAssets(digests)
    : [];
  const cachedDigests = new Set(cachedAssets.map(({ digest }) => digest));
  const needsVaultAssets = digests.some((digest) => !cachedDigests.has(digest));
  const assetsDirectory = needsVaultAssets
    ? await root.getDirectoryHandle(ASSETS_DIR)
    : null;
  const report = { assetsRead: 0 };
  const assets = await hydrateAssetManifest(
    assetsDirectory,
    envelope.assetManifest,
    report,
    onProgress,
    { cachedAssets }
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

async function checkpointFileExists(checkpointDirectory, checkpointId) {
  try {
    const directory = await checkpointDirectory.getDirectoryHandle(checkpointId);
    return Boolean(await optionalFileHandle(directory, CHECKPOINT_FILE));
  } catch (error) {
    if (error?.name === "NotFoundError" || /not found/i.test(String(error?.message ?? ""))) {
      return false;
    }
    throw error;
  }
}

/**
 * List the sealed daily references without loading checkpoint bodies or
 * favicons. A damaged reference, or one whose checkpoint has not arrived or
 * was lost, is counted under an allowlisted code and skipped so the remaining
 * points stay usable. Selecting a point still verifies everything it names.
 * @returns {Promise<{points:Array<object>, skipped:Array<{code:string,kind:string,count:number}>}>}
 */
export async function listVaultRestorePointsWithReport(root, {
  cryptoProvider = globalThis.crypto
} = {}) {
  const format = await readyFormat(root, cryptoProvider);
  const backups = await root.getDirectoryHandle(BACKUPS_DIR);
  const checkpointDirectory = await root.getDirectoryHandle(CHECKPOINTS_DIR);
  const report = { quarantined: [] };
  const points = [];
  for (const { name, handle } of await entries(backups)) {
    if (handle.kind !== "file") continue;
    if (!BACKUP_NAME.test(name)) {
      const foreign = classifyForeignEntry(name);
      if (foreign === "placeholder") {
        recordQuarantine(report, VAULT_FAILURE_CODES.placeholderFile, "backup");
      } else if (foreign === "conflict-copy") {
        recordQuarantine(report, VAULT_FAILURE_CODES.conflictCopy, "backup");
      }
      continue;
    }
    let backup;
    try {
      backup = await readBackup(backups, name, format, cryptoProvider);
    } catch {
      recordQuarantine(report, VAULT_FAILURE_CODES.damagedBackup, "backup");
      continue;
    }
    if (!await checkpointFileExists(checkpointDirectory, backup.checkpoint.checkpointId)) {
      recordQuarantine(report, VAULT_FAILURE_CODES.damagedBackup, "checkpoint");
      continue;
    }
    points.push({
      name: backup.name,
      day: backup.day,
      createdAt: backup.createdAt,
      checkpointId: backup.checkpoint.checkpointId,
      checkpointContentHash: backup.checkpoint.contentHash
    });
  }
  points.sort((left, right) =>
    right.day.localeCompare(left.day) || right.createdAt - left.createdAt ||
    right.name.localeCompare(left.name));
  return { points, skipped: report.quarantined };
}

/** The usable Restore points only; see listVaultRestorePointsWithReport. */
export async function listVaultRestorePoints(root, options = {}) {
  return (await listVaultRestorePointsWithReport(root, options)).points;
}

export async function previewVaultRestorePoint(root, {
  library,
  name,
  cryptoProvider = globalThis.crypto,
  onProgress = () => {}
} = {}) {
  if (!library?.previewExactRestore) throw new Error("A Storage Library is required");
  onProgress({ stage: "opening", target: "restorePoint" });
  const format = await readyFormat(root, cryptoProvider);
  const backups = await root.getDirectoryHandle(BACKUPS_DIR);
  const backup = await readBackup(backups, name, format, cryptoProvider);
  const checkpoint = await readCheckpoint(root, format, backup, {
    library, cryptoProvider, onProgress
  });
  const summary = await library.previewExactRestore(checkpoint, { onProgress });
  return {
    point: {
      name: backup.name,
      day: backup.day,
      createdAt: backup.createdAt,
      checkpointId: backup.checkpoint.checkpointId,
      checkpointContentHash: backup.checkpoint.contentHash
    },
    summary
  };
}

async function withVaultLock(work) {
  if (!navigator.locks?.request) throw new Error("Chrome Web Locks are required for Vault Restore");
  return navigator.locks.request(VAULT_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("Vault sync is already running. Try Restore again when it finishes");
    return work();
  });
}

export async function restoreVaultRestorePoint(root, {
  library,
  authority,
  preview,
  cryptoProvider = globalThis.crypto,
  createId = () => cryptoProvider.randomUUID(),
  onProgress = () => {}
} = {}) {
  if (!library?.replaceFromCheckpoint) throw new Error("A Storage Library is required");
  if (!preview?.point?.name || !preview?.summary) throw new Error("Review a Restore point first");
  return withVaultLock(async () => {
    const format = await readyFormat(root, cryptoProvider);
    const backups = await root.getDirectoryHandle(BACKUPS_DIR);
    const backup = await readBackup(backups, preview.point.name, format, cryptoProvider);
    if (backup.checkpoint.contentHash !== preview.point.checkpointContentHash) {
      throw new Error("The selected Vault Restore point changed after review");
    }
    const checkpoint = await readCheckpoint(root, format, backup, {
      library,
      cryptoProvider,
      onProgress
    });
    // File verification is complete before taking the Store lock. The final
    // stale check, replacement, derived read models, durable revision, and
    // cross-context pulse are one ordered local authority boundary.
    return commitLibraryChange(() => library.replaceFromCheckpoint(checkpoint, {
      expectedSequence: preview.summary.currentSequence,
      expectedRestoreEpoch: preview.summary.restoreEpoch,
      expectedStateHash: preview.summary.currentStateHash,
      restoreId: createId(),
      source: { name: backup.name, day: backup.day, createdAt: backup.createdAt }
    }), { authority });
  });
}

export async function undoVaultRestore({ library, authority, restoreId } = {}) {
  if (!library?.undoExactRestore) throw new Error("A Storage Library is required");
  return withVaultLock(() => commitLibraryChange(
    () => library.undoExactRestore(restoreId), { authority }
  ));
}

export async function confirmVaultRestore({ library, restoreId } = {}) {
  if (!library?.confirmExactRestore) throw new Error("A Storage Library is required");
  return withVaultLock(() => library.confirmExactRestore(restoreId));
}
