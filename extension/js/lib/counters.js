// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * M6 — lifetime counters for the Stats page. Honest numbers only: we count
 * events we actually perform. Stored in chrome.storage.local under
 * "counters" (per-device; deliberately NOT synced — they describe this
 * device's activity).
 */
import { mutateStores, readStoreMap } from "./store.js";

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
  await mutateStores([KEY], (maps) => ({
    [KEY]: bumpedCounters(maps[KEY], name, n)
  }));
}

/** @returns {Promise<Counters>} */
export async function getCounters() {
  return await readStoreMap(KEY) ?? {};
}
