/**
 * Editor-only trial palettes.
 *
 * The first candidate campaign is complete: every accepted direction is now a
 * built-in and every rejected variant has been retired. Keep this intentionally
 * empty module as the stable editor boundary for a future trial campaign.
 */

export const SCHEME_CANDIDATES = Object.freeze([]);
export const SCHEME_CANDIDATE_META = Object.freeze({});

export function createCandidateSchemeDraft() {
  return { ok: false, value: null, errors: [{
    code: "value.candidate",
    message: "That candidate scheme is unavailable."
  }] };
}
