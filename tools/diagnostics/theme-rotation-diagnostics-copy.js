/** Localized presentation for the opt-in theme-rotation diagnostic. */
import { formatNumber, msg, pluralCategory } from "../../extension/js/lib/i18n.js";

const text = (key) => () => msg(key);

const SUMMARY_KEYS = Object.freeze({
  "rotation-off": "theme_rotation_diagnostic_summary_rotation_off",
  "on-open-disabled": "theme_rotation_diagnostic_summary_on_open_disabled",
  "rotation-config-invalid": "theme_rotation_diagnostic_summary_config_invalid",
  "one-item-pool": "theme_rotation_diagnostic_summary_one_item_pool",
  "bag-malformed": "theme_rotation_diagnostic_summary_bag_malformed",
  "bag-stale": "theme_rotation_diagnostic_summary_bag_stale",
  "reservation-malformed": "theme_rotation_diagnostic_summary_reservation_malformed",
  "reservation-stale": "theme_rotation_diagnostic_summary_reservation_stale",
  "valid-reservation": "theme_rotation_diagnostic_summary_valid_reservation",
  "worker-never-saw-handshake": "theme_rotation_diagnostic_summary_missing_handshake",
  "worker-no-op": "theme_rotation_diagnostic_summary_worker_no_op",
  "worker-failed": "theme_rotation_diagnostic_summary_worker_failed",
  "rotation-successful": "theme_rotation_diagnostic_summary_successful",
  "rotation-reverted": "theme_rotation_diagnostic_summary_reverted",
  "reservation-missing": "theme_rotation_diagnostic_summary_reservation_missing",
  "insufficient-evidence": "theme_rotation_diagnostic_summary_insufficient",
  "worker-unavailable": "theme_rotation_diagnostic_summary_worker_unavailable"
});

const EVIDENCE_KEYS = Object.freeze({
  "rotation-mode-off": "theme_rotation_diagnostic_evidence_mode_off",
  "rotation-mode-open": "theme_rotation_diagnostic_evidence_mode_open",
  "rotation-mode-scheduled": "theme_rotation_diagnostic_evidence_mode_scheduled",
  "rotation-mode-invalid": "theme_rotation_diagnostic_evidence_mode_invalid",
  "pool-cannot-change-visibly": "theme_rotation_diagnostic_evidence_pool_static",
  "bag-shape-invalid": "theme_rotation_diagnostic_evidence_bag_invalid",
  "bag-state-stale": "theme_rotation_diagnostic_evidence_bag_stale",
  "reservation-shape-invalid": "theme_rotation_diagnostic_evidence_reservation_invalid",
  "reservation-state-stale": "theme_rotation_diagnostic_evidence_reservation_stale",
  "reservation-valid": "theme_rotation_diagnostic_evidence_reservation_valid",
  "synchronous-cache-stale": "theme_rotation_diagnostic_evidence_cache_stale",
  "page-handshake-recorded": "theme_rotation_diagnostic_evidence_page_handshake",
  "worker-handshake-recorded": "theme_rotation_diagnostic_evidence_worker_handshake",
  "worker-handshake-missing": "theme_rotation_diagnostic_evidence_worker_handshake_missing",
  "worker-result-no-op": "theme_rotation_diagnostic_evidence_worker_no_op",
  "worker-result-failed": "theme_rotation_diagnostic_evidence_worker_failed",
  "worker-result-changed": "theme_rotation_diagnostic_evidence_worker_changed",
  "post-commit-selection-changed": "theme_rotation_diagnostic_evidence_selection_changed",
  "post-commit-vault-change": "theme_rotation_diagnostic_evidence_vault_changed",
  "settings-differ-from-worker-commit": "theme_rotation_diagnostic_evidence_settings_mismatch",
  "paint-differs-from-worker-commit": "theme_rotation_diagnostic_evidence_paint_mismatch",
  "paint-matches-current-settings": "theme_rotation_diagnostic_evidence_paint_matches",
  "page-worker-build-mismatch": "theme_rotation_diagnostic_evidence_build_mismatch",
  "page-worker-protocol-mismatch": "theme_rotation_diagnostic_evidence_protocol_mismatch",
  "diagnostic-worker-unavailable": "theme_rotation_diagnostic_evidence_worker_unavailable"
});

export const themeRotationDiagnosticStatic = Object.freeze({
  title: text("theme_rotation_diagnostic_title"),
  initialStatus: text("theme_rotation_diagnostic_initial_status"),
  copyReport: text("theme_rotation_diagnostic_copy_report"),
  refresh: text("theme_rotation_diagnostic_refresh"),
  run: text("theme_rotation_diagnostic_run"),
  opening: text("theme_rotation_diagnostic_opening"),
  reading: text("theme_rotation_diagnostic_reading"),
  ready: text("theme_rotation_diagnostic_ready"),
  finished: text("theme_rotation_diagnostic_finished"),
  copied: text("theme_rotation_diagnostic_copied"),
  copyBlocked: text("theme_rotation_diagnostic_copy_blocked"),
  usage: text("theme_rotation_diagnostic_usage"),
  privacy: text("theme_rotation_diagnostic_privacy"),
  technicalReport: text("theme_rotation_diagnostic_technical_report")
});

export function themeRotationDiagnosticWatching(remaining) {
  const key = pluralCategory(remaining) === "one"
    ? "theme_rotation_diagnostic_watching_one"
    : "theme_rotation_diagnostic_watching_other";
  return msg(key, [formatNumber(remaining)]);
}

export function themeRotationDiagnosticSummary(id, transition = {}) {
  if (id === "rotation-reverted" && transition.revertSource === "vault") {
    return msg("theme_rotation_diagnostic_summary_reverted_vault");
  }
  return msg(SUMMARY_KEYS[id] ?? "theme_rotation_diagnostic_finished");
}

export function themeRotationDiagnosticEvidence(id) {
  const key = EVIDENCE_KEYS[id];
  return key
    ? msg(key)
    : msg("theme_rotation_diagnostic_evidence_unknown", [String(id ?? "unknown")]);
}
