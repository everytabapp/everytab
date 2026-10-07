/**
 * Public, privacy-safe scheme-rotation diagnostic report.
 *
 * Callers supply explicit snapshots. This module performs no storage, DOM, or
 * network reads and cannot expose custom scheme identities or arbitrary logs.
 */
import {
  SCHEME_ROTATION_DIAGNOSTIC_TRACE_LIMIT,
  inspectSchemeRotationDiagnosticInput
} from "./scheme-rotation-diagnostics-model.js";

export { SCHEME_ROTATION_DIAGNOSTIC_TRACE_LIMIT };
export const SCHEME_ROTATION_DIAGNOSTIC_FORMAT_VERSION = 1;

export const SCHEME_ROTATION_DIAGNOSTIC_VERDICTS = Object.freeze([
  "rotation-off",
  "on-open-disabled",
  "rotation-config-invalid",
  "one-item-pool",
  "bag-malformed",
  "bag-stale",
  "reservation-malformed",
  "reservation-stale",
  "valid-reservation",
  "worker-never-saw-handshake",
  "worker-no-op",
  "worker-failed",
  "rotation-successful",
  "rotation-reverted",
  "reservation-missing",
  "insufficient-evidence"
]);

function verdictFor(snapshot) {
  const { mode, pool, bag, reservation, trace } = snapshot;
  if (mode === "off") return "rotation-off";
  if (mode === "hourly" || mode === "daily") return "on-open-disabled";
  if (mode === "invalid") return "rotation-config-invalid";
  if (pool.size <= 1) return "one-item-pool";
  if (trace.committed && trace.reverted) return "rotation-reverted";
  if (trace.committed) return "rotation-successful";
  if (trace.handshakeExpected && !trace.workerSaw) return "worker-never-saw-handshake";
  if (["no-op", "already-handled"].includes(trace.lastOutcome)) return "worker-no-op";
  if (trace.lastOutcome === "failed") return "worker-failed";
  if (bag.health === "malformed") return "bag-malformed";
  if (reservation.health === "malformed") return "reservation-malformed";
  if (bag.health === "stale") return "bag-stale";
  if (reservation.health === "stale") return "reservation-stale";
  if (reservation.health === "valid") return "valid-reservation";
  if (reservation.health === "missing") return "reservation-missing";
  return "insufficient-evidence";
}

function evidenceFor(snapshot) {
  const { mode, pool, bag, reservation, cache, painted, trace } = snapshot;
  const evidence = [];
  if (mode === "off") evidence.push("rotation-mode-off");
  if (mode === "open") evidence.push("rotation-mode-open");
  if (mode === "hourly" || mode === "daily") evidence.push("rotation-mode-scheduled");
  if (mode === "invalid") evidence.push("rotation-mode-invalid");
  if (pool.size <= 1) evidence.push("pool-cannot-change-visibly");
  if (bag.health === "malformed") evidence.push("bag-shape-invalid");
  if (bag.health === "stale") evidence.push("bag-state-stale");
  if (reservation.health === "malformed") evidence.push("reservation-shape-invalid");
  if (reservation.health === "stale") evidence.push("reservation-state-stale");
  if (reservation.health === "valid") evidence.push("reservation-valid");
  if (cache.health === "stale") evidence.push("synchronous-cache-stale");
  if (trace.pageSent) evidence.push("page-handshake-recorded");
  if (trace.workerSaw) evidence.push("worker-handshake-recorded");
  if (trace.handshakeExpected && !trace.workerSaw) evidence.push("worker-handshake-missing");
  if (["no-op", "already-handled"].includes(trace.lastOutcome)) {
    evidence.push("worker-result-no-op");
  }
  if (trace.lastOutcome === "failed") evidence.push("worker-result-failed");
  if (trace.committed) evidence.push("worker-result-changed");
  if (trace.reverted) evidence.push("post-commit-selection-changed");
  if (trace.revertSource === "vault") evidence.push("post-commit-vault-change");
  if (trace.settingsMismatch) evidence.push("settings-differ-from-worker-commit");
  if (trace.paintMismatch) evidence.push("paint-differs-from-worker-commit");
  if (painted.currentMatchesSettings === true) evidence.push("paint-matches-current-settings");
  return evidence;
}

/**
 * @typedef {Object} SchemeRotationDiagnosticInput
 * @property {object} [settings] Current Settings record.
 * @property {object|object[]} [customRecords] Current custom-scheme map.
 * @property {object|null} [state] `schemeRotationState`.
 * @property {object|null} [prepared] `schemeRotationPrepared`.
 * @property {object|null} [cache] Parsed `tvTheme` cache.
 * @property {string|{bootSelection?:string,currentSelection?:string}} [painted]
 * @property {object[]|object} [workerTrace] Trace events or the worker's complete response.
 * @property {boolean} [expectedHandshake] A New Tab was successfully created during the check.
 * @property {number} [expectedTabId] Private tab identity used only to filter concurrent traces.
 * @property {string} [expectedCommitSelection] Private valid preflight reservation identity.
 */

/** Build one deterministic report suitable for rendering or copying. */
export function buildSchemeRotationDiagnostics(input = {}) {
  const snapshot = inspectSchemeRotationDiagnosticInput(input);
  const verdict = verdictFor(snapshot);
  return {
    formatVersion: SCHEME_ROTATION_DIAGNOSTIC_FORMAT_VERSION,
    verdict,
    summaryId: verdict,
    evidence: evidenceFor(snapshot),
    rotation: {
      mode: snapshot.mode,
      settingsPresent: snapshot.settingsPresent,
      requested: snapshot.requested,
      current: snapshot.current,
      missingCustomSelection: snapshot.missingCustomSelection,
      favorites: snapshot.favorites,
      pool: snapshot.pool
    },
    customSchemes: snapshot.customSchemes,
    operational: {
      bag: snapshot.bag,
      reservation: snapshot.reservation,
      cache: snapshot.cache
    },
    runtime: {
      painted: snapshot.painted,
      handshake: {
        expected: snapshot.trace.handshakeExpected,
        pageSent: snapshot.trace.pageSent,
        workerSaw: snapshot.trace.workerSaw
      },
      worker: {
        outcome: snapshot.trace.lastOutcome,
        changedTo: snapshot.trace.lastChangedTo
      },
      transition: {
        committed: snapshot.trace.committed,
        committedSelection: snapshot.trace.committedSelection,
        reverted: snapshot.trace.reverted,
        revertSource: snapshot.trace.revertSource
      },
      trace: snapshot.trace.report
    },
    privacy: {
      customSchemeIdentities: "masked",
      customSchemeNames: "omitted",
      customSchemeDetails: "omitted",
      arbitraryTraceText: "omitted",
      traceLimit: SCHEME_ROTATION_DIAGNOSTIC_TRACE_LIMIT
    }
  };
}
