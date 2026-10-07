// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Localized presentation for Settings. Stored values and domain decisions stay language-free. */
import { browserUiLocale, formatNumber, msg } from "../lib/i18n.js";
import { UI_LANGUAGE_VALUES } from "../lib/types.js";

const GROUP_KEYS = Object.freeze({
  appearance: "settings_group_appearance",
  newtab: "settings_group_new_tab",
  focus: "settings_group_focus",
  autosave: "settings_group_auto_save",
  suspension: "settings_group_suspension",
  protection: "settings_group_protection",
  sessions: "settings_group_sessions",
  duplicates: "settings_group_duplicates",
  privacy: "settings_group_privacy",
  intro: "settings_group_intro",
  keyboard: "settings_group_keyboard"
});

const ROW_KEYS = Object.freeze({
  language: ["settings_row_language", "settings_desc_language"],
  colorScheme: ["settings_row_color_scheme", "settings_desc_color_scheme"],
  mode: ["settings_row_mode", "settings_desc_mode"],
  rotation: ["settings_row_rotation", "settings_desc_rotation"],
  backgroundGradient: ["settings_row_background_gradient", "settings_desc_background_gradient"],
  sectionDescriptions: ["settings_row_section_descriptions", "settings_desc_section_descriptions"],
  interfaceStyle: ["settings_row_interface_style", "settings_desc_interface_style"],
  rowInformation: ["settings_row_row_information", "settings_desc_row_information"],
  rowActionLabels: ["settings_row_row_action_labels", "settings_desc_row_action_labels"],
  oneNewTab: ["settings_row_one_new_tab", "settings_desc_one_new_tab"],
  welcomePhrasesEnabled: [
    "settings_row_welcome_phrases_enabled", "settings_desc_welcome_phrases_enabled"
  ],
  welcomePhrases: ["settings_row_welcome_phrases", "settings_desc_welcome_phrases"],
  welcomeTone: ["settings_row_welcome_tone", "settings_desc_welcome_tone"],
  focusDuration: ["settings_row_focus_duration", "settings_desc_focus_duration"],
  morningEnds: ["settings_row_morning_ends", "settings_desc_morning_ends"],
  dayEnds: ["settings_row_day_ends", "settings_desc_day_ends"],
  blockedSites: ["settings_row_blocked_sites", "settings_desc_blocked_sites"],
  focusAccess: ["settings_row_focus_access", "settings_desc_focus_access_immediate"],
  autoSaveAfter: ["settings_row_auto_save_after", "settings_desc_auto_save_after"],
  maxTabsOpen: ["settings_row_max_tabs_open", "settings_desc_max_tabs_open"],
  protectedPages: ["settings_row_protected_pages", "settings_desc_protected_pages"],
  inboxExpiry: ["settings_row_inbox_expiry", "settings_desc_inbox_expiry"],
  suspendAfter: ["settings_row_suspend_after", "settings_desc_suspend_after"],
  suspendMinTabs: ["settings_row_suspend_min_tabs", "settings_desc_suspend_min_tabs"],
  suspendMaxTabs: ["settings_row_suspend_max_tabs", "settings_desc_suspend_max_tabs"],
  automationExclusions: [
    "settings_row_automation_exclusions", "settings_desc_automation_exclusions"
  ],
  suspendPageExceptions: ["settings_row_temporary_suspend_exceptions", "settings_desc_temporary_suspend_exceptions"],
  suspendPage: ["settings_row_suspend_page", "settings_desc_suspend_page"],
  preserveGroups: ["settings_row_preserve_groups", "settings_desc_preserve_groups"],
  snapshotEvery: ["settings_row_snapshot_every", "settings_desc_snapshot_every"],
  snapshotsKeep: ["settings_row_snapshots_keep", "settings_desc_snapshots_keep"],
  autoCloseDuplicates: ["settings_row_auto_close_duplicates", "settings_desc_auto_close_duplicates"],
  history: ["settings_row_history", "history_access_copy"],
  replayIntro: ["settings_row_replay_intro", "settings_desc_replay_intro"],
  openHelp: ["settings_row_open_help", "settings_desc_open_help"]
});

