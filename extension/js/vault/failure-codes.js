// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Allowlisted Vault failure codes and quarantine entries.
 *
 * A code names a failure family that the user can act on. A file kind names
 * the protocol role of the affected file. Neither ever carries a file name,
 * a folder name, file contents, or error text, so both may enter the local
 * sync receipt and the Vault screen.
 */

export const VAULT_FAILURE_CODES = Object.freeze({
  /** Data written by a newer EveryTab; this device must update. Fatal. */
  updateRequired: "vault-update-required",
  /** A cloud eviction placeholder (`.name.icloud`) stands in for a file. */
  placeholderFile: "vault-placeholder-file",
  /** A daily backup reference is unreadable or lacks its checkpoint. */
  damagedBackup: "vault-damaged-backup",
  /** Another device's manifest could not be verified; that device is skipped. */
  foreignManifestUnreadable: "vault-foreign-manifest-unreadable",
  /** A sync-service conflict copy or unknown entry was ignored. */
  conflictCopy: "vault-conflict-copy"
});

const CODES = new Set(Object.values(VAULT_FAILURE_CODES));

export const VAULT_FILE_KINDS = Object.freeze([
  "format", "manifest", "backup", "checkpoint", "transaction", "asset",
  "directory", "file"
]);
const KINDS = new Set(VAULT_FILE_KINDS);

/** Thrown by the protocol when a failure has an actionable, allowlisted cause. */
export class VaultSyncError extends Error {
  constructor(message, { code, kind = "file" } = {}) {
    super(message);
    this.name = "Error";
    this.code = CODES.has(code) ? code : null;
    this.fileKind = KINDS.has(kind) ? kind : "file";
  }
}

function readableString(value, property) {
  try {
    const candidate = value?.[property];
    return typeof candidate === "string" ? candidate : null;
  } catch {
    return null;
  }
}

/** The allowlisted failure code carried by a thrown value, or null. */
export function vaultFailureCode(error) {
  const code = readableString(error, "code");
  return CODES.has(code) ? code : null;
}

/** The allowlisted file kind carried by a thrown value, or null. */
export function vaultFailureFileKind(error) {
  const kind = readableString(error, "fileKind");
  return KINDS.has(kind) ? kind : null;
}

export function isVaultFailureCode(value) {
  return CODES.has(value);
}

const UPDATE_REQUIRED_TEXT = /Update EveryTab before using this data/;

/**
 * Saved-data guards in the Library throw plain errors with fixed product text
 * when a record family or schema version is newer than this build. Give them
 * the update-required code without reading anything beyond that fixed text.
 */
export function classifyVaultProtocolError(error) {
  if (vaultFailureCode(error)) return error;
  const message = readableString(error, "message") ?? "";
  if (UPDATE_REQUIRED_TEXT.test(message)) {
    const classified = new VaultSyncError(message, {
      code: VAULT_FAILURE_CODES.updateRequired, kind: "transaction"
    });
    classified.cause = error;
    return classified;
  }
  return error;
}

/**
 * Count one skipped non-authoritative file in a sync or Restore report.
 * Entries are small `{code, kind, count}` records sorted for stable receipts.
 */
export function recordQuarantine(report, code, kind) {
  if (!CODES.has(code) || !KINDS.has(kind)) {
    throw new Error("Vault quarantine entry is not allowlisted");
  }
  report.quarantined ??= [];
  const existing = report.quarantined.find((entry) =>
    entry.code === code && entry.kind === kind);
  if (existing) existing.count += 1;
  else report.quarantined.push({ code, kind, count: 1 });
  report.quarantined.sort((left, right) =>
    left.code.localeCompare(right.code) || left.kind.localeCompare(right.kind));
  return report.quarantined;
}

/** Accept only well-formed quarantine entries from a stored receipt. */
export function readQuarantine(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) =>
    entry && typeof entry === "object" && CODES.has(entry.code) &&
    KINDS.has(entry.kind) && Number.isSafeInteger(entry.count) && entry.count > 0);
}
