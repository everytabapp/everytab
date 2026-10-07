// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Stable logical identities shared across storage modules. */
export const STORAGE_AUTHORITY_INITIALIZATION_KEY = "storageAuthorityInitialization";
export const STORAGE_REVISION_KEY = "storageV2Revision";
export const STORAGE_DURABLE_REVISION_LOCAL_KEY = "storageV2DurableRevision";
export const STORAGE_PENDING_LIBRARY_REVISION_LOCAL_KEY = "storageV2PendingLibraryRevision";
export const STORAGE_SETTINGS_FAMILY = "settings";
export const STORAGE_LABEL_META_FAMILY = "labelMeta";
export const STORAGE_SINGLETON_ID = "current";

/** Local-only repair intent; never a portable Library record or Vault field. */
export function pendingLibraryFamilies(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((family) => typeof family !== "string" || !family)) {
    throw new Error("The pending Library revision is invalid");
  }
  return [...new Set(value)];
}

/**
 * Expand one small IndexedDB revision pulse into the logical storage-change
 * shape already consumed by extension surfaces. Physical values deliberately
 * remain absent: readers pull the authoritative value through store.js.
 *
 * Keeping this helper DOM- and Chrome-free lets every context share the same
 * notification contract without importing or opening either database.
 */
export function expandStorageChanges(changes = {}) {
  const expanded = { ...changes };
  const pulse = changes?.[STORAGE_REVISION_KEY]?.newValue;
  if (!Array.isArray(pulse?.changedKeys)) return expanded;
  for (const key of pulse.changedKeys) {
    if (typeof key !== "string" || !key || key in expanded) continue;
    const logical = pulse?.logicalChanges?.[key];
    expanded[key] = logical && typeof logical === "object" && !Array.isArray(logical)
      ? logical : {};
  }
  return expanded;
}

export function storageChangedKeys(changes = {}) {
  const pulse = changes?.[STORAGE_REVISION_KEY]?.newValue;
  return Array.isArray(pulse?.changedKeys)
    ? pulse.changedKeys.filter((key) => typeof key === "string" && key)
    : [];
}
