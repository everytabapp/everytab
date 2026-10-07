// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { formatNumber, msg as localeMessage } from "../lib/i18n.js";

const text = (value) => String(value ?? "");
const savedLocation = (value) => {
  const canonical = text(value).toLowerCase();
  if (canonical === "inbox") return localeMessage("search_source_inbox");
  if (canonical === "archive") return localeMessage("search_source_archive");
  return text(value);
};
const count = (entry) => Math.max(0, Number(entry?.actionParams?.count) || 0);

/** Recorded occurrences only: no current saved-data lookup or URL deduplication. */
export function activityAffectedTabs(entry) {
  let groups;
  let partial = false;
  const expected = entry?.actionParams?.count;
  if (entry?.actionKind === "auto-saved-tabs") {
    groups = Array.isArray(entry.reopen) ? entry.reopen : [];
  } else if (entry?.actionKind === "auto-archived-items") {
    const puts = Array.isArray(entry.puts) ? entry.puts : [];
    groups = puts.map((put) => put?.item?.tabs);
    partial = Number.isSafeInteger(expected) && expected !== puts.length;
  } else return null;
  const tabs = [];
  for (const group of groups) {
    if (!Array.isArray(group) || group.length === 0) { partial = true; continue; }
    for (const ref of group) {
      const title = typeof ref?.title === "string" ? ref.title : "";
      const url = typeof ref?.url === "string" ? ref.url : "";
      tabs.push({ title, url });
      if (!url) partial = true;
    }
  }
  if (entry.actionKind === "auto-saved-tabs" && Number.isSafeInteger(expected) && expected !== tabs.length) {
    partial = true;
  }
  return { tabs, partial };
}

export const activityTabDetailsCopy = {
  summary: (value) => value === 1
    ? localeMessage("activity_affected_tabs_one")
    : localeMessage("activity_affected_tabs_other", [formatNumber(value)]),
  unavailable: () => localeMessage("activity_tab_details_unavailable"),
  missing: () => localeMessage("activity_no_tab_details"),
  partial: () => localeMessage("activity_partial_tab_details")
};
const additionalCount = (entry) => Math.max(0, count(entry) - 1);
const automaticAffectedName = (entry) => {
  const explicit = text(entry?.actionParams?.name);
  if (explicit) return explicit;
  // Older automatic records did not store a presentation name, but their Undo
  // payload already owns the exact affected references. Read that immutable
  // local metadata rather than rewriting Activity or guessing from the browser.
  for (const tab of activityAffectedTabs(entry)?.tabs ?? []) {
    const name = tab.title || tab.url;
    if (name) return name;
  }
  return "";
};
const countMessage = (base, entry, extra = []) => {
  const value = count(entry);
  return localeMessage(`${base}_${value === 1 ? "one" : "other"}`,
    [formatNumber(value), ...extra.map(text)]);
};

/**
 * Localize current structured Activity records. Old/imported entries keep the
 * persisted label as their compatibility fallback.
 * @param {import("../lib/types.js").JournalEntry} entry
 */
