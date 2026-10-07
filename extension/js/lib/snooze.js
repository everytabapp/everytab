// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { STORE_KEYS } from "./types.js";
import { newMeta, listItems, mutateStores } from "./store.js";
import { JOURNAL_KEY, makeJournalEntry, appendedJournal } from "./journal.js";
import { closeReceiptTabs } from "./live-close.js";
import {
  SNOOZE_ALARM_PREFIX, SNOOZE_DELIVERY_KEY, fireSnooze,
  snoozeDeliveryConflict, wakeSnoozeSelections
} from "./snooze-delivery.js";
import {
  SNOOZE_PLACEMENT_KEY, placementForSnooze, snoozePlacementMap
} from "./snooze-placement.js";
import {
  normalizedSnoozeSelections, sameSnoozeRecord, snoozeRefs, snoozeWithoutIndexes
} from "./snooze-record.js";
export { nextOccurrence } from "./snooze-schedule.js";
export { isWindowSnooze, snoozeRefs } from "./snooze-record.js";
export {
  SNOOZE_ALARM_PREFIX, fireSnooze, recoverInterruptedSnoozeDeliveries
} from "./snooze-delivery.js";

/**
 * Preset due-time computation (pure, testable).
 * @param {"later-today"|"this-evening"|"tomorrow"|"weekend"|"next-week"} preset
 * @param {Date} [now]
 * @returns {number} epoch ms
 */
export function presetDue(preset, now = new Date()) {
  const d = new Date(now.getTime());
  const at = (date, h, m = 0) => {
    date.setHours(h, m, 0, 0);
    return date.getTime();
  };
  switch (preset) {
    case "later-today":
      return now.getTime() + 3 * 3600_000;
    case "this-evening": {
      const t = at(new Date(now.getTime()), 18);
      return t > now.getTime() ? t : t + 24 * 3600_000; // past 18:00 → tomorrow evening
    }
    case "tomorrow":
      d.setDate(d.getDate() + 1);
      return at(d, 9);
    case "weekend": {
      // next Saturday (if today is Sat, next one)
      const days = (6 - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + days);
      return at(d, 9);
    }
    case "next-week": {
      // next Monday
      const days = (1 - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + days);
      return at(d, 9);
    }
    default:
      throw new Error(`Unknown preset: ${preset}`);
  }
}

/**
 * The recurrence rules a snooze can carry, as [value, label] pairs — the single
 * source of truth shared by every picker (dashboard, popup) and the chip label.
 * Encodings: "" = one-shot, "daily", "weekly", "weeks:N" (every N weeks),
 * "weekday:D" (every occurrence of weekday D, 0=Sun … 6=Sat).
 * @type {[string, string][]}
 */
export const RECURRENCE_OPTIONS = [
  ["", "Don’t repeat"],
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["weeks:2", "Every 2 weeks"],
  ["weeks:3", "Every 3 weeks"],
  ["weeks:4", "Every 4 weeks"],
  ["weekday:1", "Every Monday"],
  ["weekday:2", "Every Tuesday"],
  ["weekday:3", "Every Wednesday"],
  ["weekday:4", "Every Thursday"],
  ["weekday:5", "Every Friday"],
  ["weekday:6", "Every Saturday"],
  ["weekday:0", "Every Sunday"]
];

/** Human label for a stored recurrence value (falls back to the raw value). */
export function recurrenceLabel(value) {
  if (!value) return "";
  const hit = RECURRENCE_OPTIONS.find(([v]) => v === value);
  return hit ? hit[1] : value;
}

/**
 * Create a Snooze and schedule its alarm. Window bundles use `tabs` and an
 * empty scalar URL. Single-tab records use url/title and may retain a full ref.
 * @param {{url?: string, title: string, favIconUrl?: string, dueAt: number, tabs?: import("./types.js").TabRef[], recurrence?: string}} opts
 * @param {{placement?: import("./types.js").SnoozePlacement|null}} [runtime]
 * @returns {Promise<import("./types.js").Snooze>}
 */
