// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Localized Focus presentation boundary.
 *
 * The Focus domain module owns rules, clocks, and trusted state. This module is
 * the single place where those decisions become user-facing copy, keeping
 * Chrome messages and locale formatting out of stored data and coordinators.
 */
import { formatNumber, msg } from "./i18n.js";
import { elapsedAccessMinutes, siteRuleCounts } from "./focus.js";

/** Compact remaining time for the shared Focus surfaces. */
export function formatRemaining(endsAt, now) {
  const ms = Number(endsAt) - Number(now);
  if (!Number.isFinite(ms) || ms <= 0) return msg("focus_duration_less_than_minute");
  const totalMin = Math.round(ms / 60000);
  if (totalMin <= 0) return msg("focus_duration_less_than_minute");
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours === 0) return msg("focus_duration_minutes_short", [formatNumber(minutes)]);
  if (minutes === 0) return msg("focus_duration_hours_short", [formatNumber(hours)]);
  return msg("focus_duration_hours_minutes_short", [formatNumber(hours), formatNumber(minutes)]);
}

/** Complete inactive Focus summary for every rule-scope combination. */
export function blockedSitesSummary(rules) {
  const { during, always } = siteRuleCounts(rules);
  if (during > 0 && always > 0) {
    return msg("focus_blocked_sites_both", [formatNumber(during), formatNumber(always)]);
  }
  if (during > 0) return msg("focus_blocked_sites_during", [formatNumber(during)]);
  if (always > 0) return msg("focus_blocked_sites_always", [formatNumber(always)]);
  return msg("focus_blocked_sites_none");
}

/** Visual pause copy. Zero means the normal unlocked label should be restored. */
export function pauseCountdownText(ms) {
  const seconds = Math.max(0, Math.ceil(Number(ms) / 1000));
  if (seconds === 0) return "";
  return seconds === 1
    ? msg("focus_pause_continue_one")
    : msg("focus_pause_continue_other", [formatNumber(seconds)]);
}

/** Locale-aware long minute duration. */
export function minutesLabel(value) {
  const minutes = Number(value);
  return minutes === 1
    ? msg("time_minute_one")
    : msg("time_minutes_other", [formatNumber(minutes)]);
}

/** What the popup Start-duration control should show and send. */
export function focusPopupDurationInfo(settings) {
  const minutes = Number(settings?.focusDefaultDurationMinutes) || 60;
  const isDuration = settings?.focusDefaultEndMode === "duration";
  const customDefault = isDuration && minutes !== 60;
  return {
    minutes,
    isDuration,
    customDefault,
    label: minutes === 60 ? msg("time_hour_one") : minutesLabel(minutes)
  };
}

/**
 * Turn one trusted guard context into complete localized messages and semantic
 * action codes. User domains remain substitutions and are never interpreted.
 */
export function guardView(ctx, now) {
  switch (ctx?.kind) {
    case "initial":
      if (ctx.runActive && ctx.ruleScope === "focus") {
        return {
          heading: msg("focus_guard_heading_on"),
          line: msg("focus_guard_line_on_list", [ctx.displayDomain]),
          primary: msg("focus_guard_action_back_to_focus"),
          primaryAction: "close-without-saving",
          showAccess: true,
          showReturn: false
        };
      }
      return {
        heading: msg("focus_guard_heading_blocked", [ctx.displayDomain]),
        line: msg("focus_guard_line_blocked"),
        primary: msg("focus_guard_action_go_back"),
        primaryAction: "safe-return",
        showAccess: true,
        showReturn: false
      };
    case "expired": {
      const duration = minutesLabel(elapsedAccessMinutes(ctx.accessStartedAt, now));
      return {
        heading: ctx.runActive
          ? msg("focus_guard_heading_return")
          : msg("focus_guard_heading_access_ended"),
        line: msg("focus_guard_line_available", [ctx.displayDomain, duration]),
        primary: ctx.runActive
          ? msg("focus_guard_action_return")
          : msg("focus_guard_action_leave_site"),
        primaryAction: "return-flow",
        showAccess: true,
        showReturn: true
      };
    }
    case "ended":
      return {
        heading: msg("focus_guard_heading_ended"),
        line: msg("focus_guard_line_ended"),
        primary: msg("focus_guard_action_continue_site"),
        primaryAction: "continue-to-site",
        showAccess: false,
        showReturn: false
      };
    case "unblocked":
    case "allowed":
      return {
        heading: msg("focus_guard_heading_unblocked"),
        line: msg("focus_guard_line_keep_going"),
        primary: msg("focus_guard_action_continue_site"),
        primaryAction: "continue-to-site",
        showAccess: false,
        showReturn: false
      };
    default:
      return {
        heading: msg("focus_guard_heading_missing"),
        line: msg("focus_guard_line_missing"),
        primary: msg("focus_guard_action_open_everytab"),
        primaryAction: "dashboard",
        showAccess: false,
        showReturn: false
      };
  }
}
