// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Periodic Library checkpoints and bounded daily Vault restore points. */
import {
  DIGEST,
  VAULT_FORMAT_VERSION,
  classifyForeignEntry,
  entries,
  optionalFileHandle,
  parseJson,
  readNamedFile,
  requiredName,
  seal,
  verifySeal,
  createAssetWriter,
  writeImmutable,
  writeJson
} from "./protocol-io.js";
import { VAULT_FAILURE_CODES, recordQuarantine } from "./failure-codes.js";

const CHECKPOINTS_DIR = "checkpoints";
const BACKUPS_DIR = "backups";
const CHECKPOINT_FILE = "library.json";
const MAINTENANCE_FILE = "maintenance.json";
const RETAINED_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;
/**
 * A checkpoint written by another device may reach this folder before the
 * daily backup that references it. Cloud clients upload the two files
 * independently, and a closed laptop can hold the second upload for days.
 * Routine pruning therefore never removes a foreign checkpoint until it is
 * older than the retention window plus this margin; a backup that referenced
 * it would already be outside the retained days.
 */
export const FOREIGN_CHECKPOINT_GRACE_DAYS = 2;
export const FOREIGN_CHECKPOINT_MIN_AGE_MS = (RETAINED_DAYS + FOREIGN_CHECKPOINT_GRACE_DAYS) * DAY;
const BACKUP_NAME = /^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;

function utcDay(now) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("Vault maintenance time is invalid");
  return date.toISOString().slice(0, 10);
}

function checkpointDescriptor(value, vaultId, label = "Vault checkpoint") {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.vaultId !== vaultId || !DIGEST.test(value.contentHash ?? "") ||
      !DIGEST.test(value.libraryContentHash ?? "") ||
      !DIGEST.test(value.inputHash ?? "") ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw new Error(`${label} reference is invalid`);
  }
  requiredName(value.checkpointId, `${label} identity`);
  requiredName(value.sourceDeviceId, `${label} device`);
  return value;
}

async function readMaintenance(root, format, cryptoProvider) {
  const text = await readNamedFile(root, MAINTENANCE_FILE, { optional: true });
  if (text === null) return null;
  try {
    const receipt = await verifySeal(
      parseJson(text, MAINTENANCE_FILE), "Vault maintenance receipt", cryptoProvider
    );
    if (receipt.app !== "everytab" || receipt.kind !== "vault-v2-maintenance" ||
        receipt.formatVersion !== VAULT_FORMAT_VERSION || receipt.vaultId !== format.vaultId ||
        receipt.retainedDays !== RETAINED_DAYS ||
        typeof receipt.latestBackup?.day !== "string" ||
        typeof receipt.latestBackup?.name !== "string" ||
        !DIGEST.test(receipt.latestBackup?.contentHash ?? "")) {
      return null;
    }
    checkpointDescriptor(receipt.checkpoint, format.vaultId);
    return receipt;
  } catch {
    return null;
  }
}

function backupName(day, checkpointId) {
  return `${day}-${checkpointId}.json`;
}

async function verifyBackup(value, { name, vaultId }, cryptoProvider) {
  await verifySeal(value, `Daily backup ${name}`, cryptoProvider);
  const match = BACKUP_NAME.exec(name);
  if (!match || value.app !== "everytab" || value.kind !== "vault-v2-daily-backup" ||
      value.formatVersion !== VAULT_FORMAT_VERSION || value.vaultId !== vaultId ||
      value.day !== match[1] || value.checkpoint?.checkpointId !== match[2] ||
      value.name !== name || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw new Error(`Daily backup ${name} is invalid`);
  }
  checkpointDescriptor(value.checkpoint, vaultId, "Daily backup checkpoint");
  return value;
}

/**
 * Daily backup references are not sync authority. One unreadable file is
 * counted in the report and skipped so the remaining references, and the
 * sync itself, stay usable. Nothing here deletes an unrecognized entry.
 */
