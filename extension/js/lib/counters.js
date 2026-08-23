/**
 * M6 — lifetime counters for the Stats page. Honest numbers only: we count
 * events we actually perform. Stored in chrome.storage.local under
 * "counters" (per-device; deliberately NOT synced — they describe this
 * device's activity).
 */
import { withStoreLock } from "./store.js";

const KEY = "counters";

/** Storage key, exported so domain ops can ride a counter change in the same
 * atomic mutateStores commit as the mutation it counts (E2-0c). */
export const COUNTERS_KEY = KEY;

/**
 * Pure: a new counters map with `name` bumped by n — for use inside a
 * mutateStores mutator. Mirrors bump()'s semantics exactly.
 * @param {Counters|undefined} c @param {keyof Counters} name @param {number} [n]
 */
export function bumpedCounters(c, name, n = 1) {
  const base = c ?? {};
  return { ...base, [name]: (base[name] ?? 0) + n };
}

/** @typedef {{tabsDumped?:number, tabsAutoArchived?:number, itemsExpired?:number,
 *             duplicatesClosed?:number, snoozesFired?:number, tabsSuspended?:number,
 *             vaultSyncs?:number, tabsLost?:number}} Counters */
// tabsLost: reserved for the Stats "tabs ever lost" line. Never bumped — it is
// structurally 0 (tombstone guarantee), read via the store only so that stat is
// not a bare literal. If a genuine data-loss path is ever discovered, bump it.

/** @param {keyof Counters} name @param {number} [n] */
export async function bump(name, n = 1) {
  if (!n) return;
  // E2-0b: lock-guarded RMW (e2-0-storage-concurrency.md §2.2 — low risk, but
  // uniform: every RMW writer goes through the one store lock).
  await withStoreLock(async () => {
    const r = await chrome.storage.local.get(KEY);
    const c = r[KEY] ?? {};
    c[name] = (c[name] ?? 0) + n;
    await chrome.storage.local.set({ [KEY]: c });
  });
}

/** @returns {Promise<Counters>} */
export async function getCounters() {
  const r = await chrome.storage.local.get(KEY);
  return r[KEY] ?? {};
}
