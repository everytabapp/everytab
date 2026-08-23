/**
 * Localized presentation data for first run and permanent Help.
 *
 * Stable ids stay language-free. First run is deliberately six outcomes;
 * Help is a separate, complete topic library that reuses the same renderer.
 */
import { formatNumber, msg } from "./i18n.js";

const page = (id, title, essence, why, options = {}) => Object.freeze({
  id, title, essence, why: Array.isArray(why) ? why : [why], ...options
});

export const ONBOARDING_PAGES = Object.freeze([
  page("local", msg("onboarding_local_title"), msg("onboarding_local_essence"), [
    msg("onboarding_local_body_one"), msg("onboarding_local_body_two")
  ], {
    terms: [
      [msg("onboarding_overview_clear_term"), msg("onboarding_overview_clear_desc")],
      [msg("onboarding_overview_organize_term"), msg("onboarding_overview_organize_desc")],
      [msg("onboarding_overview_focus_term"), msg("onboarding_overview_focus_desc")]
    ],
    note: msg("onboarding_local_note")
  }),
  page("newtab", msg("onboarding_new_tab_title"), msg("onboarding_new_tab_essence"),
    msg("onboarding_new_tab_body"), { special: "newtab", note: msg("onboarding_new_tab_note") }),
  page("save", msg("onboarding_save_title"), msg("onboarding_save_essence"), [
    msg("onboarding_save_body_one"), msg("onboarding_save_body_two")
  ], { special: "automation" }),
  page("find", msg("onboarding_find_title"), msg("onboarding_find_essence"), [
    msg("onboarding_find_body_one"), msg("onboarding_find_body_two")
  ], { note: msg("onboarding_find_note") }),
  page("scheme", msg("onboarding_scheme_title"), msg("onboarding_scheme_essence"),
    msg("onboarding_scheme_body"), { special: "scheme" }),
  page("data", msg("onboarding_data_title"), msg("onboarding_data_essence"), [
    msg("onboarding_data_body_one"), msg("onboarding_data_body_two")
  ], { special: "vault", settingsClosure: true })
]);

export const HELP_TOPICS = Object.freeze([
  page("open", msg("help_open_title"), msg("help_open_essence"), [], {
    how: [msg("help_open_how_one"), msg("help_open_how_two"),
      msg("help_open_how_three"), msg("help_open_how_four")]
  }),
  page("inbox", msg("help_inbox_title"), msg("help_inbox_essence"), msg("help_inbox_body"), {
    how: [msg("help_inbox_how_one"), msg("help_inbox_how_two")],
    note: msg("help_inbox_how_three"), settingsGroups: ["autosave"]
  }),
  page("sessions", msg("help_sessions_title"), msg("help_sessions_essence"), [
    msg("help_sessions_body"), msg("help_sessions_how_three")
  ], {
    how: [msg("help_sessions_how_one"), msg("help_sessions_how_two")],
    settingsGroups: ["sessions"]
  }),
  page("labels", msg("help_labels_title"), msg("help_labels_essence"), [
    msg("help_labels_body"), msg("help_labels_how_one")
  ], {
    terms: [
      [msg("help_labels_group_term"), msg("help_labels_how_two")],
      [msg("help_labels_lens_term"), msg("help_labels_how_three")]
    ]
  }),
  page("search", msg("help_search_title"), msg("help_search_essence"), msg("help_search_body"), {
    how: [msg("help_search_how_one"), msg("help_search_how_two"), msg("help_search_how_three")],
    settingsGroups: ["privacy"]
  }),
  page("snooze", msg("help_snooze_title"), msg("help_snooze_essence"), msg("help_snooze_body"), {
    how: [msg("help_snooze_how_one"), msg("help_snooze_how_two")]
  }),
  page("focus", msg("help_focus_title"), msg("help_focus_essence"), [
    msg("help_focus_body"), msg("help_focus_how_three")
  ], {
    steps: [msg("help_focus_how_one"), msg("help_focus_how_two")],
    note: msg("help_focus_note"), settingsGroups: ["focus"]
  }),
  page("automation", msg("help_automation_title"), msg("help_automation_essence"), [
    msg("help_automation_how_one"), msg("help_automation_how_two")
  ], {
    terms: [
      [msg("help_automation_autosave_term"), msg("help_automation_autosave_desc")],
      [msg("help_automation_suspension_term"), msg("help_automation_suspension_desc")],
      [msg("help_automation_snapshots_term"), msg("help_automation_snapshots_desc")],
      [msg("help_automation_duplicates_term"), msg("help_automation_duplicates_desc")]
    ],
    note: msg("help_automation_how_three"),
    settingsGroups: ["autosave", "suspension", "sessions", "duplicates"]
  }),
  page("close-day", msg("help_close_day_title"), msg("help_close_day_essence"),
    msg("help_close_day_body"), {
      steps: [msg("help_close_day_how_one"), msg("help_close_day_how_two"), msg("help_close_day_how_three")]
    }),
  page("appearance", msg("help_appearance_title"), msg("help_appearance_essence"),
    msg("help_appearance_body"), {
      how: [msg("help_appearance_how_one"), msg("help_appearance_how_two"), msg("help_appearance_how_three")],
      settingsGroups: ["appearance", "newtab"]
    }),
  page("keyboard", msg("help_keyboard_title"), msg("help_keyboard_essence"),
    msg("help_keyboard_body"), {
      terms: [
        [msg("help_keyboard_in_page_term"), msg("help_keyboard_how_one")],
        [msg("help_keyboard_chrome_term"), msg("help_keyboard_how_two")]
      ],
      note: msg("help_keyboard_how_three"), settingsGroups: ["keyboard"]
    }),
  page("data", msg("help_data_title"), msg("help_data_essence"), msg("help_data_body"), {
    how: [msg("help_data_how_one"), msg("help_data_how_two"), msg("help_data_how_three")]
  }),
  page("history", msg("help_history_title"), msg("help_history_essence"), [
    msg("help_history_body"), msg("help_history_how_one"),
    msg("help_history_how_two"), msg("help_history_how_three")
  ], { settingsGroups: ["privacy"] }),
  page("safety", msg("help_safety_title"), msg("help_safety_essence"), [
    msg("help_safety_body"), msg("help_safety_how_one"),
    msg("help_safety_how_two"), msg("help_safety_how_three")
  ], {
    note: msg("help_safety_note")
  })
]);

