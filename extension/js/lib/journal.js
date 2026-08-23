/**
 * M6 — undo system. Every destructive/creative action records an inverse:
 *   puts   → records to write back (revives tombstoned items, restores
 *            pre-edit versions; upsert stamps a fresh modifiedAt, so undos
 *            win last-write-wins and merge cleanly through the vault)
 *   dels   → record ids to tombstone (removes items an action created)
 *   reopen → TabRef windows to reopen (for closed tabs)
 *   moves  → live-tab positions to move back to (P2g-4, Open-tabs drag):
 *            BEST-EFFORT — re-moves each tab to its pre-drag window/index if
 *            it still exists; a gone tab/window is skipped silently
 *            (interaction-model.md [AP]: live drags are best-effort undo,
 *            and the entry label says so).
 * Journal capped at JOURNAL_CAP entries in chrome.storage.local (per device).
 * F46r: the cap is 200. It was 50, which on a busy day scrolled a morning's work
 * out of reach; `unlimitedStorage` is held, so the only real cost is the size of
 * the `puts` snapshots a long history keeps alive.
 */
import { mutateStores, withStoreLock } from "./store.js";
import {
  JOURNAL_CAP as CAP, JOURNAL_KEY as KEY,
  hasValidUndoContract, journalStaleStores, journalTargetStores
} from "./journal-state.js";
import { inferJournalDescriptor, normalizedJournalParams } from "./journal-descriptor.js";

/** Storage key + cap, exported so domain ops can commit a journal entry in the
 * SAME atomic mutateStores set as the mutation it undoes (E2-0c). */
export const JOURNAL_KEY = KEY;
export const JOURNAL_CAP = CAP;

/**
 * Pure: build a journal entry (id + timestamp stamped now), or null when the
 * inverse is empty — recordAction's exact semantics, usable inside a commit.
 * @param {string} label
 * @param {{puts?: object[], dels?: object[], reopen?: object[][], moves?: object[], restoreCheckpointId?: string, closeDayTransactionId?: string}} [inverse]
 * @param {{auto?:boolean,category?:string,forwardReceipt?:object,actionKind?:string,actionParams?:Record<string,string|number>}} [meta]
 * @returns {JournalEntry | null}
 */
export function makeJournalEntry(label, {
  puts = [], dels = [], reopen = [], moves = [], restoreCheckpointId = "",
  closeDayTransactionId = ""
} = {},
  { auto = false, category = "", forwardReceipt = null,
    actionKind = "", actionParams = null } = {}) {
  if (puts.length === 0 && dels.length === 0 && reopen.length === 0 &&
      moves.length === 0 && !restoreCheckpointId && !closeDayTransactionId) return null;
  // F46: `auto` marks the things EveryTab did on its own. It is the one fact a
  // user cannot reconstruct from the label, and it is what Activity filters on.
  // Absent means user-initiated, so every existing entry stays correct.
  const descriptor = actionKind
    ? { actionKind, actionParams: normalizedJournalParams(actionParams) }
    : inferJournalDescriptor(label);
  return { id: crypto.randomUUID(), at: Date.now(), label, puts, dels, reopen, moves,
    ...(descriptor ? descriptor : {}),
    ...(restoreCheckpointId ? { restoreCheckpointId } : {}),
    ...(closeDayTransactionId ? { closeDayTransactionId } : {}),
    ...(auto ? { auto: true } : {}), ...(category ? { category } : {}),
    ...(forwardReceipt ? { forwardReceipt: structuredClone(forwardReceipt) } : {}) };
}

/**
 * Pure: a new journal array with `entry` prepended and the cap applied —
 * for use inside a mutateStores mutator.
 * @param {JournalEntry[]|undefined} arr @param {JournalEntry} entry
 */
export function appendedJournal(arr, entry) {
  return [entry, ...(arr ?? [])].slice(0, CAP);
}

/** @typedef {import("./types.js").JournalEntry} JournalEntry */

/**
 * @param {string} label human sentence, e.g. "Closed 3 tabs"
 * @param {{puts?: object[], dels?: object[], reopen?: object[][], moves?: object[], restoreCheckpointId?: string, closeDayTransactionId?: string}} inverse
 * @param {{auto?: boolean, category?: string, forwardReceipt?: object}} [meta]
 * @returns {Promise<JournalEntry | null>}
 */