export async function createSnooze(opts, { placement = null } = {}) {
  const snooze = buildSnooze(await newMeta(), opts);
  const localPlacement = placementForSnooze(snooze, placement);
  const persisted = { ...snooze, modifiedAt: Date.now() };
  if (localPlacement) {
    await mutateStores([STORE_KEYS.snoozes, SNOOZE_PLACEMENT_KEY], (maps) => {
      const snoozes = {
        ...(maps[STORE_KEYS.snoozes] ?? {}),
        [snooze.id]: persisted
      };
      const placements = { ...snoozePlacementMap(maps[SNOOZE_PLACEMENT_KEY]) };
      for (const id of Object.keys(placements)) {
        if (!snoozes[id] || snoozes[id].deletedAt) delete placements[id];
      }
      placements[snooze.id] = localPlacement;
      return {
        [STORE_KEYS.snoozes]: snoozes,
        [SNOOZE_PLACEMENT_KEY]: placements
      };
    });
  } else {
    await mutateStores([STORE_KEYS.snoozes], (maps) => ({
      [STORE_KEYS.snoozes]: {
        ...(maps[STORE_KEYS.snoozes] ?? {}),
        [persisted.id]: persisted
      }
    }));
  }
  await chrome.alarms.create(SNOOZE_ALARM_PREFIX + snooze.id, { when: snooze.dueAt });
  return structuredClone(persisted);
}

/**
 * Persist a live-tab Snooze and its pending close receipt in one commit. The
 * alarm and browser effects deliberately remain after that durable boundary.
 * @param {{url?: string, title: string, favIconUrl?: string, dueAt: number, tabs?: import("./types.js").TabRef[], recurrence?: string}} opts
 * @param {chrome.tabs.Tab[]} liveTabs
 * @param {{placement?: import("./types.js").SnoozePlacement|null,label:string}} runtime
 * @returns {Promise<{snooze:import("./types.js").Snooze,entryId:string}>}
 */