const OPTION_KEYS = Object.freeze({
  language: {
    system: "settings_option_language_system", en: "settings_option_language_en",
    fr: "settings_option_language_fr"
  },
  mode: {
    system: "settings_option_mode_system", scheme: "settings_option_mode_scheme",
    light: "settings_option_mode_light", dark: "settings_option_mode_dark"
  },
  rotation: {
    off: "settings_option_rotation_off", open: "settings_option_rotation_open",
    hourly: "settings_option_rotation_hourly", daily: "settings_option_rotation_daily"
  },
  interfaceStyle: {
    soft: "settings_option_interface_soft", crisp: "settings_option_interface_crisp",
    terminal: "settings_option_interface_terminal"
  },
  rowInfo: {
    clean: "settings_option_row_clean", useful: "settings_option_row_useful",
    detailed: "settings_option_row_detailed"
  },
  actionLabels: {
    named: "settings_option_actions_named", icons: "settings_option_actions_icons"
  },
  welcomeTone: {
    clock: "settings_option_welcome_tone_clock", accent: "settings_option_welcome_tone_accent"
  },
  focusDuration: {
    "1h": "settings_option_duration_hour", "morning-end": "settings_option_duration_morning",
    "day-end": "settings_option_duration_day", manual: "settings_option_duration_manual",
    custom: "settings_option_duration_custom"
  },
  focusScope: {
    focus: "settings_option_scope_focus", always: "settings_option_scope_always"
  },
  focusAccess: {
    immediate: "settings_option_access_immediate", pause: "settings_option_access_pause"
  }
});

export function settingsGroupTitle(id) {
  return msg(GROUP_KEYS[id] ?? GROUP_KEYS.appearance);
}

export function settingsRowCopy(id, substitutions = []) {
  const keys = ROW_KEYS[id] ?? ROW_KEYS.colorScheme;
  return { title: msg(keys[0], substitutions), description: msg(keys[1], substitutions) };
}

export function settingsOptions(kind) {
  return Object.entries(OPTION_KEYS[kind] ?? {}).map(([value, key]) => [value, msg(key)]);
}

/**
 * A language's name in that language ("English", "Français"), for the option
 * that follows the browser. Falls back to the code when Intl.DisplayNames is
 * unavailable or does not know the language.
 * @param {string} locale BCP 47 tag
 */
export function settingsLanguageOwnName(locale) {
  try {
    const language = new Intl.Locale(locale).language;
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(language);
    if (!name || name === language) return language;
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    return String(locale);
  }
}

/**
 * Options for the Language select: "System (<browser language name>)" then each
 * packaged language under its own name. Stored values stay language codes.
 * @param {string} [browserLocale] the browser's UI locale, not the installed one
 * @returns {[string, string][]}
 */
export function settingsLanguageOptions(browserLocale = browserUiLocale()) {
  return UI_LANGUAGE_VALUES.map((value) => [
    value,
    value === "system"
      ? msg(OPTION_KEYS.language.system, [settingsLanguageOwnName(browserLocale)])
      : msg(OPTION_KEYS.language[value])
  ]);
}

export function settingsOptionLabel(kind, value) {
  const key = OPTION_KEYS[kind]?.[value];
  return key ? msg(key) : String(value ?? "");
}

export function settingsModeChoiceLabel(value) {
  if (value === "light") return msg("settings_mode_light_label");
  if (value === "dark") return msg("settings_mode_dark_label");
  return msg("settings_option_mode_scheme");
}

