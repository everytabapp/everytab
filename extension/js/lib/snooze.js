import { STORE_KEYS } from "./types.js";
import { newMeta, upsertItem, listItems, tombstoneItem, mutateStores } from "./store.js";
import { COUNTERS_KEY, bumpedCounters } from "./counters.js";
import { JOURNAL_KEY, makeJournalEntry, appendedJournal } from "./journal.js";
import { SNOOZE_ALARM_PREFIX, fireSnooze } from "./snooze-delivery.js";
export { nextOccurrence } from "./snooze-schedule.js";
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
 * Advance a recurring snooze to its next occurrence strictly after `from`,
 * preserving the original clock time. Supports:
 *   "daily", "weekly", "weeks:N" (every N weeks), "weekday:D" (next weekday D).
 * @param {number} dueAt @param {string} recurrence @param {number} from
 */
/**
 * Create a snooze and schedule its alarm. Pass `tabs` for a whole-window snooze
 * (P2b-1) — additive; a single-tab snooze passes `url`/`title` and no `tabs`.
 * @param {{url?: string, title: string, dueAt: number, tabs?: import("./types.js").TabRef[], recurrence?: string}} opts
 * @returns {Promise<import("./types.js").Snooze>}
 */
export async function createSnooze(opts) {
  const snooze = buildSnooze(await newMeta(), opts);
  await upsertItem(STORE_KEYS.snoozes, snooze);
  await chrome.alarms.create(SNOOZE_ALARM_PREFIX + snooze.id, { when: snooze.dueAt });
  return snooze;
}

/**
 * E2-0c pure form: build the snooze record from prepared meta (no I/O).
 * createSnooze delegates here; atomic domain commits (actions.js
 * snoozeTabRefs) embed the result in ONE set and schedule alarms after.
 * @param {import("./types.js").Meta} meta
 * @param {{url?: string, title: string, dueAt: number, tabs?: import("./types.js").TabRef[], sessionId?: string, recurrence?: string}} opts
 * @returns {import("./types.js").Snooze}
 */
export function buildSnooze(meta, opts) {
  return {
    ...meta,
    url: opts.url ?? "",
    title: opts.title,
    dueAt: opts.dueAt,
    ...(opts.tabs ? { tabs: opts.tabs } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.recurrence ? { recurrence: opts.recurrence } : {})
  };
}

/**
 * E2-0c pure: snoozes map with picked refs split out of `snooze` — the
 * remainder keeps its schedule/recurrence and re-titles; an emptied snooze
 * tombstones (the caller clears its alarm AFTER the commit). Mirrors
 * splitSnooze exactly.
 * @param {Record<string, import("./types.js").Snooze>} map
 * @param {import("./types.js").Snooze} snooze @param {number[]} indexes
 * @param {number} now
 */
function snoozeMapWithSplit(map, snooze, indexes, now) {
  const drop = new Set(indexes);
  const keep = snoozeRefs(snooze).filter((_, i) => !drop.has(i));
  const next = { ...map };
  if (keep.length === 0) {
    const cur = next[snooze.id];
    if (cur) next[snooze.id] = { ...cur, deletedAt: now, modifiedAt: now };
    return { map: next, emptied: true };
  }
  next[snooze.id] = {
    ...snooze, tabs: keep,
    title: keep.length > 1 ? `Window (${keep.length} tabs)` : keep[0].title || keep[0].url,
    modifiedAt: now
  };
  return { map: next, emptied: false };
}

/** @param {string} id */
export async function cancelSnooze(id) {
  await chrome.alarms.clear(SNOOZE_ALARM_PREFIX + id);
  await tombstoneItem(STORE_KEYS.snoozes, id);
}

/**
 * P2g-5 — cancel with an undo path: journals the pre-cancel snooze so the ×
 * is reversible ("every mutation is journaled"). If undo revives it, the
 * alarm is re-asserted by sweepOverdueSnoozes (same recovery path as always).
 * @param {import("./types.js").Snooze} snooze
 */
