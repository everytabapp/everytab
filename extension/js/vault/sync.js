// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Installed Vault sync boundary.
 *
 * The UI resolves the retained folder here; the Vault protocol owns all file
 * comparison, replication, recovery, readable views, and locking.
 */
import { classifyFailure } from "../lib/failure-diagnostic.js";
import { commitLibraryChange } from "../lib/store.js";
import {
  activeStorageAuthority, activeVaultStores
} from "../lib/storage/authority-runtime.js";
import { bump } from "../lib/counters.js";
import {
  getVaultHandle, getVaultStatus, VAULT_META_KEY
} from "./vault.js";
import { retryTransientVaultFileOperation } from "./transient-file-retry.js";
import { ensureDuplicateDomainRulesPortable } from "../lib/duplicate-domain-rules.js";
import { isVaultFailureCode, vaultFailureCode, vaultFailureFileKind } from "./failure-codes.js";

/**
 * Resolve the configured folder, run one protocol sync, and persist its small
 * outcome receipt. The working Library never depends on folder availability.
 */
export async function syncNow({ onProgress = null } = {}) {
  const status = await getVaultStatus();
  if (status.state !== "connected") return { status };
  onProgress?.({ stage: "connecting", target: "", operationCount: 0 });
  try {
    // Migrate the retired local array before the Library snapshot is opened, so
    // the first sync after upgrading cannot publish a Vault that omits its rules.
    await ensureDuplicateDomainRulesPortable();
    const report = await retryTransientVaultFileOperation(async () => {
      const handle = await getVaultHandle();
      // Open through the replication projection first, then reuse the selected
      // authority. Parallel first-open calls must not create duplicate handles
      // for the same databases before the authority cache is established.
      const replication = await activeVaultStores();
      const authority = await activeStorageAuthority();
      if (!authority || !replication) {
        throw new Error("EveryTab storage is not ready for Vault sync");
      }
      const { syncVault } = await import("./protocol-sync.js");
      return syncVault(handle, {
        library: replication.library,
        recovery: replication.recovery,
        onProgress: onProgress ?? undefined,
        // Remote payloads complete every filesystem read before entering this
        // short Vault-to-Library commit boundary.
        commitRemoteApply: (apply) => commitLibraryChange(apply, { authority })
      });
    });
    report.storageVersion = 2;
    // Another page owns a valid sync and will publish its own receipt.
    if (report.skipped) return { status, report };
    await chrome.storage.local.set({
      [VAULT_META_KEY]: { lastSyncAt: Date.now(), ok: true, ...report }
    });
    bump("vaultSyncs");
    return { status, report };
  } catch (error) {
    await recordVaultSyncFailure(error);
    const failureCode = vaultFailureCode(error);
    return { status: {
      state: "error", message: "Vault sync failed", errorClass: classifyFailure(error),
      ...(failureCode ? { failureCode, fileKind: vaultFailureFileKind(error) } : {})
    } };
  }
}

/** Record one failed attempt without retaining error text or page/file payloads.
 * The fixed message preserves compatibility with older receipt readers; the
 * class is diagnostic metadata. Current UI uses localized copy and failureCode,
 * which is either "timeout" or an allowlisted Vault code with its file kind. */
export function recordVaultSyncFailure(
  error,
  lastSyncAt = Date.now(),
  failureCode = null,
  ownerTabId = null
) {
  const code = failureCode === "timeout" || isVaultFailureCode(failureCode)
    ? failureCode
    : vaultFailureCode(error);
  const fileKind = code && code !== "timeout" ? vaultFailureFileKind(error) : null;
  return chrome.storage.local.set({
    [VAULT_META_KEY]: {
      lastSyncAt: Number.isFinite(lastSyncAt) ? lastSyncAt : Date.now(),
      ok: false,
      error: code === "timeout" ? "Vault sync stopped responding" : "Vault sync failed",
      errorClass: classifyFailure(error),
      ...(code ? { failureCode: code } : {}),
      ...(fileKind ? { fileKind } : {}),
      ...(Number.isInteger(ownerTabId) ? { ownerTabId } : {})
    }
  });
}
