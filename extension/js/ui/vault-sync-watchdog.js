// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Run the Vault operation behind the UI lifecycle.
 *
 * Kept as a small seam so stalled browser file-system promises can be tested
 * without mounting the Dashboard.
 */
export const VAULT_SYNC_INACTIVITY_MS = 30_000;

export class VaultSyncTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Vault sync timed out after ${timeoutMs} ms`);
    this.name = "VaultSyncTimeoutError";
  }
}

/**
 * A timed-out File System Access promise still owns its Web Lock. Reloading
 * the recorded owning tab destroys that abandoned execution context; Web Locks
 * then releases ownership automatically. Older receipts without an owner fall
 * back to reloading the Dashboard that requested the restart.
 */
export async function restartStalledVaultSync({
  tabId = null,
  reloadTab = (id) => globalThis.chrome.tabs.reload(id),
  reload = () => globalThis.location.reload()
} = {}) {
  if (Number.isInteger(tabId) && typeof reloadTab === "function") {
    try {
      await reloadTab(tabId);
      return "owner-tab";
    } catch {
      /* The owner may already have closed. Reload this page as the safe fallback. */
    }
  }
  reload();
  return "current-page";
}

export function runVaultSyncWithDeadline({
  sync,
  timeoutMs = VAULT_SYNC_INACTIVITY_MS,
  onProgress = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return sync(onProgress ?? (() => {}));
  let timer = 0;
  let settled = false;
  let rejectDeadline = null;
  const deadline = new Promise((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const arm = () => {
    clearTimer(timer);
    timer = setTimer(() => rejectDeadline?.(new VaultSyncTimeoutError(timeoutMs)), timeoutMs);
  };
  const heartbeat = (progress) => {
    if (settled) return;
    arm();
    onProgress?.(progress);
  };
  arm();
  return Promise.race([Promise.resolve().then(() => sync(heartbeat)), deadline])
    .finally(() => {
      settled = true;
      clearTimer(timer);
    });
}
