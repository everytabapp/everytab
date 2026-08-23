/**
 * Localized presentation shared by every tab list. Store enums, list state,
 * and action ids stay language-free; this module turns them into visible copy.
 */
import { formatNumber, msg, pluralCategory } from "../lib/i18n.js";
import { compactRelativeAge } from "../lib/relative-time.js";

const count = (kind, value) => {
  const n = Number(value) || 0;
  const one = pluralCategory(n) === "one";
  if (kind === "window") return one
    ? msg("unit_window_one") : msg("unit_windows_other", [formatNumber(n)]);
  if (kind === "label") return one
    ? msg("unit_label_one") : msg("unit_labels_other", [formatNumber(n)]);
  if (kind === "session") return one
    ? msg("unit_session_one") : msg("unit_sessions_other", [formatNumber(n)]);
  if (kind === "place") return one
    ? msg("unit_place_one") : msg("unit_places_other", [formatNumber(n)]);
  return one ? msg("unit_tab_one") : msg("unit_tabs_other", [formatNumber(n)]);
};

const SOURCE_COPY = Object.freeze({
  "auto-archive": () => msg("list_source_auto_saved"),
  dump: () => msg("list_source_saved"),
  dedup: () => msg("list_source_duplicate_closed"),
  manual: () => msg("list_source_saved"),
  snooze: () => msg("list_source_woke_snooze")
});

export function listSourceLabel(source) {
  return SOURCE_COPY[source]?.() ?? String(source ?? "");
}

export function listSelectionSummary(selected, sourceCount) {
  if (selected === 0) return msg("list_selection_zero");
  if (sourceCount > 1) {
    return msg("list_selection_across", [count("tab", selected), formatNumber(sourceCount)]);
  }
  return pluralCategory(selected) === "one"
    ? msg("list_selection_one")
    : msg("list_selection_other", [formatNumber(selected)]);
}

export const listUnit = count;
export const listSingleTabTitle = () => msg("list_single_tab");
export const listWindowCardTitle = (tabs) => msg("list_window_card", [count("tab", tabs)]);
export const listOpenWindowTitle = (index) => msg("list_window_number", [formatNumber(index)]);
export const listCurrentWindowBadge = () => msg("list_current_window_badge");
export const listOpenWindowMeta = (tabs) => count("tab", tabs);
export const listInboxMeta = (source, timestamp) =>
  msg("list_source_age", [listSourceLabel(source), compactRelativeAge(timestamp)]);
export const listArchiveMeta = (source, timestamp) =>
  msg("list_archive_meta", [listSourceLabel(source), compactRelativeAge(timestamp)]);
export const listSessionMeta = (windows, tabs, timestamp) =>
  msg("list_session_meta", [count("window", windows), count("tab", tabs), compactRelativeAge(timestamp)]);
export const listSessionWindowMeta = (index, tabs) =>
  msg("list_window_number_tabs", [formatNumber(index), count("tab", tabs)]);
export const listDuplicateMeta = (copies, windows) =>
  msg("list_duplicate_meta", [formatNumber(copies), count("window", windows)]);
export const listLabelMeta = (tabs, places) =>
  msg("list_label_meta", [count("tab", tabs), count("place", places)]);

const SHORT_ACTION_COPY = Object.freeze({
  dump: () => msg("action_inbox"),
  label: () => msg("action_label"),
  snooze: () => msg("action_snooze"),
  suspend: () => msg("action_suspend"),
  wake: () => msg("action_wake"),
  close: () => msg("action_close"),
  restore: () => msg("search_action_restore"),
  archive: () => msg("action_archive"),
  copy: () => msg("action_copy"),
  session: () => msg("action_session"),
  remove: () => msg("action_remove"),
  rename: () => msg("action_rename"),
  delete: () => msg("action_delete")
});

export function listShortActionLabel(id, fallback) {
  return SHORT_ACTION_COPY[id]?.() ?? fallback;
}

const PANEL_COPY = Object.freeze({
  label: () => ({ title: msg("list_panel_labels_title"), description: msg("list_panel_labels_description"), icon: "labels" }),
  session: () => ({ title: msg("list_panel_session_title"), description: msg("list_panel_session_description"), icon: "sessions" }),
  snooze: () => ({ title: msg("list_panel_snooze_title"), description: msg("list_panel_snooze_description"), icon: "snooze" }),
  "bulk-snooze": () => ({ title: msg("list_panel_bulk_snooze_title"), description: msg("list_panel_snooze_description"), icon: "snooze" }),
  "bulk-label": () => ({ title: msg("list_panel_bulk_label_title"), description: msg("list_panel_labels_description"), icon: "labels" }),
  "bulk-move": () => ({ title: msg("list_panel_bulk_move_title"), description: msg("list_panel_bulk_move_description"), icon: "move" }),
  "snooze-session": () => ({ title: msg("list_panel_snooze_session_title"), description: msg("list_panel_snooze_session_description"), icon: "snooze" }),
  organize: () => ({ title: msg("list_panel_organize_title"), description: msg("list_panel_organize_description"), icon: "organize" }),
  "organization-label": () => ({ title: msg("list_panel_label_groups_title"), description: msg("list_panel_label_groups_description"), icon: "cluster" }),
  "organization-session": () => ({ title: msg("list_panel_session_groups_title"), description: msg("list_panel_session_groups_description"), icon: "cluster" }),
  "new-label-group": () => ({ title: msg("list_panel_new_label_group_title"), description: msg("list_panel_new_group_description"), icon: "cluster" }),
  "new-session-group": () => ({ title: msg("list_panel_new_session_group_title"), description: msg("list_panel_new_group_description"), icon: "cluster" }),
  "add-labels-to-group": () => ({ title: msg("list_panel_add_labels_title"), description: msg("list_panel_add_labels_description"), icon: "labels" }),
  "add-sessions-to-group": () => ({ title: msg("list_panel_add_sessions_title"), description: msg("list_panel_add_sessions_description"), icon: "sessions" }),
  "manage-label-group": () => ({ title: msg("list_panel_manage_label_group_title"), description: msg("list_panel_manage_group_description"), icon: "cluster" }),
  "manage-session-group": () => ({ title: msg("list_panel_manage_session_group_title"), description: msg("list_panel_manage_group_description"), icon: "cluster" })
});

export function listPanelCopy(name) {
  return PANEL_COPY[name]?.() ?? {
    title: String(name).replaceAll("-", " "),
    description: msg("list_panel_default_description"),
    icon: null
  };
}

export function listSnoozePresetLabel(preset) {
  return ({
    "later-today": () => msg("list_snooze_later_today"),
    "this-evening": () => msg("list_snooze_this_evening"),
    tomorrow: () => msg("list_snooze_tomorrow"),
    weekend: () => msg("list_snooze_weekend"),
    "next-week": () => msg("list_snooze_next_week")
  })[preset]?.() ?? String(preset ?? "");
}

export function listRecurrenceOptionLabel(value, fallback = "") {
  return ({
    daily: () => msg("list_repeat_daily"),
    weekly: () => msg("list_repeat_weekly"),
    monthly: () => msg("list_repeat_monthly")
  })[value]?.() ?? (value ? fallback : msg("list_repeat_never"));
}

export function listSortLabel(mode) {
  return ({
    domain: () => msg("list_sort_domain"),
    title: () => msg("list_sort_title"),
    recent: () => msg("list_sort_recent")
  })[mode]?.() ?? String(mode ?? "");
}