export function settingsInvalidSite(reason) {
  const key = ({
    empty: "settings_site_invalid_empty",
    wildcard: "settings_site_invalid_wildcard",
    scheme: "settings_site_invalid_scheme",
    ip: "settings_site_invalid_ip",
    localhost: "settings_site_invalid_localhost",
    "single-label": "settings_site_invalid_single_label",
    malformed: "settings_site_invalid_malformed"
  })[reason] ?? "settings_site_invalid_malformed";
  return msg(key);
}

export function settingsExceptionDescription(style) {
  return msg(style === "pause" ? "settings_desc_focus_access_pause" : "settings_desc_focus_access_immediate");
}

export function settingsSchemeGroupLabel(defaultMode, tone) {
  if (defaultMode === "dark") {
    return msg(tone === "vivid" ? "settings_scheme_group_dark_vivid" : "settings_scheme_group_dark_soft");
  }
  return msg(tone === "vivid" ? "settings_scheme_group_light_vivid" : "settings_scheme_group_light_soft");
}

export function settingsFavoritesSummary(count, total) {
  return msg("settings_favorites_title");
}

export function settingsFavoritesHelp(count, rotation) {
  return msg("settings_favorites_help");
}

export function settingsFavoriteAria(selected, label) {
  return msg(selected ? "settings_favorite_remove_aria" : "settings_favorite_add_aria", [label]);
}

export function settingsApplySchemeAria(selected, label) {
  return msg(selected ? "settings_scheme_current_aria" : "settings_scheme_apply_aria", [label]);
}

export function settingsDurationLabel(minutes, mode = "minutes") {
  const value = Number(minutes) || 0;
  if (value <= 0) return msg("settings_duration_off");
  if (mode === "auto" && value % 1440 === 0) {
    const days = value / 1440;
    return msg(days === 1 ? "settings_duration_day_one" : "settings_duration_day_many", [formatNumber(days)]);
  }
  if (mode === "auto" && value % 60 === 0) {
    const hours = value / 60;
    return msg(hours === 1 ? "settings_duration_hour_one" : "settings_duration_hour_many", [formatNumber(hours)]);
  }
  return msg(value === 1 ? "settings_duration_minute_one" : "settings_duration_minute_many", [formatNumber(value)]);
}

