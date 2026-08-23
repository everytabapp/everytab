/**
 * Narrow compatibility facade for portable state.
 *
 * Registry/validation live in portable-state-registry.js; pure plans/envelopes
 * live in portable-state-planner.js.
 * Locked Export/Restore/checkpoint effects live in portable-state-transaction.js.
 * Existing Vault and UI consumers import this stable public seam.
 */
export {
  PORTABLE_EXCLUDED_KINDS, PORTABLE_EXPORT_MAX_BYTES, PORTABLE_EXPORT_VERSION,
  assertPortableRestoreTextSize, inspectPortableRecord, isPortableRecordId,
  isPortableVaultFile, isValidPortableRecord, portableVaultFileId,
  normalizePortableSettings, portableStateEntries, portableVaultFileName,
  registerPortableState
} from "./portable-state-registry.js";

export {
  RESTORE_CHECKPOINT_KEY, buildPortableExport, buildRestoreCheckpointExport,
  previewPortableRestore, readPortableRestoreCheckpoint, readPortableRestoreFile,
  restorePortableState, undoPortableRestore
} from "./portable-state-transaction.js";
