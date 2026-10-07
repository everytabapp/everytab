// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "./failure-diagnostic.js";
/**
 * F18 — group-aware sessions. Read-and-recreate ONLY: EveryTab captures a
 * window's Chrome tab groups at save time and recreates them at restore time. It
 * never manages, edits, or tracks live groups outside the save/restore boundary.
 *
 * Split of responsibility:
 *   · pure helpers (`mapGroupIndexes`, `groupPlanFromRefs`) run in Node — the
 *     membership mapping and the restore plan are just data transforms.
 *   · chrome-touching helpers (`hasTabGroupsPermission`, `fetchGroupTemplates`,
 *     `recreateWindowGroups`) read/create groups. Membership (`groupIndex`) is
 *     FREE — reading `tab.groupId` and `chrome.tabs.group()` are plain tabs-API.
 *     Only names/colors/collapsed need the optional `tabGroups` permission.
 *
 * Groups are garnish, never the meal: a recreate failure leaves those tabs
 * ungrouped and the restore still succeeds (see `recreateWindowGroups`).
 */

/** The optional permission that unlocks reading/writing group name/color/collapsed. */
export const TAB_GROUPS_PERMISSION = { permissions: ["tabGroups"] };

/** Chrome's tab-group color names → a hex the read-only session chips can paint. */
export const GROUP_COLOR_HEX = {
  grey: "#5f6368",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#188038",
  pink: "#d01884",
  purple: "#a142f4",
  cyan: "#007b83",
  orange: "#fa903e"
};

/** Chrome's sentinel for "this tab is not in a group". */
const NO_GROUP = -1;

/**
 * A UI-injected reporter for the one non-blocking "Tab groups could not be
 * recreated" notice (spec §5.4). The dashboard registers `showNotice`; the
 * background service worker leaves it null (no UI there), so a Focus-path
 * recreate failure is silent beyond the console warning. Keeps this domain
 * module free of any DOM dependency.
 * @type {((message: string) => void) | null}
 */
let groupNotifier = null;
/** @param {(message: string) => void} fn */
export function setGroupRestoreNotifier(fn) {
  groupNotifier = typeof fn === "function" ? fn : null;
}

/** Is the optional `tabGroups` permission currently granted? Never throws. */
export async function hasTabGroupsPermission() {
  try {
    return await chrome.permissions.contains(TAB_GROUPS_PERMISSION);
  } catch {
    return false;
  }
}

/**
 * Ensure the optional `tabGroups` permission is granted, requesting it if needed.
 * MUST be called from a user gesture (a click) — Chrome only shows the grant
 * prompt then. Returns true if already granted or newly granted, false if denied
 * or unavailable. Safe if the permission is ever install-time (contains → true,
 * no request).
 * @returns {Promise<boolean>}
 */
export async function ensureTabGroupsPermission() {
  if (await hasTabGroupsPermission()) return true;
  try {
    return await chrome.permissions.request(TAB_GROUPS_PERMISSION);
  } catch {
    return false;
  }
}

/**
 * Pure: map a window's saveable tabs (in order, aligned to the refs array) to a
 * per-tab group index and the distinct group ids in first-seen order.
 * `groupIndexByPos[i]` is the group index for saveable tab i, or undefined when
 * that tab is ungrouped. Pinned tabs report `groupId === -1`, so they never map.
 * @param {chrome.tabs.Tab[]} saveableTabs
 * @returns {{groupIndexByPos: (number|undefined)[], groupIds: number[]}}
 */
export function mapGroupIndexes(saveableTabs) {
  const groupIds = [];
  const indexByGroupId = new Map();
  const groupIndexByPos = new Array((saveableTabs ?? []).length);
  for (let i = 0; i < (saveableTabs ?? []).length; i++) {
    const gid = saveableTabs[i]?.groupId;
    if (gid == null || gid === NO_GROUP) continue;
    if (!indexByGroupId.has(gid)) {
      indexByGroupId.set(gid, groupIds.length);
      groupIds.push(gid);
    }
    groupIndexByPos[i] = indexByGroupId.get(gid);
  }
  return { groupIndexByPos, groupIds };
}

/**
 * Read the title/color/collapsed of each captured group. With the permission a
 * `chrome.tabGroups.get` fills each entry; without it (or on any read failure)
 * the entry stays `{}` (membership only, spec §4). Returns one entry per id in
 * order, so `groups[groupIndex]` lines up with `mapGroupIndexes`.
 * @param {number[]} groupIds distinct group ids, first-seen order
 * @param {boolean} withPermission
 * @returns {Promise<import("./types.js").GroupTemplate[]>}
 */
export async function fetchGroupTemplates(groupIds, withPermission) {
  const groups = (groupIds ?? []).map(() => ({}));
  if (!withPermission) return groups;
  for (let i = 0; i < groupIds.length; i++) {
    try {
      const g = await chrome.tabGroups.get(groupIds[i]);
      const meta = {};
      if (g?.title) meta.title = g.title;
      if (g?.color) meta.color = g.color;
      if (g?.collapsed) meta.collapsed = true;
      groups[i] = meta;
    } catch {
      /* group vanished mid-capture — keep membership-only {} */
    }
  }
  return groups;
}