export async function cancelSnoozeJournaled(snooze) {
  await chrome.alarms.clear(SNOOZE_ALARM_PREFIX + snooze.id);
  // E2-0c: tombstone + undo entry in ONE atomic set.
  const entry = makeJournalEntry(`Cancelled snooze “${snooze.title || snooze.url}”`,
    { puts: [{ store: STORE_KEYS.snoozes, item: snooze }] });
  const now = Date.now();
  await mutateStores([STORE_KEYS.snoozes, JOURNAL_KEY], (maps) => {
    const map = { ...(maps[STORE_KEYS.snoozes] ?? {}) };
    const cur = map[snooze.id];
    if (cur) map[snooze.id] = { ...cur, deletedAt: now, modifiedAt: now };
    return { [STORE_KEYS.snoozes]: map, [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry) };
  });
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
  await mutateStores([STORE_KEYS.snoozes, JOURNAL_KEY], (maps) => ({
    [STORE_KEYS.snoozes]: {
      ...(maps[STORE_KEYS.snoozes] ?? {}),
      [snooze.id]: { ...snooze, modifiedAt: now }
    },
    [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
  }));
  await chrome.alarms.create(SNOOZE_ALARM_PREFIX + snooze.id, { when: dueAt });
  return snooze;
}

/** @param {import("./types.js").Snooze} snooze @param {number} newDueAt */
export async function rescheduleSnooze(snooze, newDueAt) {
  await upsertItem(STORE_KEYS.snoozes, { ...snooze, dueAt: newDueAt });
  await chrome.alarms.create(SNOOZE_ALARM_PREFIX + snooze.id, { when: newDueAt });
}

/**
 * Fire a snooze: reopen the tab, notify, then reschedule (recurring) or
 * tombstone (one-shot).
 * @param {string} id
 */
/* ---------- P2g-3 (U7): tab-grain selection ops on snoozes ---------- */

/**
 * A snooze's tabs at tab grain: the bundle's `tabs[]`, or the single
 * url/title as a one-element list (mirrors `fromSnoozes`).
 * @param {import("./types.js").Snooze} s
 * @returns {import("./types.js").TabRef[]}
 */
export function snoozeRefs(s) {
  return Array.isArray(s.tabs) && s.tabs.length > 0
    ? s.tabs
    : [{ url: s.url, title: s.title || s.url }];
}

/**
 * Split picked tabs OUT of a snooze (store op — callers journal). The
 * remainder keeps its dueAt/recurrence and its alarm; an emptied snooze
 * tombstones and its alarm clears. A shrunk bundle keeps `tabs[]` (a
 * one-tab bundle is valid P2b-1 schema) and re-titles itself.
 * @param {import("./types.js").Snooze} snooze @param {number[]} indexes
 * @returns {Promise<import("./types.js").Snooze|null>} the remainder, or null
 */
export async function splitSnooze(snooze, indexes) {
  const drop = new Set(indexes);
  const keep = snoozeRefs(snooze).filter((_, i) => !drop.has(i));
  if (keep.length === 0) {
    await chrome.alarms.clear(SNOOZE_ALARM_PREFIX + snooze.id);
    await tombstoneItem(STORE_KEYS.snoozes, snooze.id);
    return null;
  }
  const updated = { ...snooze, tabs: keep,
    title: keep.length > 1 ? `Window (${keep.length} tabs)` : keep[0].title || keep[0].url };
  await upsertItem(STORE_KEYS.snoozes, updated);
  return updated;
}

/**
 * @typedef {{snooze: import("./types.js").Snooze, indexes: number[]}} SnoozeSelection
 */

/**
 * U7 bulk Wake: open the picked tabs NOW (one window per source bundle when
 * several, else a background tab), then split them out of their snoozes (subset =
 * split, an exit). A fully-picked snooze ends — recurring included: a manual
 * wake of everything is the user closing it out, and Undo brings it back.
 * ONE journal entry restores the pre-split snoozes. Undo cannot close tabs it
 * opened (same as Restore).
 * @param {SnoozeSelection[]} selections
 * @returns {Promise<number>} tabs woken
 */
export async function wakeSnoozeTabs(selections) {
  const puts = [];
  const applied = [];
  let woken = 0;
  for (const { snooze, indexes } of selections) {
    const all = snoozeRefs(snooze);
    const refs = indexes.map((i) => all[i]).filter(Boolean);
    if (refs.length === 0) continue;
    puts.push({ store: STORE_KEYS.snoozes, item: snooze });
    const urls = refs.map((r) => r.url).filter((u) => /^https?:/.test(u ?? ""));
    if (urls.length > 1) await chrome.windows.create({ url: urls });
    else if (urls.length === 1) await chrome.tabs.create({ url: urls[0], active: false });
    applied.push({ snooze, indexes });
    woken += refs.length;
  }
  if (woken === 0) return 0;
  // E2-0c: every split + counter + the ONE undo entry are a single atomic
  // commit; emptied snoozes' alarms clear after (an orphan
  // alarm fires as a harmless no-op — the snooze is tombstoned).
  const entry = makeJournalEntry(`Woke ${woken} snoozed tab${woken === 1 ? "" : "s"}`, { puts });
  const now = Date.now();
  const emptied = [];
  await mutateStores(
    [STORE_KEYS.snoozes, COUNTERS_KEY, JOURNAL_KEY],
    (maps) => {
      let map = maps[STORE_KEYS.snoozes] ?? {};
      for (const { snooze, indexes } of applied) {
        const r = snoozeMapWithSplit(map, snooze, indexes, now);
        map = r.map;
        if (r.emptied) emptied.push(snooze.id);
      }
      return {
        [STORE_KEYS.snoozes]: map,
        [COUNTERS_KEY]: bumpedCounters(maps[COUNTERS_KEY], "snoozesFired"),
        [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
      };
    }
  );
  for (const id of emptied) await chrome.alarms.clear(SNOOZE_ALARM_PREFIX + id);
  return woken;
}

/**
 * U7 bulk Cancel: drop the picked tabs from their snoozes without opening
 * anything (subset = split; emptied snooze tombstones, alarm cleared).
 * ONE journal entry restores the pre-split snoozes. (If Undo revives a
 * fully-cancelled snooze, its alarm is re-asserted by sweepOverdueSnoozes
 * at startup — same recovery path alarms already rely on.)
 * @param {SnoozeSelection[]} selections
 * @returns {Promise<number>} tabs cancelled
 */
export async function cancelSnoozeTabs(selections) {
  const puts = [];
  const applied = [];
  let cancelled = 0;
  for (const { snooze, indexes } of selections) {
    if (indexes.length === 0) continue;
    puts.push({ store: STORE_KEYS.snoozes, item: snooze });
    applied.push({ snooze, indexes });
    cancelled += indexes.length;
  }
  if (cancelled === 0) return 0;
  // E2-0c: every split + the ONE undo entry in a single atomic commit;
  // emptied snoozes' alarms clear after (orphan alarms are harmless no-ops).
  const entry = makeJournalEntry(
    `Cancelled ${cancelled} snoozed tab${cancelled === 1 ? "" : "s"}`, { puts });
  const now = Date.now();
  const emptied = [];
  await mutateStores([STORE_KEYS.snoozes, JOURNAL_KEY], (maps) => {
    let map = maps[STORE_KEYS.snoozes] ?? {};
    for (const { snooze, indexes } of applied) {
      const r = snoozeMapWithSplit(map, snooze, indexes, now);
      map = r.map;
      if (r.emptied) emptied.push(snooze.id);
    }
    return { [STORE_KEYS.snoozes]: map, [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry) };
  });
  for (const id of emptied) await chrome.alarms.clear(SNOOZE_ALARM_PREFIX + id);
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
