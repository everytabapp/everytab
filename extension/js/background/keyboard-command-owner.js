// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { msg as localeMessage } from "../lib/i18n.js";
import { presetDue } from "../lib/snooze.js";
import { armSearchPopupMode, clearSearchPopupMode } from "../lib/search-popup.js";

async function openPopupInFocusedWindow() {
  if (typeof chrome.action?.openPopup !== "function") {
    throw new Error("openPopup unavailable");
  }
  const win = await chrome.windows.getLastFocused();
  if (Number.isInteger(win?.id) && win.type === "normal" && !win.incognito) {
    await chrome.action.openPopup({ windowId: win.id });
  } else {
    await chrome.action.openPopup();
  }
}

async function openKeyboardPopup(openDashboard, { focusSearch = false } = {}) {
  if (focusSearch && await focusExistingPopupSearch()) {
    await clearSearchPopupMode();
    return;
  }
  if (focusSearch && !(await armSearchPopupMode())) {
    await openDashboard("search");
    return;
  }
  if (!focusSearch) await clearSearchPopupMode();
  try {
    await openPopupInFocusedWindow();
  } catch {
    await clearSearchPopupMode();
    if (!focusSearch || !(await focusExistingPopupSearch())) {
      await openDashboard(focusSearch ? "search" : undefined);
    }
  }
}

async function focusExistingPopupSearch() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "focus-popup-search" });
    return reply?.focused === true;
  } catch {
    return false;
  }
}

/**
 * Install the single Chrome keyboard-command listener. The owner selects the
 * required browser context and shapes command feedback; the worker supplies
 * the existing product operations.
 *
 * @param {{
 *   openDashboard: (section?: string) => unknown,
 *   saveWindow: () => unknown,
 *   saveTab: (tabId: number) => Promise<{n:number,undoId:string|null}>,
 *   snoozeTab: (tab: chrome.tabs.Tab, dueAt: number) => Promise<{title: string,undoId?:string}|null>,
 *   suspendTab: (tabId: number) => Promise<unknown>,
 *   notify: (notice: {id: string, title: string, message: string, undoId?: string|null}) => unknown
 * }} actions
 */
export function installKeyboardCommandOwner({
  openDashboard,
  saveWindow,
  saveTab,
  snoozeTab,
  suspendTab,
  notify
}) {
  const openSidePanelWindows = new Set();
  const sidePanelKeyboardEntryWindows = new Set();

  if (typeof chrome.sidePanel?.onOpened?.addListener === "function") {
    chrome.sidePanel.onOpened.addListener((info) => {
      if (Number.isInteger(info?.windowId)) openSidePanelWindows.add(info.windowId);
    });
  }
  if (typeof chrome.sidePanel?.onClosed?.addListener === "function") {
    chrome.sidePanel.onClosed.addListener((info) => {
      if (!Number.isInteger(info?.windowId)) return;
      openSidePanelWindows.delete(info.windowId);
      sidePanelKeyboardEntryWindows.delete(info.windowId);
    });
  }

  // The Side Panel page announces its containing window after it mounts. This
  // reconstructs open state when the worker started after the panel and lets a
  // shortcut-opened document claim its selected section tab for arrow entry.
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== "side-panel-navigation-ready" ||
        !Number.isInteger(message.windowId)) return;
    openSidePanelWindows.add(message.windowId);
    const keyboardEntry = sidePanelKeyboardEntryWindows.delete(message.windowId);
    respond({ keyboardEntry });
    return false;
  });

  async function fallbackSidePanelWindowId() {
    let win = await chrome.windows.getLastFocused();
    if (!win || win.type !== "normal" || win.incognito) {
      const wins = await chrome.windows.getAll();
      win = wins.find((candidate) =>
        candidate.type === "normal" && !candidate.incognito) || null;
    }
    return Number.isInteger(win?.id) ? win.id : null;
  }

  async function toggleSidePanel(commandTab) {
    // commands.onCommand supplies the active tab. Calling open() before the
    // first await preserves Chrome's user gesture; the former window lookup
    // consumed that activation and made assigned shortcuts appear inert.
    let windowId = Number.isInteger(commandTab?.windowId) && !commandTab?.incognito
      ? commandTab.windowId
      : null;
    if (!Number.isInteger(windowId)) windowId = await fallbackSidePanelWindowId();
    if (!Number.isInteger(windowId)) return;

    if (openSidePanelWindows.has(windowId) && typeof chrome.sidePanel?.close === "function") {
      openSidePanelWindows.delete(windowId);
      sidePanelKeyboardEntryWindows.delete(windowId);
      try { await chrome.sidePanel.close({ windowId }); }
      catch { /* A stale event is equivalent to an already-closed panel. */ }
      return;
    }

    // The worker may have slept while a Side Panel document stayed open. Probe
    // existing panel documents without awaiting, then still call open() in this
    // user-activation task. An existing panel reports itself and is closed after
    // the idempotent open resolves; a missing panel receives the ordinary open.
    const presence = chrome.runtime.sendMessage({
      type: "probe-side-panel-navigation",
      windowId
    }).catch(() => null);
    sidePanelKeyboardEntryWindows.add(windowId);
    try {
      // Do not insert an await before this call. Chrome permits open() only in
      // the command's transient user-activation task.
      const opening = chrome.sidePanel.open({ windowId });
      openSidePanelWindows.add(windowId);
      const [, existingPanel] = await Promise.all([opening, presence]);
      if (existingPanel?.open === true && typeof chrome.sidePanel?.close === "function") {
        openSidePanelWindows.delete(windowId);
        sidePanelKeyboardEntryWindows.delete(windowId);
        await chrome.sidePanel.close({ windowId });
        return;
      }
      // A warm, already-mounted panel receives this path; a newly-mounted one
      // also performs the ready handshake above, so neither ordering can lose
      // the requested keyboard entry.
      void chrome.runtime.sendMessage({ type: "focus-side-panel-navigation", windowId })
        .catch?.(() => {});
    } catch {
      openSidePanelWindows.delete(windowId);
      sidePanelKeyboardEntryWindows.delete(windowId);
    }
  }

  chrome.commands.onCommand.addListener(async (command, commandTab) => {
    if (command === "open-search-popup") {
      await openKeyboardPopup(openDashboard, { focusSearch: true });
      return;
    }
    if (command === "open-popup") {
      await openKeyboardPopup(openDashboard);
      return;
    }
    if (command === "open-dashboard") return void openDashboard();
    if (command === "open-side-panel") {
      await toggleSidePanel(commandTab);
      return;
    }
    if (command === "dump-window") return void saveWindow();
    if (!["dump-tab", "snooze-tab", "suspend-tab"].includes(command)) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    if (command === "dump-tab") {
      const saved = await saveTab(tab.id);
      if (saved.n > 0) {
        void notify({
          id: `cmd-dump-${Date.now()}`,
          title: localeMessage("notification_saved_inbox_title"),
          message: localeMessage("notification_saved_inbox_body"),
          undoId: saved.undoId
        });
      }
    } else if (command === "snooze-tab") {
      const snooze = await snoozeTab(tab, presetDue("tomorrow"));
      if (snooze) {
        void notify({
          id: `cmd-snooze-${Date.now()}`,
          title: localeMessage("notification_snoozed_tomorrow_title"),
          message: localeMessage("notification_snoozed_tomorrow_body", [snooze.title]),
          undoId: snooze.undoId ?? null
        });
      }
    } else if (command === "suspend-tab") {
      await suspendTab(tab.id);
    }
  });
}
