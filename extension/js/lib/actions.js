import { STORE_KEYS } from "./types.js";
import { newMeta, upsertItem, tombstoneItem, mutateStores } from "./store.js";
import { isSaveableTab, canonicalRef } from "./tabs.js";
import { COUNTERS_KEY, bumpedCounters } from "./counters.js";
import { LABEL_META_KEY, touchedLabelMeta } from "./label-meta.js";
import { JOURNAL_KEY, makeJournalEntry, appendedJournal } from "./journal.js";
import { buildSnooze, SNOOZE_ALARM_PREFIX } from "./snooze.js";
import { buildSessionFromWindows } from "./sessions.js";
import { dashboardHref } from "./newtab-focus.js";

/**
 * E2-0c — pure form of removeTabsFromItem for use inside a mutateStores
 * mutator: the store map with `item`'s selected tabs removed (updated in
 * place; tombstoned when emptied). Mirrors removeTabsFromItem exactly: the
 * tombstone path marks the FRESH map record (missing record = no-op), the
 * update path writes the caller's item with a fresh modifiedAt.
 * Exported for other domain modules' atomic commits (labels.js archive exit).
 * @param {Record<string, import("./types.js").InboxItem>} map
 * @param {import("./types.js").InboxItem} item @param {number[]} indexes
 * @param {number} now
 */
export function mapWithTabsRemoved(map, item, indexes, now) {
  const drop = new Set(indexes);
  const tabs = item.tabs.filter((_, i) => !drop.has(i));
  const next = { ...map };
  if (tabs.length === 0) {
    const cur = next[item.id];
    if (cur) next[item.id] = { ...cur, deletedAt: now, modifiedAt: now };
    return next;
  }
  next[item.id] = { ...item, tabs, kind: tabs.length > 1 ? "window" : "tab", modifiedAt: now };
  return next;
}

/** Device-local receipts for the narrow Focus save transaction. Never vault-synced. */
export const FOCUS_SAVE_RECEIPTS_KEY = "focusSaveReceipts";
const FOCUS_SAVE_RECEIPT_CAP = 200;
const JOURNAL_CAP = 50;

/** @param {chrome.tabs.Tab} t */
function isDumpable(t) {
  if (t.pinned) return false;
  return isSaveableTab(t);
}

/**
 * One-click dump (PRD §3.1): close all unpinned http(s) tabs of the window,
 * save them as one Inbox item. Window bundle if >1 tab.
 * MUST run in the background worker — callers in popups send a message.
 * @param {number} [windowId]
 * @returns {Promise<number>} number of tabs dumped
 */
export async function dumpWindow(windowId) {
  const tabs = await chrome.tabs.query(
    windowId !== undefined ? { windowId } : { currentWindow: true }
  );
  const toDump = tabs.filter(isDumpable);
  if (toDump.length === 0) return 0;

  /** @type {import("./types.js").InboxItem} */
  const item = {
    ...(await newMeta()),
    kind: toDump.length > 1 ? "window" : "tab",
    tabs: toDump.map(canonicalRef),
    source: "dump",
    labels: []
  };
  // E2-0c: Inbox item + counter + its undo entry are ONE atomic commit,
  // persisted BEFORE any tab closes (nothing-lost ordering preserved).
  const entry = makeJournalEntry(
    `Saved ${toDump.length} tab${toDump.length === 1 ? "" : "s"} to the Inbox`,
    { dels: [{ store: STORE_KEYS.inbox, id: item.id }], reopen: [item.tabs] }
  );
  const now = Date.now();
  await mutateStores([STORE_KEYS.inbox, COUNTERS_KEY, JOURNAL_KEY], (maps) => ({
    [STORE_KEYS.inbox]: { ...(maps[STORE_KEYS.inbox] ?? {}), [item.id]: { ...item, modifiedAt: now } },
    [COUNTERS_KEY]: bumpedCounters(maps[COUNTERS_KEY], "tabsDumped", toDump.length),
    [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
  }));

  // Open the dashboard first so the window survives if every tab closes.
  await openDashboard();
  await chrome.tabs.remove(toDump.map((t) => t.id));
  return toDump.length;
}

/**
 * Dump a single tab to the Inbox (explicit user action, so pinned is allowed).
 * MUST run in the background worker.
 * @param {number} tabId
 * @returns {Promise<number>} 1 if dumped, 0 if not dumpable
 */
export async function dumpTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSaveableTab(tab)) return 0;

  /** @type {import("./types.js").InboxItem} */
  const item = {
    ...(await newMeta()),
    kind: "tab",
    tabs: [canonicalRef(tab)],
    source: "manual",
    labels: []
  };
  // E2-0c: item + counter + undo entry in ONE atomic commit (persist-first).
  const entry = makeJournalEntry("Saved a tab to the Inbox", {
    dels: [{ store: STORE_KEYS.inbox, id: item.id }],
    reopen: [item.tabs]
  });
  const now = Date.now();
  await mutateStores([STORE_KEYS.inbox, COUNTERS_KEY, JOURNAL_KEY], (maps) => ({
    [STORE_KEYS.inbox]: { ...(maps[STORE_KEYS.inbox] ?? {}), [item.id]: { ...item, modifiedAt: now } },
    [COUNTERS_KEY]: bumpedCounters(maps[COUNTERS_KEY], "tabsDumped"),
    [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
  }));

  // If it's the window's last tab, open the dashboard so the window survives.
  const windowTabs = await chrome.tabs.query({ windowId: tab.windowId });
  if (windowTabs.length <= 1) await openDashboard();
  await chrome.tabs.remove(tabId);
  return 1;
}

