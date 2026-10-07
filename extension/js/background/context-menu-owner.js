// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { msg as localeMessage } from "../lib/i18n.js";
import { presetDue } from "../lib/snooze.js";

const MENU_ITEMS = [
  ["dump-tab", "context_save_tab_inbox"],
  ["dump-window", "context_save_window_inbox"],
  ["snooze-tomorrow", "context_snooze_tomorrow"],
  ["snooze-next-week", "context_snooze_monday"]
];

/**
 * Own the page context-menu lifecycle while delegating product operations to
 * the worker shell. Installation is idempotent across installs, updates, and
 * unpacked reloads because stale ids are removed before the complete menu is
 * recreated.
 *
 * @param {{
 *   saveTab: (tabId: number) => unknown,
 *   saveWindow: (windowId: number) => unknown,
 *   snoozeTab: (tab: chrome.tabs.Tab, dueAt: number) => unknown
 * }} actions
 */
export function createContextMenuOwner({ saveTab, saveWindow, snoozeTab }) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab) return;
    if (info.menuItemId === "dump-tab" && tab.id !== undefined) {
      void saveTab(tab.id);
    } else if (info.menuItemId === "dump-window" && tab.windowId !== undefined) {
      void saveWindow(tab.windowId);
    } else if (info.menuItemId === "snooze-tomorrow") {
      void snoozeTab(tab, presetDue("tomorrow"));
    } else if (info.menuItemId === "snooze-next-week") {
      void snoozeTab(tab, presetDue("next-week"));
    }
  });

  function install() {
    chrome.contextMenus.removeAll(() => {
      for (const [id, messageKey] of MENU_ITEMS) {
        chrome.contextMenus.create({
          id,
          title: localeMessage(messageKey),
          contexts: ["page"]
        });
      }
    });
  }

  return { install };
}
