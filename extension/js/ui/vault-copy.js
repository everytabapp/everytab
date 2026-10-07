// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { formatDate, formatList, formatNumber, msg, pluralCategory } from "../lib/i18n.js";
import { compactRelativeAge } from "../lib/relative-time.js";

const text = (key) => () => msg(key);

const TARGET_KEYS = Object.freeze({
  library: "vault_target_library",
  recovery: "vault_target_recovery",
  assets: "vault_target_favicons",
  inbox: "vault_target_inbox",
  archive: "vault_target_archive",
  sessions: "vault_target_sessions",
  collections: "vault_target_collections",
  snoozes: "vault_target_snoozes",
  smartviews: "vault_target_smartviews",
  starred: "vault_target_starred",
  customSchemes: "vault_target_schemes",
  organizationGroups: "vault_target_groups",
  organizationMemberships: "vault_target_memberships",
  settings: "vault_target_settings",
  labelMeta: "vault_target_labels",
  backup: "vault_target_backup",
  index: "vault_target_index"
});

export const vaultStatic = Object.freeze({
  syncing: text("vault_syncing"),
  syncingAnother: text("vault_syncing_another_tab"),
  finishing: text("vault_finishing"),
  updatingViews: text("vault_updating_views"),
  updatingIndex: text("vault_updating_index"),
  starting: text("vault_starting"),
  reconnectPill: text("vault_pill_reconnect"),
  errorPill: text("vault_pill_error"),
  noVault: text("vault_pill_none"),
  restarting: text("vault_restarting"),
  restartSync: text("vault_restart_sync"),
  syncNow: text("vault_sync_now"),
  tryAgain: text("vault_try_again"),
  details: text("vault_details"),
  reconnectVault: text("vault_reconnect_vault"),
  connectFolder: text("vault_connect_folder"),
  changeFolder: text("vault_change_folder"),
  folderSelectionGuidance: text("vault_folder_selection_guidance"),
  reconnect: text("vault_reconnect"),
  neverSynced: text("vault_never_synced"),
  timeoutGuidance: text("vault_timeout_guidance"),
  retryGuidance: text("vault_retry_guidance"),
  unknownError: text("vault_unknown_error"),
  failureNotice: text("vault_failure_notice"),
  defaultFailureBanner: text("vault_failure_banner_default"),
  description: text("vault_description")
});

export const vaultRestoreStatic = Object.freeze({
  unavailable: text("vault_restore_unavailable"),
  reviewChanges: text("vault_restore_review_changes"),
  alreadyMatches: text("vault_restore_already_matches"),
  replacing: text("vault_restore_replacing"),
  restoredReview: text("vault_restore_restored_review"),
  undoing: text("vault_restore_undoing"),
  keeping: text("vault_restore_keeping"),
  safetyUnavailable: text("vault_restore_safety_unavailable"),
  undone: text("vault_restore_undone"),
  kept: text("vault_restore_kept"),
  heading: text("vault_restore_heading"),
  description: text("vault_restore_description"),
  working: text("vault_restore_working"),
  keep: text("vault_restore_keep"),
  undo: text("vault_restore_undo"),
  noPoints: text("vault_restore_no_points"),
  selectAria: text("vault_restore_select_aria"),
  checking: text("vault_restore_checking"),
  reviewPoint: text("vault_restore_review_point"),
  replace: text("vault_restore_replace"),
  noRecords: text("vault_restore_no_records"),
  noChanges: text("vault_restore_no_changes")
});

export function vaultTargetLabel(target) {
  return msg(TARGET_KEYS[target] ?? "vault_target_vault");
}

function ageSuffix(timestamp, now) {
  return timestamp
    ? msg("vault_age_suffix", [compactRelativeAge(timestamp, now)])
    : "";
}

export function vaultPillState(status, meta, inFlight, now = Date.now()) {
  if (inFlight && status.state === "connected") {
    return { cls: "", text: msg("vault_pill_syncing") };
  }
  switch (status.state) {
    case "connected":
      if (meta?.busy) return { cls: "", text: msg("vault_pill_syncing_another") };
      if (meta && !meta.ok) {
        return {
          cls: "warn",
          text: msg("vault_pill_failed", [ageSuffix(meta.lastSyncAt, now)])
        };
      }
      return {
        cls: "",
        text: msg("vault_pill_synced", [ageSuffix(meta?.lastSyncAt, now)])
      };
    case "needs-permission":
      return { cls: "warn", text: vaultStatic.reconnectPill() };
    case "error":
      return { cls: "warn", text: vaultStatic.errorPill() };
    default:
      return { cls: "unset", text: vaultStatic.noVault() };
  }
}