/**
 * P2e-1 — Split: remove a SET of tabs (by index) from an item in ANY store
 * (Inbox, Archive, …). The acted-on tabs leave; the rest stay (kind downgrades
 * to "tab" at 1 left); an emptied item tombstones itself. Pure store mutation —
 * no journal; callers that are an "exit" record the pre-split item in `puts` so
 * Undo restores it exactly. Store-generic so the unified list (P2e) can run the
 * same tab-grain exits over the Archive as over the Inbox.
 * @param {string} store STORE_KEYS.*
 * @param {import("./types.js").InboxItem} item
 * @param {number[]} indexes
 * @returns {Promise<import("./types.js").InboxItem|null>} the remaining item, or null if emptied
 */
export async function removeTabsFromItem(store, item, indexes) {
  const drop = new Set(indexes);
  const tabs = item.tabs.filter((_, i) => !drop.has(i));
  if (tabs.length === 0) {
    await tombstoneItem(store, item.id);
    return null;
  }
  const updated = { ...item, tabs, kind: tabs.length > 1 ? "window" : "tab" };
  await upsertItem(store, updated);
  return updated;
}

/**
 * P2d-1 — Split a SET of tabs out of an Inbox item. Thin wrapper over the
 * store-generic `removeTabsFromItem` (kept for existing callers/tests).
 * @param {import("./types.js").InboxItem} item @param {number[]} indexes
 * @returns {Promise<import("./types.js").InboxItem|null>}
 */
export async function removeTabsFromInboxItem(item, indexes) {
  return removeTabsFromItem(STORE_KEYS.inbox, item, indexes);
}

/**
 * Remove one tab from an Inbox item (by index). Empty items are tombstoned.
 * Thin wrapper over `removeTabsFromInboxItem` (kept for existing callers).
 * @param {import("./types.js").InboxItem} item @param {number} index
 */
export async function removeTabFromInboxItem(item, index) {
  return removeTabsFromInboxItem(item, [index]);
}

/**
 * @typedef {{item: import("./types.js").InboxItem, indexes: number[]}} TabSelection
 * A per-source-item slice of a tab-level triage selection.
 */

/**
 * P2d-1 — Restore exit at tab grain. Opens each source's selected tabs, grouping
 * by source item so window structure survives: a window bundle's picked tabs
 * reopen as one window, loose tabs as tabs. Splits each item; Undo (puts the
 * pre-split items) returns them to their store. `store` (P2e-1) defaults to the
 * Inbox but the unified list passes STORE_KEYS.archive to restore-out of Archive.
 * @param {TabSelection[]} sources @param {string} [store] STORE_KEYS.* (default inbox)
 * @returns {Promise<number>} tabs restored
 */
