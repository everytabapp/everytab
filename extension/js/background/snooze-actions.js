// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { canonicalRef, isSaveableTab, saveableTabRef } from "../lib/tabs.js";
import { closeUnchangedLiveTabs } from "../lib/live-close.js";

/**
 * Create the live-tab Snooze actions shared by messages, context menus, and
 * keyboard commands. Persistence always precedes browser closing, and capture
 * eligibility is rechecked here regardless of caller presentation.
 *
 * @param {{
 *   createWithCloseReceipt: (record:object,tabs:object[],options:object) => Promise<{snooze:object,entryId:string}>,
 *   finishCloseReceipt: (entryId:string,tabs:object[],effect:()=>Promise<object>) => Promise<object>,
 *   capturePlacement: (tab:object) => Promise<object>,
 *   openDashboard: () => Promise<unknown>,
 *   tabs: {
 *     get: (tabId:number) => Promise<object>,
 *     query: (query:object) => Promise<object[]>,
 *     remove: (ids:number|number[]) => Promise<unknown>
 *   },
 *   windows: { getAll: (query:object) => Promise<object[]> }
 * }} dependencies
 */
export function createSnoozeActions(dependencies) {
  const snoozeTab = async (tab, dueAt, recurrence) => {
    const ref = saveableTabRef(tab);
    if (!ref) return null;
    const placement = await dependencies.capturePlacement(tab);
    const label = `Snoozed “${ref.title || ref.url}”`;
    const created = await dependencies.createWithCloseReceipt({
      url: ref.url,
      title: ref.title || ref.url,
      dueAt,
      ...(ref.favIconUrl ? { favIconUrl: ref.favIconUrl } : {}),
      ...(recurrence ? { recurrence } : {})
    }, [tab], { placement, label });
    const snooze = created.snooze;
    if (tab.id !== undefined) {
      const windowTabs = await dependencies.tabs.query({ windowId: tab.windowId });
      if (windowTabs.length <= 1) await dependencies.openDashboard();
      await dependencies.finishCloseReceipt(created.entryId, [tab], () =>
        closeUnchangedLiveTabs([tab], dependencies.tabs));
    } else {
      await dependencies.finishCloseReceipt(created.entryId, [tab], async () => ({ closed: [] }));
    }
    return { ...snooze, undoId: created.entryId };
  };

  const snoozeWindow = async (windowId, dueAt, recurrence) => {
    const tabs = await dependencies.tabs.query(
      windowId !== undefined ? { windowId } : { currentWindow: true }
    );
    const saveable = tabs.filter(isSaveableTab);
    const refs = saveable.map(canonicalRef);
    if (refs.length === 0) return null;
    const title = `Window (${refs.length} tab${refs.length === 1 ? "" : "s"})`;
    const label = `Snoozed a window (${refs.length} tab${refs.length === 1 ? "" : "s"})`;
    const created = await dependencies.createWithCloseReceipt({
      title,
      dueAt,
      tabs: refs,
      ...(recurrence ? { recurrence } : {})
    }, saveable, { label });
    const snooze = created.snooze;
    const windows = await dependencies.windows.getAll({});
    if (windows.length <= 1) await dependencies.openDashboard();
    await dependencies.finishCloseReceipt(created.entryId, saveable, () =>
      closeUnchangedLiveTabs(saveable, dependencies.tabs));
    return { ...snooze, undoId: created.entryId };
  };

  return { tab: snoozeTab, window: snoozeWindow };
}