function withElapsed(progressText, elapsedMs) {
  const seconds = Math.floor(Number(elapsedMs) / 1_000);
  if (seconds < 1) return progressText;
  const elapsed = msg(pluralCategory(seconds) === "one"
    ? "vault_elapsed_one"
    : "vault_elapsed_other", [formatNumber(seconds)]);
  return msg("vault_progress_elapsed", [progressText, elapsed]);
}

export function vaultProgressText(progress, otherTab = false, elapsedMs = 0) {
  if (otherTab) return withElapsed(vaultStatic.syncingAnother(), elapsedMs);
  const target = vaultTargetLabel(progress?.target);
  let result;
  if (progress?.stage === "complete") result = vaultStatic.finishing();
  else if (progress?.stage === "views") result = vaultStatic.updatingViews();
  else if (progress?.stage === "indexing") result = vaultStatic.updatingIndex();
  if (progress?.stage === "connecting" || progress?.stage === "starting") {
    result = vaultStatic.starting();
  } else if (progress?.stage === "scanning" && Number.isFinite(progress.completed)) {
    const visibleCount = Math.floor(progress.completed / 100) * 100;
    result = visibleCount > 0
      ? msg("vault_scanning_found", [target, formatNumber(visibleCount)])
      : msg("vault_scanning", [target]);
  } else if (progress?.stage === "reading" && Number.isFinite(progress.total) && progress.total > 0) {
    const step = Math.max(1, Math.ceil(progress.total / 20));
    const visibleCount = progress.completed >= progress.total
      ? progress.total
      : Math.floor(progress.completed / step) * step;
    result = visibleCount > 0
      ? msg("vault_syncing_count", [
        target, formatNumber(visibleCount), formatNumber(progress.total)
      ])
      : msg("vault_syncing_target", [target]);
  }
  return withElapsed(result ?? msg("vault_syncing_target", [target]), elapsedMs);
}

export function vaultSyncAction({ restarting, busy, stalled }) {
  if (restarting) return vaultStatic.restarting();
  if (busy) return vaultStatic.syncing();
  return stalled ? vaultStatic.restartSync() : vaultStatic.syncNow();
}

export function vaultStatusBadge(status, meta) {
  switch (status.state) {
    case "connected":
      return {
        cls: meta && !meta.ok && !meta.busy ? "status warn" : "status ok",
        text: msg("vault_folder_connected", [status.name])
      };
    case "needs-permission":
      return { cls: "status warn", text: msg("vault_needs_reconnect", [status.name]) };
    case "error": {
      const reason = status.errorClass != null
        ? vaultSyncFailureReason(status) ?? vaultStatic.unknownError()
        : status.message;
      return { cls: "status danger", text: msg("vault_error_status", [reason]) };
    }
    default:
      return { cls: "status unset", text: msg("vault_not_configured") };
  }
}

function conflictSuffix(count) {
  if (!count) return "";
  const key = pluralCategory(count) === "one"
    ? "vault_conflict_one"
    : "vault_conflict_other";
  return msg(key, [formatNumber(count)]);
}

/** New diagnostic receipts use product copy; older receipts retain their reason. */
export function vaultSyncFailureReason(meta) {
  if (meta?.errorClass != null) {
    return meta.failureCode === "timeout" ? vaultSyncStopped() : null;
  }
  return meta?.error;
}

export function vaultLastSyncText(meta, progress = null, {
  now = Date.now(), timeoutFailure = meta?.failureCode === "timeout", elapsedMs = 0
} = {}) {
  if (!meta) return vaultStatic.neverSynced();
  if (meta.busy) return vaultProgressText(meta.progress ?? progress, !meta.local, elapsedMs);
  const when = compactRelativeAge(meta.lastSyncAt, now);
  if (meta.ok) {
    return msg("vault_last_sync", [
      when,
      formatNumber(meta.pulled ?? 0),
      formatNumber(meta.pushed ?? 0),
      conflictSuffix(meta.conflictCopies),
      meta.backedUp ? msg("vault_backup_written") : ""
    ]);
  }
  const reason = String(vaultSyncFailureReason(meta) ?? vaultStatic.unknownError()).replace(/[.\s]+$/, "");
  const guidance = timeoutFailure
    ? vaultStatic.timeoutGuidance()
    : vaultStatic.retryGuidance();
  return msg("vault_sync_attempt_failed", [when, reason, guidance]);
}

export function vaultSyncStopped(target) {
  return target
    ? msg("vault_stopped_at_target", [vaultTargetLabel(target)])
    : msg("vault_stopped");
}

