// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "./failure-diagnostic.js";
import { STORE_KEYS } from "./types.js";
import {
  newMeta, upsertItem, tombstoneItem, mutateStores, mutateNamedSessionStores
} from "./store.js";
import { isSaveableTab, canonicalRef } from "./tabs.js";
import { COUNTERS_KEY, bumpedCounters } from "./counters.js";
import { LABEL_META_KEY, touchedLabelMeta } from "./label-meta.js";
import { JOURNAL_KEY, makeJournalEntry, appendedJournal } from "./journal.js";
import { buildSnooze, SNOOZE_ALARM_PREFIX } from "./snooze.js";
import { buildSessionFromWindows } from "./sessions.js";
import { assignNewOrganizationMembers } from "./organization.js";
import { dashboardHref } from "./newtab-focus.js";
import {
  canUseCurrentSavedCarrier, groupSavedTabSelections, sameSavedRecord
} from "./saved-selection-safety.js";
import {
  closeUnchangedLiveTabs, finishPendingLiveClose
} from "./live-close.js";

/**
 * Copy supported tab fields. Labels on an Inbox item apply to each selected
 * tab, so carry them into destinations that only store labels on tab refs.
 * Unrecognized source fields are not added to the destination record.
 * @param {import("./types.js").TabRef} ref
 * @param {string[]} [carrierLabels]
 * @returns {import("./types.js").TabRef}
 */
function transferableTabRef(ref, carrierLabels = []) {
  const labels = [...new Set([
    ...carrierLabels.filter((label) => typeof label === "string"),
    ...(ref.labels ?? []).filter((label) => typeof label === "string")
  ])];
  return {
    url: ref.url,
    title: ref.title,
    ...(typeof ref.favIconUrl === "string" ? { favIconUrl: ref.favIconUrl } : {}),
    ...(typeof ref.pinned === "boolean" ? { pinned: ref.pinned } : {}),
    ...(carrierLabels.length > 0 || Array.isArray(ref.labels) ? { labels } : {}),
    ...(Number.isInteger(ref.groupIndex) && ref.groupIndex >= 0
      ? { groupIndex: ref.groupIndex } : {})
  };
}

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

/** @param {chrome.tabs.Tab} t */
function isDumpable(t) {
  if (t.pinned) return false;
  return isSaveableTab(t);
}

function pendingCloseReceipt(tabs) {
  const placements = tabs.map((tab) => ({
    tabId: tab.id,
    ref: canonicalRef(tab),
    windowId: tab.windowId,
    index: tab.index,
    pinned: tab.pinned === true
  }));
  if (!placements.every((tab) =>
    Number.isInteger(tab.tabId) && Number.isInteger(tab.windowId) && tab.windowId >= 0 &&
    Number.isInteger(tab.index) && tab.index >= 0)) return null;
  return {
    kind: "close-tabs",
    status: "pending",
    tabs: placements,
    closedCount: placements.length
  };
}

/**
 * One-click dump (PRD §3.1): close all unpinned http(s) tabs of the window,
 * save them as one Inbox item. Window bundle if >1 tab.
 * MUST run in the background worker — callers in popups send a message.
 * @param {number} [windowId]
 * @returns {Promise<{n:number,undoId:string|null}>} exact saved count and Undo receipt
 */
export async function dumpWindow(windowId) {
  const tabs = await chrome.tabs.query(
    windowId !== undefined ? { windowId } : { currentWindow: true }
  );
  const toDump = tabs.filter(isDumpable);
  if (toDump.length === 0) return { n: 0, undoId: null };

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
    { dels: [{ store: STORE_KEYS.inbox, id: item.id }], reopen: [item.tabs] },
    { forwardReceipt: pendingCloseReceipt(toDump) }
  );
  const now = Date.now();
  await mutateStores([STORE_KEYS.inbox, COUNTERS_KEY, JOURNAL_KEY], (maps) => ({
    [STORE_KEYS.inbox]: { ...(maps[STORE_KEYS.inbox] ?? {}), [item.id]: { ...item, modifiedAt: now } },
    [COUNTERS_KEY]: bumpedCounters(maps[COUNTERS_KEY], "tabsDumped", toDump.length),
    [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
  }));

  // Open the dashboard first so the window survives if every tab closes.
  await openDashboard();
  await finishPendingLiveClose(
    entry.id, toDump, () => closeUnchangedLiveTabs(toDump)
  );
  return { n: toDump.length, undoId: entry.id };
}

