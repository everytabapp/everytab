// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Persist-first close receipts for live browser tabs. */
import { canonicalUrlOf, saveableTabRef } from "./tabs.js";
import {
  JOURNAL_KEY, appendedJournal, listActions, makeJournalEntry
} from "./journal.js";
import { mutateStores } from "./store.js";

/**
 * @param {chrome.tabs.Tab[]} tabs
 * @returns {Array<{tabId:number,ref:object,windowId?:number,index?:number,pinned:boolean}>}
 */
export function closeReceiptTabs(tabs) {
  return tabs.flatMap((tab) => {
    const ref = saveableTabRef(tab);
    if (!Number.isInteger(tab?.id) || !ref) return [];
    return [{
      tabId: tab.id,
      ref,
      ...(Number.isInteger(tab.windowId) && tab.windowId >= 0
        ? { windowId: tab.windowId }
        : {}),
      ...(Number.isInteger(tab.index) && tab.index >= 0 ? { index: tab.index } : {}),
      pinned: tab.pinned === true
    }];
  });
}

/**
 * The mutable Chrome tab fields that authorize a close. Raw committed and
 * pending addresses are both retained: a canonical URL alone can hide an
 * in-flight navigation or a change between a suspended and awake page.
 * @param {chrome.tabs.Tab} tab
 * @returns {{tabId:number,windowId:number|null,url:string,pendingUrl:string,canonicalUrl:string|null,pinned:boolean,incognito:boolean}|null}
 */
export function liveTabCloseIdentity(tab) {
  if (!Number.isInteger(tab?.id)) return null;
  return {
    tabId: tab.id,
    windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
    url: typeof tab.url === "string" ? tab.url : "",
    pendingUrl: typeof tab.pendingUrl === "string" ? tab.pendingUrl : "",
    canonicalUrl: canonicalUrlOf(tab),
    pinned: tab.pinned === true,
    incognito: tab.incognito === true
  };
}

/**
 * @param {chrome.tabs.Tab} expected
 * @param {chrome.tabs.Tab|undefined} current
 * @returns {boolean}
 */
export function sameLiveTabCloseIdentity(expected, current) {
  const before = liveTabCloseIdentity(expected);
  const now = liveTabCloseIdentity(current);
  return before !== null && now !== null &&
    before.tabId === now.tabId && before.windowId === now.windowId &&
    before.url === now.url && before.pendingUrl === now.pendingUrl &&
    before.canonicalUrl === now.canonicalUrl && before.pinned === now.pinned &&
    before.incognito === now.incognito;
}

/**
 * Re-read each distinct target and retain only unchanged live identities.
 * @param {chrome.tabs.Tab[]} expectedTabs
 * @param {{get:(tabId:number)=>Promise<chrome.tabs.Tab>}} tabsApi
 * @returns {Promise<Array<{expected:chrome.tabs.Tab,current:chrome.tabs.Tab}>>}
 */
export async function revalidateLiveTabsForClose(expectedTabs, tabsApi = chrome.tabs) {
  const distinct = [];
  const ids = new Set();
  for (const tab of expectedTabs ?? []) {
    if (!Number.isInteger(tab?.id) || ids.has(tab.id)) continue;
    ids.add(tab.id);
    distinct.push(tab);
  }
  const checked = await Promise.all(distinct.map(async (expected) => {
    try {
      const current = await tabsApi.get(expected.id);
      return sameLiveTabCloseIdentity(expected, current) ? { expected, current } : null;
    } catch {
      return null;
    }
  }));
  return checked.filter(Boolean);
}

/**
 * Revalidate at the last available boundary, remove only unchanged identities,
 * and report which of those exact targets are now absent. Chrome has no atomic
 * compare-and-remove operation, so navigation can still race the final call.
 * @param {chrome.tabs.Tab[]} expectedTabs
 * @param {{get:(tabId:number)=>Promise<chrome.tabs.Tab>,remove:(tabIds:number[])=>Promise<unknown>}} tabsApi
 * @param {{allOrNothing?:boolean,accept?:(current:chrome.tabs.Tab,expected:chrome.tabs.Tab)=>boolean}} options
 * @returns {Promise<{matched:chrome.tabs.Tab[],closed:chrome.tabs.Tab[],error:boolean}>}
 */