export async function restoreTabsFromItems(sources, store = STORE_KEYS.inbox) {
  const puts = [];
  /** @type {TabSelection[]} */
  const applied = [];
  let restored = 0;
  for (const { item, indexes } of sources) {
    const refs = indexes.map((i) => item.tabs[i]).filter(Boolean);
    const urls = refs.map((t) => t.url).filter((u) => /^https?:/.test(u ?? ""));
    if (urls.length === 0) continue;
    puts.push({ store, item });
    if (item.kind === "window" && urls.length > 1) {
      await chrome.windows.create({ url: urls });
    } else {
      for (const url of urls) await chrome.tabs.create({ url });
    }
    applied.push({ item, indexes });
    restored += refs.length;
  }
  if (restored === 0) return 0;
  // E2-0c: every split + the undo entry commit as ONE set, AFTER the tabs
  // opened (tab side effects never run under the lock; a failed open now
  // leaves all source items intact instead of split-without-journal).
  const entry = makeJournalEntry(`Restored ${restored} tab${restored === 1 ? "" : "s"}`, { puts });
  const now = Date.now();
  await mutateStores([store, JOURNAL_KEY], (maps) => {
    let map = maps[store] ?? {};
    for (const { item, indexes } of applied) map = mapWithTabsRemoved(map, item, indexes, now);
    return { [store]: map, [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry) };
  });
  return restored;
}

/**
 * P2d-1 — Delete exit at tab grain. Splits the selected tabs out of each source
 * item (emptied items tombstone). Journal-backed: Undo revives the pre-split
 * items, so nothing is truly lost until the journal ages out. `store` (P2e-1)
 * defaults to the Inbox; the unified list passes STORE_KEYS.archive for Archive.
 * @param {TabSelection[]} sources @param {string} [store] STORE_KEYS.* (default inbox)
 * @returns {Promise<number>} tabs deleted
 */
export async function deleteTabsFromItems(sources, store = STORE_KEYS.inbox) {
  const puts = [];
  const applied = [];
  let deleted = 0;
  for (const { item, indexes } of sources) {
    if (indexes.length === 0) continue;
    puts.push({ store, item });
    applied.push({ item, indexes });
    deleted += indexes.length;
  }
  if (deleted === 0) return 0;
  // E2-0c: all splits + the undo entry are ONE atomic commit — a crash can no
  // longer delete tabs without the journal entry that revives them.
  const entry = makeJournalEntry(`Deleted ${deleted} tab${deleted === 1 ? "" : "s"}`, { puts });
  const now = Date.now();
  await mutateStores([store, JOURNAL_KEY], (maps) => {
    let map = maps[store] ?? {};
    for (const { item, indexes } of applied) map = mapWithTabsRemoved(map, item, indexes, now);
    return { [store]: map, [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry) };
  });
  return deleted;
}

/**
 * P2d-1 — Snooze exit at tab grain: ONE snooze per source item (bundles
 * preserved as a window snooze carrying `tabs[]`, loose tabs as a single
 * snooze), then split them out. Journal-backed: Undo revives the pre-split
 * items and tombstones the snoozes created.
 * @param {TabSelection[]} sources @param {number} dueAt @param {string} [recurrence]
 * @returns {Promise<number>} tabs snoozed
 */
