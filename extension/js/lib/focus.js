/**
 * F8 (Focus Mode) — pure domain helpers. DOM-free and Chrome-free so they run
 * in Node tests and can be shared by the future background coordinator (F8-3).
 *
 * This module contains only decisions: domain normalization/validation, host
 * matching, and Focus-run end-time calculation. It never touches tabs, windows,
 * storage, alarms, or the DOM. See focus-mode.md §5.3, §8, and §13.
 */

/**
 * @typedef {Object} DomainResult
 * @property {boolean} ok
 * @property {string} [domain] canonical ASCII hostname used for comparison (leading `www.` stripped)
 * @property {string} [displayDomain] safe display form (the ASCII canonical; homograph-safe)
 * @property {string} [reason] present when `ok` is false: why the input was rejected
 */

/** @param {string} reason @returns {DomainResult} */
function invalidDomain(reason) {
  return { ok: false, reason };
}

/** Max length of a presentation-form hostname (RFC 1035). */
const MAX_HOSTNAME_LENGTH = 253;

/**
 * A single DNS label is 1..63 chars and must not begin or end with a hyphen.
 * Interior hyphens (including the "xn--" IDN prefix) are allowed.
 * @param {string} label
 * @returns {boolean}
 */
function isValidLabel(label) {
  return label.length >= 1 && label.length <= 63 &&
    !label.startsWith("-") && !label.endsWith("-");
}

/**
 * Canonicalize one user-entered domain or pasted HTTP(S) URL into a stored rule
 * domain. Accepts a bare domain ("Example.COM"), a full HTTP(S) URL
 * ("https://example.com/path?q=1"), and IDN input (punycoded by the platform
 * URL parser). Scheme, credentials, port, path, query, and fragment are all
 * discarded. Rejects empty, wildcard, credentials-only, internal-scheme, IP,
 * localhost, single-label, and otherwise malformed input.
 *
 * Never throws for ordinary user input; malformed input returns a typed invalid
 * result so the settings UI can show an inline message.
 *
 * V1 intentionally ships no public-suffix list: a rule for "example.co.uk" is
 * treated as an ordinary two-label-plus domain. The add UI states that a rule
 * covers the entered domain and its subdomains, so unusually broad input stays
 * visible and removable (focus-mode.md §5.3).
 *
 * @param {string} input
 * @returns {DomainResult}
 */
export function canonicalizeDomain(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return invalidDomain("empty");
  if (/\s/.test(raw)) return invalidDomain("malformed");
  if (raw.includes("*")) return invalidDomain("wildcard");

  let urlString;
  const schemeWithSlashes = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (schemeWithSlashes) {
    const scheme = schemeWithSlashes[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") return invalidDomain("scheme");
    urlString = raw;
  } else {
    // A leading "scheme:" not followed by a digit (so a bare port like ":8080"
    // is not mistaken for a scheme) that is not http/https is an internal or
    // dangerous scheme — javascript:, data:, mailto:, chrome:, about:, etc.
    const bareScheme = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):(?!\d)/);
    if (bareScheme) {
      const scheme = bareScheme[1].toLowerCase();
      if (scheme !== "http" && scheme !== "https") return invalidDomain("scheme");
    }
    urlString = "https://" + raw;
  }

  let host;
  try {
    const url = new URL(urlString);
    // Defensive: the parser is the source of truth for the final scheme.
    if (url.protocol !== "http:" && url.protocol !== "https:") return invalidDomain("scheme");
    host = url.hostname;
  } catch {
    return invalidDomain("malformed");
  }

  host = host.toLowerCase().replace(/\.$/, "");
  if (!host) return invalidDomain("malformed");
  if (host.length > MAX_HOSTNAME_LENGTH) return invalidDomain("malformed"); // overlong hostname
  if (host.startsWith("[")) return invalidDomain("ip"); // IPv6 literal, e.g. [::1]
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return invalidDomain("ip"); // IPv4
  if (host === "localhost") return invalidDomain("localhost");
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..") || host.startsWith(".")) {
    return invalidDomain("malformed");
  }
  // Every DNS label must be 1..63 chars and must not begin or end with a hyphen.
  // The URL parser accepts labels DNS forbids (e.g. "-foo.com", "foo-.com",
  // "a-.b.com", a 64-char label), so validate them here. Interior double hyphens
  // are allowed so IDN/punycode ("xn--…") labels keep working.
  if (!host.split(".").every(isValidLabel)) return invalidDomain("malformed");
  if (!host.includes(".")) return invalidDomain("single-label");

  // Strip a leading www. only for the stored rule so www.example.com and
  // example.com can never become two rules (focus-mode.md §5.3).
  const canonical = host.startsWith("www.") ? host.slice(4) : host;
  if (!canonical.includes(".")) return invalidDomain("single-label");

  return { ok: true, domain: canonical, displayDomain: canonical };
}