async function listBackups(directory, format, cryptoProvider, report) {
  const backups = [];
  for (const { name, handle } of await entries(directory)) {
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
    try {
      const value = parseJson(await readNamedFile(directory, name), name);
      backups.push(await verifyBackup(value, { name, vaultId: format.vaultId }, cryptoProvider));
    } catch {
      recordQuarantine(report, VAULT_FAILURE_CODES.damagedBackup, "backup");
    }
  }
  return backups.sort((left, right) =>
    left.day.localeCompare(right.day) || left.createdAt - right.createdAt ||
    left.name.localeCompare(right.name));
}

async function checkpointExists(checkpoints, descriptor) {
  try {
    const directory = await checkpoints.getDirectoryHandle(descriptor.checkpointId);
    return Boolean(await optionalFileHandle(directory, CHECKPOINT_FILE));
  } catch (error) {
    if (/not found/i.test(String(error?.message ?? "")) || error?.name === "NotFoundError") {
      return false;
    }
    throw error;
  }
}

async function writeCheckpoint({
  checkpoints,
  assetsDirectory,
  library,
  exact,
  input,
  format,
  replication,
  now,
  cryptoProvider,
  createId,
  report,
  onProgress,
  assetWriter
}) {
  const checkpoint = exact ?? await library.createExactCheckpoint();
  await (assetWriter ?? createAssetWriter(assetsDirectory))
    .write(checkpoint.assets, report, onProgress);
  const checkpointId = requiredName(createId(), "Vault checkpoint identity");
  const envelope = await seal({
    app: "everytab",
    kind: "vault-v2-checkpoint",
    formatVersion: VAULT_FORMAT_VERSION,
    vaultId: format.vaultId,
    checkpointId,
    createdAt: now,
    sourceDeviceId: replication.deviceId,
    sourceId: replication.sourceId,
    throughSequence: replication.sequence,
    inputHash: input.contentHash,
    deviceHeads: input.deviceHeads,
    libraryCreatedAt: checkpoint.createdAt,
    libraryContentHash: checkpoint.contentHash,
    entities: checkpoint.entities,
    assetManifest: checkpoint.assets.map(({ dataUrl: _dataUrl, ...asset }) => asset)
  }, cryptoProvider);
  const directory = await checkpoints.getDirectoryHandle(checkpointId, { create: true });
  await writeImmutable(directory, CHECKPOINT_FILE, `${JSON.stringify(envelope, null, 2)}\n`);
  report.checkpointWritten = true;
  onProgress({
    stage: "checkpoint", target: "library",
    completed: checkpoint.entities.length, total: checkpoint.entities.length
  });
  return {
    checkpointId,
    vaultId: format.vaultId,
    sourceDeviceId: replication.deviceId,
    inputHash: input.contentHash,
    contentHash: envelope.contentHash,
    libraryContentHash: checkpoint.contentHash,
    createdAt: now
  };
}

async function writeBackupReference({
  backups, day, descriptor, format, now, cryptoProvider, report, onProgress
}) {
  const name = backupName(day, descriptor.checkpointId);
  const backup = await seal({
    app: "everytab",
    kind: "vault-v2-daily-backup",
    formatVersion: VAULT_FORMAT_VERSION,
    vaultId: format.vaultId,
    name,
    day,
    createdAt: now,
    checkpoint: descriptor
  }, cryptoProvider);
  await writeImmutable(backups, name, `${JSON.stringify(backup, null, 2)}\n`);
  report.backedUp = true;
  onProgress({ stage: "backup", target: "backup" });
  return backup;
}

