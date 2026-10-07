// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * N3 — one shared horizontal-slider component for the two threshold settings
 * (Suspend after · Auto-dump after), used by both the main Settings form and the
 * popup's quick settings. The slider always runs over an array of discrete stops
 * (index-based), so native arrow keys move exactly one stop and the non-linear
 * longer durations work the same way as short suspension intervals.
 *
 * The stop tables + the pure value→settings-patch mappings live here too, so the
 * off-semantics and the minute↔stop round-trip are unit-testable without a DOM.
 */
import { el } from "./dom.js";

/** Five-minute suspension steps up to 2h, then the longer first-run choices. */
export const SUSPEND_STOPS = [...Array.from({ length: 25 }, (_, i) => i * 5), 240, 720];

/** Auto-dump stops: [minutes, human label]. 0 = Off; non-linear up to 31 days. */
export const AUTO_DUMP_STOPS = [
  [0, "Off"],
  [60, "1 hour"],
  [360, "6 hours"],
  [720, "12 hours"],
  [1440, "1 day"],
  [2880, "2 days"],
  [4320, "3 days"],
  [7200, "5 days"],
  [10080, "7 days"],
  [14400, "10 days"],
  [20160, "14 days"],
  [30240, "21 days"],
  [43200, "30 days"],
  [44640, "31 days"]
];

export const AUTO_DUMP_MINUTES = AUTO_DUMP_STOPS.map(([m]) => m);

/** Human label for a suspend value (minutes). */
export function suspendLabel(min) {
  return min > 0 ? `${min} min` : "Off";
}

/** Human label for an auto-dump value (minutes) — the exact stop label, else a fallback. */
export function autoDumpLabel(min) {
  const hit = AUTO_DUMP_STOPS.find(([m]) => m === min);
  return hit ? hit[1] : (min > 0 ? `${min} min` : "Off");
}

/** Index of the stop nearest to `value` (for showing an arbitrary stored value). */
export function nearestIndex(stops, value) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const d = Math.abs(stops[i] - value);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Pure: suspend slider value (minutes) → settings patch. 0 ⇒ disabled. */
export function suspendPatch(min) {
  return min > 0
    ? { suspendEnabled: true, suspendAfterMinutes: min }
    : { suspendEnabled: false };
}

/** Pure: auto-dump slider value (minutes) → settings patch. 0 ⇒ disabled.
 *  Keeps `autoArchiveDays` written (rounded up, ≥1) for back-compat. */
export function autoDumpPatch(min) {
  return min > 0
    ? { autoArchiveEnabled: true, autoDumpAfterMinutes: min, autoArchiveDays: Math.max(1, Math.ceil(min / 1440)) }
    : { autoArchiveEnabled: false };
}

/**
 * Build a themed range slider over `stops`.
 * @param {{
 *   stops: number[], value: number, format: (v:number)=>string,
 *   onChange: (v:number)=>void, ariaLabel: string, ticks?: string[]
 * }} opts
 * @returns {{node: HTMLElement, set: (v:number)=>void}}
 */
export function createSlider({ stops, value, format, onChange, ariaLabel, ticks = [] }) {
  const input = el("input", {
    type: "range", class: "slider-range",
    min: "0", max: String(stops.length - 1), step: "1",
    "aria-label": ariaLabel
  });
  const valueLabel = el("span", { class: "slider-value" });

  const paint = (i) => {
    input.value = String(i);
    const label = format(stops[i]);
    input.setAttribute("aria-valuetext", label);
    valueLabel.textContent = label;
  };
  paint(nearestIndex(stops, value));

  input.addEventListener("input", () => {
    const i = Number(input.value);
    const label = format(stops[i]);
    input.setAttribute("aria-valuetext", label);
    valueLabel.textContent = label;
    onChange(stops[i]);
  });

  const node = el(
    "div",
    { class: "slider" },
    el("div", { class: "slider-row" }, input, valueLabel),
    ticks.length
      ? el("div", { class: "slider-ticks" }, ...ticks.map((t) => el("span", {}, t)))
      : null
  );
  return { node, set: (v) => paint(nearestIndex(stops, v)) };
}