export async function recordAction(label, inverse = {}, meta = {}) {
  const entry = makeJournalEntry(label, inverse, meta);
  if (!entry) return null;
  // This compatibility path is only for browser-effect receipts. Persist it
  // through mutateStores so even an older caller gets the same sealed
  // post-state contract as an atomic domain mutation. Saved-data operations
  // must append their entry in the same commit as their forward change.
  const stores = journalTargetStores(entry);
  await mutateStores([...stores, KEY], (maps) => ({
    [KEY]: appendedJournal(maps[KEY], entry)
  }));
  return entry;
}

/** @returns {Promise<JournalEntry[]>} newest first */
export async function listActions() {
  const r = await chrome.storage.local.get(KEY);
  return r[KEY] ?? [];
}

/**
 * Periodic recovery snapshots are deliberately absent from user activity.
 * They can run dozens of times a day without asking anything of the user. The
 * category check is the durable contract; the label fallback protects a future
 * or imported pre-category automatic entry. Manual snapshot actions remain.
 * @param {JournalEntry} entry
 */
export function isVisibleActivityEntry(entry) {
  if (entry?.forwardReceipt?.status === "pending") return false;
  if (!entry?.auto) return true;
  const category = String(entry.category ?? "").toLowerCase();
  const label = String(entry.label ?? "");
  return category !== "snapshot" && !/\bauto[- ]?snapshots?\b/i.test(label);
}

function isTerminalEntry(entry) {
  return Boolean(entry?.undone || entry?.restoreUndoStatus || entry?.undoStatus);
}

function isPendingForwardEntry(entry) {
  return entry?.forwardReceipt?.status === "pending";
}

function inverseTargets(entry) {
  return [...(entry?.puts ?? []), ...(entry?.dels ?? [])];
}

function applyStoreInverse(maps, entry, now) {
  const sets = {};
  const writable = (store) => {
    if (!sets[store]) sets[store] = { ...(maps[store] ?? {}) };
    return sets[store];
  };
  for (const target of entry.puts ?? []) {
    const id = target?.item?.id;
    if (typeof target?.store !== "string" || typeof id !== "string") continue;
    writable(target.store)[id] = { ...structuredClone(target.item), modifiedAt: now };
  }
  for (const target of entry.dels ?? []) {
    if (typeof target?.store !== "string" || typeof target?.id !== "string") continue;
    const map = writable(target.store);
    const current = map[target.id];
    if (current) map[target.id] = { ...current, deletedAt: now, modifiedAt: now };
  }
  return sets;
}

async function claimGenericUndo(entry) {
  const claimId = crypto.randomUUID();
  const stores = journalTargetStores(entry);
  let result = { status: "unavailable", entry: null, claimId: null };
  await mutateStores([...stores, KEY], (maps) => {
    const journal = structuredClone(maps[KEY] ?? []);
    const mine = journal.find((candidate) => candidate.id === entry.id);
    if (!mine || isTerminalEntry(mine)) return null;
    if (mine.undoClaim) {
      result = { status: "busy", entry: mine, claimId: null };
      return null;
    }

    if (inverseTargets(mine).length > 0 && !hasValidUndoContract(mine)) {
      mine.undoStatus = "unavailable";
      result = { status: "unavailable", entry: mine, claimId: null };
      return { [KEY]: journal };
    }
    const staleStores = journalStaleStores(mine, maps);
    if (staleStores.length > 0) {
      mine.undoStatus = "stale";
      mine.undoStaleStores = staleStores;
      result = { status: "stale", entry: mine, claimId: null };
      return { [KEY]: journal };
    }

    const hasEffects = (mine.reopen?.length ?? 0) > 0 || (mine.moves?.length ?? 0) > 0;
    const sets = applyStoreInverse(maps, mine, Date.now());
    if (hasEffects) {
      mine.undoClaim = { id: claimId, at: Date.now(), phase: "effects" };
      result = { status: "claimed", entry: mine, claimId };
    } else {
      mine.undone = true;
      result = { status: "undone", entry: mine, claimId: null };
    }
    sets[KEY] = journal;
    return sets;
  });
  return result;
}