export const settingsStatic = Object.freeze({
  pageTitle: () => msg("settings_page_title"),
  saved: () => msg("settings_saved"),
  filterPlaceholder: () => msg("settings_filter_placeholder"),
  filterAria: () => msg("settings_filter_aria"),
  noMatch: () => msg("settings_no_match"),
  jumpTo: (title) => msg("settings_jump_to", [title]),
  patternsPlaceholder: () => msg("settings_patterns_placeholder"),
  welcomePhrasesPlaceholder: () => msg("settings_welcome_phrases_placeholder"),
  keyboardHint: () => msg("settings_keyboard_hint"),
  focusHint: () => msg("settings_focus_hint"),
  customDurationAria: () => msg("settings_custom_duration_aria"),
  addSitePlaceholder: () => msg("settings_add_site_placeholder"),
  addSiteAria: () => msg("settings_add_site_aria"),
  addSite: () => msg("settings_add_site"),
  noBlockedSites: () => msg("settings_no_blocked_sites"),
  siteScopeAria: (domain) => msg("settings_site_scope_aria", [domain]),
  removeSiteAria: (domain) => msg("settings_site_remove_aria", [domain]),
  remove: () => msg("settings_remove"),
  manageProtection: () => msg("settings_manage_protection"),
  noSuspendPageExceptions: () => msg("settings_no_suspend_page_exceptions"),
  suspendPageFor: (remaining) => msg("settings_suspend_page_for", [remaining]),
  removeSuspendPageAria: (url) => msg("settings_suspend_page_remove_aria", [url]),
  siteDuplicate: (domain) => msg("settings_site_duplicate", [domain]),
  focusAccessAria: () => msg("settings_focus_access_aria"),
  yours: () => msg("settings_yours"),
  allowGroupAccess: () => msg("settings_allow_group_access"),
  groupPermissionNote: () => msg("settings_group_permission_note"),
  historyOn: () => msg("settings_history_on"),
  historyOff: () => msg("settings_history_off"),
  historyTurnOff: () => msg("settings_history_turn_off"),
  historyAllow: () => msg("settings_history_allow"),
  historyRemoved: () => msg("settings_history_removed"),
  historyRemoveFailed: () => msg("settings_history_remove_failed"),
  historyEnabled: () => msg("settings_history_enabled"),
  historyEnableFailed: () => msg("settings_history_enable_failed"),
  historyDenied: () => msg("settings_history_denied"),
  replayIntro: () => msg("settings_replay_intro"),
  openHelp: () => msg("settings_open_help"),
  durationOffShort: () => msg("settings_duration_off"),
  oneDayShort: () => msg("settings_tick_one_day"),
  sevenDaysShort: () => msg("settings_tick_seven_days"),
  thirtyOneDaysShort: () => msg("settings_tick_thirty_one_days"),
  colorScheme: () => msg("settings_row_color_scheme"),
  colorSchemeTrigger: () => msg("settings_color_scheme_trigger"),
  appearanceModeAria: () => msg("settings_appearance_mode_aria"),
  modeLightTip: () => msg("settings_mode_light_tip"),
  modeDarkTip: () => msg("settings_mode_dark_tip"),
  modeSchemeTip: () => msg("settings_mode_scheme_tip"),
  schemeEditorAction: () => msg("settings_scheme_editor_action"),
  schemePickerTitle: () => msg("settings_scheme_picker_title"),
  schemePickerBack: () => msg("settings_scheme_picker_back"),
  schemePickerFavorites: () => msg("settings_scheme_picker_favorites"),
  schemePickerAll: () => msg("settings_scheme_picker_all"),
  schemePickerEmptyFavorites: () => msg("settings_scheme_picker_empty_favorites"),
  schemePickerCurrent: () => msg("settings_scheme_picker_current"),
  followingSystem: (description) => msg("settings_following_system", [description])
});

export const customSchemeSettingsCopy = Object.freeze({
  shareBlocked: () => msg("settings_custom_share_blocked"),
  exported: (name) => msg("settings_custom_exported", [name]),
  duplicateFailed: () => msg("settings_custom_duplicate_failed"),
  duplicated: (name) => msg("settings_custom_duplicated", [name]),
  empty: () => msg("settings_custom_empty"),
  applied: (name) => msg("settings_custom_applied", [name]),
  appliedAction: () => msg("settings_custom_applied_action"),
  applyAction: () => msg("settings_custom_apply_action"),
  confirmDeleteAria: (name) => msg("settings_custom_confirm_delete_aria", [name]),
  deleteAria: (name) => msg("settings_custom_delete_aria", [name]),
  deleted: (name) => msg("settings_custom_deleted", [name]),
  unavailable: (name) => msg("settings_custom_unavailable", [name]),
  confirmDelete: () => msg("settings_custom_confirm_delete"),
  deleteAction: () => msg("settings_custom_delete_action"),
  defaultMode: (mode) => msg(mode === "dark" ? "settings_custom_dark_default" : "settings_custom_light_default"),
  edit: () => msg("settings_custom_edit"),
  duplicate: () => msg("settings_custom_duplicate"),
  share: () => msg("settings_custom_share"),
  tooLarge: (size) => msg("settings_custom_too_large", [formatNumber(size)]),
  unreadable: () => msg("settings_custom_unreadable"),
  invalid: () => msg("settings_custom_invalid"),
  imported: (name) => msg("settings_custom_imported", [name]),
  openEditor: () => msg("settings_custom_open_editor"),
  importScheme: () => msg("settings_custom_import"),
  heading: () => msg("settings_custom_heading"),
  intro: () => msg("settings_custom_intro"),
  untitled: () => msg("settings_custom_untitled"),
  unsaved: (name) => msg("settings_custom_unsaved", [name]),
  continueDraft: () => msg("settings_custom_continue_draft")
});