export const HELP_GROUPS = Object.freeze([
  Object.freeze({
    id: "start", title: msg("help_group_start"),
    topicIds: Object.freeze(["open", "inbox", "search"])
  }),
  Object.freeze({
    id: "organize", title: msg("help_group_organize"),
    topicIds: Object.freeze(["sessions", "labels", "snooze", "close-day"])
  }),
  Object.freeze({
    id: "control", title: msg("help_group_control"),
    topicIds: Object.freeze(["focus", "automation", "appearance", "keyboard"])
  }),
  Object.freeze({
    id: "trust", title: msg("help_group_trust"),
    topicIds: Object.freeze(["data", "history", "safety"])
  })
]);

const HELP_IDS = new Set(HELP_TOPICS.map((topic) => topic.id));

/** Section Learn more routes. */
export const SECTION_TO_PAGE = Object.freeze({
  open: "open",
  "close-day": "close-day",
  inbox: "inbox",
  snoozed: "snooze",
  duplicates: "automation",
  sessions: "sessions",
  snapshots: "sessions",
  labels: "labels",
  archive: "inbox",
  data: "data",
  vault: "data",
  activity: "safety",
  settings: "appearance"
});

/** Old incomplete tours resume at the nearest new outcome instead of restarting. */
export const LEGACY_ONBOARDING_STEP = Object.freeze({
  promise: "local", inbox: "save", sessions: "find", snooze: "find", labels: "find",
  search: "find", focus: "find", machinery: "save", newtab: "newtab", keyboard: "find",
  appearance: "scheme", vault: "data"
});

export function onboardingStepId(savedId) {
  const candidate = LEGACY_ONBOARDING_STEP[savedId] ?? savedId;
  return ONBOARDING_PAGES.some((entry) => entry.id === candidate) ? candidate : "local";
}

export function helpTopicId(requestedId) {
  const candidate = SECTION_TO_PAGE[requestedId] ?? ({
    promise: "safety", machinery: "automation", newtab: "appearance", vault: "data"
  })[requestedId] ?? requestedId;
  return HELP_IDS.has(candidate) ? candidate : "open";
}

export const onboardingStatic = Object.freeze({
  welcome: () => msg("onboarding_welcome"),
  skip: () => msg("onboarding_skip"),
  back: () => msg("onboarding_back"),
  next: () => msg("onboarding_next"),
  done: () => msg("onboarding_done"),
  progress: (current, total) => msg("onboarding_progress", [formatNumber(current), formatNumber(total)]),
  progressAria: () => msg("onboarding_progress_aria"),
  pageAria: (current, total, title) => msg("onboarding_page_aria", [formatNumber(current), formatNumber(total), title]),
  example: () => msg("onboarding_example"),
  newTabAria: () => msg("onboarding_new_tab_aria"),
  newTabDashboard: () => msg("onboarding_new_tab_dashboard"),
  newTabDashboardDesc: () => msg("onboarding_new_tab_dashboard_desc"),
  newTabMinimal: () => msg("onboarding_new_tab_minimal"),
  newTabMinimalDesc: () => msg("onboarding_new_tab_minimal_desc"),
  newTabBlank: () => msg("onboarding_new_tab_blank"),
  newTabBlankDesc: () => msg("onboarding_new_tab_blank_desc"),
  tuneAutomation: () => msg("onboarding_tune_automation"),
  tuneAutomationHint: () => msg("onboarding_tune_automation_hint"),
  automationSummary: (autoSave, suspend, snapshots, keep) =>
    msg("onboarding_automation_summary", [autoSave, suspend, snapshots, keep]),
  keepAllSnapshots: () => msg("onboarding_keep_all_snapshots"),
  keepSnapshots: (count) => msg("onboarding_keep_snapshots", [formatNumber(count)]),
  moreAutomation: () => msg("onboarding_more_automation"),
  schemeAria: () => msg("onboarding_scheme_aria"),
  finalSettingsCopy: () => msg("onboarding_final_settings_copy"),
  openSettings: () => msg("onboarding_open_settings"),
  openHelp: () => msg("onboarding_open_help"),
  settingsSaved: () => msg("onboarding_settings_saved"),
  vaultConnect: () => msg("onboarding_vault_connect"),
  vaultLater: () => msg("onboarding_vault_later"),
  vaultConnected: (name) => msg("onboarding_vault_connected", [name]),
  vaultLocal: () => msg("onboarding_vault_local"),
  vaultUnavailable: () => msg("onboarding_vault_unavailable"),
  helpBrand: () => msg("help_brand"),
  helpTitle: () => msg("help_title"),
  helpClose: () => msg("action_close"),
  helpTopics: () => msg("help_topics"),
  helpChooseTopic: () => msg("help_choose_topic"),
  helpRelatedSettings: () => msg("help_related_settings"),
  helpSettingsLink: (section) => msg("help_settings_link", [section])
});