function placedCloseTabs(entry) {
  const receipt = entry?.forwardReceipt;
  if (receipt?.kind !== "close-tabs" || receipt.status !== "complete" ||
      !Array.isArray(receipt.tabs) || receipt.tabs.length === 0) return null;
  if (!receipt.tabs.every((tab) =>
    Number.isInteger(tab?.windowId) && tab.windowId >= 0 &&
    Number.isInteger(tab?.index) && tab.index >= 0 &&
    /^https?:/.test(tab?.ref?.url ?? ""))) return null;
  return receipt.tabs;
}

async function hasNormalWindow(windowId) {
  try {
    const win = await chrome.windows.get(windowId);
    return win?.incognito !== true && (!win?.type || win.type === "normal");
  } catch {
    return false;
  }
}

async function reopenAtOriginalPlaces(placements) {
  const groups = new Map();
  for (const tab of placements) {
    const group = groups.get(tab.windowId) ?? [];
    group.push(tab);
    groups.set(tab.windowId, group);
  }

  let reopened = 0;
  let failed = 0;
  for (const [windowId, group] of groups) {
    group.sort((a, b) => a.index - b.index);
    if (await hasNormalWindow(windowId)) {
      for (const tab of group) {
        try {
          await chrome.tabs.create({
            url: tab.ref.url,
            windowId,
            index: tab.index,
            pinned: tab.pinned === true,
            active: false
          });
          reopened += 1;
        } catch {
          failed += 1;
        }
      }
      continue;
    }

    // The original window itself was closed. Preserve its tab grouping in one
    // replacement window; exact window identity cannot survive a close.
    try {
      const win = await chrome.windows.create({ url: group.map((tab) => tab.ref.url) });
      reopened += group.length;
      const created = win?.tabs ?? [];
      for (let index = 0; index < Math.min(created.length, group.length); index++) {
        if (!group[index].pinned || !Number.isInteger(created[index]?.id)) continue;
        try { await chrome.tabs.update(created[index].id, { pinned: true }); }
        catch { /* exact pin restoration remains best-effort */ }
      }
    } catch {
      failed += group.length;
    }
  }
  return { reopened, failed };
}

async function finishUndoEffects(entry, claimId) {
  let reopened = 0;
  let moved = 0;
  let failed = 0;
  const placements = placedCloseTabs(entry);
  if (placements) {
    const placed = await reopenAtOriginalPlaces(placements);
    reopened += placed.reopened;
    failed += placed.failed;
  } else {
    for (const refs of entry.reopen ?? []) {
      const urls = refs.map((tab) => tab.url).filter((url) => /^https?:/.test(url ?? ""));
      if (urls.length === 0) continue;
      try {
        if (urls.length === 1) await chrome.tabs.create({ url: urls[0], active: false });
        else await chrome.windows.create({ url: urls });
        reopened += urls.length;
      } catch {
        failed += urls.length;
      }
    }
  }
  for (const move of entry.moves ?? []) {
    try {
      await chrome.tabs.move(move.tabId, {
        windowId: move.windowId,
        index: move.index
      });
      moved += 1;
    } catch {
      // Live-tab move Undo is deliberately best-effort. A tab or destination
      // window can disappear after the action; skipping it is the settled
      // contract and must not turn an otherwise completed Undo into an error.
    }
  }

  let result = { status: "unavailable", entry: null };
  await mutateStores([KEY], (maps) => {
    const journal = structuredClone(maps[KEY] ?? []);
    const mine = journal.find((candidate) => candidate.id === entry.id);
    if (!mine || mine.undoClaim?.id !== claimId) return null;
    mine.undoEffectResult = { reopened, moved, failed };
    delete mine.undoClaim;
    if (failed > 0) {
      mine.undoStatus = "incomplete";
      result = { status: "incomplete", entry: mine };
    } else {
      mine.undone = true;
      result = { status: "undone", entry: mine };
    }
    return { [KEY]: journal };
  });
  return result;
}