export async function snoozeTabRefs(sources, dueAt, recurrence) {
  const puts = [];
  const dels = [];
  const applied = [];
  let snoozed = 0;
  const snoozes = [];
  for (const { item, indexes } of sources) {
    const refs = indexes.map((i) => item.tabs[i]).filter(Boolean);
    if (refs.length === 0) continue;
    puts.push({ store: STORE_KEYS.inbox, item });
    const snooze = buildSnooze(await newMeta(), refs.length > 1
      ? { title: `Window (${refs.length} tabs)`, dueAt, tabs: refs,
          ...(recurrence ? { recurrence } : {}) }
      : { url: refs[0].url, title: refs[0].title || refs[0].url, dueAt,
          ...(recurrence ? { recurrence } : {}) });
    snoozes.push(snooze);
    dels.push({ store: STORE_KEYS.snoozes, id: snooze.id });
    applied.push({ item, indexes });
    snoozed += refs.length;
  }
  if (snoozed === 0) return 0;
  // E2-0c-5: snooze records + all splits + the undo entry are ONE atomic
  // commit; alarms are scheduled AFTER the commit (a missed alarm is
  // re-asserted by sweepOverdueSnoozes at startup — existing recovery).
  const entry = makeJournalEntry(`Snoozed ${snoozed} tab${snoozed === 1 ? "" : "s"}`, { puts, dels });
  const now = Date.now();
  await mutateStores([STORE_KEYS.inbox, STORE_KEYS.snoozes, JOURNAL_KEY], (maps) => {
    let map = maps[STORE_KEYS.inbox] ?? {};
    const snoozeMap = { ...(maps[STORE_KEYS.snoozes] ?? {}) };
    for (const s of snoozes) snoozeMap[s.id] = { ...s, modifiedAt: now };
    for (const { item, indexes } of applied) map = mapWithTabsRemoved(map, item, indexes, now);
    return {
      [STORE_KEYS.inbox]: map,
      [STORE_KEYS.snoozes]: snoozeMap,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  for (const s of snoozes) {
    await chrome.alarms.create(SNOOZE_ALARM_PREFIX + s.id, { when: s.dueAt });
  }
  return snoozed;
}

/**
 * Restore a single tab out of an Inbox item: open it, remove it from the item.
 * @param {import("./types.js").InboxItem} item
 * @param {number} index
 */
export async function restoreSingleTab(item, index) {
  const t = item.tabs[index];
  if (!t) return;
  await chrome.tabs.create({ url: t.url });
  await removeTabFromInboxItem(item, index);
}

/**
 * Restore an Inbox item: window bundle → new window; single tab → current window.
 * @param {import("./types.js").InboxItem} item
 */
export async function restoreInboxItem(item) {
  const urls = item.tabs.map((t) => t.url).filter(Boolean);
  if (urls.length === 0) return;
  if (item.kind === "window") {
    await chrome.windows.create({ url: urls });
  } else {
    for (const url of urls) await chrome.tabs.create({ url });
  }
  await tombstoneItem(STORE_KEYS.inbox, item.id);
}

/**
 * F8-R2 — save one already-validated TabRef to the Inbox as an ordinary manual
 * item, journaled + counted like any other save. Used by the Focus guard's
 * "Save to Inbox and close": the live tab is on `focus.html`, so the destination
 * cannot be read from the tab and is passed as a validated ref instead. The caller
 * (focus-guard) revalidates the URL as HTTP(S) before calling. MUST run in the
 * background worker.
 * When `opts.id` is given, the save is end-to-end idempotent for that identity. A local
 * operation receipt advances with each Inbox/counter/journal effect in the SAME storage
 * write as that effect. A worker restart or an ambiguous rejected write can therefore
 * resume at the exact unfinished phase without duplicating any effect. This is deliberately
 * narrow to Focus saves; unrelated save paths retain their existing coordination.
 * @param {import("./types.js").TabRef} ref a validated {url, title, favIconUrl?}
 * @param {{id?: string}} [opts] a stable inbox item id for idempotent saves
 * @returns {Promise<import("./types.js").InboxItem>} the created (or existing) item
 */
export async function saveRefToInbox(ref, opts = {}) {
  if (!ref || !/^https?:/i.test(ref.url ?? "")) throw new Error("unsaveable ref");
  const tab = {
    url: ref.url,
    title: ref.title || ref.url,
    ...(ref.favIconUrl ? { favIconUrl: ref.favIconUrl } : {})
  };
  /** @type {import("./types.js").InboxItem} */
  const item = { ...(await newMeta()), ...(opts.id != null ? { id: opts.id } : {}), kind: "tab", tabs: [tab], source: "manual", labels: [] };
  if (opts.id != null) return saveFocusRefTransaction(item);
  // E2-0c: item + counter + undo entry in ONE atomic commit. (The stable-id
  // path above keeps its own receipt-phased writes — each phase is already a
  // single set pairing effect + receipt; deliberately untouched.)
  const entry = makeJournalEntry("Saved a tab to the Inbox", {
    dels: [{ store: STORE_KEYS.inbox, id: item.id }],
    reopen: [item.tabs]
  });
  const now = Date.now();
  await mutateStores([STORE_KEYS.inbox, COUNTERS_KEY, JOURNAL_KEY], (maps) => ({
    [STORE_KEYS.inbox]: { ...(maps[STORE_KEYS.inbox] ?? {}), [item.id]: { ...item, modifiedAt: now } },
    [COUNTERS_KEY]: bumpedCounters(maps[COUNTERS_KEY], "tabsDumped"),
    [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
  }));
  return item;
}

/**
 * Complete one stable-identity Focus save across Inbox, counter, and undo journal. Each
 * receipt transition is atomically written with its matching effect, so retry can repair
 * any interrupted phase after a service-worker restart.
 * @param {import("./types.js").InboxItem} candidate
 * @returns {Promise<import("./types.js").InboxItem>}
 */
async function saveFocusRefTransaction(candidate) {
  const id = candidate.id;
  const journalId = `focus-save:${id}`;
  let state = await chrome.storage.local.get([
    STORE_KEYS.inbox, "counters", "journal", FOCUS_SAVE_RECEIPTS_KEY
  ]);
  let receipts = state[FOCUS_SAVE_RECEIPTS_KEY] ?? {};
  let receipt = receipts[id];

  if (!receipt) {
    const existing = state[STORE_KEYS.inbox]?.[id];
    const legacyJournal = (state.journal ?? []).find((entry) =>
      entry?.dels?.some((del) => del.store === STORE_KEYS.inbox && del.id === id));
    receipt = {
      id,
      startedAt: Date.now(),
      itemApplied: !!existing,
      counterApplied: !!legacyJournal,
      journalApplied: !!legacyJournal,
      complete: !!legacyJournal
    };
    receipts = cappedFocusReceipts({ ...receipts, [id]: receipt });
    await chrome.storage.local.set({ [FOCUS_SAVE_RECEIPTS_KEY]: receipts });
    state = await chrome.storage.local.get([
      STORE_KEYS.inbox, "counters", "journal", FOCUS_SAVE_RECEIPTS_KEY
    ]);
    receipts = state[FOCUS_SAVE_RECEIPTS_KEY] ?? receipts;
    receipt = receipts[id] ?? receipt;
  }

  let inbox = state[STORE_KEYS.inbox] ?? {};
  let saved = inbox[id];
  if (!receipt.itemApplied || !saved || saved.deletedAt) {
    const now = Date.now();
    saved = { ...candidate, modifiedAt: now };
    inbox = { ...inbox, [id]: saved };
    receipt = { ...receipt, itemApplied: true };
    receipts = { ...receipts, [id]: receipt };
    await chrome.storage.local.set({
      [STORE_KEYS.inbox]: inbox,
      [FOCUS_SAVE_RECEIPTS_KEY]: cappedFocusReceipts(receipts)
    });
  }

  if (!receipt.counterApplied) {
    const counters = state.counters ?? {};
    const nextCounters = { ...counters, tabsDumped: (counters.tabsDumped ?? 0) + 1 };
    receipt = { ...receipt, counterApplied: true };
    receipts = { ...receipts, [id]: receipt };
    await chrome.storage.local.set({
      counters: nextCounters,
      [FOCUS_SAVE_RECEIPTS_KEY]: cappedFocusReceipts(receipts)
    });
  }

  if (!receipt.journalApplied) {
    const journal = state.journal ?? [];
    const entry = {
      id: journalId,
      at: Date.now(),
      label: "Saved a tab to the Inbox",
      puts: [],
      dels: [{ store: STORE_KEYS.inbox, id }],
      reopen: [saved.tabs],
      moves: []
    };
    const nextJournal = [entry, ...journal.filter((e) => e.id !== journalId)].slice(0, JOURNAL_CAP);
    receipt = { ...receipt, journalApplied: true, complete: true, completedAt: Date.now() };
    receipts = { ...receipts, [id]: receipt };
    await chrome.storage.local.set({
      journal: nextJournal,
      [FOCUS_SAVE_RECEIPTS_KEY]: cappedFocusReceipts(receipts)
    });
  }
  return saved;
}

function cappedFocusReceipts(receipts) {
  const entries = Object.entries(receipts);
  if (entries.length <= FOCUS_SAVE_RECEIPT_CAP) return receipts;
  const pending = entries.filter(([, receipt]) => !receipt?.complete);
  const complete = entries.filter(([, receipt]) => receipt?.complete);
  complete.sort((a, b) => Number(b[1]?.completedAt ?? b[1]?.startedAt ?? 0) -
    Number(a[1]?.completedAt ?? a[1]?.startedAt ?? 0));
  return Object.fromEntries([...pending, ...complete.slice(0,
    Math.max(0, FOCUS_SAVE_RECEIPT_CAP - pending.length))]);
}

/**
 * Dump a specific set of tabs (M6 "Open tabs" section), then close them.
 * Labels belong to tabs: with labels, each tab becomes its own labeled Inbox
 * item; without, the selection is saved as one bundle. MUST run in the
 * background worker.
 * @param {number[]} tabIds @param {string|string[]} [label]
 * @returns {Promise<number>} tabs dumped
 */
export async function dumpTabs(tabIds, label) {
  /** @type {chrome.tabs.Tab[]} */
  const tabs = [];
  for (const id of tabIds) {
    try {
      const t = await chrome.tabs.get(id);
      if (isSaveableTab(t)) tabs.push(t);
    } catch {
      /* already gone */
    }
  }
  if (tabs.length === 0) return 0;

  const labels = (Array.isArray(label) ? label : label ? [label] : [])
    .map((l) => String(l).trim())
    .filter(Boolean);

  /** @type {import("./types.js").InboxItem[]} */
  const items = [];
  if (labels.length > 0) {
    // labels belong to tabs → one labeled item per tab
    for (const t of tabs) {
      items.push({
        ...(await newMeta()),
        kind: "tab",
        tabs: [canonicalRef(t)],
        source: "manual",
        labels
      });
    }
  } else {
    items.push({
      ...(await newMeta()),
      kind: tabs.length > 1 ? "window" : "tab",
      tabs: tabs.map(canonicalRef),
      source: "manual",
      labels: []
    });
  }
  // E2-0c: every created item + counter + undo entry in ONE atomic commit,
  // persisted BEFORE any tab closes.
  const entry = makeJournalEntry(
    `Saved ${tabs.length} tab${tabs.length === 1 ? "" : "s"} to the Inbox`,
    {
      dels: items.map((i) => ({ store: STORE_KEYS.inbox, id: i.id })),
      reopen: [tabs.map(canonicalRef)]
    }
  );
  const now = Date.now();
  // F21: when this save carries labels, mark them used in the same atomic commit.
  const touchKeys = labels.length > 0 ? [LABEL_META_KEY] : [];
  await mutateStores([STORE_KEYS.inbox, COUNTERS_KEY, JOURNAL_KEY, ...touchKeys], (maps) => {
    const inbox = { ...(maps[STORE_KEYS.inbox] ?? {}) };
    for (const item of items) inbox[item.id] = { ...item, modifiedAt: now };
    return {
      [STORE_KEYS.inbox]: inbox,
      [COUNTERS_KEY]: bumpedCounters(maps[COUNTERS_KEY], "tabsDumped", tabs.length),
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry),
      ...(labels.length > 0 ? { [LABEL_META_KEY]: touchedLabelMeta(maps[LABEL_META_KEY], labels, now) } : {})
    };
  });

  // If this would close every tab of some window, keep the browser alive.
  const all = await chrome.tabs.query({});
  const closing = new Set(tabs.map((t) => t.id));
  const survivors = all.filter((t) => !closing.has(t.id));
  if (survivors.length === 0) await openDashboard();
  await chrome.tabs.remove(tabs.map((t) => t.id));
  return tabs.length;
}

/**
 * N6 — Session exit at tab grain: MOVE the selected tabs into a session (new or
 * existing), splitting them out of their Inbox items. Window structure is
 * preserved (one session window per source item). Journal-backed so a single
 * Undo restores both sides (the pre-split Inbox items and — for a new session —
 * removes it; for an append, the session's prior windows). Never appends to an
 * `auto` snapshot (immutable, N8).
 * @param {{item: import("./types.js").InboxItem, indexes: number[]}[]} sources
 * @param {string} sessionId existing session id, or "__new"
 * @param {string} [name] name for a new session
 * @returns {Promise<{moved: number, name: string, entry: object|null}|null>}
 */
export async function moveTabsToSession(sources, sessionId, name) {
  const windows = sources
    .map((g) => g.indexes.map((i) => g.item.tabs[i]).filter(Boolean))
    .filter((w) => w.length > 0);
  if (windows.length === 0) return null;

  const puts = sources.map((g) => ({ store: STORE_KEYS.inbox, item: g.item }));
  const dels = [];
  let sessionName;

  // E2-0c: session create/append + every Inbox split + the undo entry are ONE
  // atomic commit — the doc's named "session merge" torn case (§2.3 R2). The
  // existing-session guard re-reads FRESH under the lock (strictly stronger
  // than the old pre-read; same rejects: missing / deleted / auto snapshot).
  const newSession = sessionId === "__new"
    ? buildSessionFromWindows(await newMeta(), windows, name)
    : null;
  if (sessionId === "__new" && !newSession) return null;
  if (newSession) {
    sessionName = newSession.name;
    dels.push({ store: STORE_KEYS.sessions, id: newSession.id });
  }

  const now = Date.now();
  let moved = 0;
  let entry = null;
  const committed = await mutateStores(
    [STORE_KEYS.sessions, STORE_KEYS.inbox, JOURNAL_KEY],
    (maps) => {
      const sessions = { ...(maps[STORE_KEYS.sessions] ?? {}) };
      if (newSession) {
        sessions[newSession.id] = { ...newSession, modifiedAt: now };
      } else {
        const before = sessions[sessionId];
        if (!before || before.deletedAt || before.auto) return null; // never touch a snapshot
        sessionName = before.name;
        puts.push({ store: STORE_KEYS.sessions, item: before });
        sessions[sessionId] = { ...before, windows: [...before.windows, ...windows], modifiedAt: now };
      }
      let inbox = maps[STORE_KEYS.inbox] ?? {};
      moved = 0;
      for (const { item, indexes } of sources) {
        inbox = mapWithTabsRemoved(inbox, item, indexes, now);
        moved += indexes.length;
      }
      entry = makeJournalEntry(
        `Moved ${moved} tab${moved === 1 ? "" : "s"} to “${sessionName}”`, { puts, dels }
      );
      return {
        [STORE_KEYS.sessions]: sessions,
        [STORE_KEYS.inbox]: inbox,
        [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
      };
    }
  );
  if (!committed) return null;
  return { moved, name: sessionName, entry };
}

/**
 * P2g-4b — the Inbox drag exit: move ONE tab ref between Inbox items (or
 * reorder within one), with the [AP] STALE-DROP GUARD and exact undo.
 *
 * Guard: source and target are RE-READ from storage here, at drop time; if
 * either changed since the lift (modifiedAt mismatch — a sweep, a sync,
 * another window) or vanished, nothing is written and {ok:false, stale:true}
 * comes back — the caller shows "List changed — nothing moved".
 *
 * Semantics ([AP]): the moved ref carries its per-tab labels (they live on
 * the ref); each bundle keeps its own meta (source, timestamps). An emptied
 * source tombstones. `targetId: null` = the between-bundles zone — a NEW
 * ordinary item (`source: "manual"`, no new enum). ONE journal entry records
 * the pre-state of BOTH items (and removes a created bundle), so a single
 * Undo restores everything exactly.
 *
 * @param {string} sourceId @param {number} fromIndex
 * @param {string|null} targetId an Inbox item id, or null for a new bundle
 * @param {number} toIndex insert-before index in the target; -1 = append
 * @param {{source: number, target?: number}} expectModified modifiedAt values
 *   captured at lift time (target omitted when targetId is null)
 * @returns {Promise<{ok: boolean, stale?: boolean, noop?: boolean, entry?: object}>}
 */
export async function moveInboxTab(sourceId, fromIndex, targetId, toIndex, expectModified) {
  // E2-0c: the whole drop — guard, both record writes, journal entry — is ONE
  // atomic commit, and the [AP] stale guard now re-reads under the store lock
  // at the true commit point (strictly stronger: nothing can change between
  // the guard and the write). Same external contract: {ok, stale?, noop?, entry?}.
  const freshMeta = targetId === null ? await newMeta() : null; // async, built outside the lock
  const now = Date.now();
  let result = { ok: false, stale: true };
  await mutateStores([STORE_KEYS.inbox, JOURNAL_KEY], (maps) => {
    const map = maps[STORE_KEYS.inbox] ?? {};
    const source = map[sourceId];
    if (!source || source.deletedAt || source.modifiedAt !== expectModified.source ||
        !source.tabs[fromIndex]) {
      result = { ok: false, stale: true };
      return null;
    }
    const target = targetId === null ? null : map[targetId];
    if (targetId !== null &&
        (!target || target.deletedAt || target.modifiedAt !== expectModified.target)) {
      result = { ok: false, stale: true };
      return null;
    }

    const ref = source.tabs[fromIndex];

    // same-item reorder: one record touched, one put
    if (targetId === sourceId) {
      const tabs = source.tabs.filter((_, i) => i !== fromIndex);
      let at = toIndex === -1 ? tabs.length : Math.min(toIndex, tabs.length);
      if (toIndex !== -1 && fromIndex < toIndex) at -= 1; // removal shifted the slot
      if (at === fromIndex) {
        result = { ok: true, noop: true }; // dropped where it was
        return null;
      }
      tabs.splice(at, 0, ref);
      const entry = makeJournalEntry(`Reordered “${ref.title || ref.url}”`,
        { puts: [{ store: STORE_KEYS.inbox, item: source }] });
      result = { ok: true, entry };
      return {
        [STORE_KEYS.inbox]: { ...map, [sourceId]: { ...source, tabs, modifiedAt: now } },
        [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
      };
    }

    const puts = [{ store: STORE_KEYS.inbox, item: source }];
    const dels = [];
    let destName;
    let next = { ...map };
    if (target) {
      puts.push({ store: STORE_KEYS.inbox, item: target });
      const tabs = [...target.tabs];
      tabs.splice(toIndex === -1 ? tabs.length : Math.min(toIndex, tabs.length), 0, ref);
      next[targetId] = { ...target, tabs, kind: tabs.length > 1 ? "window" : "tab", modifiedAt: now };
      destName = "another bundle";
    } else {
      /** @type {import("./types.js").InboxItem} */
      const fresh = { ...freshMeta, kind: "tab", tabs: [ref], source: "manual", labels: [], modifiedAt: now };
      next[fresh.id] = fresh;
      dels.push({ store: STORE_KEYS.inbox, id: fresh.id });
      destName = "a new bundle";
    }
    next = mapWithTabsRemoved(next, source, [fromIndex], now); // emptied → tombstone
    const entry = makeJournalEntry(`Moved “${ref.title || ref.url}” to ${destName}`, { puts, dels });
    result = { ok: true, entry };
    return { [STORE_KEYS.inbox]: next, [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry) };
  });
  return result;
}

/**
 * Open (or focus) the dashboard tab, optionally deep-linked to a page via the
 * hash router (e.g. openDashboard("inbox") → dashboard.html#inbox). Focusing an
 * existing dashboard and only changing its hash is a same-document navigation,
 * so it routes without a reload.
 * @param {string} [hash] page id (inbox, vault, duplicates, snoozed, …)
 */
export async function openDashboard(hash = "open") {
  const base = chrome.runtime.getURL("dashboard.html");
  const url = dashboardHref(hash);
  const existing = await chrome.tabs.query({ url: base });
  const first = existing[0];
  if (first && first.id !== undefined) {
    await chrome.tabs.update(first.id, { active: true, ...(hash ? { url } : {}) });
    if (first.windowId !== undefined) {
      await chrome.windows.update(first.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url });
  }
}
