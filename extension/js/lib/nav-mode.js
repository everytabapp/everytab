// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * D4-3a — the Dashboard shell's navigation mode.
 *
 * One pure decision shared by every caller: the remembered wide-layout
 * preference (`Settings.uiSidebarCollapsed`) plus the two measured viewport
 * boundaries resolve to exactly one of three presentations. There is only ever
 * ONE navigation model in the DOM; the mode changes how it is presented.
 *
 * DOM-free and chrome-free on purpose, so the resolution is directly testable
 * and `js/boot.js` (a classic pre-paint script that cannot import modules) can
 * mirror the same two numbers without a second rule set.
 *
 * Breakpoints were validated against real Dashboard content at normal and 200%
 * browser zoom, not chosen by convention:
 *
 * - at or below 900px the labelled 204px sidebar plus the 880px content column
 *   no longer both fit, so navigation drops to the icon rail;
 * - at or below 620px even a 60px rail beside the list squeezes the content
 *   column past usefulness, so navigation moves to the anchored header
 *   switcher and the content column takes the full width.
 *
 * 200% zoom halves the CSS-pixel viewport, so a 1280px window at 200% reports
 * 640px and lands in the header state by the same rule. No zoom-specific
 * branch exists or is needed.
 */

/** Icon rail at or below this viewport width (CSS px). */
export const NAV_COMPACT_MAX = 900;
/** Anchored header switcher at or below this viewport width (CSS px). */
export const NAV_HEADER_MAX = 620;

/** @typedef {("expanded"|"rail"|"header")} NavMode */

/**
 * @param {boolean} collapsed the user's remembered wide-layout choice
 * @param {boolean} compact viewport is at or below NAV_COMPACT_MAX
 * @param {boolean} header viewport is at or below NAV_HEADER_MAX
 * @returns {NavMode}
 */
export function resolveNavMode(collapsed, compact, header) {
  if (header) return "header";
  if (compact || collapsed === true) return "rail";
  return "expanded";
}
