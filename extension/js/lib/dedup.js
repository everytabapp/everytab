// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { canonicalUrlOf, isSaveableTab, isOwnSuspendPage } from "./tabs.js";
import { bump } from "./counters.js";
import {
  closeTabsWithReceipt, closeUnchangedLiveTabsInBatches
} from "./live-close.js";
import { normalizeUrl } from "./url-key.js";
import {
  duplicateDomainRuleMap, duplicateUrlKey, readDuplicateDomainRules
} from "./duplicate-domain-rules.js";

export { normalizeUrl } from "./url-key.js";

/**
 * A Chrome tab can expose its previous committed `url` and a different
 * `pendingUrl` while navigation is in flight. Neither page is a stable
 * duplicate candidate in that state: acting on the old URL can close the tab
 * that is becoming the new page. Blank committed URLs are safe because their
 * pending URL is already the only identity available.
 * @param {chrome.tabs.Tab} tab
 * @returns {string|null}
 */
function stableDuplicateKey(tab, rules) {
  const current = canonicalUrlOf(tab);
  const currentKey = duplicateUrlKey(current, rules);
  if (!tab.pendingUrl) return currentKey;
  const pending = canonicalUrlOf({ ...tab, url: "" });
  const pendingKey = duplicateUrlKey(pending, rules);
  return currentKey && currentKey === pendingKey ? currentKey : null;
}

/**
 * @typedef {Object} DupGroup
 * @property {string} key normalized URL
 * @property {chrome.tabs.Tab} keep
 * @property {chrome.tabs.Tab[]} close
 * @property {chrome.tabs.Tab[]} tabs every copy, including the survivor and pinned copies
 */

/**
 * Group open tabs by normalized URL. Within a group the kept tab is the
 * active one if present, else the oldest (lowest id). Never proposes closing
 * pinned tabs.
 * @returns {Promise<DupGroup[]>}
 */
export function findDuplicateGroupsFromTabs(tabs, rules = []) {
  const ruleMap = duplicateDomainRuleMap(rules);
  /** @type {Map<string, chrome.tabs.Tab[]>} */
  const byKey = new Map();
  for (const t of tabs) {
    if (!isSaveableTab(t)) continue;
    // Canonicalize so a suspended tab dedupes against its awake twin, while
    // exact-domain exceptions can retain fragments or skip comparison.
    const key = stableDuplicateKey(t, ruleMap);
    if (key === null) continue;
    const arr = byKey.get(key) ?? [];
    arr.push(t);
    byKey.set(key, arr);
  }

  /** @type {DupGroup[]} */
  const groups = [];
  for (const [key, arr] of byKey) {
    if (arr.length < 2) continue;
    // Keep preference: the active copy → an awake (non-suspended) copy → oldest.
    const keep =
      arr.find((t) => t.active) ??
      arr.find((t) => !isOwnSuspendPage(t)) ??
      arr.reduce((a, b) => (a.id < b.id ? a : b));
    const close = arr.filter((t) => t !== keep && !t.pinned);
    if (close.length > 0) groups.push({ key, keep, close, tabs: arr });
  }
  return groups;
}

export async function findDuplicateGroups() {
  const [tabs, rules] = await Promise.all([
    chrome.tabs.query({}), readDuplicateDomainRules()
  ]);
  return findDuplicateGroupsFromTabs(tabs, rules);
}

/** Total number of closable duplicate tabs. */
export async function duplicateCount() {
  const groups = await findDuplicateGroups();
  return groups.reduce((n, g) => n + g.close.length, 0);
}

/**
 * Close duplicates — one copy (by tabId), one group (by key), or all groups.
 * The fresh duplicate scan is also the stale guard: a requested tab is closed
 * only if it is still a closable extra at commit time. If a closed tab was
 * active, focus moves to its survivor (PRD §3.5).
 * @param {{tabId?: number, key?: string, auto?: boolean}} [opts]
 * @returns {Promise<number>} tabs closed
 */
export async function closeDuplicates(opts = {}) {
  const groups = await findDuplicateGroups();
  const selected = opts.key ? groups.filter((g) => g.key === opts.key) : groups;
  const targets = opts.tabId === undefined
    ? selected
    : selected
        .map((g) => ({ ...g, close: g.close.filter((t) => t.id === opts.tabId) }))
        .filter((g) => g.close.length > 0);
  const closing = targets.flatMap((group) => group.close);
  if (closing.length === 0) return 0;
  const result = await closeTabsWithReceipt(closing, async () => {
    // The receipt write can yield long enough for the survivor to navigate or
    // disappear. Re-scan the duplicate relation, then exact-match the original
    // close identities at the final Chrome boundary.
    const currentClosingIds = new Set((await findDuplicateGroups())
      .flatMap((group) => group.close).map((tab) => tab.id));
    const stillDuplicate = closing.filter((tab) => currentClosingIds.has(tab.id));
    const close = await closeUnchangedLiveTabsInBatches(stillDuplicate);
    const closedIds = new Set(close.closed.map((tab) => tab.id));
    for (const group of targets) {
      if (!group.close.some((tab) => tab.active && closedIds.has(tab.id)) ||
          group.keep.id === undefined) continue;
      try {
        await chrome.tabs.update(group.keep.id, { active: true });
        if (group.keep.windowId !== undefined) {
          await chrome.windows.update(group.keep.windowId, { focused: true });
        }
      } catch { /* the close ledger remains authoritative if focus changed */ }
    }
    return close;
  }, {
    label: `Closed ${closing.length} duplicate${closing.length === 1 ? "" : "s"}`,
    auto: opts.auto === true,
    category: "duplicates"
  });
  if (!result.ok) return 0;
  bump("duplicatesClosed", result.closed);
  return result.closed;
}

/** Refresh the toolbar badge with the duplicate count. */
export async function updateDupBadge() {
  const count = await duplicateCount();
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  if (count > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: "#b06000" });
  }
  return count;
}
