// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Localized presentation for Search results across the shared Search box and
 * Chrome omnibox. Search matching remains language-free; this module owns the
 * user-facing vocabulary, compact counts, and relative ages.
 */
import { formatNumber, msg, pluralCategory } from "./i18n.js";
import { compactRelativeAge } from "./relative-time.js";

const ACTION_MESSAGES = Object.freeze({
  open: () => msg("search_action_switch"),
  starred: () => msg("search_action_launch"),
  inbox: () => msg("search_action_open"),
  snoozed: () => msg("search_action_open"),
  archive: () => msg("search_action_open"),
  collection: () => msg("search_action_open"),
  session: () => msg("search_action_open"),
  "session-entity": () => msg("search_action_restore"),
  "label-group-entity": () => msg("search_action_view"),
  "session-group-entity": () => msg("search_action_view"),
  history: () => msg("search_action_open")
});

const SOURCE_MESSAGES = Object.freeze({
  open: [() => msg("search_source_open_short"), () => msg("search_source_open")],
  starred: [() => msg("search_source_starred_short"), () => msg("search_source_starred")],
  inbox: [() => msg("search_source_inbox_short"), () => msg("search_source_inbox")],
  snoozed: [() => msg("search_source_snoozed_short"), () => msg("search_source_snoozed")],
  archive: [() => msg("search_source_archive_short"), () => msg("search_source_archive")],
  collection: [() => msg("search_source_collection_short"), () => msg("search_source_collection")],
  session: [() => msg("search_source_session_short"), () => msg("search_source_session")],
  history: [() => msg("search_source_history_short"), () => msg("search_source_history")]
});

const windowsCount = (count) => pluralCategory(count) === "one"
  ? msg("unit_window_one") : msg("unit_windows_other", [formatNumber(count)]);
const tabsCount = (count) => pluralCategory(count) === "one"
  ? msg("unit_tab_one") : msg("unit_tabs_other", [formatNumber(count)]);
const labelsCount = (count) => pluralCategory(count) === "one"
  ? msg("unit_label_one") : msg("unit_labels_other", [formatNumber(count)]);
const sessionsCount = (count) => pluralCategory(count) === "one"
  ? msg("unit_session_one") : msg("unit_sessions_other", [formatNumber(count)]);

/** Compact relative age shared by History and automatic Snapshot results. */
export function searchRelativeAge(timestamp, now = Date.now()) {
  return compactRelativeAge(timestamp, now);
}

/** Outcome word shown in the fixed action lane. */
export function searchResultAction(type) {
  return (ACTION_MESSAGES[type] ?? ACTION_MESSAGES.inbox)();
}

/**
 * Shared result metadata. `omnibox` uses fuller source nouns; the visual Search
 * list retains its compact lower-case source lane.
 * @param {import("./search.js").SearchResult} result
 * @param {{context?: "results"|"omnibox", now?: number}} [opts]
 */
export function searchResultMeta(result, opts = {}) {
  const context = opts.context ?? "results";
  const now = opts.now ?? Date.now();
  if (result.type === "history") {
    const visited = Number(result.lastVisitTime) || 0;
    return visited > 0
      ? msg("search_history_with_age", [searchRelativeAge(visited, now)])
      : msg("search_source_history");
  }
  if (result.type === "session-entity") {
    const windows = Number(result.windowCount ?? result.windowsCount) || 0;
    const tabs = Number(result.tabCount ?? result.tabsCount) || 0;
    return msg(context === "results" ? "search_session_result_counts" : "search_session_counts", [
      windowsCount(windows),
      tabsCount(tabs)
    ]);
  }
  if (result.type === "label-group-entity" || result.type === "session-group-entity") {
    const count = Number(result.memberCount) || 0;
    const labelGroup = result.type === "label-group-entity";
    return msg("search_group_counts", [
      labelGroup ? msg("search_group_label") : msg("search_group_session"),
      labelGroup ? labelsCount(count) : sessionsCount(count)
    ]);
  }
  if (result.snapshot) {
    const createdAt = Number(result.sourceCreatedAt) || 0;
    return createdAt > 0
      ? msg("search_snapshot_with_age", [searchRelativeAge(createdAt, now)])
      : msg("search_source_snapshot");
  }
  const messages = SOURCE_MESSAGES[result.type];
  const source = messages
    ? messages[context === "omnibox" ? 1 : 0]()
    : String(result.type ?? "");
  return result.sourceName
    ? msg("search_source_with_name", [source, result.sourceName])
    : source;
}

/** Locale-formatted count for the Search footer and live-status region. */
export function searchCount(kind, count, { announcement = false } = {}) {
  const one = pluralCategory(count) === "one";
  const formatted = formatNumber(count);
  if (kind === "suggestion") {
    if (announcement) return one
      ? msg("search_count_suggestion_one_announcement")
      : msg("search_count_suggestion_other_announcement", [formatted]);
    return one
      ? msg("search_count_suggestion_one")
      : msg("search_count_suggestion_other", [formatted]);
  }
  if (kind === "recent") {
    if (announcement) return one
      ? msg("search_count_recent_one_announcement")
      : msg("search_count_recent_other_announcement", [formatted]);
    return one
      ? msg("search_count_recent_one")
      : msg("search_count_recent_other", [formatted]);
  }
  if (announcement) return one
    ? msg("search_count_result_one_announcement")
    : msg("search_count_result_other_announcement", [formatted]);
  return one
    ? msg("search_count_result_one")
    : msg("search_count_result_other", [formatted]);
}
