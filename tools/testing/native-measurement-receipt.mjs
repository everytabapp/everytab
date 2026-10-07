// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Validate terminal measurement receipts without browser or filesystem effects. */
const SEARCH_PHASES = ['first', 'warm-immediate', 'warm-immediate', 'warm-immediate', 'warm-expired', 'after-edit'];
const SEARCH_TIMINGS = ['primaryResolvedMs', 'progressivePrimaryMs', 'completionResolvedMs',
  'primaryDomReadyMs', 'primaryFrameOpportunityMs', 'completionDomReadyMs', 'completionFrameOpportunityMs'];
const PRIMARY_TIMINGS = ['primaryResolvedMs', 'progressivePrimaryMs', 'primaryDomReadyMs', 'primaryFrameOpportunityMs'];
const COMPLETION_TIMINGS = ['completionResolvedMs', 'completionDomReadyMs', 'completionFrameOpportunityMs'];
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A previous document's terminal state cannot count toward a new navigation.
 * Failure labels are fixed here; page-provided error payloads are not forwarded.
 * @param {{href?:string,state?:object}|null|undefined} observed
 * @param {string} url Exact expected document URL, including trial query.
 * @param {Record<string,number|string>|null} trial Search dimensions, round and optional mixed workload; null for Library mode.
 * @returns {object|null} Valid completed report, or null while awaiting this document.
 */
export function inspectMeasurementReceipt(observed, url, trial = null) {
  if (observed?.href !== url || observed.state == null) return null;
  const state = observed.state;
  if (state.status === 'running') return null;
  if (state.status === 'fail') {
    const codes = ['frame-timeout', 'warm-cadence', 'cache-phase', 'fixture-contract', 'mixed-contract'];
    const code = codes.includes(state.failureCode) ? state.failureCode : null;
    const phase = [...SEARCH_PHASES, 'seed'].includes(state.failedPhase) ? state.failedPhase : null;
    throw new Error('Native measurement page reported failure' +
      (code ? ` (${code}${phase ? `, ${phase}` : ''})` : ''));
  }
  if (state.status !== 'pass' || !isRecord(state.report)) throw new Error('Malformed native measurement receipt');
  const report = state.report;
  if (trial) {
    const result = report.result;
    const mixed = Object.hasOwn(trial, 'workload');
    const workload = mixed ? trial.workload : 'selective';
    const identity = mixed ? Object.entries(trial)
      : ['round', 'records', 'icons'].map(key => [key, trial[key]]);
    if (!isRecord(result) || !['selective', 'broad', 'facets'].includes(workload) ||
        identity.some(([key, value]) => result[key] !== value) || report.cleanup?.deletedDatabases !== 2) {
      throw new Error('Mounted Search receipt does not match its trial or database cleanup');
    }
    if (!Array.isArray(result.phases) || result.phases.length !== SEARCH_PHASES.length ||
        result.phases.some((phase, index) => !isRecord(phase) || phase.phase !== SEARCH_PHASES[index])) {
      throw new Error('Mounted Search receipt has an invalid phase sequence');
    }
    const requiredTimings = workload === 'facets' ? ['resolvedMs']
      : workload === 'broad' ? PRIMARY_TIMINGS : SEARCH_TIMINGS;
    for (const phase of result.phases) {
      for (const field of requiredTimings) {
        if (!Number.isFinite(phase[field]) || phase[field] < 0) {
          throw new Error('Mounted Search receipt has an invalid timing value');
        }
      }
      if (workload === 'broad' && COMPLETION_TIMINGS.some(field => phase[field] !== null)) {
        throw new Error('Broad Search receipt must not claim completion timing');
      }
      if (workload === 'facets' && [...SEARCH_TIMINGS, 'primaryRowsStillCurrentAtFrame',
        'completionRowsStillCurrentAtFrame'].some(field => phase[field] != null)) {
        throw new Error('Facet receipt must not claim mounted Search timing or frames');
      }
      if (mixed && (!Array.isArray(phase.calls) || !isRecord(phase.requests) ||
          (Object.hasOwn(phase.requests, 'assets.get') ? phase.requests['assets.get'] : 0) !== 0)) {
        throw new Error('Mixed Search receipt requires request evidence with zero asset reads');
      }
    }
  } else if (!Array.isArray(report.results) || !report.results.length ||
      !Number.isSafeInteger(report.cleanup?.deletedDatabases) || report.cleanup.deletedDatabases < 0) {
    throw new Error('Malformed Library measurement receipt');
  }
  return report;
}