export function vaultSyncDidNotFinish(reason) {
  return msg("vault_did_not_finish", [String(reason)]);
}

export function vaultSyncRestartFailure(reason) {
  return msg("vault_restart_failure", [String(reason)]);
}

export function vaultReconnectBanner(name) {
  return msg("vault_reconnect_banner", [name]);
}

export function vaultFailureBanner(reason) {
  const clean = String(reason ?? "").replace(/[.\s]+$/, "");
  return clean ? msg("vault_failure_banner", [clean]) : vaultStatic.defaultFailureBanner();
}

export function vaultRestorePointLabel(day) {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime())
    ? formatDate(date, { dateStyle: "medium", timeZone: "UTC" })
    : String(day);
}

export function vaultRestoreRestoredFrom(source) {
  return msg("vault_restore_restored_from", [source]);
}

function restoreChange(count, key) {
  return count > 0 ? msg(key, [formatNumber(count)]) : "";
}

export function vaultRestoreSummary(summary) {
  const families = Object.entries(summary.targetFamilies ?? {})
    .filter(([, count]) => count > 0)
    .map(([family, count]) => msg("vault_restore_family_count", [
      formatNumber(count), vaultTargetLabel(family)
    ]));
  const familySummary = families.length
    ? formatList(families)
    : vaultRestoreStatic.noRecords();
  const changes = [
    restoreChange(summary.added, "vault_restore_added"),
    restoreChange(summary.updated, "vault_restore_replaced"),
    restoreChange(summary.removed, "vault_restore_removed"),
    restoreChange(summary.watermarks, "vault_restore_watermarks")
  ].filter(Boolean);
  const plan = changes.length ? formatList(changes) : vaultRestoreStatic.noChanges();
  return msg("vault_restore_summary", [familySummary, plan]);
}

function restoreProgressCount(progress, key, plainKey) {
  const completed = Number(progress?.completed);
  const total = Number(progress?.total);
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) {
    return msg(plainKey);
  }
  return msg(key, [formatNumber(completed), formatNumber(total)]);
}

export function vaultRestoreProgressText(progress = {}) {
  if (progress.stage === "opening" || progress.target === "restorePoint") {
    return msg("vault_restore_progress_opening");
  }
  if (progress.target === "checkpoint") {
    return restoreProgressCount(progress, "vault_restore_progress_file",
      "vault_restore_progress_file_plain");
  }
  if (progress.target === "assets") {
    return restoreProgressCount(progress, "vault_restore_progress_favicons",
      "vault_restore_progress_favicons_plain");
  }
  if (progress.stage === "comparing") {
    return msg("vault_restore_progress_comparing");
  }
  return restoreProgressCount(progress, "vault_restore_progress_records",
    "vault_restore_progress_records_plain");
}

function restoreHost(change) {
  if (typeof change?.host === "string" && change.host.trim()) return change.host.trim();
  try {
    const url = new URL(change?.url ?? "");
    return url.hostname || url.protocol.replace(/:$/, "");
  } catch {
    return "";
  }
}

function restoreDeltaRow(change) {
  const family = vaultTargetLabel(change.family);
  const title = String(change.title || change.id || family);
  const host = restoreHost(change);
  const detail = host ? msg("vault_restore_delta_identity", [title, host]) : title;
  const key = {
    added: "vault_restore_delta_added",
    updated: "vault_restore_delta_replaced",
    removed: "vault_restore_delta_removed",
    watermark: "vault_restore_delta_watermark"
  }[change.kind] ?? "vault_restore_delta_replaced";
  return msg(key, [family, detail]);
}

export function vaultRestoreDeltaRows({ changes = [], limit = 50 } = {}) {
  const normalizedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const visible = changes.slice(0, normalizedLimit);
  const remaining = Math.max(0, changes.length - visible.length);
  return {
    rows: visible.map(restoreDeltaRow),
    remaining,
    remainingText: remaining > 0
      ? msg(pluralCategory(remaining) === "one"
        ? "vault_restore_delta_remaining_one"
        : "vault_restore_delta_remaining_other", [formatNumber(remaining)])
      : ""
  };
}

export function vaultRestoreChangesAction(count, expanded) {
  if (expanded) return msg("vault_restore_hide_changes");
  return msg(pluralCategory(count) === "one"
    ? "vault_restore_show_changes_one"
    : "vault_restore_show_changes_other", [formatNumber(count)]);
}

export function vaultRestoreShowMoreAction(count) {
  return msg("vault_restore_show_more", [formatNumber(count)]);
}

export function vaultRestoreReadFailure(reason) {
  return msg("vault_restore_read_failure", [String(reason)]);
}
