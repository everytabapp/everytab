import { STORE_KEYS } from "../lib/types.js";
import { listItems } from "../lib/store.js";
import { collectLabels } from "../lib/labels.js";
import { findDuplicateGroups } from "../lib/dedup.js";
import { getCounters } from "../lib/counters.js";
import { isOwnSuspendPage } from "../lib/tabs.js";
import { el, coalesce } from "./dom.js";
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

    const [inbox, archive, labels, sessions, snoozes] = await Promise.all([
      listItems(STORE_KEYS.inbox),
      listItems(STORE_KEYS.archive),
      collectLabels(),
      listItems(STORE_KEYS.sessions),
      listItems(STORE_KEYS.snoozes)
    ]);

    const stat = (value, label) => el("div", { class: "stat" },
      el("div", { class: "v" }, String(value)),
      el("div", { class: "l" }, label));

    setHeading(shellSectionTitle("stats"));
    getBody().replaceChildren(
      el("div", { class: "note", style: "text-align:center" },
        "Every number EveryTab knows. Local only, nothing leaves your machine."),
      el("div", { class: "statgrid" },
        stat(tabs.length, "tabs open now"),
        stat(windows.length, `window${windows.length === 1 ? "" : "s"} open`),
        stat(tabs.filter((tab) => tab.pinned).length, "pinned tabs"),
        stat(suspendedNow, "tabs suspended right now"),
        stat(duplicateCount, "duplicate tabs open"),
        stat(inbox.length, `inbox items (${inbox.reduce((count, item) => count + item.tabs.length, 0)} tabs)`),
        stat(archive.length, "items in the archive"),
        stat(labels.length, "labels in use"),
        stat(snoozes.length, `snoozed (${snoozes.filter((snooze) => snooze.recurrence).length} recurring)`),
        stat(sessions.filter((session) => !session.auto).length, "named sessions"),
        stat(sessions.filter((session) => session.auto).length, "auto-snapshots kept"),
        stat(counters.tabsDumped ?? 0, "tabs saved to Inbox, all time"),
        stat(counters.tabsAutoArchived ?? 0, "tabs auto-saved, all time"),
        stat(counters.itemsExpired ?? 0, "items expired to Archive"),
        stat(counters.duplicatesClosed ?? 0, "duplicates closed, all time"),
        stat(counters.snoozesFired ?? 0, "snoozes fired, all time"),
        stat(counters.tabsSuspended ?? 0, "tabs suspended, all time"),
        stat(counters.vaultSyncs ?? 0, "vault syncs"),
        stat(counters.tabsLost ?? 0, "tabs ever lost")
      )
    );
  }

  return { render };
}
