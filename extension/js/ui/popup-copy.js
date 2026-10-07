// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Localized presentation for the toolbar popup. Worker messages, action ids,
 * routes, and shortcut keys remain stable; callers ask this module only for
 * user-facing headings, outcomes, and count grammar.
 */
import { formatList, formatNumber, msg, pluralCategory } from "../lib/i18n.js";
import { listUnit } from "./list-copy.js";

const one = (value) => pluralCategory(Number(value) || 0) === "one";

export const popupStatic = Object.freeze({
  undo: () => msg("action_undo"),
  undone: () => msg("popup_undone"),
  rename: () => msg("action_rename"),
  save: () => msg("popup_action_save"),
  thisTab: () => msg("popup_this_tab"),
  thisWindow: () => msg("popup_this_window"),
  saveTabInbox: () => msg("popup_save_tab_inbox"),
  saveWindowInbox: () => msg("popup_save_window_inbox"),
  snooze: () => msg("popup_snooze"),
  suspend: () => msg("action_suspend"),
  keepAwake: () => msg("popup_keep_awake"),
  keepAwakeDay: () => msg("popup_keep_awake_day"),
  keepAwakeAlways: () => msg("popup_keep_awake_always"),
  keepAwakeDayDone: () => msg("popup_keep_awake_day_done"),
  keepAwakeAlwaysDone: () => msg("popup_keep_awake_always_done"),
  keepAwakeForeverStatus: () => msg("popup_keep_awake_forever_status"),
  keepAwakeRuleStatus: () => msg("popup_keep_awake_rule_status"),
  keepAwakeRemove: () => msg("popup_keep_awake_remove"),
  keepAwakeRemoved: () => msg("popup_keep_awake_removed"),
  manageSuspension: () => msg("popup_manage_suspension"),
  keepAwakeFailed: () => msg("popup_keep_awake_failed"),
  label: () => msg("popup_label"),
  suspendOthers: () => msg("popup_suspend_others"),
  saveSession: () => msg("popup_save_session"),
  sort: () => msg("popup_sort"),
  copyLinks: () => msg("popup_copy_links"),
  starTab: () => msg("popup_star_tab"),
  unstarTab: () => msg("popup_unstar_tab"),
  sidePanel: () => msg("popup_side_panel"),
  dashboard: () => msg("nav_dashboard"),
  settings: () => msg("nav_settings"),
  focus: () => msg("popup_focus"),
  endFocus: () => msg("popup_end_focus"),
  setUpFocus: () => msg("popup_setup_focus"),
  notSetUp: () => msg("popup_not_set_up"),
  focusDuration: () => msg("popup_focus_duration"),
  oneHour: () => msg("popup_one_hour"),
  untilEnd: () => msg("popup_until_end"),
  custom: () => msg("popup_custom"),
  customEndTime: () => msg("popup_custom_end_time"),
  startFocus: () => msg("popup_start_focus"),
  switch: () => msg("popup_switch"),
  dismiss: () => msg("popup_dismiss"),
  duplicates: () => msg("shell_section_duplicates"),
  seeDuplicates: () => msg("popup_see_duplicates"),
  review: () => msg("popup_review"),
  labels: () => msg("shell_section_labels"),
  labelsPlaceholder: () => msg("popup_labels_placeholder"),
  saveLabeledCopy: () => msg("popup_save_labeled_copy"),
  labelExplanation: () => msg("popup_label_explanation"),
  pinnedStay: () => msg("popup_pinned_stay"),
  noActiveTab: () => msg("popup_no_active_tab"),
  privateTab: () => msg("popup_private_tab"),
  unsupportedPage: () => msg("popup_unsupported_page"),
  savedInbox: () => msg("popup_saved_inbox"),
  nothingSave: () => msg("popup_nothing_save"),
  starred: () => msg("popup_starred"),
  unstarred: () => msg("popup_unstarred"),
  wakeTab: () => msg("popup_wake_tab"),
  saving: () => msg("popup_saving"),
  nothingCopy: () => msg("popup_nothing_copy"),
  copyFailed: () => msg("popup_copy_failed"),
  typeLabelFirst: () => msg("popup_type_label_first"),
  cannotLabel: () => msg("popup_cannot_label"),
  alreadySorted: () => msg("popup_already_sorted"),
  cannotSort: () => msg("popup_cannot_sort"),
  cannotSnoozeWindow: () => msg("popup_cannot_snooze_window"),
  cannotSnoozeTab: () => msg("popup_cannot_snooze_tab"),
  noPagesWindow: () => msg("popup_no_pages_window"),
  pinnedOnly: () => msg("popup_pinned_only"),
  sidePanelFailed: () => msg("popup_side_panel_failed"),
  focusEndFailed: () => msg("popup_focus_end_failed"),
  focusStartFailed: () => msg("popup_focus_start_failed"),
  focusRulesMissing: () => msg("popup_focus_rules_missing"),
  futureTime: () => msg("popup_future_time"),
  vaultReconnect: () => msg("popup_vault_reconnect"),
  vaultError: () => msg("popup_vault_error"),
  vaultIncomplete: () => msg("popup_vault_incomplete")
});

