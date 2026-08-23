/** Persist-first close receipts for live browser tabs. */
import { saveableTabRef } from "./tabs.js";
import {
  JOURNAL_KEY, appendedJournal, listActions, makeJournalEntry
} from "./journal.js";
import { mutateStores } from "./store.js";

function closeReceiptTabs(tabs) {
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
      journal.splice(index, 1);
      result = { ok: false, closed: 0, undoId: null, recoverySaved: true };
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
      await closeEffect();
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

  try {
    await closeEffect();
    // Promise resolution means Chrome accepted the operation. Publish Undo only
    // for tab ids that are actually gone, so a partial/no-op close cannot gain
    // a second copy through recovery.
    const missing = await missingReceiptTabs(receiptTabs);
    return await finishReceipt(entry.id, missing);
  } catch {
    const missing = await missingReceiptTabs(receiptTabs);
    return finishReceipt(entry.id, missing);
  }
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
    () => chrome.tabs.remove(tabs.map((tab) => tab.id)),
    { label: `Closed ${recoverable} tab${recoverable === 1 ? "" : "s"}` }
  );
  return { ...result, reason: result.ok ? "closed" : "error" };
}

/** Resolve any persist-first close left pending by a stopped worker. */
export async function recoverPendingLiveCloses() {
  const pending = (await listActions()).filter((entry) =>
    entry?.forwardReceipt?.kind === "close-tabs" &&
    entry.forwardReceipt.status === "pending");
  let recovered = 0;
  for (const entry of pending) {
    const missing = await missingReceiptTabs(entry.forwardReceipt.tabs ?? []);
    await finishReceipt(entry.id, missing);
    recovered += 1;
  }
  return recovered;
}
