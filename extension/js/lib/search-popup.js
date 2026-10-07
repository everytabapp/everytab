// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { canonicalRef, urlOf } from "./tabs.js";
import { hostnameOf } from "./organize.js";
import { msg } from "./i18n.js";

/** One-shot worker -> popup focus handoff. It carries no tab or browsing data. */
export const SEARCH_POPUP_MODE_KEY = "searchPopupMode";
export const SEARCH_POPUP_MODE_TTL_MS = 5_000;
export const RECENT_TAB_LIMIT = 10;

/** @param {unknown} value @param {number} [now] */
export function isFreshSearchPopupMode(value, now = Date.now()) {
  const requestedAt = Number(value?.requestedAt);
  return Number.isFinite(requestedAt) && requestedAt <= now &&
    now - requestedAt <= SEARCH_POPUP_MODE_TTL_MS;
}

/** Arm the next popup open to focus the shared Search component. */
export async function armSearchPopupMode(now = Date.now()) {
  try {
    await chrome.storage.session.set({
      [SEARCH_POPUP_MODE_KEY]: { requestedAt: now }
    });
    return true;
  } catch {
    return false;
  }
}

/** Clear a request after a failed programmatic open or an explicit fallback. */
export async function clearSearchPopupMode() {
  try {
    await chrome.storage.session.remove(SEARCH_POPUP_MODE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Consume the one-shot handoff. Stale values are removed and never activate the
 * popup, so a failed command cannot leak Search mode into a later toolbar click.
 */
export async function consumeSearchPopupMode(now = Date.now()) {
  let value;
  try {
    value = (await chrome.storage.session.get(SEARCH_POPUP_MODE_KEY))[SEARCH_POPUP_MODE_KEY];
    await chrome.storage.session.remove(SEARCH_POPUP_MODE_KEY);
  } catch {
    return false;
  }
  return isFreshSearchPopupMode(value, now);
}

/** @param {string} url */
function pageContext(url) {
  const host = hostnameOf(url);
  if (host) return host.replace(/^www\./, "");
  if (String(url).startsWith("file:")) return msg("search_context_local_file");
  try {
    if (String(url).startsWith(chrome.runtime.getURL(""))) return msg("manifest_short_name");
  } catch { /* plain-data tests or a context without runtime URLs */ }
  return msg("search_context_internal_page");
}

/**
 * Shape every focused Search host's ten most recently used open tabs. Only
 * normal, non-incognito windows participate. The active tab underneath the
 * surface is excluded, while pinned, discarded, and suspended tabs remain
 * valid switch targets.
 *
 * @param {chrome.windows.Window[]} windows
 * @param {{activeTabId?: number, currentWindowId?: number, limit?: number}} [opts]
 * @returns {import("./search.js").SearchResult[]}
 */
export function recentOpenTabResults(windows, opts = {}) {
  const limit = Math.max(0, Math.floor(Number(opts.limit ?? RECENT_TAB_LIMIT)));
  const tabs = (windows ?? [])
    .filter((win) => win?.type === "normal" && !win.incognito)
    .flatMap((win) => (win.tabs ?? []).map((tab) => ({ ...tab, windowId: tab.windowId ?? win.id })))
    .filter((tab) => !tab.incognito && Number.isInteger(tab.id) &&
      Number.isInteger(tab.windowId) && tab.id !== opts.activeTabId)
    .sort((a, b) =>
      (Number(b.lastAccessed) || 0) - (Number(a.lastAccessed) || 0) ||
      (b.id ?? 0) - (a.id ?? 0))
    .slice(0, limit);

  return tabs.map((tab) => {
    const ref = canonicalRef(tab);
    const url = ref?.url ?? urlOf(tab);
    const title = ref?.title || tab.title || url || msg("search_untitled_tab");
    const windowContext = tab.windowId === opts.currentWindowId
      ? msg("search_context_this_window")
      : msg("search_context_another_window");
    return {
      type: "open",
      title,
      url,
      tabId: tab.id,
      windowId: tab.windowId,
      sourceName: msg("search_recent_context", [pageContext(url), windowContext])
    };
  });
}