async function pruneBackups({
  backups, checkpoints, format, allBackups, latest, deviceId, now, report, cryptoProvider
}) {
  const keptDays = new Set(
    [...new Set(allBackups.map(({ day }) => day))].sort().reverse().slice(0, RETAINED_DAYS)
  );
  const kept = [];
  for (const backup of allBackups) {
    if (keptDays.has(backup.day)) {
      kept.push(backup);
      continue;
    }
    await backups.removeEntry(backup.name);
    report.backupsPruned += 1;
  }

  const referenced = new Set([
    format.bootstrap.checkpointId,
    latest.checkpoint.checkpointId,
    ...kept.map(({ checkpoint }) => checkpoint.checkpointId)
  ]);
  for (const { name, handle } of await entries(checkpoints)) {
    if (handle.kind !== "directory" || referenced.has(name)) continue;
    const text = await readNamedFile(handle, CHECKPOINT_FILE, { optional: true });
    if (text === null) continue;
    try {
      const envelope = await verifySeal(
        parseJson(text, `${name}/${CHECKPOINT_FILE}`),
        `Vault checkpoint ${name}`,
        cryptoProvider
      );
      if (envelope.app !== "everytab" || envelope.kind !== "vault-v2-checkpoint" ||
          envelope.formatVersion !== VAULT_FORMAT_VERSION || envelope.vaultId !== format.vaultId ||
          envelope.checkpointId !== name) {
        continue;
      }
      // This device sees every backup it wrote itself, so its own unreferenced
      // checkpoints are safe to remove. Another device's backup may still be in
      // transit through the cloud; keep its checkpoint until it is old enough.
      const own = envelope.sourceDeviceId === deviceId;
      const age = Number.isSafeInteger(envelope.createdAt) ? now - envelope.createdAt : -1;
      if (!own && age < FOREIGN_CHECKPOINT_MIN_AGE_MS) continue;
      await checkpoints.removeEntry(name, { recursive: true });
      report.checkpointsPruned += 1;
    } catch {
      // Unknown or damaged data is never removed by routine maintenance.
    }
  }
}

async function writeMaintenance(root, { format, backup, now, cryptoProvider }) {
  const receipt = await seal({
    app: "everytab",
    kind: "vault-v2-maintenance",
    formatVersion: VAULT_FORMAT_VERSION,
    vaultId: format.vaultId,
    retainedDays: RETAINED_DAYS,
    checkpoint: backup.checkpoint,
    latestBackup: {
      day: backup.day,
      name: backup.name,
      contentHash: backup.contentHash
    },
    updatedAt: now
  }, cryptoProvider);
  await writeJson(root, MAINTENANCE_FILE, receipt);
}

/**
 * Publish at most one restore point per UTC day. The completion receipt is
 * written last, so an interrupted run safely resumes from immutable files.
 */
export async function publishCheckpointBackup({
  root,
  library,
  assetsDirectory,
  format,
  replication,
  input,
  exact = null,
  bootstrapDescriptor = null,
  now,
  cryptoProvider,
  createId,
  report,
  onProgress,
  assetWriter = null
}) {
  const day = utcDay(now);
  const receipt = await readMaintenance(root, format, cryptoProvider);
  if (receipt?.latestBackup.day === day) return;

  const backups = await root.getDirectoryHandle(BACKUPS_DIR, { create: true });
  const checkpoints = await root.getDirectoryHandle(CHECKPOINTS_DIR, { create: true });
  const existing = await listBackups(backups, format, cryptoProvider, report);
  // Today's reference from another device may precede its checkpoint through
  // the cloud, or point at data that never arrived. Count it and fall back to
  // an older complete reference for today, or write this device's own.
  let backup = null;
  for (const candidate of existing.filter((entry) => entry.day === day).reverse()) {
    if (await checkpointExists(checkpoints, candidate.checkpoint)) {
      backup = candidate;
      break;
    }
    recordQuarantine(report, VAULT_FAILURE_CODES.damagedBackup, "checkpoint");
  }

  if (!backup) {
    let descriptor = null;
    if (bootstrapDescriptor && bootstrapDescriptor.inputHash === input.contentHash) {
      descriptor = bootstrapDescriptor;
    } else if (receipt?.checkpoint.inputHash === input.contentHash &&
               await checkpointExists(checkpoints, receipt.checkpoint)) {
      descriptor = receipt.checkpoint;
    } else {
      descriptor = await writeCheckpoint({
        checkpoints, assetsDirectory, library, exact, input, format, replication,
        now, cryptoProvider, createId, report, onProgress, assetWriter
      });
    }
    backup = await writeBackupReference({
      backups, day, descriptor, format, now, cryptoProvider, report, onProgress
    });
    existing.push(backup);
  }

  await pruneBackups({
    backups, checkpoints, format, allBackups: existing,
    latest: backup, deviceId: replication.deviceId, now, report, cryptoProvider
  });
  await writeMaintenance(root, { format, backup, now, cryptoProvider });
}
