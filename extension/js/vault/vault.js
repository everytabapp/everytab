/**
 * M0 vault prototype (File System Access API).
 * Goal: learn how permission persistence behaves across browser restarts,
 * which decides the M5 reconnect UX (plan.md risk #1).
 * Runs in extension page contexts (dashboard), NOT the service worker.
 */
import { idbGet, idbSet } from "../lib/idb.js";

const HANDLE_KEY = "vaultDir";

/**
 * @typedef {{state:"unset"} | {state:"connected", name:string} |
 *           {state:"needs-permission", name:string} | {state:"error", message:string}} VaultStatus
 */

/** The stored directory handle (or undefined). For the M5 sync engine. */
export async function getVaultHandle() {
  return idbGet(HANDLE_KEY);
}

/** @returns {Promise<VaultStatus>} */
export async function pickVaultFolder() {
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await idbSet(HANDLE_KEY, handle);
  return { state: "connected", name: handle.name };
}

/** @returns {Promise<VaultStatus>} */
export async function getVaultStatus() {
  try {
    const handle = await idbGet(HANDLE_KEY);
    if (!handle) return { state: "unset" };
    const perm = await handle.queryPermission({ mode: "readwrite" });
    return perm === "granted"
      ? { state: "connected", name: handle.name }
      : { state: "needs-permission", name: handle.name };
  } catch (e) {
    return { state: "error", message: String(e) };
  }
}

/**
 * Re-request permission on a stored handle (requires user gesture).
 * @returns {Promise<VaultStatus>}
 */
export async function reconnectVault() {
  const handle = await idbGet(HANDLE_KEY);
  if (!handle) return { state: "unset" };
  const perm = await handle.requestPermission({ mode: "readwrite" });
  return perm === "granted"
    ? { state: "connected", name: handle.name }
    : { state: "needs-permission", name: handle.name };
}

/**
 * Write + read back a test file.
 * @returns {Promise<string>} success message
 */
export async function testWrite() {
  const handle = await idbGet(HANDLE_KEY);
  if (!handle) throw new Error("No vault folder configured");
  const payload = JSON.stringify(
    { test: true, writtenAt: new Date().toISOString() },
    null,
    2
  );
  const file = await handle.getFileHandle("vault-test.json", { create: true });
  const writable = await file.createWritable();
  await writable.write(payload);
  await writable.close();
  const readBack = await (await file.getFile()).text();
  if (readBack !== payload) throw new Error("Round-trip mismatch");
  return "vault-test.json written and verified";
}