/**
 * Does a hostname fall under a rule domain? Matches the exact domain and any
 * subdomain, and never a lookalike suffix: "example.com" matches "example.com"
 * and "video.example.com" but not "notexample.com".
 *
 * Takes a hostname, not a full URL — the caller extracts the hostname first, so
 * this can never match a mere substring of a longer URL (focus-mode.md §12).
 *
 * @param {string} host a hostname
 * @param {string} domain a canonical rule domain
 * @returns {boolean}
 */
export function hostMatchesDomain(host, domain) {
  if (typeof host !== "string" || typeof domain !== "string") return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  const d = domain.toLowerCase().replace(/\.$/, "");
  if (!h || !d) return false;
  return h === d || h.endsWith("." + d);
}

/**
 * Index of the rule whose canonical domain equals `domain`, or -1. Used by the
 * settings editor to keep one rule per canonical domain (changing scope edits
 * the existing row instead of adding a duplicate).
 * @param {Array<{domain: string}>} rules
 * @param {string} domain canonical domain
 * @returns {number}
 */
export function ruleIndexForDomain(rules, domain) {
  if (!Array.isArray(rules)) return -1;
  return rules.findIndex((r) => r && r.domain === domain);
}

/**
 * The next epoch-ms at which a local wall-clock time occurs. If today's time
 * has already passed (or is exactly now), returns tomorrow's occurrence.
 * @param {number} now epoch ms
 * @param {number} minutesSinceMidnight 0..1439 in local time
 * @returns {number} epoch ms
 */
export function nextLocalWallClock(now, minutesSinceMidnight) {
  const base = new Date(now);
  const target = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  target.setMinutes(minutesSinceMidnight);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return target.getTime();
}

/** @param {number} m @returns {boolean} */
function isValidDayMinutes(m) {
  return Number.isFinite(m) && m >= 0 && m < 1440;
}

/**
 * @typedef {Object} EndTimeParams
 * @property {("duration"|"morning-end"|"day-end"|"manual"|"custom")} mode
 * @property {number} now epoch ms — injected so calculations are deterministic in tests
 * @property {number} [durationMinutes] for "duration"
 * @property {number} [morningEndMinutes] minutes since local midnight, for "morning-end"
 * @property {number} [dayEndMinutes] minutes since local midnight, for "day-end"
 * @property {number|Date} [customAt] absolute end time, for "custom"
 */

/**
 * @typedef {{ok: true, endsAt: number|null} | {ok: false, reason: string}} EndTimeResult
 * endsAt is null for open-ended ("manual") runs — the caller creates no end alarm.
 */

/**
 * Resolve a Focus run's end time. "manual" is open-ended (endsAt null, no alarm);
 * "morning-end"/"day-end" resolve to the next occurrence of the configured local
 * time; "custom" must be strictly in the future or the result is invalid.
 * See focus-mode.md §8.
 * @param {EndTimeParams} params
 * @returns {EndTimeResult}
 */
export function resolveFocusEndTime(params) {
  const now = Number(params?.now);
  if (!Number.isFinite(now)) return { ok: false, reason: "now-required" };

  switch (params.mode) {
    case "manual":
      return { ok: true, endsAt: null };
    case "duration": {
      // Reject anything below one minute after numeric conversion (a small
      // positive fraction like 0.4 would round to a zero-length run).
      const minutes = Number(params.durationMinutes);
      if (!Number.isFinite(minutes) || minutes < 1) return { ok: false, reason: "duration" };
      const endsAt = now + Math.round(minutes) * 60000;
      // Invariant: a successful timed run ends at a FINITE time strictly after
      // now. `!Number.isFinite` guards an overflowing finite duration (e.g.
      // Number.MAX_VALUE) whose milliseconds product is Infinity.
      if (!Number.isFinite(endsAt) || endsAt <= now) return { ok: false, reason: "duration" };
      return { ok: true, endsAt };
    }
    case "morning-end": {
      const m = Number(params.morningEndMinutes);
      if (!isValidDayMinutes(m)) return { ok: false, reason: "morning" };
      return { ok: true, endsAt: nextLocalWallClock(now, m) };
    }
    case "day-end": {
      const m = Number(params.dayEndMinutes);
      if (!isValidDayMinutes(m)) return { ok: false, reason: "day" };
      return { ok: true, endsAt: nextLocalWallClock(now, m) };
    }
    case "custom": {
      const at = params.customAt instanceof Date ? params.customAt.getTime() : Number(params.customAt);
      if (!Number.isFinite(at)) return { ok: false, reason: "custom" };
      if (at <= now) return { ok: false, reason: "custom-past" };
      return { ok: true, endsAt: at };
    }
    default:
      return { ok: false, reason: "mode" };
  }
}

