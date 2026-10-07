// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import {
  formatDate, formatList, formatNumber, formatTime, msg, pluralCategory
} from "../lib/i18n.js";
import { importFormatLabel } from "../lib/import-copy.js";

const text = (key) => () => msg(key);
const plural = (count, one, other, substitutions = [formatNumber(count)]) =>
  msg(pluralCategory(count) === "one" ? one : other, substitutions);

export const dataStatic = Object.freeze({
  downloadBackup: text("data_download_backup"),
  pasteExport: text("data_paste_export"),
  importFormatAria: text("data_import_format_aria"),
  autoDetect: text("data_auto_detect"),
  importDestinationAria: text("data_import_destination_aria"),
  archiveDestination: text("data_import_destination_archive"),
  inboxDestination: text("data_import_destination_inbox"),
  sessionDestination: text("data_import_destination_session"),
  labelsTitle: text("data_import_labels_title"),
  labelsToggle: text("data_import_labels_toggle"),
  importAction: text("data_import_action"),
  checkRecentlyClosed: text("data_check_recently_closed"),
  noRecentlyClosed: text("data_no_recently_closed"),
  recentWorkerFailure: text("data_recent_worker_failure"),
  noTabsRecovered: text("data_no_tabs_recovered"),
  checkingRecentlyClosed: text("data_checking_recently_closed"),
  recentCheckFailure: text("data_recent_check_failure"),
  recentlyClosed: text("data_recently_closed"),
  checkSnapshots: text("data_check_snapshots"),
  noMissingTabs: text("data_no_missing_tabs"),
  snapshotWorkerFailure: text("data_snapshot_worker_failure"),
  comparingSnapshot: text("data_comparing_snapshot"),
  snapshotUnavailable: text("data_snapshot_unavailable"),
  checkingSnapshots: text("data_checking_snapshots"),
  snapshotCheckFailure: text("data_snapshot_check_failure"),
  noSnapshots: text("data_no_snapshots"),
  snapshotSelectAria: text("data_snapshot_select_aria"),
  reviewMissing: text("data_review_missing"),
  backupHeading: text("data_backup_heading"),
  backupTitle: text("data_backup_title"),
  backupDescription: text("data_backup_description"),
  restoreHeading: text("data_restore_heading"),
  restoreTitle: text("data_restore_title"),
  restoreDescription: text("data_restore_description"),
  recoveryHeading: text("data_recovery_heading"),
  recentTitle: text("data_recent_title"),
  recentDescription: text("data_recent_description"),
  snapshotTitle: text("data_snapshot_title"),
  snapshotDescription: text("data_snapshot_description"),
  importHeading: text("data_import_heading"),
  importDescription: text("data_import_description"),
  chooseFile: text("data_choose_file")
});

export function dataImportNoLinks(source) {
  return msg("data_import_no_links", [importFormatLabel(source)]);
}

export function dataRecentlyClosedAction(count) {
  return plural(count, "data_recover_tab_one", "data_recover_tab_other");
}

export function dataRecentlyClosedProgress(count) {
  return plural(count, "data_recovering_tab_one", "data_recovering_tab_other");
}

export function dataRecentlyClosedFound(count) {
  return plural(count, "data_recent_found_one", "data_recent_found_other");
}

export function dataSnapshotAction(count) {
  return plural(count, "data_recover_missing_one", "data_recover_missing_other");
}

export function dataSnapshotProgress(count) {
  return plural(count, "data_recovering_missing_one", "data_recovering_missing_other");
}

function recovered(count) {
  return plural(count, "data_recovered_one", "data_recovered_other");
}

function failed(count) {
  return plural(count, "data_failed_one", "data_failed_other");
}

function unavailable(count) {
  return plural(count, "data_unavailable_one", "data_unavailable_other");
}

function snapshotUnavailable(count) {
  return plural(count, "data_snapshot_unavailable_one", "data_snapshot_unavailable_other");
}

function newWindows(count) {
  return plural(count, "data_new_window_one", "data_new_window_other");
}

export function dataRecentlyClosedResult({ restored = 0, failed: failedCount = 0, unavailable: unavailableCount = 0 }) {
  const parts = [
    restored ? recovered(restored) : "",
    failedCount ? failed(failedCount) : "",
    unavailableCount ? unavailable(unavailableCount) : ""
  ].filter(Boolean);
  return parts.length ? formatList(parts) : dataStatic.noTabsRecovered();
}

export function dataSnapshotResult({ restored = 0, windows = 0, failed: failedCount = 0,
  unavailable: unavailableCount = 0, uncertain = 0, degraded = 0 }) {
  const parts = [
    restored ? msg("data_snapshot_recovered", [recovered(restored), newWindows(windows)]) : "",
    failedCount ? failed(failedCount) : "",
    unavailableCount ? snapshotUnavailable(unavailableCount) : "",
    uncertain ? plural(uncertain, "data_snapshot_uncertain_one", "data_snapshot_uncertain_other") : "",
    degraded ? plural(degraded, "data_snapshot_degraded_one", "data_snapshot_degraded_other") : ""
  ].filter(Boolean);
  return parts.length ? formatList(parts) : dataStatic.noTabsRecovered();
}

export function dataCandidateMeta(domain, when) {
  return msg("data_candidate_meta", [domain, when]);
}

export function dataSnapshotCandidateMeta(windowIndex, domain) {
  return msg("data_snapshot_candidate_meta", [formatNumber(windowIndex + 1), domain]);
}

export function dataSnapshotMissing(count) {
  return plural(count, "data_snapshot_missing_one", "data_snapshot_missing_other");
}

function dataSnapshotTabCount(count) {
  return plural(count, "data_snapshot_tabs_one", "data_snapshot_tabs_other");
}

function dataSnapshotMissingCount(count) {
  return plural(count, "data_snapshot_missing_count_one", "data_snapshot_missing_count_other");
}

export function dataSnapshotOption(snapshot) {
  const value = snapshot.createdAt || snapshot.modifiedAt;
  const when = msg("data_date_time", [
    formatDate(value, { dateStyle: "medium" }),
    formatTime(value, { timeStyle: "short" })
  ]);
  return msg("data_snapshot_option", [
    when,
    dataSnapshotTabCount(snapshot.tabCount),
    dataSnapshotMissingCount(snapshot.missingCount)
  ]);
}

export function dataSnapshotsAvailable(count) {
  return plural(count, "data_snapshots_available_one", "data_snapshots_available_other");
}