/**
 * Read metadata for live group ids in one query when Chrome supports it. Open
 * tabs use this read model only for presentation; membership still comes from
 * each tab's ordinary `groupId`, so the UI can retain neutral group structure
 * without the optional permission. Missing/vanished groups remain `{}`.
 * @param {number[]} groupIds
 * @param {boolean} withPermission
 * @returns {Promise<Map<number, import("./types.js").GroupTemplate>>}
 */
export async function fetchLiveGroupDetails(groupIds, withPermission) {
  const ids = [...new Set((groupIds ?? []).filter((id) => Number.isInteger(id) && id !== NO_GROUP))];
  const details = new Map(ids.map((id) => [id, {}]));
  if (!withPermission || ids.length === 0) return details;

  const keep = (group) => {
    if (!group || !details.has(group.id)) return;
    const meta = {};
    if (group.title) meta.title = group.title;
    if (group.color) meta.color = group.color;
    if (group.collapsed) meta.collapsed = true;
    details.set(group.id, meta);
  };
  if (typeof chrome.tabGroups?.query === "function") {
    try {
      (await chrome.tabGroups.query({})).forEach(keep);
      return details;
    } catch {
      /* fall through to bounded per-id reads */
    }
  }
  await Promise.all(ids.map(async (id) => {
    try { keep(await chrome.tabGroups.get(id)); }
    catch { /* group vanished mid-read — retain membership-only metadata */ }
  }));
  return details;
}

/**
 * Pure: turn a restored window's refs (each aligned to a created tab id) into a
 * grouping plan — one entry per group index that has ≥1 created tab, carrying the
 * tab ids to group and the stored template. Refs without a `groupIndex`, or whose
 * tab id is missing, are skipped.
 * @param {import("./types.js").TabRef[]} refs
 * @param {(number|undefined)[]} tabIds created tab id per ref (aligned by index)
 * @param {import("./types.js").GroupTemplate[]} [groups]
 * @returns {{groupIndex: number, tabIds: number[], template: import("./types.js").GroupTemplate}[]}
 */
export function groupPlanFromRefs(refs, tabIds, groups = []) {
  const byIndex = new Map();
  for (let i = 0; i < (refs ?? []).length; i++) {
    const gi = refs[i]?.groupIndex;
    const tabId = tabIds?.[i];
    if (gi == null || tabId == null) continue;
    if (!byIndex.has(gi)) byIndex.set(gi, []);
    byIndex.get(gi).push(tabId);
  }
  const plan = [];
  for (const [groupIndex, ids] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    plan.push({ groupIndex, tabIds: ids, template: groups?.[groupIndex] ?? {} });
  }
  return plan;
}

/**
 * Recreate a restored window's tab groups. Best-effort and permission-gated:
 * when preservation is off or the permission is absent, nothing is grouped and
 * the flat restore stands (spec §5). Membership is applied first; title/color
 * when stored; `collapsed` LAST (after every group exists), so tab creation and
 * grouping never fight a collapsing UI. Any failure leaves those tabs ungrouped,
 * reports the one non-blocking notice, and still resolves — never rejects.
 * @param {number} windowId
 * @param {import("./types.js").TabRef[]} refs the window's refs (carry groupIndex)
 * @param {(number|undefined)[]} tabIds created tab id per ref (aligned by index)
 * @param {import("./types.js").GroupTemplate[]} [groups] the window's stored templates
 * @param {{preserveEnabled: boolean, withPermission: boolean}} gate
 * @returns {Promise<{attempted: boolean, ok: boolean}>}
 */
export async function recreateWindowGroups(windowId, refs, tabIds, groups, gate) {
  if (!gate?.preserveEnabled || !gate?.withPermission) return { attempted: false, ok: true };
  const plan = groupPlanFromRefs(refs, tabIds, groups);
  if (plan.length === 0) return { attempted: false, ok: true };

  let ok = true;
  const collapsedGroupIds = [];
  for (const { tabIds: ids, template } of plan) {
    try {
      const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
      const update = {};
      if (template.title) update.title = template.title;
      if (template.color) update.color = template.color;
      if (Object.keys(update).length > 0) await chrome.tabGroups.update(groupId, update);
      if (template.collapsed) collapsedGroupIds.push(groupId);
    } catch {
      ok = false; // this group failed; keep going so the rest still recreate
    }
  }
  // Collapse LAST, once every group exists (spec §5.3).
  for (const groupId of collapsedGroupIds) {
    try {
      await chrome.tabGroups.update(groupId, { collapsed: true });
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    reportFailure("tab-group-restore", undefined);
    // Language-free reason; the Dashboard owner maps it to catalogue copy.
    groupNotifier?.("tab-group-restore");
  }
  return { attempted: true, ok };
}