/**
 * F8-2 — a per-run end choice, sent by the popup and validated in the coordinator.
 * A named union (not an untyped bag) so message validation is explicit. Omitting
 * the choice entirely means "use the saved Focus defaults" (see resolveEndChoice).
 * @typedef {(
 *   {mode: "duration", durationMinutes: number} |
 *   {mode: "morning-end"} |
 *   {mode: "day-end"} |
 *   {mode: "manual"} |
 *   {mode: "custom", customAt: number}
 * )} FocusEndChoice
 */

/** The saved-default end choice, built from Settings (focus-mode.md §5.1, §8). */
function defaultEndChoice(settings) {
  const mode = settings?.focusDefaultEndMode ?? "duration";
  if (mode === "duration") {
    return { mode: "duration", durationMinutes: Number(settings?.focusDefaultDurationMinutes) || 60 };
  }
  if (mode === "morning-end" || mode === "day-end" || mode === "manual") return { mode };
  // An unknown stored mode falls back to a safe one-hour run rather than failing
  // a start the user explicitly asked for.
  return { mode: "duration", durationMinutes: 60 };
}

/**
 * Resolve a per-run end CHOICE into an end time, using saved Settings for the
 * morning/day wall-clock values. `choice` omitted/null means "use saved
 * defaults". Direct Open-tabs / Session starts pass no choice; the popup passes
 * an explicit per-run override that never mutates Settings. "custom" is a
 * one-run absolute future time. See focus-mode.md §8 and worker-prompt.md.
 * @param {FocusEndChoice|null|undefined} choice
 * @param {import("./types.js").Settings} settings
 * @param {number} now epoch ms
 * @returns {EndTimeResult}
 */
export function resolveEndChoice(choice, settings, now) {
  const c = choice ?? defaultEndChoice(settings);
  switch (c.mode) {
    case "manual":
      return resolveFocusEndTime({ mode: "manual", now });
    case "duration":
      return resolveFocusEndTime({ mode: "duration", durationMinutes: Number(c.durationMinutes), now });
    case "morning-end":
      return resolveFocusEndTime({
        mode: "morning-end", morningEndMinutes: Number(settings?.focusMorningEndMinutes), now
      });
    case "day-end":
      return resolveFocusEndTime({
        mode: "day-end", dayEndMinutes: Number(settings?.focusDayEndMinutes), now
      });
    case "custom":
      return resolveFocusEndTime({ mode: "custom", customAt: Number(c.customAt), now });
    default:
      return { ok: false, reason: "mode" };
  }
}

/**
 * The next occurrence of a local wall-clock time, plus whether it lands tomorrow.
 * The popup uses `isTomorrow` to say "Tomorrow at {time}" (focus-mode.md §6.2).
 * @param {number} now epoch ms @param {number} minutesSinceMidnight 0..1439
 * @returns {{at: number, isTomorrow: boolean}}
 */
export function nextWallClockInfo(now, minutesSinceMidnight) {
  const at = nextLocalWallClock(now, minutesSinceMidnight);
  return { at, isTomorrow: new Date(at).getDate() !== new Date(now).getDate() };
}

// F8-R1: `buildFocusStatus` (the UI-safe window/session run status) was removed with
// the retired Workspace Focus surface. F8-R2 derives its own SITE-ONLY status below.

/* ============================ F8-R2: site-guard decisions ============================
 * Pure, DOM-free, Chrome-free decisions for distraction-site guarding (focus-mode.md
 * §5, §6, §8). The coordinator (js/lib/focus-guard.js) owns all storage / tabs / alarms;
 * these helpers only DECIDE. */

/** The only temporary-access durations (minutes). */
export const GRANT_MINUTES = [5, 10, 15, 30];
/** The persisted access-pause length (focus-mode.md §8.3). */
export const ACCESS_PAUSE_MS = 15000;

