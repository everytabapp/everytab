import { canonicalUrlOf, isSaveableTab, isOwnSuspendPage } from "./tabs.js";
import { bump } from "./counters.js";
import { closeTabsWithReceipt } from "./live-close.js";
import { normalizeUrl } from "./url-key.js";

export { normalizeUrl } from "./url-key.js";

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
export function findDuplicateGroupsFromTabs(tabs) {
  /** @type {Map<string, chrome.tabs.Tab[]>} */
  const byKey = new Map();
  for (const t of tabs) {
    if (!isSaveableTab(t)) continue;
    // Canonicalize so a suspended tab dedupes against its awake twin.
    const key = normalizeUrl(canonicalUrlOf(t));
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
  return findDuplicateGroupsFromTabs(await chrome.tabs.query({}));
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
    await chrome.tabs.remove(closing.map((tab) => tab.id));
    for (const group of targets) {
      if (!group.close.some((tab) => tab.active) || group.keep.id === undefined) continue;
      await chrome.tabs.update(group.keep.id, { active: true });
      if (group.keep.windowId !== undefined) {
        await chrome.windows.update(group.keep.windowId, { focused: true });
      }
    }
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