export function activityEntryLabel(entry) {
  const p = entry?.actionParams ?? {};
  const automaticName = automaticAffectedName(entry);
  switch (entry?.actionKind) {
    case "saved-tabs-inbox": return countMessage("activity_saved_tabs_inbox", entry);
    case "restored-tabs": return countMessage("activity_restored_tabs", entry);
    case "deleted-tabs": return countMessage("activity_deleted_tabs", entry);
    case "deleted-saved-item": return localeMessage("activity_deleted_saved_item", [savedLocation(p.location)]);
    case "deleted-snapshot": return localeMessage("activity_deleted_snapshot", [text(p.name)]);
    case "snoozed-tabs": return countMessage("activity_snoozed_tabs", entry);
    case "moved-tabs-session": return countMessage("activity_moved_tabs_session", entry, [p.name]);
    case "reordered-item": return localeMessage("activity_reordered_item", [text(p.name)]);
    case "moved-item": return localeMessage("activity_moved_item", [text(p.name), text(p.destination)]);
    case "auto-saved-tabs": return automaticName
      ? count(entry) > 1
        ? localeMessage("activity_auto_saved_named_batch",
          [automaticName, formatNumber(additionalCount(entry))])
        : localeMessage("activity_auto_saved_named", [automaticName])
      : countMessage("activity_auto_saved_tabs", entry);
    case "auto-archived-items": return automaticName
      ? count(entry) > 1
        ? localeMessage("activity_auto_archived_named_batch",
          [automaticName, formatNumber(additionalCount(entry))])
        : localeMessage("activity_auto_archived_named", [automaticName])
      : countMessage("activity_auto_archived_items", entry);
    case "close-day": return countMessage("activity_close_day", entry);
    case "imported-tabs": return countMessage("activity_imported_tabs", entry, [p.source]);
    case "saved-labeled-copies": return countMessage("activity_saved_labeled_copies", entry);
    case "renamed-label": return localeMessage("activity_renamed_label", [text(p.from), text(p.to)]);
    case "deleted-label": return localeMessage("activity_deleted_label", [text(p.name)]);
    case "archived-items": return countMessage("activity_archived_items", entry);
    case "labeled-tabs": return p.name
      ? countMessage("activity_labeled_tabs_in", entry, [p.name])
      : countMessage("activity_labeled_tabs", entry);
    case "archived-tabs": return countMessage("activity_archived_tabs", entry);
    case "removed-label": return localeMessage("activity_removed_label", [text(p.name)]);
    case "created-group": return localeMessage("activity_created_group", [text(p.kind), text(p.name)]);
    case "renamed-group": return localeMessage("activity_renamed_group", [text(p.kind), text(p.name)]);
    case "deleted-group": return localeMessage("activity_deleted_group", [text(p.kind), text(p.name)]);
    case "updated-member-groups": return localeMessage("activity_updated_member_groups", [text(p.kind), text(p.name)]);
    case "updated-group-members": return localeMessage("activity_updated_group_members", [text(p.kind), text(p.name)]);
    case "deleted-session": return localeMessage("activity_deleted_session", [text(p.name)]);
    case "restored-backup": return localeMessage("activity_restored_backup");
    case "created-session": return localeMessage("activity_created_session", [text(p.name)]);
    case "added-session": return localeMessage("activity_added_session", [text(p.name)]);
    case "renamed-session": return localeMessage("activity_renamed_session", [text(p.name)]);
    case "removed-session-tab": return localeMessage("activity_removed_session_tab", [text(p.item), text(p.name)]);
    case "merged-session-tabs": return countMessage("activity_merged_session_tabs", entry, [p.name]);
    case "moved-session-tab": return localeMessage("activity_moved_session_tab", [text(p.item), text(p.name)]);
    case "updated-session": return localeMessage("activity_updated_session", [text(p.name)]);
    case "cancelled-snooze": return localeMessage("activity_cancelled_snooze", [text(p.name)]);
    case "snoozed-session": return localeMessage("activity_snoozed_session", [text(p.name)]);
    case "woke-snoozed-tabs": return countMessage("activity_woke_snoozed_tabs", entry);
    case "cancelled-snoozed-tabs": return countMessage("activity_cancelled_snoozed_tabs", entry);
    case "starred-item": return localeMessage("activity_starred_item", [text(p.name)]);
    case "unstarred-item": return localeMessage("activity_unstarred_item", [text(p.name)]);
    case "renamed-starred-item": return localeMessage("activity_renamed_starred_item", [text(p.from), text(p.to)]);
    case "snoozed-item": return localeMessage("activity_snoozed_item", [text(p.name)]);
    case "snoozed-window": return countMessage("activity_snoozed_window", entry);
    case "moved-live-tabs": return countMessage("activity_moved_live_tabs", entry, [p.destination]);
    case "sorted-window": return localeMessage("activity_sorted_window", [text(p.mode)]);
    case "gathered-domain": return localeMessage("activity_gathered_domain", [text(p.domain)]);
    default: return text(entry?.label);
  }
}

/** Short copy for the one-line Needs you queue; Activity keeps the full sentence. */
export function activityAttentionLabel(entry) {
  const automaticName = automaticAffectedName(entry);
  if (entry?.actionKind === "auto-saved-tabs") {
    if (automaticName) {
      return count(entry) > 1
        ? localeMessage("attention_auto_saved_named_batch",
          [automaticName, formatNumber(additionalCount(entry))])
        : localeMessage("attention_auto_saved_named", [automaticName]);
    }
    return countMessage("attention_auto_saved_tabs", entry);
  }
  if (entry?.actionKind === "auto-archived-items" && automaticName) {
    return count(entry) > 1
      ? localeMessage("attention_auto_archived_named_batch",
        [automaticName, formatNumber(additionalCount(entry))])
      : localeMessage("attention_auto_archived_named", [automaticName]);
  }
  return activityEntryLabel(entry);
}