export const popupRenamed = (name) => msg("popup_renamed", [name]);
export const popupKeepAwakeFor = (remaining) => msg("popup_keep_awake_for", [remaining]);
export const popupRenameFailed = () => msg("popup_rename_failed");
export const popupDefaultDuration = (label) => msg("popup_default_duration", [label]);
export const popupUntilTomorrow = (time) => msg("popup_until_tomorrow", [time]);
export const popupUntilTime = (time) => msg("popup_until_time", [time]);
export const popupGuardedSites = (value) => one(value)
  ? msg("popup_guarded_site_one")
  : msg("popup_guarded_sites_other", [formatNumber(value)]);
export const popupFocusSummary = (remaining, guarded) =>
  msg("popup_focus_summary", [remaining, guarded]);
export const popupDuplicateWhere = (sameWindow) => sameWindow
  ? msg("popup_duplicate_this_window")
  : msg("popup_duplicate_another_window");
export const popupDuplicateHint = (where) => msg("popup_duplicate_hint", [where]);
export const popupStatusSummary = (tabs, windows) =>
  msg("popup_status_summary", [listUnit("tab", tabs), listUnit("window", windows)]);
export const popupInboxCount = (value) => msg("popup_inbox_count", [formatNumber(value)]);
export const popupDueToday = (value) => one(value)
  ? msg("popup_due_today_one")
  : msg("popup_due_today_other", [formatNumber(value)]);
export const popupSavedTabs = (value) => one(value)
  ? msg("popup_saved_tab_one")
  : msg("popup_saved_tabs_other", [formatNumber(value)]);
export const popupSavedSession = (name) => msg("popup_saved_session", [name]);
export const popupCopiedLinks = (value) => one(value)
  ? msg("popup_copied_link_one")
  : msg("popup_copied_links_other", [formatNumber(value)]);
export const popupSuspendedTabs = (value) => one(value)
  ? msg("popup_suspended_tab_one")
  : msg("popup_suspended_tabs_other", [formatNumber(value)]);
export const popupCloseDuplicates = (value) => one(value)
  ? msg("popup_close_duplicate_one")
  : msg("popup_close_duplicates_other", [formatNumber(value)]);
export const popupClosedDuplicates = (value) => one(value)
  ? msg("popup_closed_duplicate_one")
  : msg("popup_closed_duplicates_other", [formatNumber(value)]);
export const popupLabeledWith = (labels) =>
  msg("popup_labeled_with", [formatList((labels ?? []).map((label) => `“${label}”`))]);
export const popupOpenLabel = (label) => msg("popup_open_label", [label]);
export const popupMoreLabelsTitle = (value) => one(value)
  ? msg("popup_more_label_one")
  : msg("popup_more_labels_other", [formatNumber(value)]);
export const popupOpenAllLabels = (value) => one(value)
  ? msg("popup_open_all_labels_one")
  : msg("popup_open_all_labels_other", [formatNumber(value)]);
export const popupSortedBy = (label) => msg("popup_sorted_by", [label]);
export const popupSnoozedUntil = (isWindow, when) => isWindow
  ? msg("popup_window_snoozed_until", [when])
  : msg("popup_tab_snoozed_until", [when]);
