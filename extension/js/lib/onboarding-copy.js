// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

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
  page("local", msg("onboarding_intro_title"), msg("onboarding_intro_essence"), [], {
    benefits: [
      ["inbox", msg("onboarding_intro_save")],
      ["search", msg("onboarding_intro_find")],
      ["activity", msg("onboarding_intro_automate")]
    ],
    note: msg("onboarding_intro_local")
  }),
  page("find", msg("onboarding_organize_title"), msg("onboarding_organize_essence"), [], {
    definitions: [
      ["inbox", msg("shell_section_inbox"), msg("onboarding_organize_inbox")],
      ["sessions", msg("shell_section_sessions"), msg("onboarding_organize_sessions")],
      ["labels", msg("shell_section_labels"), msg("onboarding_organize_labels")]
    ],
    note: msg("onboarding_organize_search")
  }),
  page("save", msg("onboarding_automation_title"), msg("onboarding_automation_essence"), [],
    { special: "automation" }),
  page("newtab", msg("onboarding_new_tab_title"), msg("onboarding_new_tab_essence"), [],
    { special: "newtab" }),
  page("scheme", msg("onboarding_appearance_title"), msg("onboarding_appearance_essence"), [],
    { special: "scheme" }),
  page("data", msg("onboarding_vault_title"), msg("onboarding_vault_essence"), [
    msg("onboarding_vault_body"), msg("onboarding_vault_folders")
  ], { special: "vault", note: msg("onboarding_vault_optional") })
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

/** The full Help list in compact form, with Imports replacing permissions during first run. */
export const ONBOARDING_FEATURES = Object.freeze(HELP_TOPICS.map((topic) => topic.id === "history"
  ? Object.freeze({ id: "import", title: msg("onboarding_feature_import_title"),
    description: msg("onboarding_feature_import_detail") })
  : Object.freeze({ id: topic.id, title: topic.title, description: topic.essence })));

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
  openHelp: () => msg("onboarding_open_help"),
  settingsSaved: () => msg("onboarding_settings_saved"),
  vaultConnect: () => msg("onboarding_vault_connect"),
  vaultConnected: (name) => msg("onboarding_vault_connected", [name]),
  vaultUnavailable: () => msg("onboarding_vault_unavailable"),
  helpBrand: () => msg("help_brand"),
  helpTitle: () => msg("help_title"),
  helpClose: () => msg("action_close"),
  helpTopics: () => msg("help_topics"),
  helpChooseTopic: () => msg("help_choose_topic"),
  helpRelatedSettings: () => msg("help_related_settings"),
  helpSettingsLink: (section) => msg("help_settings_link", [section])
});