/**
 * Dump a single tab to the Inbox (explicit user action, so pinned is allowed).
 * MUST run in the background worker.
 * @param {number} tabId
 * @returns {Promise<{n:number,undoId:string|null}>} exact saved count and Undo receipt
 */
export async function dumpTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSaveableTab(tab)) return { n: 0, undoId: null };

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
  }, { forwardReceipt: pendingCloseReceipt([tab]) });
  const now = Date.now();
  await mutateStores([STORE_KEYS.inbox, COUNTERS_KEY, JOURNAL_KEY], (maps) => ({
    [STORE_KEYS.inbox]: { ...(maps[STORE_KEYS.inbox] ?? {}), [item.id]: { ...item, modifiedAt: now } },
    [COUNTERS_KEY]: bumpedCounters(maps[COUNTERS_KEY], "tabsDumped"),
    [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
  }));

  // If it's the window's last tab, open the dashboard so the window survives.
  const windowTabs = await chrome.tabs.query({ windowId: tab.windowId });
  if (windowTabs.length <= 1) await openDashboard();
  await finishPendingLiveClose(
    entry.id, [tab], () => closeUnchangedLiveTabs([tab])
  );
  return { n: 1, undoId: entry.id };
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
 * Open selected saved references while preserving their source records. Window
 * structure survives when more than one selected URL belongs to a window item.
 * Browser effects finish before the caller can perform any separate saved-data
 * mutation, so a rejected create never removes a saved occurrence.
 * @param {TabSelection[]} sources
 * @returns {Promise<{opened:number,applied:TabSelection[]}>}
 */
async function openTabSelections(sources) {
  /** @type {TabSelection[]} */
  const applied = [];
  let opened = 0;
  for (const { item, indexes } of sources) {
    const refs = indexes.map((i) => item.tabs[i]).filter(Boolean);
    const urls = refs.map((t) => t.url).filter((u) => /^https?:/.test(u ?? ""));
    if (urls.length === 0) continue;
    if (item.kind === "window" && urls.length > 1) {
      await chrome.windows.create({ url: urls });
    } else {
      for (const url of urls) await chrome.tabs.create({ url });
    }
    applied.push({ item, indexes });
    opened += urls.length;
  }
  return { opened, applied };
}

/**
 * Open selected saved references without consuming or rewriting them. Archive
 * uses this copy-like operation; opening durable saved material needs no Undo.
 * @param {TabSelection[]} sources
 * @returns {Promise<number>} tabs opened
 */
export async function openTabsFromItems(sources) {
  return (await openTabSelections(sources)).opened;
}

/**
 * Restore selected Inbox occurrences. Validate before browser effects, then
 * consume confirmed opens only if the source is still safe to change. The
 * separate Restore lock serializes repeated clicks without holding the Store
 * lock during Chrome calls. Archive remains a non-consuming copy operation.
 * @param {TabSelection[]} sources
 * @returns {Promise<number>} confirmed opened occurrences, including retained
 *   sources changed during opening. Partial browser failures commit safe
 *   successes before rejecting; a failed Store commit leaves sources intact.
 */
export async function restoreTabsFromItems(sources) {
  const grouped = groupSavedTabSelections(sources);
  if (grouped.length === 0) return 0;
  return navigator.locks.request("everytab-inbox-restore", { mode: "exclusive" }, async () => {
    const prepared = [];
    await mutateStores([STORE_KEYS.inbox], (maps) => {
      for (const { expected, indexes } of grouped) {
        const current = maps[STORE_KEYS.inbox]?.[expected.id];
        if (!canUseCurrentSavedCarrier(expected, current, { indexed: true })) continue;
        const selected = indexes.filter((index) => restoreUrl(current.tabs[index].url));
        if (selected.length) prepared.push({ item: current, indexes: selected });
      }
      return null;
    });
    const applied = [];
    let browserError = null;
    try {
      for (const { item, indexes } of prepared) {
        const opened = { item, indexes: [] };
        applied.push(opened);
        if (item.kind === "window" && indexes.length > 1) {
          const win = await chrome.windows.create({
            url: indexes.map((index) => item.tabs[index].url)
          });
          if (!Number.isInteger(win?.id) || win.id < 0) throw unconfirmedRestoreError();
          const tabs = await chrome.tabs.query({ windowId: win.id });
          opened.indexes = confirmedWindowIndexes(item, indexes, tabs, win.id);
          if (opened.indexes.length !== indexes.length) throw unconfirmedRestoreError();
        } else {
          for (const index of indexes) {
            const tab = await chrome.tabs.create({ url: item.tabs[index].url });
            if (!Number.isInteger(tab?.id) || tab.id < 0) throw unconfirmedRestoreError();
            opened.indexes.push(index);
          }
        }
      }
    } catch (error) {
      // A later create may fail after earlier tabs opened. Preserve those
      // receipts for the atomic source update, then surface the failure.
      browserError = error;
    }
    const restored = applied.reduce((count, source) => count + source.indexes.length, 0);
    if (restored > 0) {
      await mutateStores([STORE_KEYS.inbox, JOURNAL_KEY], (maps) => {
        let map = maps[STORE_KEYS.inbox] ?? {};
        const puts = [];
        const now = Date.now();
        let consumed = 0;
        for (const { item, indexes } of applied) {
          const current = maps[STORE_KEYS.inbox]?.[item.id];
          if (!indexes.length || !canUseCurrentSavedCarrier(item, current, { indexed: true })) continue;
          puts.push({ store: STORE_KEYS.inbox, item: current });
          map = mapWithTabsRemoved(map, current, indexes, now);
          consumed += indexes.length;
        }
        if (!consumed) return null;
        const entry = makeJournalEntry(
          `Restored ${consumed} tab${consumed === 1 ? "" : "s"}`, { puts }
        );
        return { [STORE_KEYS.inbox]: map, [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry) };
      });
    }
    if (browserError) throw browserError;
    return restored;
  });
}

/**
 * @param {string|undefined} url
 * @returns {string|null} browser-normalized web address
 */
function restoreUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch { return null; }
}

