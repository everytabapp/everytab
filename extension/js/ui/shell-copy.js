/**
 * Localized presentation for Dashboard and side-panel chrome. Route ids and
 * section ids remain stable English-free data; only this module turns them
 * into visible navigation and section copy.
 */
import { formatNumber, msg } from "../lib/i18n.js";

const SECTION_KEYS = Object.freeze({
  open: () => msg("shell_section_open"),
  "close-day": () => msg("shell_section_close_day"),
  inbox: () => msg("shell_section_inbox"),
  snoozed: () => msg("shell_section_snoozed"),
  duplicates: () => msg("shell_section_duplicates"),
  sessions: () => msg("shell_section_sessions"),
  snapshots: () => msg("shell_section_snapshots"),
  labels: () => msg("shell_section_labels"),
  archive: () => msg("shell_section_archive"),
  data: () => msg("shell_section_data"),
  vault: () => msg("shell_section_vault"),
  activity: () => msg("shell_section_activity"),
  stats: () => msg("shell_section_stats"),
  settings: () => msg("shell_section_settings")
});

const INTRO_KEYS = Object.freeze({
  open: () => msg("shell_intro_open"),
  "close-day": () => msg("shell_intro_close_day"),
  inbox: () => msg("shell_intro_inbox"),
  snoozed: () => msg("shell_intro_snoozed"),
  duplicates: () => msg("shell_intro_duplicates"),
  sessions: () => msg("shell_intro_sessions"),
  snapshots: () => msg("shell_intro_snapshots"),
  labels: () => msg("shell_intro_labels"),
  archive: () => msg("shell_intro_archive"),
  data: () => msg("shell_intro_data"),
  vault: () => msg("shell_intro_vault"),
  activity: () => msg("shell_intro_activity"),
  stats: () => msg("shell_intro_stats")
});

export function shellSectionTitle(id) {
  return SECTION_KEYS[id]?.() ?? String(id ?? "");
}

export function shellSectionIntro(id) {
  return INTRO_KEYS[id]?.() ?? "";
}

export function shellSectionCountTitle(id, value) {
  return msg("shell_section_count", [shellSectionTitle(id), formatNumber(value)]);
}

export function shellAutoSnapshotsTitle(value) {
  return msg("shell_auto_snapshots_count", [formatNumber(value)]);
}

export function shellNavLabel(id) {
  return shellSectionTitle(id);
}

export function shellPanelTabLabel(id) {
  return id === "open" ? msg("shell_panel_open") : shellSectionTitle(id);
}

export function shellNavName(label, value) {
  return value === undefined
    ? label
    : msg("shell_nav_name_count", [label, formatNumber(value)]);
}

export function shellNavToggleLabel(label) {
  return msg("shell_nav_toggle", [label]);
}

export function shellSidebarToggleLabel(collapsed) {
  return collapsed ? msg("shell_nav_expand") : msg("shell_nav_collapse");
}

export function shellAllLink(kind) {
  return kind === "sessions" ? msg("shell_all_sessions") : msg("shell_all_labels");
}

export function shellRestoreSessionTitle(name) {
  return msg("shell_restore_session_title", [name]);
}

export function shellRestoreSessionAria(name) {
  return msg("shell_restore_session_aria", [name]);
}

export const shellStatic = Object.freeze({
  learnMore: () => msg("shell_learn_more"),
  sectionActions: () => msg("shell_section_actions"),
  closeDay: () => msg("shell_section_close_day"),
  closeDayTip: () => msg("shell_close_day_tip"),
  now: () => msg("shell_nav_now"),
  saved: () => msg("shell_nav_saved"),
  more: () => msg("shell_nav_more"),
  moreSections: () => msg("shell_more_sections"),
  panelSections: () => msg("shell_panel_sections"),
  openDashboard: () => msg("shell_open_dashboard"),
  brand: () => msg("manifest_short_name"),
  settings: () => msg("shell_section_settings")
});

export function shellMoreSelected(section) {
  return msg("shell_more_selected", [shellSectionTitle(section)]);
}

export function shellLoadingSection(section) {
  return ({
    open: () => msg("shell_loading_open"),
    inbox: () => msg("shell_loading_inbox"),
    sessions: () => msg("shell_loading_sessions"),
    labels: () => msg("shell_loading_labels"),
    snoozed: () => msg("shell_loading_snoozed")
  })[section]?.() ?? msg("shell_loading_open");
}