export async function closeUnchangedLiveTabs(
  expectedTabs,
  tabsApi = chrome.tabs,
  { allOrNothing = false, accept = null } = {}
) {
  const expectedCount = new Set((expectedTabs ?? [])
    .filter((tab) => Number.isInteger(tab?.id)).map((tab) => tab.id)).size;
  const exactMatches = await revalidateLiveTabsForClose(expectedTabs, tabsApi);
  const matches = typeof accept === "function"
    ? exactMatches.filter(({ expected, current }) => accept(current, expected))
    : exactMatches;
  if (matches.length === 0 || (allOrNothing && matches.length !== expectedCount)) {
    return { matched: [], closed: [], error: false };
  }
  let failed = false;
  try {
    await tabsApi.remove(matches.map(({ current }) => current.id));
  } catch {
    failed = true;
  }
  const closed = (await Promise.all(matches.map(async ({ expected }) => {
    try {
      await tabsApi.get(expected.id);
      return null;
    } catch {
      return expected;
    }
  }))).filter(Boolean);
  return { matched: matches.map(({ current }) => current), closed, error: failed };
}

const yieldCloseBatch = () => new Promise((resolve) => setTimeout(resolve, 40));

/**
 * Close a large reviewed set in bounded batches. Chrome broadcasts one event
 * per removed tab; yielding between batches lets extension surfaces consume
 * those events without one long main-thread burst.
 * @param {chrome.tabs.Tab[]} expectedTabs
 * @param {{get:(tabId:number)=>Promise<chrome.tabs.Tab>,remove:(tabIds:number[])=>Promise<unknown>}} tabsApi
 * @param {{batchSize?:number,yieldBetween?:()=>Promise<void>}} options
 */
export async function closeUnchangedLiveTabsInBatches(
  expectedTabs,
  tabsApi = chrome.tabs,
  { batchSize = 20, yieldBetween = yieldCloseBatch } = {}
) {
  const distinct = [];
  const ids = new Set();
  for (const tab of expectedTabs ?? []) {
    if (!Number.isInteger(tab?.id) || ids.has(tab.id)) continue;
    ids.add(tab.id);
    distinct.push(tab);
  }
  const size = Math.max(1, Math.floor(Number(batchSize) || 20));
  const matched = [];
  const closed = [];
  let error = false;
  for (let offset = 0; offset < distinct.length; offset += size) {
    const result = await closeUnchangedLiveTabs(
      distinct.slice(offset, offset + size), tabsApi);
    matched.push(...result.matched);
    closed.push(...result.closed);
    error ||= result.error;
    if (offset + size < distinct.length) await yieldBetween();
  }
  return { matched, closed, error };
}

async function tabIsGone(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return false;
  } catch {
    return true;
  }
}

async function missingReceiptTabs(receiptTabs) {
  const missing = [];
  for (const tab of receiptTabs) if (await tabIsGone(tab.tabId)) missing.push(tab);
  return missing;
}