function unconfirmedRestoreError() {
  return new Error("Some tabs could not be confirmed open. Unconfirmed tabs remain in Inbox.");
}

/**
 * Match only returned browser occurrences. A partially returned duplicate URL
 * cannot identify which saved occurrence opened, so keep all of that URL saved.
 * @param {import("./types.js").InboxItem} item
 * @param {number[]} indexes
 * @param {chrome.tabs.Tab[]} tabs
 * @param {number} windowId
 * @returns {number[]}
 */
function confirmedWindowIndexes(item, indexes, tabs, windowId) {
  const returned = new Map();
  const seenIds = new Set();
  for (const tab of tabs ?? []) {
    if (!Number.isInteger(tab.id) || tab.id < 0 || seenIds.has(tab.id) ||
        (Number.isInteger(tab.windowId) && tab.windowId !== windowId)) continue;
    seenIds.add(tab.id);
    const url = restoreUrl(tab.pendingUrl || tab.url);
    if (url) returned.set(url, (returned.get(url) ?? 0) + 1);
  }
  const requested = new Map();
  for (const index of indexes) {
    const url = restoreUrl(item.tabs[index].url);
    requested.set(url, (requested.get(url) ?? 0) + 1);
  }
  return indexes.filter((index) => {
    const url = restoreUrl(item.tabs[index].url);
    return (returned.get(url) ?? 0) >= requested.get(url);
  });
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
  const grouped = groupSavedTabSelections(sources);
  if (grouped.length === 0) return 0;
  // E2-0c: all splits + the undo entry are ONE atomic commit — a crash can no
  // longer delete tabs without the journal entry that revives them.
  let deleted = 0;
  await mutateStores([store, JOURNAL_KEY], (maps) => {
    let map = maps[store] ?? {};
    const puts = [];
    const now = Date.now();
    for (const { expected, indexes } of grouped) {
      const current = maps[store]?.[expected.id];
      if (!canUseCurrentSavedCarrier(expected, current, { indexed: true })) continue;
      puts.push({ store, item: current });
      map = mapWithTabsRemoved(map, current, indexes, now);
      deleted += indexes.length;
    }
    if (deleted === 0) return null;
    const entry = makeJournalEntry(
      `Deleted ${deleted} tab${deleted === 1 ? "" : "s"}`, { puts }
    );
    return { [store]: map, [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry) };
  });
  return deleted;
}