export async function createLiveSnoozeWithReceipt(
  opts,
  liveTabs,
  { placement = null, label } = {}
) {
  const snooze = buildSnooze(await newMeta(), opts);
  const receiptTabs = closeReceiptTabs(liveTabs);
  const entry = makeJournalEntry(label || `Snoozed “${snooze.title}”`, {
    dels: [{ store: STORE_KEYS.snoozes, id: snooze.id }],
    reopen: receiptTabs.length ? [receiptTabs.map((tab) => tab.ref)] : []
  }, {
    forwardReceipt: { kind: "close-tabs", status: "pending", tabs: receiptTabs }
  });
  const localPlacement = placementForSnooze(snooze, placement);
  const keys = [STORE_KEYS.snoozes, JOURNAL_KEY,
    ...(localPlacement ? [SNOOZE_PLACEMENT_KEY] : [])];
  const now = Date.now();
  const persisted = { ...snooze, modifiedAt: now };
  await mutateStores(keys, (maps) => {
    const snoozes = {
      ...(maps[STORE_KEYS.snoozes] ?? {}),
      [snooze.id]: persisted
    };
    const sets = {
      [STORE_KEYS.snoozes]: snoozes,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
    if (localPlacement) {
      const placements = { ...snoozePlacementMap(maps[SNOOZE_PLACEMENT_KEY]) };
      for (const id of Object.keys(placements)) {
        if (!snoozes[id] || snoozes[id].deletedAt) delete placements[id];
      }
      placements[snooze.id] = localPlacement;
      sets[SNOOZE_PLACEMENT_KEY] = placements;
    }
    return sets;
  });
  await chrome.alarms.create(SNOOZE_ALARM_PREFIX + snooze.id, { when: snooze.dueAt });
  return { snooze: structuredClone(persisted), entryId: entry.id };
}

/**
 * Build a Snooze record without I/O. Callers commit the record with any source
 * changes and Undo receipt before scheduling its alarm.
 * @param {import("./types.js").Meta} meta
 * @param {{url?: string, title: string, favIconUrl?: string, dueAt: number, tabs?: import("./types.js").TabRef[], sessionId?: string, recurrence?: string}} opts
 * @returns {import("./types.js").Snooze}
 */
export function buildSnooze(meta, opts) {
  return {
    ...meta,
    url: opts.url ?? "",
    title: opts.title,
    dueAt: opts.dueAt,
    ...(opts.favIconUrl ? { favIconUrl: opts.favIconUrl } : {}),
    ...(opts.tabs ? { tabs: opts.tabs } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.recurrence ? { recurrence: opts.recurrence } : {})
  };
}

/**
 * Cancel an exact current Snooze and journal its fresh inverse in one commit.
 * An active delivery refuses the edit; the alarm clears after persistence.
 * @param {import("./types.js").Snooze} snooze
 * @returns {Promise<{ok:true,snooze:import("./types.js").Snooze,undoId:string}|{ok:false,reason:string}>}
 */
export async function cancelSnoozeJournaled(snooze) {
  const expected = structuredClone(snooze);
  const now = Date.now();
  let result = { ok: false, reason: "missing" };
  await mutateStores([STORE_KEYS.snoozes, SNOOZE_DELIVERY_KEY, JOURNAL_KEY], (maps) => {
    const map = { ...(maps[STORE_KEYS.snoozes] ?? {}) };
    const current = map[expected.id];
    if (!current || current.deletedAt) return null;
    if (!sameSnoozeRecord(current, expected)) {
      result = { ok: false, reason: "stale" };
      return null;
    }
    if (snoozeDeliveryConflict(
      maps[SNOOZE_DELIVERY_KEY]?.[current.id], current) === "busy") {
      result = { ok: false, reason: "busy" };
      return null;
    }
    const entry = makeJournalEntry(`Cancelled snooze “${current.title || current.url}”`,
      { puts: [{ store: STORE_KEYS.snoozes, item: structuredClone(current) }] });
    map[current.id] = { ...current, deletedAt: now, modifiedAt: now };
    result = { ok: true, snooze: structuredClone(map[current.id]), undoId: entry.id };
    return {
      [STORE_KEYS.snoozes]: map,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  if (result.ok) {
    try { await chrome.alarms.clear(SNOOZE_ALARM_PREFIX + expected.id); }
    catch { /* the durable tombstone makes any orphan alarm a no-op */ }
  }
  return result;
}

/**
 * P2g-5 — snooze a SESSION: a scheduled "Restore all". The session is a
 * template — never mutated or consumed; the snooze references it by id and
 * reads it live at fire time. One snooze per session (re-snoozing replaces
 * the schedule via the caller using reschedule). Journaled (undo removes
 * the snooze; the session was never touched).
 * @param {import("./types.js").Session} session
 * @param {number} dueAt @param {string} [recurrence]
 * @returns {Promise<import("./types.js").Snooze|null>}
 */
export async function snoozeSession(session, dueAt, recurrence) {
  if (session.auto) return null; // snapshots are immutable — and not schedulable
  const snooze = buildSnooze(await newMeta(), {
    title: session.name, dueAt, sessionId: session.id,
    ...(recurrence ? { recurrence } : {})
  });
  // E2-0c: record + undo entry in ONE atomic set; the alarm is scheduled after
  // (a missed alarm is re-asserted by sweepOverdueSnoozes — existing recovery).
  const entry = makeJournalEntry(`Snoozed session “${session.name}”`, {
    dels: [{ store: STORE_KEYS.snoozes, id: snooze.id }] });
  const now = Date.now();
  const persisted = { ...snooze, modifiedAt: now };
  await mutateStores([STORE_KEYS.snoozes, JOURNAL_KEY], (maps) => ({
    [STORE_KEYS.snoozes]: {
      ...(maps[STORE_KEYS.snoozes] ?? {}),
      [snooze.id]: persisted
    },
    [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
  }));
  await chrome.alarms.create(SNOOZE_ALARM_PREFIX + snooze.id, { when: dueAt });
  return structuredClone(persisted);
}

/**
 * Reschedule an exact current Snooze. An uncertain completed occurrence can be
 * superseded by a deliberate new due time; active effects refuse the edit.
 * @param {import("./types.js").Snooze} snooze
 * @param {number} newDueAt
 * @returns {Promise<{ok:true,snooze:import("./types.js").Snooze}|{ok:false,reason:string}>}
 */
export async function rescheduleSnooze(snooze, newDueAt) {
  const expected = structuredClone(snooze);
  if (!Number.isFinite(newDueAt)) return { ok: false, reason: "invalid" };
  const now = Date.now();
  let result = { ok: false, reason: "missing" };
  await mutateStores(
    [STORE_KEYS.snoozes, SNOOZE_DELIVERY_KEY, SNOOZE_PLACEMENT_KEY],
    (maps) => {
      const snoozes = { ...(maps[STORE_KEYS.snoozes] ?? {}) };
      const current = snoozes[expected.id];
      if (!current || current.deletedAt) return null;
      if (!sameSnoozeRecord(current, expected)) {
        result = { ok: false, reason: "stale" };
        return null;
      }
      if (snoozeDeliveryConflict(
        maps[SNOOZE_DELIVERY_KEY]?.[current.id], current) === "busy") {
        result = { ok: false, reason: "busy" };
        return null;
      }
      const updated = { ...current, dueAt: newDueAt, modifiedAt: now };
      snoozes[current.id] = updated;
      const placements = { ...snoozePlacementMap(maps[SNOOZE_PLACEMENT_KEY]) };
      if (placements[current.id]) {
        placements[current.id] = { ...placements[current.id], occurrenceDueAt: newDueAt };
      }
      result = { ok: true, snooze: structuredClone(updated) };
      return {
        [STORE_KEYS.snoozes]: snoozes,
        ...(placements[current.id] ? { [SNOOZE_PLACEMENT_KEY]: placements } : {})
      };
    }
  );
  if (result.ok) {
    try { await chrome.alarms.create(SNOOZE_ALARM_PREFIX + expected.id, { when: newDueAt }); }
    catch { /* startup reasserts the already-durable due time */ }
  }
  return result;
}

/**
 * @typedef {{snooze: import("./types.js").Snooze, indexes: number[]}} SnoozeSelection
 */

/**
 * Compatibility wrapper for the worker-owned persisted bulk-Wake operation.
 * Throws with `opened` and `reason` after partial or ambiguous browser effects.
 * @param {SnoozeSelection[]} selections
 * @returns {Promise<number>} tabs woken
 */
export async function wakeSnoozeTabs(selections) {
  const result = await wakeSnoozeSelections(structuredClone(selections));
  if (result.status === "interrupted" || result.status === "uncertain") {
    const error = new Error("Some tabs may already have opened. Check your open tabs, then reschedule this Snooze if needed.");
    error.name = "SnoozeWakeIncompleteError";
    error.reason = result.status;
    error.opened = result.opened;
    throw error;
  }
  return result.status === "delivered" ? result.opened : 0;
}

/**
 * Drop exact selected occurrences without opening them. Every source and index
 * is validated under the lock; the fresh inverse is committed atomically.
 * @param {SnoozeSelection[]} selections
 * @returns {Promise<number>} tabs cancelled
 */
export async function cancelSnoozeTabs(selections) {
  const grouped = normalizedSnoozeSelections(structuredClone(selections));
  if (!grouped?.length) return 0;
  const now = Date.now();
  const emptied = [];
  let cancelled = 0;
  await mutateStores(
    [STORE_KEYS.snoozes, SNOOZE_DELIVERY_KEY, JOURNAL_KEY],
    (maps) => {
      const map = { ...(maps[STORE_KEYS.snoozes] ?? {}) };
      for (const selection of grouped) {
        const current = map[selection.snooze.id];
        if (!current || current.deletedAt || !sameSnoozeRecord(current, selection.snooze)) {
          return null;
        }
        if (selection.indexes.some((index) => !snoozeRefs(current)[index])) return null;
        if (snoozeDeliveryConflict(
          maps[SNOOZE_DELIVERY_KEY]?.[current.id], current) === "busy") return null;
      }
      const puts = [];
      for (const selection of grouped) {
        const current = map[selection.snooze.id];
        puts.push({ store: STORE_KEYS.snoozes, item: structuredClone(current) });
        const split = snoozeWithoutIndexes(current, selection.indexes, now);
        map[current.id] = split.snooze;
        cancelled += selection.indexes.length;
        if (split.emptied) emptied.push(current.id);
      }
      const entry = makeJournalEntry(
        `Cancelled ${cancelled} snoozed tab${cancelled === 1 ? "" : "s"}`, { puts });
      return {
        [STORE_KEYS.snoozes]: map,
        [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
      };
    }
  );
  for (const id of emptied) {
    try { await chrome.alarms.clear(SNOOZE_ALARM_PREFIX + id); }
    catch { /* the durable tombstone makes any orphan alarm a no-op */ }
  }
  return cancelled;
}

/**
 * Fire everything overdue (run at startup — covers wakes missed while the
 * browser was closed) and ensure alarms exist for pending snoozes.
 */
export async function sweepOverdueSnoozes() {
  /** @type {import("./types.js").Snooze[]} */
  const snoozes = await listItems(STORE_KEYS.snoozes);
  const now = Date.now();
  for (const s of snoozes) {
    if (s.dueAt <= now) {
      await fireSnooze(s.id, { manual: false });
    } else {
      // re-assert the alarm (cheap, idempotent) — alarms can vanish on update
      await chrome.alarms.create(SNOOZE_ALARM_PREFIX + s.id, { when: s.dueAt });
    }
  }
}
