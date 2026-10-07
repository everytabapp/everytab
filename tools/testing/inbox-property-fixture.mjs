// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Exact invariants for the isolated static Inbox property-rule comparison. */
import assert from "node:assert/strict";

const STYLESHEETS = ["tokens", "primitives", "dashboard", "onboarding", "new-tab-choices",
  "settings-schemes", "tablist-d4", "interface-style"].map(name => `css/${name}.css`);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

/** Shared script-free layout and selection contract for both comparisons. */
function validateCommonState(state, { count, removed } = {}) {
  assert.ok([250, 1000].includes(count) && typeof removed === "boolean", "Property fixture scenario is invalid");
  assert.ok(record(state), "Property fixture state is missing");
  const keys = Array.from({ length: count }, (_, index) => `inbox-fixture-${String(index).padStart(4, "0")}::0`);
  assert.deepEqual(state.rowKeys, keys, "Property fixture rows must preserve exact ordered identities");
  for (const field of ["selectedKeys", "checkedKeys"]) {
    assert.deepEqual(state[field], [keys[0], keys.at(-1)], "Property fixture selection must match the exact endpoints");
  }
  assert.equal(typeof state.focusVisible, "boolean", "Property fixture focus-visible observation is required");
  assert.equal(state.documentVisible, true, "Property fixture document must be visible");
  assert.equal(state.focused, true, "Property fixture document must be focused");
  assert.equal(state.focusLayoutValue, "0px", "Property fixture focus layout value must remain explicitly collapsed");
  for (const field of ["scriptCount", "inlineHandlerCount", "scriptResources"]) {
    assert.equal(state[field], 0, "Property fixture must not contain or load scripts");
  }
  assert.deepEqual(state.stylesheetPaths, STYLESHEETS, "Property fixture stylesheet order must remain exact");
  assert.equal(state.propertyRules, removed ? 0 : 1, "Property fixture must contain the expected property rule count");
  assert.ok(integer(state.elements) && state.elements > 0, "Property fixture element count must be positive");
  assert.ok(integer(state.focusStripCount), "Property fixture focus strip count is invalid");
  assert.ok(Array.isArray(state.geometry) && state.geometry.length === 8 + 4 * count + 4 * state.focusStripCount &&
    state.geometry.every(Number.isFinite), "Property fixture geometry must have exact shape and finite coordinates");
  assert.ok(state.geometry[0] > 0 && state.geometry[1] > 0, "Property fixture viewport must have positive dimensions");
  for (let offset = 4; offset < state.geometry.length; offset += 4) {
    const focusStrip = offset >= 8 + 4 * count;
    assert.ok(focusStrip
      ? state.geometry[offset + 2] >= 0 && state.geometry[offset + 3] >= 0
      : state.geometry[offset + 2] > 0 && state.geometry[offset + 3] > 0,
    "Property fixture body and rows must have positive dimensions; focus strips may collapse");
  }
  return true;
}

/** Validate a single script-free document's observed Inbox property state. */
export function validateInboxPropertyState(state, options) {
  validateCommonState(state, options);
  assert.equal(state.focusedKey, state.rowKeys.at(-1), "Property fixture focus must remain on the last row");
  return true;
}

/** Only removal of the property rule may differ; no geometry tolerance is used. */
export function validateInboxPropertyPair(control, removed, count) {
  validateInboxPropertyState(control, { count, removed: false });
  validateInboxPropertyState(removed, { count, removed: true });
  const { propertyRules: controlRules, ...controlState } = control;
  const { propertyRules: removedRules, ...removedState } = removed;
  assert.deepEqual(removedState, controlState, "Property fixture pair must differ only in property rule count");
  return true;
}

