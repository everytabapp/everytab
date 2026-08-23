/** Pure policy for the optional one-EveryTab-New-Tab-per-window behavior. */

/** @param {unknown} value @param {string} extensionBaseUrl */
export function isEveryTabNewTabUrl(value, extensionBaseUrl) {
  try {
    const url = new URL(String(value ?? ""));
    // Chrome deliberately preserves its browser-owned address-bar identity for
    // an overridden New Tab unless the page performs a real navigation. In
    // EveryTab-search mode that navigation exposes the extension URL; in
    // address-bar mode the same mounted document stays `chrome://newtab/` in
    // the Tabs API. Both are the one override surface this policy owns.
    if (url.protocol === "chrome:" && url.hostname === "newtab" &&
        (url.pathname === "" || url.pathname === "/")) return true;
    const base = new URL(extensionBaseUrl);
    return url.origin === base.origin && url.pathname === `${base.pathname}newtab.html`;
  } catch {
    return false;
  }
}

const tabUrl = (tab) => tab?.pendingUrl || tab?.url || "";

/**
 * Chrome's tab lifecycle is the authoritative fallback when the override page
 * cannot deliver its runtime message. Only the active completed override may
 * ask the worker to reconcile its own window.
 * @param {object} changeInfo @param {object} tab @param {string} extensionBaseUrl
 */
export function shouldReconcileNewTabUpdate(changeInfo, tab, extensionBaseUrl) {
  return changeInfo?.status === "complete" && tab?.active === true &&
    !tab?.pinned && !tab?.incognito &&
    isEveryTabNewTabUrl(tabUrl(tab), extensionBaseUrl);
}

/**
 * Decide only whether the mounted page is the newest eligible keeper and which
 * older tabs may retire. Chrome mutations remain in the background worker.
 * @param {{enabled:boolean,readyTabId:number,windowType:string,extensionBaseUrl:string,
 * creationRanks:Map<number,number>,tabs:Array<object>}} input
 * @returns {{keeperTabId:number,retireTabIds:number[]}|null}
 */
export function planNewTabRetirement(input) {
  if (input?.enabled !== true || input?.windowType !== "normal") return null;
  if (!Number.isInteger(input.readyTabId) || !(input.creationRanks instanceof Map)) return null;
  const ready = (input.tabs ?? []).find((tab) => tab?.id === input.readyTabId);
  const readyRank = input.creationRanks.get(input.readyTabId);
  const trackedReady = Number.isFinite(readyRank);
  // The active mounted override is always a safe keeper, including during
  // browser startup and when a cold MV3 worker missed tabs.onCreated. Only one
  // tab can be active in the window; inactive restored pages remain unable to
  // initiate cleanup.
  const safeUntrackedReady = ready?.active === true;
  if (!ready || (!trackedReady && !safeUntrackedReady) || ready.pinned || ready.incognito ||
      !isEveryTabNewTabUrl(tabUrl(ready), input.extensionBaseUrl)) return null;

  const eligible = (input.tabs ?? []).filter((tab) =>
    Number.isInteger(tab?.id) && tab.windowId === ready.windowId && !tab.pinned && !tab.incognito &&
    isEveryTabNewTabUrl(tabUrl(tab), input.extensionBaseUrl));
  if (trackedReady &&
      eligible.some((tab) => (input.creationRanks.get(tab.id) ?? -1) > readyRank)) return null;
  const retireTabIds = eligible
    .filter((tab) => tab.id !== ready.id && !tab.active)
    .map((tab) => tab.id)
    .sort((a, b) => a - b);
  return retireTabIds.length ? { keeperTabId: ready.id, retireTabIds } : null;
}
