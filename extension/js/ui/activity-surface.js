// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { listActions, JOURNAL_CAP, isVisibleActivityEntry } from "../lib/journal.js";
import { buildRestoreCheckpointExport } from "../lib/portable-state.js";
import { el, coalesce, settleCue } from "./dom.js";
import { icon } from "./icons.js";
import { requestClearJournal, requestUndo } from "./undo-client.js";
import { activityEntryLabel, activityAffectedTabs, activityTabDetailsCopy } from "./activity-copy.js";
import { shellSectionCountTitle } from "./shell-copy.js";
import { formatDate, formatNumber, msg as localeMessage } from "../lib/i18n.js";

/** Day buckets, newest first, so a long history stays scannable. */
export function activityDayLabel(at, now = Date.now()) {
  const day = (time) => new Date(time).setHours(0, 0, 0, 0);
  const difference = Math.round((day(now) - day(at)) / 86_400_000);
  if (difference <= 0) return localeMessage("activity_day_today");
  if (difference === 1) return localeMessage("activity_day_yesterday");
  return formatDate(at, { weekday: "long", month: "short", day: "numeric" });
}

/**
 * Owns Activity filtering, journal actions, recovery download, focus continuity,
 * and list presentation. The Dashboard host supplies only stable DOM slots and
 * the refresh/notice effects that cross section boundaries.
 */
