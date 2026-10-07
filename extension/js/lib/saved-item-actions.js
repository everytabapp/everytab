// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Whole-record saved-item deletion with a guarded inverse. */
import { mutateStores } from "./store.js";
import { JOURNAL_KEY, makeJournalEntry, appendedJournal } from "./journal.js";
import { sameSavedRecord } from "./saved-selection-safety.js";

/**
 * Delete one complete saved item and record its exact inverse. Library records
 * and their Journal entry commit atomically. Recovery Snapshots live in a
 * separate database: their inverse is persisted before deletion, so failure
 * can leave a saved copy but cannot remove the only recoverable copy.
 * The caller's complete record is the optimistic revision
 * token, so same-tick content changes cannot be erased by stale confirmation.
 *
 * @param {string} store
 * @param {import("./types.js").InboxItem|import("./types.js").Session} item
 * @param {string} label
 * @param {{actionKind?:string,actionParams?:Record<string,string|number>}} [descriptor]
 * @returns {Promise<{ok:boolean,reason:"deleted"|"gone"|"stale",entry:import("./types.js").JournalEntry|null}>}
 */
export async function deleteSavedItem(store, item, label, descriptor = {}) {
  let result = { ok: false, reason: "gone", entry: null };
  await mutateStores([store, JOURNAL_KEY], (maps) => {
    const current = maps[store]?.[item?.id];
    if (!current || current.deletedAt) return null;
    if (!sameSavedRecord(current, item)) {
      result = { ok: false, reason: "stale", entry: null };
      return null;
    }
    const now = Date.now();
    const entry = makeJournalEntry(label, {
      puts: [{ store, item: structuredClone(current) }]
    }, descriptor);
    result = { ok: true, reason: "deleted", entry };
    return {
      [store]: {
        ...(maps[store] ?? {}),
        [current.id]: { ...current, deletedAt: now, modifiedAt: now }
      },
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  return result;
}