/** Focus treatment retains the registered property, selection and pointer hover. */
export function validateInboxFocusState(state, { count, blurred } = {}) {
  assert.equal(typeof blurred, "boolean", "Focus fixture treatment must be explicit");
  validateCommonState(state, { count, removed: false });
  assert.equal(state.focusedKey, blurred ? null : state.rowKeys.at(-1), "Focus fixture row focus does not match treatment");
  assert.equal(state.focusedRowCount, blurred ? 0 : 1, "Focus fixture focused row count does not match treatment");
  assert.equal(state.focusedCheckbox, !blurred, "Focus fixture checkbox focus does not match treatment");
  if (blurred) assert.equal(state.focusVisible, false, "Blurred fixture must not retain visible focus");
  assert.deepEqual(state.hoveredRowKeys, [state.rowKeys.at(-1)], "Focus fixture hover must remain on the last row");
  assert.equal(state.svgUseCount, 0, "Focus fixture must not contain SVG use elements");
  return true;
}

/** Only the four measured row-focus observations may differ between variants. */
export function validateInboxFocusPair(focused, blurred, count) {
  validateInboxFocusState(focused, { count, blurred: false });
  validateInboxFocusState(blurred, { count, blurred: true });
  const { focusedKey: focusedKeyBefore, focusVisible: visibleBefore, focusedRowCount: countBefore,
    focusedCheckbox: checkboxBefore, ...before } = focused;
  const { focusedKey: focusedKeyAfter, focusVisible: visibleAfter, focusedRowCount: countAfter,
    focusedCheckbox: checkboxAfter, ...after } = blurred;
  assert.deepEqual(after, before, "Focus fixture pair must differ only in row focus observations");
  return true;
}

/** Command is the only treatment; every measured outgoing field must match. */
export function validateInboxCommandPair(navigate, reload, count) {
  validateInboxFocusState(navigate, { count, blurred: false });
  validateInboxFocusState(reload, { count, blurred: false });
  assert.deepEqual(reload, navigate, "Command fixture pair must have identical outgoing state");
  return true;
}

/** Both arms reduce motion; only the browser's source for that setting differs. */
export function validateInboxMediaPair(emulated, native, count) {
  validateInboxCommandPair(emulated, native, count);
  assert.equal(emulated.reducedMotion, true, "Media comparison requires reduced motion in both arms");
  return true;
}

/** Validate observations, not an assumed mapping from CDP command to type. */
export function validateInboxCommandDestination(state) {
  assert.ok(record(state) && state.sameUrl === true && state.entryCount === 1 &&
    ["navigate", "reload"].includes(state.type), "Command destination must have one known navigation entry at the canonical URL");
  return true;
}

/** Split already-clipped trace costs at the unique completed-preparation mark. */
export function summarizeInboxFocusPhases(departure) {
  assert.ok(record(departure) && Number.isFinite(departure.intervalMs) && departure.intervalMs > 0 &&
    Array.isArray(departure.events), "Focus phase trace is invalid");
  const interval = departure.intervalMs;
  const rounding = Number.EPSILON * Math.max(1, interval) * 4;
  for (const event of departure.events) {
    assert.ok(record(event) && typeof event.name === "string" && event.name.length > 0 &&
      Number.isFinite(event.atMs) && event.atMs >= 0 && event.atMs <= interval &&
      Number.isFinite(event.durationMs) && event.durationMs >= 0 &&
      Number.isFinite(event.atMs + event.durationMs) && event.atMs + event.durationMs <= interval + rounding,
    "Focus phase event must have valid clipped timing");
  }
  const markers = departure.events.filter(event => event.name === "inbox:focus-prepared");
  assert.ok(markers.length === 1 && markers[0].durationMs === 0 && markers[0].atMs < interval,
    "Focus phase trace requires one instant preparation marker inside the interval");
  const preparationMs = markers[0].atMs;
  let styleBeforeMs = 0, styleAfterMs = 0;
  for (const event of departure.events) {
    if (event.name !== "UpdateLayoutTree") continue;
    const end = Math.min(interval, event.atMs + event.durationMs);
    styleBeforeMs += Math.max(0, Math.min(end, preparationMs) - event.atMs);
    styleAfterMs += Math.max(0, end - Math.max(event.atMs, preparationMs));
  }
  assert.ok(Number.isFinite(styleBeforeMs) && Number.isFinite(styleAfterMs), "Focus phase style total is invalid");
  return { preparationMs, navigationMs: interval - preparationMs, styleBeforeMs, styleAfterMs };
}
