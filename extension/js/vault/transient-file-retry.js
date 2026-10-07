// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Chrome can briefly reject a valid File System Access handle while the
 * backing folder is being updated by the operating system or a sync provider.
 * A later manual sync succeeds, so absorb exactly one such read race here.
 */
export const VAULT_TRANSIENT_RETRY_DELAY_MS = 250;

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function isTransientVaultFileError(error) {
  return error?.name === "NotReadableError";
}

export async function retryTransientVaultFileOperation(operation, {
  delayMs = VAULT_TRANSIENT_RETRY_DELAY_MS,
  wait: waitForRetry = wait
} = {}) {
  try {
    return await operation();
  } catch (error) {
    if (!isTransientVaultFileError(error)) throw error;
    await waitForRetry(delayMs);
    return operation();
  }
}