async function finishReceipt(entryId, missing) {
  let result = { ok: false, closed: 0, undoId: null, recoverySaved: false };
  await mutateStores([JOURNAL_KEY], (maps) => {
    const journal = structuredClone(maps[JOURNAL_KEY] ?? []);
    const index = journal.findIndex((entry) => entry.id === entryId);
    if (index < 0) return null;
    const entry = journal[index];
    if (entry.forwardReceipt?.kind !== "close-tabs" ||
        entry.forwardReceipt.status !== "pending") return null;
    if (missing.length === 0) {
      entry.reopen = [];
      entry.forwardReceipt = {
        ...entry.forwardReceipt,
        status: "complete",
        tabs: [],
        closedCount: 0
      };
      const keepsSavedEffect = (entry.puts?.length ?? 0) > 0 ||
        (entry.dels?.length ?? 0) > 0 || (entry.moves?.length ?? 0) > 0 ||
        Boolean(entry.restoreCheckpointId || entry.closeDayTransactionId);
      if (!keepsSavedEffect) journal.splice(index, 1);
      result = {
        ok: keepsSavedEffect,
        closed: 0,
        undoId: keepsSavedEffect ? entry.id : null,
        recoverySaved: true
      };
      return { [JOURNAL_KEY]: journal };
    }
    entry.reopen = [missing.map((tab) => tab.ref)];
    entry.label = String(entry.label ?? "").replace(
      /^Closed \d+/,
      `Closed ${missing.length}`
    );
    entry.forwardReceipt = {
      ...entry.forwardReceipt,
      status: "complete",
      tabs: missing,
      closedCount: missing.length
    };
    result = {
      ok: true,
      closed: missing.length,
      undoId: entry.id,
      recoverySaved: true
    };
    return { [JOURNAL_KEY]: journal };
  });
  return result;
}

async function recordConfirmedReceiptTabs(entryId, confirmedTabs) {
  await mutateStores([JOURNAL_KEY], (maps) => {
    const journal = structuredClone(maps[JOURNAL_KEY] ?? []);
    const entry = journal.find((candidate) => candidate.id === entryId);
    if (!entry || entry.forwardReceipt?.kind !== "close-tabs" ||
        entry.forwardReceipt.status !== "pending") return null;
    entry.forwardReceipt = {
      ...entry.forwardReceipt,
      // Presence, including an empty array, distinguishes an explicit close
      // ledger from crash recovery's necessarily weaker absence inference.
      confirmedTabs: confirmedTabs,
      confirmedAt: Date.now()
    };
    return { [JOURNAL_KEY]: journal };
  });
}

/**
 * Complete a receipt already committed atomically with another saved effect.
 * @param {string} entryId
 * @param {chrome.tabs.Tab[]} tabs
 * @param {() => Promise<{closed?:chrome.tabs.Tab[]}|unknown>} closeEffect
 * @returns {Promise<{ok:boolean,closed:number,undoId:string|null,recoverySaved:boolean}>}
 */
export async function finishPendingLiveClose(entryId, tabs, closeEffect) {
  const receiptTabs = closeReceiptTabs(tabs);
  let outcome;
  try {
    outcome = await closeEffect();
  } catch {
    return finishReceipt(entryId, await missingReceiptTabs(receiptTabs));
  }
  const confirmedIds = Array.isArray(outcome?.closed)
    ? new Set(outcome.closed.map((tab) => tab?.id).filter(Number.isInteger))
    : null;
  const closed = confirmedIds
    ? receiptTabs.filter((tab) => confirmedIds.has(tab.tabId))
    : await missingReceiptTabs(receiptTabs);
  // Do not turn a journal/storage settlement failure into broad absence
  // inference: an explicit close ledger remains the stronger evidence.
  if (!confirmedIds) return finishReceipt(entryId, closed);
  try {
    return await finishReceipt(entryId, closed);
  } catch (failure) {
    // Keep healthy closes to one settlement commit. If that commit fails, make
    // one narrow best-effort write of the in-memory exact ledger so startup can
    // finish without inferring from every now-absent original target.
    try { await recordConfirmedReceiptTabs(entryId, closed); }
    catch { /* retain and rethrow the original settlement failure */ }
    throw failure;
  }
}

/**
 * Persist an inverse before invoking one browser close effect, then publish the
 * action only after that effect completes. Recovery can distinguish a prepared
 * action that never ran from a partial/complete close after an MV3 stop.
 *
 * @param {chrome.tabs.Tab[]} tabs
 * @param {() => Promise<any>} closeEffect
 * @param {{label:string,auto?:boolean,category?:string}} options
 */
