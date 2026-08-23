/**
 * Set-based live-tab movement for the Open Tabs surface.
 *
 * The interface accepts one stable selected set and one destination. Validation,
 * the single best-effort Undo entry, and every Chrome mutation stay behind this
 * worker-owned seam so UI callers cannot accidentally move only the invoking row.
 */
import { recordAction } from "./journal.js";

const uniqueTabIds = (values) => [...new Set((Array.isArray(values) ? values : [])
  .filter((value) => Number.isInteger(value) && value >= 0))];

/**
 * @typedef {{kind:"window",windowId:number,index?:number}|{kind:"new-window"}} OpenTabMoveDestination
 * @typedef {{ok:boolean,reason?:string,moved:number,windowId?:number,undoId?:string|null}} OpenTabMoveResult
 */

/**
 * Move one selected set to an existing regular window or a fresh background
 * window. The selected order is preserved and the operation records one Undo.
 * @param {number[]} tabIds
 * @param {OpenTabMoveDestination} destination
 * @returns {Promise<OpenTabMoveResult>}
 */
export async function moveSelectedOpenTabs(tabIds, destination) {
  const ids = uniqueTabIds(tabIds);
  if (ids.length === 0) return { ok: false, reason: "empty", moved: 0 };
  if (!destination || !["window", "new-window"].includes(destination.kind)) {
    return { ok: false, reason: "invalid-destination", moved: 0 };
  }

  const tabs = [];
  try {
    for (const id of ids) tabs.push(await chrome.tabs.get(id));
  } catch {
    return { ok: false, reason: "changed", moved: 0 };
  }
  if (tabs.some((tab) => tab?.incognito || !Number.isInteger(tab?.windowId) || !Number.isInteger(tab?.index))) {
    return { ok: false, reason: "unavailable", moved: 0 };
  }

  let targetWindowId = null;
  let targetIndex = -1;
  if (destination.kind === "window") {
    if (!Number.isInteger(destination.windowId)) {
      return { ok: false, reason: "invalid-destination", moved: 0 };
    }
    let target;
    try { target = await chrome.windows.get(destination.windowId); }
    catch { return { ok: false, reason: "changed", moved: 0 }; }
    if (target?.type !== "normal" || target?.incognito) {
      return { ok: false, reason: "unavailable", moved: 0 };
    }
    targetWindowId = destination.windowId;
    if (destination.index !== undefined &&
        (!Number.isInteger(destination.index) || destination.index < -1)) {
      return { ok: false, reason: "invalid-destination", moved: 0 };
    }
    targetIndex = destination.index ?? -1;
  }

  const inverse = tabs.map((tab) => ({ tabId: tab.id, windowId: tab.windowId, index: tab.index }));
  const place = destination.kind === "new-window" ? "a new window" : "another window";
  const entry = await recordAction(
    `Moved ${ids.length} selected tab${ids.length === 1 ? "" : "s"} to ${place} (Undo is best-effort)`,
    { moves: inverse }
  );

  if (destination.kind === "new-window") {
    const created = await chrome.windows.create({ tabId: ids[0], focused: false });
    if (!Number.isInteger(created?.id)) {
      return { ok: false, reason: "unavailable", moved: 0, undoId: entry?.id ?? null };
    }
    targetWindowId = created.id;
    if (ids.length > 1) {
      await chrome.tabs.move(ids.slice(1), { windowId: targetWindowId, index: -1 });
    }
  } else {
    await chrome.tabs.move(ids, { windowId: targetWindowId, index: targetIndex });
  }

  return { ok: true, moved: ids.length, windowId: targetWindowId, undoId: entry?.id ?? null };
}
