// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

export const STORAGE_AUTHORITY_KEY = "storageAuthority";

/**
 * Validate the one permanent pointer to EveryTab's local Library and Recovery
 * databases. Database names are data: changing either one would select a
 * different store, so callers must carry them through exactly.
 */
export function isStorageAuthorityRecord(record) {
  return record?.app === "everytab" &&
    record.kind === "storage-authority" &&
    record.formatVersion === 1 &&
    typeof record.runId === "string" && Boolean(record.runId) &&
    Number.isFinite(record.createdAt) && record.createdAt >= 0 &&
    typeof record.databases?.library === "string" && Boolean(record.databases.library) &&
    typeof record.databases?.recovery === "string" && Boolean(record.databases.recovery) &&
    Number.isInteger(record.snapshotRetention) && record.snapshotRetention >= 0;
}

/**
 * Construct the permanent authority record. Database names are copied exactly
 * because they identify the installed data.
 */
export function createStorageAuthorityRecord({
  runId,
  createdAt = Date.now(),
  databases,
  snapshotRetention = 200
}) {
  const record = {
    app: "everytab",
    kind: "storage-authority",
    formatVersion: 1,
    runId,
    createdAt,
    databases: {
      library: databases?.library,
      recovery: databases?.recovery
    },
    snapshotRetention
  };
  if (!isStorageAuthorityRecord(record)) {
    throw new Error("A valid Storage authority record is required");
  }
  return record;
}