export async function closeTabsWithReceipt(tabs, closeEffect, {
  label,
  auto = false,
  category = ""
}) {
  const receiptTabs = closeReceiptTabs(tabs);
  if (receiptTabs.length === 0) {
    try {
      const outcome = await closeEffect();
      if (Array.isArray(outcome?.closed) && outcome.closed.length === 0) {
        return { ok: false, closed: 0, undoId: null, recoverySaved: true };
      }
      return { ok: true, closed: 0, undoId: null, recoverySaved: true };
    } catch {
      return { ok: false, closed: 0, undoId: null, recoverySaved: true };
    }
  }
  const entry = makeJournalEntry(label, {
    reopen: [receiptTabs.map((tab) => tab.ref)]
  }, {
    auto,
    category,
    forwardReceipt: { kind: "close-tabs", status: "pending", tabs: receiptTabs }
  });
  await mutateStores([JOURNAL_KEY], (maps) => ({
    [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
  }));

  return finishPendingLiveClose(entry.id, tabs, closeEffect);
}

/** Fresh id validation plus a persist-first direct tab close. */
export async function closeLiveTabsById(tabIds) {
  const ids = [...new Set((tabIds ?? []).filter(Number.isInteger))];
  if (ids.length === 0) return { ok: false, reason: "empty", closed: 0 };
  const tabs = [];
  for (const id of ids) {
    try { tabs.push(await chrome.tabs.get(id)); }
    catch { /* already gone */ }
  }
  if (tabs.length === 0) return { ok: false, reason: "gone", closed: 0 };
  if (tabs.some((tab) => !saveableTabRef(tab))) {
    return { ok: false, reason: "unavailable", closed: 0 };
  }
  const recoverable = closeReceiptTabs(tabs).length;
  const result = await closeTabsWithReceipt(
    tabs,
    () => closeUnchangedLiveTabs(tabs),
    { label: `Closed ${recoverable} tab${recoverable === 1 ? "" : "s"}` }
  );
  return { ...result, reason: result.ok ? "closed" : "error" };
}

/**
 * Close only pages that EveryTab cannot serialize for Undo. The separate
 * worker route is intentional: a stale UI can never use this non-recoverable
 * path to bypass the persist-first receipt for an ordinary web page.
 */
export async function closeUnsaveableTabsById(tabIds) {
  const ids = [...new Set((tabIds ?? []).filter(Number.isInteger))];
  if (ids.length === 0) return { ok: false, reason: "empty", closed: 0 };
  const tabs = [];
  for (const id of ids) {
    try { tabs.push(await chrome.tabs.get(id)); }
    catch { /* already gone */ }
  }
  if (tabs.length === 0) return { ok: false, reason: "gone", closed: 0 };
  if (tabs.some((tab) => tab.incognito || saveableTabRef(tab))) {
    return { ok: false, reason: "forbidden", closed: 0 };
  }
  const result = await closeUnchangedLiveTabs(tabs);
  if (result.closed.length > 0) {
    return {
      ok: true, reason: "closed", closed: result.closed.length, undoId: null
    };
  }
  return {
    ok: false,
    reason: result.error ? "error" : "changed",
    closed: 0
  };
}

/** Resolve any persist-first close left pending by a stopped worker. */
export async function recoverPendingLiveCloses() {
  const pending = (await listActions()).filter((entry) =>
    entry?.forwardReceipt?.kind === "close-tabs" &&
    entry.forwardReceipt.status === "pending");
  let recovered = 0;
  for (const entry of pending) {
    const missing = Array.isArray(entry.forwardReceipt.confirmedTabs)
      ? entry.forwardReceipt.confirmedTabs
      : await missingReceiptTabs(entry.forwardReceipt.tabs ?? []);
    await finishReceipt(entry.id, missing);
    recovered += 1;
  }
  return recovered;
}
