/**
 * P11-03: one guarded whole-window close operation.
 *
 * The UI supplies the exact tab identity it showed in the confirmation. The
 * worker re-reads the live window immediately before removing it and refuses a
 * stale request. Recovery is deliberately best-effort: ordinary web pages are
 * journaled before the window closes, while Chrome/internal pages and exact
 * window state cannot be recreated and are never represented as recoverable.
 */
import { saveableTabRef } from "./tabs.js";
import { closeTabsWithReceipt } from "./live-close.js";

const sortedIds = (ids) => [...ids].sort((a, b) => a - b);
const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

/** @param {chrome.tabs.Tab[]} tabs */
export function windowFingerprint(tabs = []) {
  const withIds = tabs.filter((tab) => Number.isInteger(tab?.id));
  return {
    tabCount: withIds.length,
    tabIds: sortedIds(withIds.map((tab) => tab.id)),
    pinnedTabIds: sortedIds(withIds.filter((tab) => tab.pinned).map((tab) => tab.id))
  };
}

/** Pure exact comparison, including pin-state changes at an unchanged count. */
export function sameWindowFingerprint(expected, live) {
  return expected?.tabCount === live?.tabCount &&
    sameIds(expected?.tabIds ?? [], live?.tabIds ?? []) &&
    sameIds(expected?.pinnedTabIds ?? [], live?.pinnedTabIds ?? []);
}

function validExpected(expected) {
  if (!expected || !Number.isInteger(expected.tabCount) || expected.tabCount < 1) return false;
  const tabIds = expected.tabIds;
  const pinned = expected.pinnedTabIds;
  if (!Array.isArray(tabIds) || !Array.isArray(pinned) || tabIds.length !== expected.tabCount) return false;
  if (![...tabIds, ...pinned].every((id) => Number.isInteger(id) && id >= 0)) return false;
  if (new Set(tabIds).size !== tabIds.length || new Set(pinned).size !== pinned.length) return false;
  const all = new Set(tabIds);
  return pinned.every((id) => all.has(id));
}

/**
 * Close one normal, non-incognito Chrome window if it still matches the UI's
 * confirmation snapshot.
 * @param {number} windowId
 * @param {{tabCount:number,tabIds:number[],pinnedTabIds:number[]}} expected
 */
export async function closeWindowSafely(windowId, expected) {
  if (!Number.isInteger(windowId) || windowId < 0 || !validExpected(expected)) {
    return { ok: false, reason: "invalid" };
  }

  let win;
  try {
    win = await chrome.windows.get(windowId, { populate: true });
  } catch {
    return { ok: false, reason: "gone" };
  }
  if (win.incognito || (win.type && win.type !== "normal")) {
    return { ok: false, reason: "forbidden" };
  }

  const live = windowFingerprint(win.tabs ?? []);
  const normalizedExpected = {
    tabCount: expected.tabCount,
    tabIds: sortedIds(expected.tabIds),
    pinnedTabIds: sortedIds(expected.pinnedTabIds)
  };
  if (!sameWindowFingerprint(normalizedExpected, live)) {
    return { ok: false, reason: "changed", ...live };
  }

  const recoverableCount = (win.tabs ?? []).filter((tab) => saveableTabRef(tab)).length;
  let closed;
  try {
    closed = await closeTabsWithReceipt(
      win.tabs ?? [],
      () => chrome.windows.remove(windowId),
      {
        label: `Closed a window with ${recoverableCount} web tab${recoverableCount === 1 ? "" : "s"} (best-effort recovery)`
      }
    );
  } catch {
    return { ok: false, reason: "error" };
  }
  if (!closed.ok) return { ok: false, reason: "error" };
  return {
    ok: true,
    ...live,
    recoverableCount,
    recoverySaved: closed.recoverySaved,
    undoId: closed.undoId
  };
}
