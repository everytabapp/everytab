/** Whole-record saved-item mutations with exact, atomic Undo. */
import { mutateStores } from "./store.js";
import { JOURNAL_KEY, makeJournalEntry, appendedJournal } from "./journal.js";

/**
 * Delete one complete saved item and append its exact inverse in the same
 * storage commit. The caller's modifiedAt is an optimistic revision token:
 * a stale confirmation cannot erase a newer version of the item.
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
    if (current.modifiedAt !== item.modifiedAt) {
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