export function createActivitySurface({
  getBody, getHeading, setHeading, showNotice, queueRefresh, download
}) {
  const modifierLabel = navigator.platform?.toLowerCase().includes("mac") ? "⌘" : "Ctrl";
  let filter = localStorage.getItem("tvActivityFilter") ?? "all";
  const render = coalesce(renderInner);
  let arrivalTimer = 0;
  const tabDetails = new Map();

  function affectedTabs(entry) {
    const recorded = activityAffectedTabs(entry);
    if (!recorded) { tabDetails.delete(entry.id); return null; }
    if (!recorded.tabs.length) {
      tabDetails.delete(entry.id);
      return el("p", { class: "activity-tab-note" }, activityTabDetailsCopy.missing());
    }
    const summaryText = activityTabDetailsCopy.summary(recorded.tabs.length);
    const unavailable = activityTabDetailsCopy.unavailable();
    const partial = recorded.partial ? activityTabDetailsCopy.partial() : "";
    const signature = JSON.stringify([recorded.tabs, summaryText, unavailable, partial]);
    const previous = tabDetails.get(entry.id);
    if (previous?.signature === signature) return previous.node;
    const node = el("details", {
      class: "activity-tab-details", "data-activity-details-id": entry.id,
      open: previous?.node.open === true
    },
    el("summary", {}, summaryText),
    // Recorded titles and addresses stay complete plain text. Each line
    // truncates visually and repeats its full value as a native tooltip, so a
    // long address cannot push the ledger around.
    el("ol", { class: "activity-tab-list" }, ...recorded.tabs.map((tab) => el("li", {},
      tab.title ? el("span", { class: "activity-tab-title", title: tab.title }, tab.title) : null,
      tab.url ? el("span", { class: "activity-tab-url", title: tab.url }, tab.url) : null,
      !tab.title && !tab.url ? el("span", { class: "activity-tab-title" }, unavailable) : null))),
    partial ? el("p", { class: "activity-tab-note" }, partial) : null);
    tabDetails.set(entry.id, { signature, node });
    return node;
  }

  function cueEntry(row) {
    clearTimeout(arrivalTimer);
    row.classList.remove("activity-arrival");
    requestAnimationFrame(() => {
      if (!row.isConnected) return;
      row.classList.add("activity-arrival");
      arrivalTimer = setTimeout(() => row.classList.remove("activity-arrival"), 700);
    });
  }

  function focusEntry(id) {
    const row = getBody().querySelector(
      `[data-activity-entry-id="${CSS.escape(id)}"]`
    );
    const action = row?.querySelector("button:not([disabled])");
    (action ?? row ?? getHeading()).focus?.();
  }

  async function goToEntry(id) {
    if (!id) return false;
    if (filter !== "all") {
      filter = "all";
      localStorage.setItem("tvActivityFilter", "all");
    }
    await render();
    const selector = `[data-activity-entry-id="${CSS.escape(id)}"]`;
    const findRow = () => getBody().querySelector(selector);
    const row = findRow();
    if (!row) return false;
    // A route can arrive while Activity already has a coalesced refresh queued.
    // Keep the cue attached to the durable entry, not to the first DOM node
    // that happens to render it.
    settleCue(findRow, (currentRow) => {
      currentRow.scrollIntoView?.({ block: "center", behavior: "auto" });
      currentRow.focus?.({ preventScroll: true });
      cueEntry(currentRow);
    });
    return true;
  }

  async function downloadRestoreRecovery(entry) {
    try {
      const text = await buildRestoreCheckpointExport(entry.restoreCheckpointId);
      if (!text) {
        showNotice(localeMessage("activity_restore_checkpoint_unavailable"));
        await render();
        focusEntry(entry.id);
        return;
      }
      download(
        `everytab-restore-recovery-${new Date(entry.at).toISOString().slice(0, 10)}.json`,
        text,
        "application/json"
      );
    } catch {
      showNotice(localeMessage("activity_restore_recovery_failed"));
      await render();
      focusEntry(entry.id);
    }
  }

  async function renderInner() {
    const all = (await listActions()).filter(isVisibleActivityEntry);
    const retainedIds = new Set(all.map((entry) => entry.id));
    for (const id of tabDetails.keys()) if (!retainedIds.has(id)) tabDetails.delete(id);
    const active = document.activeElement;
    const focusedDetailsId = active?.tagName === "SUMMARY" && getBody().contains(active)
      ? active.closest(".activity-tab-details")?.getAttribute("data-activity-details-id")
      : null;
    const entries = filter === "all"
      ? all
      : all.filter((entry) => (filter === "auto") === (entry.auto === true));
    setHeading(shellSectionCountTitle("activity", all.length));

    const filterButton = (id, label, tip) => el("button", {
      class: `activity-seg${filter === id ? " on" : ""}`,
      type: "button",
      "aria-pressed": filter === id ? "true" : "false",
      "data-tip": tip,
      onclick: async () => {
        if (filter === id) return;
        filter = id;
        localStorage.setItem("tvActivityFilter", id);
        await render();
      }
    }, label);

    const toolbar = el("div", { class: "activity-controls section-local-sticky" },
      el("div", { class: "activity-filter", role: "group", "aria-label": localeMessage("activity_filter_label") },
        filterButton("all", localeMessage("activity_filter_all"), localeMessage("activity_filter_all_tip")),
        filterButton("auto", localeMessage("activity_filter_auto"), localeMessage("activity_filter_auto_tip")),
        filterButton("manual", localeMessage("activity_filter_manual"), localeMessage("activity_filter_manual_tip"))),
      el("span", {
        class: "activity-count",
        "data-tip": localeMessage("activity_count_tip", [formatNumber(JOURNAL_CAP), modifierLabel])
      }, localeMessage("activity_shown_count", [formatNumber(entries.length)])),
      el("span", { style: "flex:1" }),
      (() => {
        const wrap = el("span", { class: "confirm-inline" });
        const ask = el("button", { class: "mini2", onclick: arm }, localeMessage("activity_clear_history"));
        const cancel = el("button", { class: "mini2", onclick: reset }, localeMessage("action_cancel"));
        const confirm = el("button", { class: "mini2 danger", onclick: async () => {
          if (!await requestClearJournal()) return;
          await render();
        } }, localeMessage("activity_delete_undo_history"));
        function arm() { wrap.replaceChildren(confirm, cancel); confirm.focus(); }
        function reset() { wrap.replaceChildren(ask); }
        reset();
        return wrap;
      })()
    );

    if (entries.length === 0) {
      getBody().replaceChildren(toolbar, el("div", { class: "empty" },
        all.length === 0
          ? localeMessage("activity_empty")
          : localeMessage("activity_empty_filtered")));
      return;
    }

    const restoreUndoCopy = (entry) => entry.restoreUndoStatus === "stale"
      ? localeMessage("activity_restore_undo_stale")
      : localeMessage("activity_restore_undo_replaced");
    const genericUndoCopy = (entry) => entry.undoStatus === "stale"
      ? localeMessage("undo_stale")
      : entry.undoStatus === "incomplete"
        ? localeMessage("undo_incomplete")
        : localeMessage("undo_unavailable");
    // Stored status values are language-free enums; unknown historical values
    // stay visible as recorded rather than disappearing behind a missing key.
    const chipKeys = {
      incomplete: "activity_chip_incomplete",
      unavailable: "activity_chip_unavailable",
      stale: "activity_chip_stale"
    };
    const statusChip = (status) => chipKeys[status] ? localeMessage(chipKeys[status]) : status;
    const genericUndoChip = (entry) => entry.undoStatus === "stale"
      ? localeMessage("activity_chip_changed_later")
      : statusChip(entry.undoStatus);

    const activityRow = (entry) => {
      const entryLabel = activityEntryLabel(entry);
      const row = el("div", {
        class: `trow${entry.undone || entry.undoStatus ? " activity-undone" : ""}`,
        tabindex: "-1",
        "data-activity-entry-id": entry.id
      },
      el("span", { class: "row-select-slot" }),
      el("span", { class: "row-glyph-slot", "aria-hidden": "true" },
        entry.auto ? icon("refresh", 15) : null),
      el("span", { class: "row-copy" },
        el("span", { class: "t" }, entryLabel),
        el("span", { class: "row-subline" },
          el("span", { class: "host" }, new Date(entry.at).toLocaleTimeString(undefined,
            { hour: "numeric", minute: "2-digit" })),
          el("span", { class: "item-meta" }, entry.restoreUndoStatus
            ? restoreUndoCopy(entry)
            : entry.undoStatus
              ? genericUndoCopy(entry)
              : entry.auto ? localeMessage("activity_by_everytab") : localeMessage("activity_by_you")))),
      el("span", { class: "row-chip-slot" },
        entry.undone
          ? el("span", { class: "chip" }, localeMessage("activity_chip_undone"))
          : entry.restoreUndoStatus
            ? el("span", { class: "chip" }, statusChip(entry.restoreUndoStatus))
            : entry.undoStatus
              ? el("span", { class: "chip" }, genericUndoChip(entry))
              : null),
      el("span", { class: "tacts" },
        entry.undone
          ? null
          : entry.restoreUndoStatus
            ? entry.restoreCheckpointAvailable
              ? el("button", {
                class: "mini",
                "data-action-id": "download-recovery",
                title: localeMessage("activity_download_recovery_title"),
                "aria-label": localeMessage("activity_download_recovery_aria", [entryLabel]),
                onclick: () => downloadRestoreRecovery(entry)
              }, el("span", { class: "activity-undo-label" }, localeMessage("activity_download_recovery")))
              : null
            : entry.undoStatus
              ? null
              : el("button", {
                class: "mini",
                "data-action-id": "undo",
                title: localeMessage("activity_undo_entry", [entryLabel]),
                "aria-label": localeMessage("activity_undo_entry", [entryLabel]),
                onclick: async () => {
                  await requestUndo(entry.id);
                  await render();
                  focusEntry(entry.id);
                  queueRefresh(["open", "inbox", "archive", "labels", "sessions"]);
                }
              },
              el("span", { class: "action-icon" }, icon("refresh", 14)),
              el("span", { class: "activity-undo-label" }, localeMessage("action_undo"))))
      );
      const details = affectedTabs(entry);
      return details ? el("div", { class: "activity-entry" }, row, details) : row;
    };

    const days = [];
    for (const entry of entries) {
      const label = activityDayLabel(entry.at);
      const last = days[days.length - 1];
      if (last && last.label === label) last.entries.push(entry);
      else days.push({ label, entries: [entry] });
    }

    const list = el("div", { class: "tablist", "data-tablist": "activity" },
      ...days.map((day) => el("div", {
        class: "item", "data-tablist-card": `day::${day.label}`
      },
      el("div", { class: "item-head-shell" },
        el("div", { class: "item-head" },
          el("span", { class: "item-title" }, day.label),
          el("span", { class: "item-meta" },
            day.entries.length === 1
              ? localeMessage("activity_day_count_one", [formatNumber(day.entries.length)])
              : localeMessage("activity_day_count_other", [formatNumber(day.entries.length)])))),
      el("div", { class: "item-body-frame" },
        el("div", { class: "tl-rows" }, ...day.entries.map(activityRow))))));

    getBody().replaceChildren(toolbar, list);
    if (focusedDetailsId) {
      const details = tabDetails.get(focusedDetailsId)?.node;
      if (details?.isConnected) details.querySelector("summary")?.focus({ preventScroll: true });
    }
  }

  return { render, goToEntry };
}
