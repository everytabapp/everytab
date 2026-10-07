// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Convert the established English compatibility label into a stable Activity
 * descriptor. The label remains in the record so old versions and imported
 * journals stay readable; current UI localizes the descriptor instead.
 *
 * New callers may provide an explicit descriptor to makeJournalEntry. This
 * inference boundary keeps every existing atomic domain operation compatible
 * without duplicating its user-facing sentence in storage forever.
 * @param {string} label
 * @returns {{actionKind:string,actionParams:Record<string,string|number>}|null}
 */
export function inferJournalDescriptor(label) {
  const value = String(label ?? "");
  const rules = [
    [/^Saved (\d+) tabs? to the Inbox$/, "saved-tabs-inbox", ["count"]],
    [/^Saved a tab to the Inbox$/, "saved-tabs-inbox", [], { count: 1 }],
    [/^Restored (\d+) tabs?$/, "restored-tabs", ["count"]],
    [/^Deleted (\d+) tabs?$/, "deleted-tabs", ["count"]],
    [/^Deleted an (Inbox|Archive) item$/, "deleted-saved-item", ["location"]],
    [/^Deleted snapshot “(.+)”$/, "deleted-snapshot", ["name"]],
    [/^Snoozed (\d+) tabs?$/, "snoozed-tabs", ["count"]],
    [/^Moved (\d+) tabs? to “(.+)”$/, "moved-tabs-session", ["count", "name"]],
    [/^Reordered “(.+)”$/, "reordered-item", ["name"]],
    [/^Moved “(.+)” to (.+)$/, "moved-item", ["name", "destination"]],
    [/^Auto-saved (\d+) tabs? to the Inbox$/, "auto-saved-tabs", ["count"]],
    [/^Auto-archived (\d+) Inbox items?$/, "auto-archived-items", ["count"]],
    [/^Closed the day: (\d+) tabs?$/, "close-day", ["count"]],
    [/^Imported (\d+) tabs? from (.+)$/, "imported-tabs", ["count", "source"]],
    [/^Saved (\d+) labeled cop(?:y|ies)$/, "saved-labeled-copies", ["count"]],
    [/^Renamed label “(.+)” → “(.+)”$/, "renamed-label", ["from", "to"]],
    [/^Deleted label “(.+)” everywhere$/, "deleted-label", ["name"]],
    [/^Archived (\d+) items?$/, "archived-items", ["count"]],
    [/^Labeled (\d+) tabs?(?: in “(.+)”)?$/, "labeled-tabs", ["count", "name"]],
    [/^Archived (\d+) tabs?$/, "archived-tabs", ["count"]],
    [/^Removed label “(.+)”( from a tab)?(?: in “(.+)”)?$/, "removed-label", ["name", "scope", "container"]],
    [/^Created (label|session) group “(.+)”$/, "created-group", ["kind", "name"]],
    [/^Renamed (label|session) group to “(.+)”$/, "renamed-group", ["kind", "name"]],
    [/^Deleted (label|session) group “(.+)”$/, "deleted-group", ["kind", "name"]],
    [/^Updated groups for (label|session) “(.+)”$/, "updated-member-groups", ["kind", "name"]],
    [/^Updated members in (label|session) group “(.+)”$/, "updated-group-members", ["kind", "name"]],
    [/^Deleted session “(.+)”$/, "deleted-session", ["name"]],
    [/^Restored an EveryTab backup$/, "restored-backup", []],
    [/^Created session “(.+)”$/, "created-session", ["name"]],
    [/^Added to session “(.+)”$/, "added-session", ["name"]],
    [/^Renamed session to “(.+)”$/, "renamed-session", ["name"]],
    [/^Removed “(.+)” from session “(.+)”$/, "removed-session-tab", ["item", "name"]],
    [/^Merged (\d+) tabs? into “(.+)”$/, "merged-session-tabs", ["count", "name"]],
    [/^Moved “(.+)” in “(.+)”$/, "moved-session-tab", ["item", "name"]],
    [/^Updated session “(.+)” from its window$/, "updated-session", ["name"]],
    [/^Cancelled snooze “(.+)”$/, "cancelled-snooze", ["name"]],
    [/^Snoozed session “(.+)”$/, "snoozed-session", ["name"]],
    [/^Woke (\d+) snoozed tabs?$/, "woke-snoozed-tabs", ["count"]],
    [/^Cancelled (\d+) snoozed tabs?$/, "cancelled-snoozed-tabs", ["count"]],
    [/^Starred “(.+)”$/, "starred-item", ["name"]],
    [/^Unstarred “(.+)”$/, "unstarred-item", ["name"]],
    [/^Renamed “(.+)” to “(.+)”$/, "renamed-starred-item", ["from", "to"]],
    [/^Snoozed “(.+)”$/, "snoozed-item", ["name"]],
    [/^Snoozed a window \((\d+) tabs?\)$/, "snoozed-window", ["count"]],
    [/^Moved (\d+) selected tabs? to (.+) \(Undo is best-effort\)$/i,
      "moved-live-tabs", ["count", "destination"]],
    [/^Sorted window by (.+) \(undo is best-effort\)$/i, "sorted-window", ["mode"]],
    [/^Gathered (.+) into a new window \(undo is best-effort\)$/i,
      "gathered-domain", ["domain"]]
  ];
  for (const [pattern, actionKind, names, defaults = {}] of rules) {
    const match = value.match(pattern);
    if (!match) continue;
    const actionParams = { ...defaults };
    names.forEach((name, index) => {
      const raw = match[index + 1];
      if (!raw) return;
      actionParams[name] = name === "count" ? Number(raw) : raw;
    });
    return { actionKind, actionParams };
  }
  return null;
}

/** Keep persisted parameters plain, bounded, and safe to localize. */
export function normalizedJournalParams(params) {
  const out = {};
  if (!params || typeof params !== "object" || Array.isArray(params)) return out;
  for (const [key, value] of Object.entries(params)) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string") out[key] = value.slice(0, 256);
  }
  return out;
}
