// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Bounded recovery when cloud delivery replaces a remote manifest during a pull. */
class RemoteReadError extends Error {
  constructor(cause) {
    super(cause?.message ?? "Remote Vault data could not be read", { cause });
  }
}

/** Mark file reads only. Local commits and their validation must not be retried here. */
export async function readRemoteVaultState(read, onProgress = () => {}) {
  let callbackError = Symbol("no callback failure");
  try {
    return await read((progress) => {
      try { onProgress(progress); }
      catch (error) { callbackError = error; throw error; }
    });
  } catch (error) {
    if (error === callbackError) throw error;
    throw new RemoteReadError(error);
  }
}

/**
 * Pull a verified head, refreshing it only after a failed remote read.
 * readManifest must verify its seal and identity. pull(manifest, attempt) must
 * refresh the durable cursor on retries; earlier chunks may have committed.
 * Returns the head actually consumed, for downstream readable-view receipts.
 */
export async function pullWithFreshManifest({ manifest, readManifest, pull }) {
  let current = manifest;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await pull(current, attempt);
      return current;
    } catch (error) {
      if (!(error instanceof RemoteReadError)) throw error;
      if (attempt === 2) throw error.cause;
      const next = await readManifest();
      if (next.sourceId !== current.sourceId || next.deviceId !== current.deviceId) {
        throw new Error("Remote Vault replication identity changed during sync");
      }
      if (next.baseSequence < current.baseSequence ||
          next.throughSequence < current.throughSequence) {
        throw new Error("Remote Vault manifest moved backwards during sync");
      }
      if (next.contentHash === current.contentHash) throw error.cause;
      current = next;
    }
  }
}