/** The parsed lowercase hostname of an HTTP(S) URL, or "" when not parseable/HTTP(S). */
export function hostnameOfUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** Is this a normal guardable web URL: HTTP(S) only (internal/extension/file/data excluded)? */
export function isGuardableUrl(url) {
  return hostnameOfUrl(url) !== "";
}

/**
 * Does a single rule apply right now? An `always` rule always applies; a `focus`
 * rule applies only while a site-only run is active (focus-mode.md §8.2).
 * @param {import("./types.js").FocusSiteRule} rule @param {boolean} runActive
 */
export function ruleApplies(rule, runActive) {
  if (!rule) return false;
  return rule.scope === "always" || (rule.scope === "focus" && !!runActive);
}

/**
 * The applicable rule whose canonical domain matches `host` (exact or subdomain),
 * given the current run state, or null. An `always` match wins over a not-yet-active
 * `focus` match for the same host, and never matches a lookalike suffix.
 * @param {import("./types.js").FocusSiteRule[]} rules @param {string} host
 * @param {boolean} runActive
 * @returns {import("./types.js").FocusSiteRule|null}
 */
export function matchingRule(rules, host, runActive) {
  if (!Array.isArray(rules) || !host) return null;
  const matches = rules.filter((r) => r && hostMatchesDomain(host, r.domain));
  // Prefer an applicable rule; among applicable, prefer `always` (guarded regardless of run).
  return matches.find((r) => r.scope === "always" && ruleApplies(r, runActive)) ??
    matches.find((r) => ruleApplies(r, runActive)) ?? null;
}

/** During Focus / All the time counts, for popup + guard copy. */
export function siteRuleCounts(rules) {
  const list = Array.isArray(rules) ? rules : [];
  return {
    during: list.filter((r) => r?.scope === "focus").length,
    always: list.filter((r) => r?.scope === "always").length
  };
}

/** Validate a requested access duration is one of the four allowed minute values. */
export function isValidGrantMinutes(m) {
  return GRANT_MINUTES.includes(Number(m));
}

/**
 * Is temporary access unlocked yet? Immediate style: always. Pause style: only once
 * ACCESS_PAUSE_MS has elapsed since `blockedAt` (a reload cannot restart it because
 * `blockedAt` is persisted, focus-mode.md §8.3).
 * @param {number} blockedAt @param {number} now @param {("immediate"|"pause")} style
 */
export function accessUnlocked(blockedAt, now, style) {
  if (style !== "pause") return true;
  return Number(now) - Number(blockedAt) >= ACCESS_PAUSE_MS;
}

/** Remaining pause ms (0 when immediate or already elapsed). */
export function pauseRemainingMs(blockedAt, now, style) {
  if (style !== "pause") return 0;
  return Math.max(0, ACCESS_PAUSE_MS - (Number(now) - Number(blockedAt)));
}

/**
 * Whole minutes an access window has been open, cumulative across extensions
 * (the coordinator preserves `accessStartedAt`). Never below 1 (focus-mode.md §5.3).
 */
export function elapsedAccessMinutes(accessStartedAt, now) {
  const ms = Number(now) - Number(accessStartedAt);
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.round(ms / 60000));
}

/**
 * UI-safe site-only Focus status from device-local `focusGuardState` + rules. Pure:
 * the coordinator passes the stored state and current rules. An overdue timed run reads
 * as inactive (the alarm/end pass will clear it). `guardedCount` is what is guarded
 * right now: every rule while a run is active, else only the All the time rules.
 * @param {{startedAt:number, endsAt:number|null}|null} guardState
 * @param {import("./types.js").FocusSiteRule[]} rules @param {number} now
 */
export function siteFocusStatus(guardState, rules, now) {
  const { during, always } = siteRuleCounts(rules);
  const endsAt = guardState?.endsAt ?? null;
  const overdue = !!guardState && endsAt != null && endsAt <= Number(now);
  const active = !!guardState && !overdue;
  return {
    active,
    endsAt: active ? endsAt : null,
    duringCount: during,
    alwaysCount: always,
    guardedCount: active ? during + always : always
  };
}

/**
 * @typedef {Object} GuardContext trusted data the background hands the guard page.
 * @property {("initial"|"expired"|"ended"|"unblocked"|"allowed"|"missing")} kind
 * @property {string} [displayDomain]
 * @property {("focus"|"always")} [ruleScope]
 * @property {boolean} [runActive]
 * @property {number} [accessStartedAt] for an expired guard (elapsed copy)
 */
