// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import {
  isEveryTabNewTabUrl,
  planNewTabRetirement
} from "../lib/newtab-singleton.js";

/**
 * Own creation order and safe retirement for the optional one-New-Tab-per-
 * window policy. Planning uses a populated window snapshot, then every target
 * is revalidated immediately before Chrome is asked to remove it.
 *
 * @param {{readSettings: () => Promise<{oneNewTabPerWindow?: boolean}>}} dependencies
 */
export function createNewTabSingletonOwner({ readSettings }) {
  const creationRanks = new Map();
  let creationRank = 0;

  const retireOlder = async (senderTab) => {
    if (!Number.isInteger(senderTab?.id) || !Number.isInteger(senderTab?.windowId)) {
      return { ok: false, reason: "missing-tab" };
    }

    const settings = await readSettings();
    if (settings.oneNewTabPerWindow !== true) {
      return { ok: true, reason: "disabled" };
    }

    let window;
    try {
      window = await chrome.windows.get(senderTab.windowId, { populate: true });
    } catch {
      return { ok: true, reason: "window-gone" };
    }

    const extensionBaseUrl = chrome.runtime.getURL("");
    const plan = planNewTabRetirement({
      enabled: true,
      readyTabId: senderTab.id,
      windowType: window.type,
      extensionBaseUrl,
      creationRanks,
      tabs: window.tabs ?? []
    });
    if (!plan) return { ok: true, reason: "no-change" };

    const retireTabIds = [];
    for (const tabId of plan.retireTabIds) {
      try {
        const live = await chrome.tabs.get(tabId);
        if (live.windowId === senderTab.windowId && !live.pinned && !live.incognito &&
            !live.active &&
            isEveryTabNewTabUrl(live.pendingUrl || live.url, extensionBaseUrl)) {
          retireTabIds.push(tabId);
        }
      } catch { /* the candidate already closed */ }
    }

    const removals = await Promise.allSettled(
      retireTabIds.map((tabId) => chrome.tabs.remove(tabId))
    );
    const retired = removals.filter(({ status }) => status === "fulfilled").length;
    return { ok: true, reason: retired ? "retired" : "no-change", retired };
  };

  return Object.freeze({
    recordCreation(tab) {
      if (!Number.isInteger(tab?.id)) return;
      creationRanks.set(tab.id, ++creationRank);
    },
    resetCreationOrder() {
      creationRanks.clear();
    },
    forget(tabId) {
      creationRanks.delete(tabId);
    },
    retireOlder
  });
}