async function undoGenericEntry(entry) {
  const claimed = await claimGenericUndo(entry);
  if (claimed.status !== "claimed") return claimed;
  return finishUndoEffects(claimed.entry, claimed.claimId);
}

async function terminalizeUnavailableEntry(entryId) {
  await mutateStores([KEY], (maps) => {
    const journal = structuredClone(maps[KEY] ?? []);
    const entry = journal.find((candidate) => candidate.id === entryId);
    if (!entry || isTerminalEntry(entry)) return null;
    entry.undoStatus = "unavailable";
    return { [KEY]: journal };
  });
}

/**
 * Undo one entry with a typed, stale-safe outcome. Generic saved-data inverses
 * are checked and committed with their terminal Journal state in one locked
 * write. Browser effects are claimed first, so concurrent callers cannot
 * repeat them.
 * @param {string} [id]
 * @returns {Promise<{status:"undone"|"stale"|"unavailable"|"busy"|"incomplete",entry:JournalEntry|null}>}
 */
export async function undoActionResult(id) {
  const explicit = Boolean(id);
  while (true) {
    const arr = await listActions();
    const entry = id
      ? arr.find((candidate) => candidate.id === id)
      : arr.find((candidate) => !isTerminalEntry(candidate) && !isPendingForwardEntry(candidate));
    if (!entry || isTerminalEntry(entry)) return { status: "unavailable", entry: entry ?? null };
    if (isPendingForwardEntry(entry)) return { status: "busy", entry };

    if (entry.restoreCheckpointId) {
      const { undoPortableRestore } = await import("./portable-state.js");
      const restored = await undoPortableRestore(entry.restoreCheckpointId);
      if (restored.status === "undone") return { status: "undone", entry: { ...entry, undone: true } };
      if (explicit) return { status: restored.status, entry };
      continue;
    }
    if (entry.closeDayTransactionId) {
      const { undoCloseDayTransaction } = await import("./close-day.js");
      const closed = await undoCloseDayTransaction(entry.closeDayTransactionId);
      if (closed.status === "undone") {
        return { status: "undone", entry: { ...entry, undone: true } };
      }
      await terminalizeUnavailableEntry(entry.id);
      if (!explicit) continue;
      return { status: "unavailable", entry: { ...entry, undoStatus: "unavailable" } };
    }

    const result = await undoGenericEntry(entry);
    if (!explicit && ["stale", "unavailable"].includes(result.status)) continue;
    return result;
  }
}

/** Compatibility interface for existing callers: the undone entry or null. */
export async function undoAction(id) {
  const result = await undoActionResult(id);
  return result.status === "undone" ? result.entry : null;
}

/**
 * A persisted browser-effect claim from a previous worker cannot be replayed
 * safely because Chrome tab creation has no idempotency key. Mark it honestly
 * incomplete on the next worker start instead of risking duplicate tabs.
 */
export async function recoverInterruptedUndos() {
  let recovered = 0;
  await mutateStores([KEY], (maps) => {
    const journal = structuredClone(maps[KEY] ?? []);
    for (const entry of journal) {
      if (!entry?.undoClaim || isTerminalEntry(entry)) continue;
      delete entry.undoClaim;
      entry.undoStatus = "incomplete";
      entry.undoEffectResult = { reopened: 0, moved: 0,
        failed: (entry.reopen ?? []).flat().length + (entry.moves ?? []).length };
      recovered += 1;
    }
    return recovered > 0 ? { [KEY]: journal } : null;
  });
  return recovered;
}

export async function clearJournal() {
  await withStoreLock(() => chrome.storage.local.set({ [KEY]: [] }));
}

/**
 * User-facing clear. Refuse to erase a receipt while a browser effect is in
 * flight; its owner must be able to finalize or recover that receipt first.
 * Test setup may continue to use `clearJournal()` directly.
 * @returns {Promise<{ok:boolean,reason?:"busy"}>}
 */
export async function clearJournalSafely() {
  let result = { ok: false, reason: "busy" };
  await mutateStores([KEY], (maps) => {
    const journal = maps[KEY] ?? [];
    if (journal.some((entry) => entry?.undoClaim || isPendingForwardEntry(entry))) return null;
    result = { ok: true };
    return { [KEY]: [] };
  });
  return result;
}