/**
 * Move selected Inbox occurrences into one Snooze per source item. Resolve
 * sources under the lock so stale selections cannot erase newer saved tabs.
 * Full supported refs carry their effective source labels. Undo preserves the
 * immediate pre-state; alarms are created after the commit.
 * @param {TabSelection[]} sources
 * @param {number} dueAt
 * @param {string} [recurrence]
 * @returns {Promise<number>} tabs snoozed
 */
export async function snoozeTabRefs(sources, dueAt, recurrence) {
  const grouped = groupSavedTabSelections(sources);
  if (grouped.length === 0) return 0;
  // Only identities are prepared before locking, with one device-id read.
  const seed = await newMeta();
  const metas = grouped.map((_, index) => index === 0
    ? seed : { ...seed, id: crypto.randomUUID() });
  let snoozed = 0;
  const snoozes = [];
  await mutateStores([STORE_KEYS.inbox, STORE_KEYS.snoozes, JOURNAL_KEY], (maps) => {
    let map = maps[STORE_KEYS.inbox] ?? {};
    const snoozeMap = { ...(maps[STORE_KEYS.snoozes] ?? {}) };
    const puts = [];
    const dels = [];
    const now = Date.now();
    for (const [position, { expected, indexes }] of grouped.entries()) {
      const current = maps[STORE_KEYS.inbox]?.[expected.id];
      const meta = metas[position];
      if (!canUseCurrentSavedCarrier(expected, current, { indexed: true }) ||
          Object.hasOwn(snoozeMap, meta.id)) continue;
      const refs = indexes.map((index) =>
        transferableTabRef(current.tabs[index], current.labels ?? []));
      const snooze = buildSnooze({ ...meta, modifiedAt: now }, refs.length > 1
        ? { title: `Window (${refs.length} tabs)`, dueAt, tabs: refs,
            ...(recurrence ? { recurrence } : {}) }
        : { url: refs[0].url, title: refs[0].title || refs[0].url, dueAt, tabs: refs,
            ...(refs[0].favIconUrl ? { favIconUrl: refs[0].favIconUrl } : {}),
            ...(recurrence ? { recurrence } : {}) });
      snoozeMap[snooze.id] = snooze;
      snoozes.push(snooze);
      puts.push({ store: STORE_KEYS.inbox, item: current });
      dels.push({ store: STORE_KEYS.snoozes, id: snooze.id });
      map = mapWithTabsRemoved(map, current, indexes, now);
      snoozed += refs.length;
    }
    if (snoozed === 0) return null;
    const entry = makeJournalEntry(
      `Snoozed ${snoozed} tab${snoozed === 1 ? "" : "s"}`, { puts, dels }
    );
    return {
      [STORE_KEYS.inbox]: map,
      [STORE_KEYS.snoozes]: snoozeMap,
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  // The persisted due time lets startup repair an interrupted alarm setup.
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
  await restoreTabsFromItems([{ item, indexes: [index] }]);
}

/**
 * Restore an Inbox item: window bundle → new window; single tab → current window.
 * @param {import("./types.js").InboxItem} item
 */
export async function restoreInboxItem(item) {
  await restoreTabsFromItems([{ item, indexes: item.tabs.map((_, index) => index) }]);
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
  let saved = null;
  await mutateStores([
    STORE_KEYS.inbox, COUNTERS_KEY, JOURNAL_KEY, FOCUS_SAVE_RECEIPTS_KEY
  ], (maps) => {
    const now = Date.now();
    const inbox = { ...(maps[STORE_KEYS.inbox] ?? {}) };
    const journal = Array.isArray(maps[JOURNAL_KEY]) ? maps[JOURNAL_KEY] : [];
    const legacyJournal = journal.find((entry) =>
      entry?.id === journalId ||
      entry?.dels?.some((del) => del.store === STORE_KEYS.inbox && del.id === id));
    const prior = maps[FOCUS_SAVE_RECEIPTS_KEY]?.[id];
    let receipt = prior ?? {
      id,
      startedAt: now,
      itemApplied: Boolean(inbox[id] && !inbox[id].deletedAt),
      counterApplied: Boolean(legacyJournal),
      journalApplied: Boolean(legacyJournal),
      complete: Boolean(legacyJournal)
    };
    const sets = {};

    saved = inbox[id];
    if (!receipt.itemApplied || !saved || saved.deletedAt) {
      saved = { ...candidate, modifiedAt: now };
      inbox[id] = saved;
      receipt = { ...receipt, itemApplied: true };
      sets[STORE_KEYS.inbox] = inbox;
    }
    if (!receipt.counterApplied) {
      sets[COUNTERS_KEY] = bumpedCounters(maps[COUNTERS_KEY], "tabsDumped");
      receipt = { ...receipt, counterApplied: true };
    }
    if (!receipt.journalApplied) {
      const entry = {
        id: journalId,
        at: now,
        label: "Saved a tab to the Inbox",
        puts: [],
        dels: [{ store: STORE_KEYS.inbox, id }],
        reopen: [saved.tabs],
        moves: []
      };
      sets[JOURNAL_KEY] = appendedJournal(
        journal.filter((existing) => existing?.id !== journalId), entry
      );
      receipt = { ...receipt, journalApplied: true };
    }
    receipt = { ...receipt, complete: true, completedAt: receipt.completedAt ?? now };
    sets[FOCUS_SAVE_RECEIPTS_KEY] = cappedFocusReceipts({
      ...(maps[FOCUS_SAVE_RECEIPTS_KEY] ?? {}), [id]: receipt
    });
    return sets;
  });
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
    },
    { forwardReceipt: pendingCloseReceipt(tabs) }
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
  await finishPendingLiveClose(
    entry.id, tabs, () => closeUnchangedLiveTabs(tabs)
  );
  return tabs.length;
}

/**
 * Move selected Inbox occurrences into a new or existing named Session,
 * preserving one window per source. Effective source labels move onto only the
 * appended refs. Fresh guarded records supply both sides and the inverse in one
 * commit. Optional organization follows that commit.
 * @param {{item: import("./types.js").InboxItem, indexes: number[]}[]} sources
 * @param {string} sessionId existing session id, or "__new"
 * @param {string} [name] name for a new session
 * @param {{groupIds?:string[],createNames?:string[]}|null} [organization]
 * @returns {Promise<{moved:number,name:string,id:string,entry:import("./types.js").JournalEntry}|null>}
 */
export async function moveTabsToSession(sources, sessionId, name, organization = null) {
  const grouped = groupSavedTabSelections(sources);
  if (grouped.length === 0) return null;
  const meta = sessionId === "__new" ? await newMeta() : null;
  let result = null;
  const committed = await mutateNamedSessionStores(
    [STORE_KEYS.sessions, STORE_KEYS.inbox, JOURNAL_KEY],
    (maps) => {
      const sessions = { ...(maps[STORE_KEYS.sessions] ?? {}) };
      const before = sessions[sessionId];
      if (meta ? Object.hasOwn(sessions, meta.id)
        : !before || before.deletedAt || before.auto) return null;
      const windows = [];
      const puts = [];
      const dels = [];
      let inbox = maps[STORE_KEYS.inbox] ?? {};
      const now = Date.now();
      let moved = 0;
      for (const { expected, indexes } of grouped) {
        const current = maps[STORE_KEYS.inbox]?.[expected.id];
        if (!canUseCurrentSavedCarrier(expected, current, { indexed: true })) continue;
        windows.push(indexes.map((index) =>
          transferableTabRef(current.tabs[index], current.labels ?? [])));
        puts.push({ store: STORE_KEYS.inbox, item: current });
        inbox = mapWithTabsRemoved(inbox, current, indexes, now);
        moved += indexes.length;
      }
      if (moved === 0) return null;
      const session = meta
        ? buildSessionFromWindows({ ...meta, modifiedAt: now }, windows, name)
        : { ...before, windows: [...before.windows, ...windows], modifiedAt: now };
      if (!session) return null;
      if (meta) dels.push({ store: STORE_KEYS.sessions, id: session.id });
      else puts.push({ store: STORE_KEYS.sessions, item: before });
      sessions[session.id] = session;
      const sessionName = session.name;
      const entry = makeJournalEntry(
        `Moved ${moved} tab${moved === 1 ? "" : "s"} to “${sessionName}”`, { puts, dels }
      );
      result = { moved, name: sessionName, id: session.id, entry };
      return {
        [STORE_KEYS.sessions]: sessions,
        [STORE_KEYS.inbox]: inbox,
        [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
      };
    }
  );
  if (!committed) return null;
  if (meta && organization) {
    const assigned = await assignNewOrganizationMembers("session", [result.id], organization);
    if (assigned?.ok === false) {
      reportFailure("session-group-assignment", assigned.reason);
    }
  }
  return result;
}

/**
 * P2g-4b — the Inbox drag exit: move ONE tab ref between Inbox items (or
 * reorder within one), with the [AP] STALE-DROP GUARD and exact undo.
 *
 * Guard: source and target are RE-READ from storage here, at drop time; if
 * either differs from the complete rendered snapshot captured by the gesture
 * or vanished, nothing is written and {ok:false, stale:true} comes back. The
 * caller shows "List changed — nothing moved".
 *
 * Semantics ([AP]): the moved ref carries its per-tab labels (they live on
 * the ref); each bundle keeps its own meta (source, timestamps). An emptied
 * source tombstones. `targetId: null` = the between-bundles zone — a NEW
 * ordinary item (`source: "manual"`, no new enum). ONE journal entry records
 * the pre-state of BOTH items (and removes a created bundle), so a single
 * Undo restores everything exactly.
 *
 * @param {import("./types.js").InboxItem} source item snapshot captured at lift
 * @param {number} fromIndex
 * @param {import("./types.js").InboxItem|null} target item snapshot at drop, or null for a new bundle
 * @param {number} toIndex insert-before index in the target; -1 = append
 * @returns {Promise<{ok: boolean, stale?: boolean, noop?: boolean, entry?: object}>}
 */
export async function moveInboxTab(source, fromIndex, target, toIndex) {
  return moveInboxTabs(
    [{ item: source, indexes: [fromIndex] }], target, toIndex
  );
}

/**
 * Move a selected set of Inbox refs as one atomic operation. Selection order
 * is preserved, every source and the destination are checked at the commit
 * point, and one Undo restores the complete pre-drag state.
 *
 * @param {{item: import("./types.js").InboxItem, indexes: number[]}[]} sources
 *   source snapshots captured at lift
 * @param {import("./types.js").InboxItem|null} targetExpected target snapshot at drop
 * @param {number} toIndex insert-before index, or -1 to append
 * @returns {Promise<{ok: boolean, stale?: boolean, noop?: boolean, moved?: number, entry?: object}>}
 */
export async function moveInboxTabs(sources, targetExpected, toIndex) {
  if (!Array.isArray(sources) || sources.length === 0 || sources.some((source) =>
    !source?.item?.id || !Array.isArray(source.item.tabs) ||
    !Array.isArray(source.indexes) || source.indexes.length === 0 ||
    source.indexes.some((index) => !Number.isInteger(index) || index < 0 ||
      index >= source.item.tabs.length))) {
    return { ok: false, stale: true };
  }
  const normalized = groupSavedTabSelections(sources);
  const requestedIds = new Set((sources ?? []).flatMap((source) =>
    source?.item?.id ? [source.item.id] : []));
  if (normalized.length === 0 || normalized.length !== requestedIds.size) {
    return { ok: false, stale: true };
  }
  const targetId = targetExpected === null ? null : targetExpected?.id;
  if (targetExpected !== null && !targetId) return { ok: false, stale: true };
  const byId = new Map(normalized.map((source) => [source.expected.id, source]));
  const targetSource = targetId === null ? null : byId.get(targetId);
  if (targetSource && !sameSavedRecord(targetSource.expected, targetExpected)) {
    return { ok: false, stale: true };
  }

  // E2-0c: the whole drop — guard, both record writes, journal entry — is ONE
  // atomic commit, and the [AP] stale guard now re-reads under the store lock
  // at the true commit point (strictly stronger: nothing can change between
  // the guard and the write). Same external contract: {ok, stale?, noop?, entry?}.
  const freshMeta = targetId === null ? await newMeta() : null; // async, built outside the lock
  const now = Date.now();
  let result = { ok: false, stale: true };
  await mutateStores([STORE_KEYS.inbox, JOURNAL_KEY], (maps) => {
    const map = maps[STORE_KEYS.inbox] ?? {};
    for (const source of normalized) {
      const item = map[source.expected.id];
      if (!item || item.deletedAt || !sameSavedRecord(item, source.expected) ||
          source.indexes.some((index) => !item.tabs[index])) {
        result = { ok: false, stale: true };
        return null;
      }
    }
    const target = targetId === null ? null : map[targetId];
    if (targetId !== null && (!target || target.deletedAt ||
        !sameSavedRecord(target, targetExpected))) {
      result = { ok: false, stale: true };
      return null;
    }

    const movedRefs = normalized.flatMap((source) => {
      const item = map[source.expected.id];
      return source.indexes.map((index) => item.tabs[index]);
    });
    const originalItems = new Map();
    for (const source of normalized) {
      originalItems.set(source.expected.id, map[source.expected.id]);
    }
    if (target && !originalItems.has(targetId)) originalItems.set(targetId, target);

    let next = { ...map };
    for (const source of normalized) {
      next = mapWithTabsRemoved(next, map[source.expected.id], source.indexes, now);
    }

    let destinationName;
    const dels = [];
    if (target) {
      const selectedInTarget = new Set(targetSource?.indexes ?? []);
      const remainder = target.tabs.filter((_, index) => !selectedInTarget.has(index));
      let at = toIndex === -1 ? remainder.length : Math.min(toIndex, remainder.length);
      if (toIndex !== -1) {
        at -= [...selectedInTarget].filter((index) => index < toIndex).length;
        at = Math.max(0, Math.min(at, remainder.length));
      }
      const tabs = [...remainder];
      tabs.splice(at, 0, ...movedRefs);
      next[targetId] = { ...target, tabs, kind: tabs.length > 1 ? "window" : "tab", modifiedAt: now };
      delete next[targetId].deletedAt;
      destinationName = "another bundle";
    } else {
      /** @type {import("./types.js").InboxItem} */
      const fresh = { ...freshMeta, kind: movedRefs.length > 1 ? "window" : "tab",
        tabs: movedRefs, source: "manual", labels: [], modifiedAt: now };
      next[fresh.id] = fresh;
      dels.push({ store: STORE_KEYS.inbox, id: fresh.id });
      destinationName = "a new bundle";
    }

    const unchanged = target && normalized.length === 1 && normalized[0].expected.id === targetId &&
      next[targetId].tabs.length === target.tabs.length &&
      next[targetId].tabs.every((ref, index) => ref === target.tabs[index]);
    if (unchanged) {
      result = { ok: true, noop: true, moved: movedRefs.length };
      return null;
    }

    const puts = [...originalItems.values()].map((item) => ({ store: STORE_KEYS.inbox, item }));
    const entry = makeJournalEntry(
      `Moved ${movedRefs.length} tab${movedRefs.length === 1 ? "" : "s"} to ${destinationName}`,
      { puts, dels });
    result = { ok: true, moved: movedRefs.length, entry };
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
