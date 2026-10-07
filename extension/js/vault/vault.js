// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Vault folder selection, retained permission, and status boundary.
 *
 * File System Access handles must be owned by an extension page because the
 * MV3 service worker cannot open a directory picker. The product has one Vault
 * protocol and one retained handle; sync internals stay behind this boundary.
 */
import { idbGet, idbSet } from "../lib/idb.js";
import { classifyFailure } from "../lib/failure-diagnostic.js";

const VAULT_HANDLE_KEY = "vaultDirV2";
export const VAULT_META_KEY = "vaultMetaV2";

export async function getVaultSyncMeta() {
  return (await chrome.storage.local.get(VAULT_META_KEY))[VAULT_META_KEY] ?? null;
}

/**
 * @typedef {{state:"unset"} | {state:"connected", name:string} |
 *           {state:"needs-permission", name:string} |
 *           {state:"error", message:string, errorClass:string}} VaultStatus
 */

/** The retained Vault directory handle, or undefined when none is configured. */
export async function getVaultHandle() {
  return idbGet(VAULT_HANDLE_KEY);
}

/**
 * @typedef {{state:"connected", name:string} | {state:"cancelled"} |
 *           {state:"rejected", reason?:string}} VaultFolderSelection
 */

/**
 * @typedef {object} VaultJoinDetails
 * @property {string} name Folder name shown to the user.
 * @property {string} vaultId Identity of the Vault in the chosen folder.
 * @property {number|null} folderRecords Live records in that Vault's readable view, when known.
 * @property {number|null} localRecords Live records in this device's Library, when known.
 */

/**
 * Decide whether choosing a populated Vault needs the user's confirmation.
 * Reconnecting the same Vault is routine. A different Vault, or a first Vault
 * while this device already holds records, merges two libraries on every
 * device that shares the folder, which no single device can undo.
 * @param {{state:string, format?:{vaultId:string}}} inspection
 * @param {{lastVaultId?:string|null, localRecords?:number|null}} context
 * @returns {"none"|"prompt"}
 */
export function vaultJoinDecision(inspection, { lastVaultId = null, localRecords = null } = {}) {
  if (inspection?.state !== "ready") return "none";
  const vaultId = inspection.format?.vaultId ?? null;
  if (lastVaultId) return vaultId === lastVaultId ? "none" : "prompt";
  return Number.isSafeInteger(localRecords) && localRecords > 0 ? "prompt" : "none";
}

/** Live record count from the Vault's readable view, or null when unavailable. */
async function readVaultRecordCount(handle, vaultId) {
  try {
    const file = await handle.getFileHandle("library.json");
    const view = JSON.parse(await (await file.getFile()).text());
    if (view?.app !== "everytab" || view.kind !== "vault-v2-readable-library" ||
        view.vaultId !== vaultId || !Number.isSafeInteger(view.summary?.records)) {
      return null;
    }
    return view.summary.records;
  } catch {
    return null;
  }
}

/** Live record count across saved-data families, or null without a Library. */
async function readLocalRecordCount() {
  try {
    const [{ activeVaultStores }, { STORE_KEYS }] = await Promise.all([
      import("../lib/storage/authority-runtime.js"),
      import("../lib/types.js")
    ]);
    const replication = await activeVaultStores();
    if (!replication?.library?.readFamily) return null;
    let total = 0;
    for (const family of Object.values(STORE_KEYS)) {
      total += (await replication.library.readFamily(family, { includeFavicons: false })).length;
    }
    return total;
  } catch {
    return null;
  }
}

/** The Vault this device last synced with, or the one its retained folder holds. */
async function lastConnectedVaultId(inspectVaultRoot) {
  const meta = await getVaultSyncMeta();
  if (typeof meta?.vaultId === "string" && meta.vaultId) return meta.vaultId;
  try {
    const retained = await getVaultHandle();
    if (!retained) return null;
    if (await retained.queryPermission({ mode: "readwrite" }) !== "granted") return null;
    const inspection = await inspectVaultRoot(retained);
    return inspection.state === "ready" ? inspection.format.vaultId : null;
  } catch {
    return null;
  }
}

/**
 * @param {{confirmJoin?:(details:VaultJoinDetails)=>Promise<boolean>}} [options]
 *   `confirmJoin` runs before a different populated Vault replaces the retained
 *   folder. Returning false keeps the previous folder untouched.
 * @returns {Promise<VaultFolderSelection>}
 */
export async function pickVaultFolder({ confirmJoin = null } = {}) {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (error) {
    // Only the picker's abort means cancellation. Reading or persisting the
    // selected handle can also abort, and those failures must reach the caller.
    if (classifyFailure(error) === "name:AbortError") return { state: "cancelled" };
    throw error;
  }
  const { inspectVaultRoot } = await import("./protocol-sync.js");
  const inspection = await inspectVaultRoot(handle);
  if (!["empty", "ready"].includes(inspection.state)) {
    return { state: "rejected", reason: inspection.state };
  }
  if (inspection.state === "ready" && typeof confirmJoin === "function") {
    const [lastVaultId, localRecords] = await Promise.all([
      lastConnectedVaultId(inspectVaultRoot), readLocalRecordCount()
    ]);
    if (vaultJoinDecision(inspection, { lastVaultId, localRecords }) === "prompt") {
      const confirmed = await confirmJoin({
        name: handle.name,
        vaultId: inspection.format.vaultId,
        folderRecords: await readVaultRecordCount(handle, inspection.format.vaultId),
        localRecords
      });
      if (!confirmed) return { state: "cancelled" };
    }
  }
  await idbSet(VAULT_HANDLE_KEY, handle);
  return { state: "connected", name: handle.name };
}

/** @returns {Promise<VaultStatus>} */
export async function getVaultStatus() {
  try {
    const handle = await getVaultHandle();
    if (!handle) return { state: "unset" };
    const permission = await handle.queryPermission({ mode: "readwrite" });
    return permission === "granted"
      ? { state: "connected", name: handle.name }
      : { state: "needs-permission", name: handle.name };
  } catch (error) {
    return { state: "error", message: "Vault is not available", errorClass: classifyFailure(error) };
  }
}

/** Re-request permission on the retained handle. Requires a user gesture. */
export async function reconnectVault() {
  const handle = await getVaultHandle();
  if (!handle) return { state: "unset" };
  const permission = await handle.requestPermission({ mode: "readwrite" });
  return permission === "granted"
    ? { state: "connected", name: handle.name }
    : { state: "needs-permission", name: handle.name };
}
