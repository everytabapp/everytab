// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { STORE_KEYS } from "../lib/types.js";
import { listItems, readSessionNavigationData } from "../lib/store.js";
import { collectLabels } from "../lib/labels.js";
import { findDuplicateGroups } from "../lib/dedup.js";
import { getCounters } from "../lib/counters.js";
import { isOwnSuspendPage } from "../lib/tabs.js";
import { el, coalesce } from "./dom.js";
import { formatNumber, msg as localeMessage } from "../lib/i18n.js";
import { shellSectionTitle } from "./shell-copy.js";

/** Owns all reads and presentation for the read-only Stats section. */
export function createStatsSurface({ getBody, setHeading }) {
  const render = coalesce(renderInner);

  async function renderInner() {
    const [tabs, windows, duplicateGroups, counters] = await Promise.all([
      chrome.tabs.query({}),
      chrome.windows.getAll({}),
      findDuplicateGroups(),
      getCounters()
    ]);
    const suspendedNow = tabs.filter((tab) => tab.discarded || isOwnSuspendPage(tab)).length;
    const duplicateCount = duplicateGroups.reduce((count, group) => count + group.close.length, 0);

    const [inbox, archive, labels, sessionNavigation, snoozes] = await Promise.all([
      listItems(STORE_KEYS.inbox),
      listItems(STORE_KEYS.archive),
      collectLabels(),
      readSessionNavigationData(),
      listItems(STORE_KEYS.snoozes)
    ]);

    const stat = (value, label) => el("div", { class: "stat" },
      el("div", { class: "v" }, String(value)),
      el("div", { class: "l" }, label));

    setHeading(shellSectionTitle("stats"));
    getBody().replaceChildren(
      el("div", { class: "note", style: "text-align:center" },
        localeMessage("stats_note")),
      el("div", { class: "statgrid" },
        stat(tabs.length, localeMessage("stats_tabs_open")),
        stat(windows.length, windows.length === 1
          ? localeMessage("stats_windows_open_one") : localeMessage("stats_windows_open_other")),
        stat(tabs.filter((tab) => tab.pinned).length, localeMessage("stats_pinned_tabs")),
        stat(suspendedNow, localeMessage("stats_tabs_suspended_now")),
        stat(duplicateCount, localeMessage("stats_duplicate_tabs")),
        stat(inbox.length, localeMessage("stats_inbox_items",
          [formatNumber(inbox.reduce((count, item) => count + item.tabs.length, 0))])),
        stat(archive.length, localeMessage("stats_archive_items")),
        stat(labels.length, localeMessage("stats_labels")),
        stat(snoozes.length, localeMessage("stats_snoozed",
          [formatNumber(snoozes.filter((snooze) => snooze.recurrence).length)])),
        stat(sessionNavigation.namedSessions.length, localeMessage("stats_named_sessions")),
        stat(sessionNavigation.snapshotCount, localeMessage("stats_snapshots")),
        stat(counters.tabsDumped ?? 0, localeMessage("stats_tabs_saved_all_time")),
        stat(counters.tabsAutoArchived ?? 0, localeMessage("stats_tabs_auto_saved_all_time")),
        stat(counters.itemsExpired ?? 0, localeMessage("stats_items_expired")),
        stat(counters.duplicatesClosed ?? 0, localeMessage("stats_duplicates_closed_all_time")),
        stat(counters.snoozesFired ?? 0, localeMessage("stats_snoozes_fired_all_time")),
        stat(counters.tabsSuspended ?? 0, localeMessage("stats_tabs_suspended_all_time")),
        stat(counters.vaultSyncs ?? 0, localeMessage("stats_vault_syncs")),
        stat(counters.tabsLost ?? 0, localeMessage("stats_tabs_lost"))
      )
    );
  }

  return { render };
}
