// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { validateInboxPropertyState, validateInboxPropertyPair } from "./inbox-property-fixture.mjs";
import * as focusApi from "./inbox-property-fixture.mjs";

function fixture(count = 250, removed = false, focusStripCount = 1) {
  const rowKeys = Array.from({ length: count }, (_, index) => `inbox-fixture-${String(index).padStart(4, "0")}::0`);
  return { rowKeys, selectedKeys: [rowKeys[0], rowKeys.at(-1)], checkedKeys: [rowKeys[0], rowKeys.at(-1)],
    focusedKey: rowKeys.at(-1), focusVisible: true, documentVisible: true, focused: true, focusLayoutValue: "0px",
    scriptCount: 0, inlineHandlerCount: 0, scriptResources: 0,
    stylesheetPaths: ["css/tokens.css", "css/primitives.css", "css/dashboard.css", "css/onboarding.css",
      "css/new-tab-choices.css", "css/settings-schemes.css", "css/tablist-d4.css", "css/interface-style.css"],
    propertyRules: removed ? 0 : 1, elements: count * 12 + 100, focusStripCount,
    geometry: [1280, 800, 0, 42, 0, -42, 1280, count * 32,
      ...rowKeys.flatMap((_, index) => [20, index * 32 - 42, 1100, 32]),
      ...Array.from({ length: focusStripCount }, () => [10, 0, 1000, 44]).flat()] };
}
function rejects(change, count = 250) {
  const state = fixture(count); change(state);
  assert.throws(() => validateInboxPropertyState(state, { count, removed: false }), assert.AssertionError);
}

test("both fixture sizes accept exact control/removal pairs with zero or multiple focus strips", () => {
  for (const count of [250, 1000]) for (const strips of [0, 1, 3]) {
    const control = fixture(count, false, strips), removed = fixture(count, true, strips);
    assert.equal(validateInboxPropertyState(control, { count, removed: false }), true);
    assert.equal(validateInboxPropertyPair(control, removed, count), true);
    control.focusVisible = removed.focusVisible = false;
    assert.equal(validateInboxPropertyPair(control, removed, count), true, "observed focus-visible boolean is preserved rather than forced");
  }
});

test("unsupported scenarios, missing state and invalid structural counts reject", () => {
  for (const count of [0, 249, 251, 1001, "250", null, NaN]) {
    assert.throws(() => validateInboxPropertyState(fixture(), { count, removed: false }), assert.AssertionError);
  }
  for (const removed of [undefined, null, 0, "false"]) {
    assert.throws(() => validateInboxPropertyState(fixture(), { count: 250, removed }), assert.AssertionError);
  }
  assert.throws(() => validateInboxPropertyState(null, { count: 250, removed: false }), assert.AssertionError);
  for (const value of [0, -1, 0.5, Infinity, "3100"]) rejects(state => { state.elements = value; });
  for (const value of [-1, 0.5, Infinity, "1", undefined]) rejects(state => { state.focusStripCount = value; });
});

test("row identity, ordering and independently measured selection must remain exact", () => {
  rejects(state => state.rowKeys.reverse());
  rejects(state => { state.rowKeys[4] = state.rowKeys[3]; });
  rejects(state => state.rowKeys.pop());
  for (const field of ["selectedKeys", "checkedKeys"]) {
    rejects(state => state[field].reverse());
    rejects(state => { state[field] = [state.rowKeys[0], state.rowKeys[2]]; });
    rejects(state => state[field].push(state.rowKeys[2]));
    rejects(state => { delete state[field]; });
  }
});

test("focus, visibility, script absence, stylesheet order and rule count are enforced", () => {
  rejects(state => { state.focusedKey = state.rowKeys[0]; });
  rejects(state => { delete state.focusedKey; });
  rejects(state => { state.focusVisible = "true"; });
  for (const field of ["documentVisible", "focused"]) rejects(state => { state[field] = false; });
  for (const value of [undefined, null, "", "16px", 0]) rejects(state => { state.focusLayoutValue = value; });
  for (const field of ["scriptCount", "inlineHandlerCount", "scriptResources"]) {
    rejects(state => { state[field] = 1; }); rejects(state => { delete state[field]; });
  }
  rejects(state => state.stylesheetPaths.reverse());
  rejects(state => state.stylesheetPaths.push("css/extra.css"));
  rejects(state => { state.stylesheetPaths[0] = "css/other.css"; });
  rejects(state => { state.propertyRules = 0; });
  assert.throws(() => validateInboxPropertyState(fixture(), { count: 250, removed: true }), assert.AssertionError);
});

test("geometry rejects nonfinite coordinates, incorrect shape and nonpositive dimensions", () => {
  for (const value of [NaN, Infinity, -Infinity, "20", null]) rejects(state => { state.geometry[2] = value; });
  rejects(state => state.geometry.pop()); rejects(state => state.geometry.push(0));
  rejects(state => { state.geometry = null; });
  for (const offset of [0, 1, 6, 7, 10, 11]) {
    rejects(state => { state.geometry[offset] = 0; });
    rejects(state => { state.geometry[offset] = -1; });
  }
});

test("collapsed focus strips permit zero dimensions but reject negative dimensions", () => {
  const control = fixture(), removed = fixture(250, true);
  control.geometry[1011] = removed.geometry[1011] = 0;
  assert.equal(validateInboxPropertyPair(control, removed, 250), true);
  control.geometry[1010] = removed.geometry[1010] = 0;
  assert.equal(validateInboxPropertyPair(control, removed, 250), true);
  for (const offset of [1010, 1011]) rejects(state => { state.geometry[offset] = -1; });
});

test("pair equality rejects any state or geometry variation without compensation", () => {
  for (const change of [state => { state.elements++; }, state => { state.focusVisible = false; },
    state => { state.geometry[2]++; }, state => { state.geometry[4] += 0.001; },
    state => { state.geometry[8]++; state.geometry[12]--; },
    state => { state.extraObservation = true; }]) {
    const control = fixture(), removed = fixture(250, true); change(removed);
    assert.throws(() => validateInboxPropertyPair(control, removed, 250), assert.AssertionError);
  }
});

function focusFixture(count = 250, blurred = false) {
  const state = fixture(count);
  state.focusedKey = blurred ? null : state.rowKeys.at(-1);
  state.focusVisible = !blurred;
  state.focusedRowCount = blurred ? 0 : 1;
  state.focusedCheckbox = !blurred;
  state.hoveredRowKeys = [state.rowKeys.at(-1)];
  state.svgUseCount = 0;
  return state;
}

test("command comparison requires identical focused state, including geometry and CSS", () => {
  for (const count of [250, 1000]) {
    assert.equal(focusApi.validateInboxCommandPair(focusFixture(count), focusFixture(count), count), true);
  }
  for (const change of [state => { state.geometry[2]++; }, state => { state.focusVisible = !state.focusVisible; },
    state => { state.propertyRules = 0; }, state => { state.focusedCheckbox = false; },
    state => { state.extra = true; }, state => { state.hoveredRowKeys = []; }]) {
    const changed = focusFixture(); change(changed);
    assert.throws(() => focusApi.validateInboxCommandPair(focusFixture(), changed, 250), assert.AssertionError);
  }
});

test("media comparison preserves reduced motion and every outgoing field across override sources", () => {
  const state = { ...focusFixture(), reducedMotion: true };
  assert.equal(focusApi.validateInboxMediaPair(state, structuredClone(state), 250), true);
  for (const reducedMotion of [false, undefined, "true", null]) {
    assert.throws(() => focusApi.validateInboxMediaPair(state, { ...state, reducedMotion }, 250), assert.AssertionError);
    assert.throws(() => focusApi.validateInboxMediaPair({ ...state, reducedMotion }, state, 250), assert.AssertionError);
  }
  const changed = structuredClone(state); changed.geometry[2]++;
  assert.throws(() => focusApi.validateInboxMediaPair(state, changed, 250), assert.AssertionError);
});

test("command destination requires one allowed navigation entry and the exact canonical URL", () => {
  for (const type of ["navigate", "reload"]) {
    assert.equal(focusApi.validateInboxCommandDestination({ type, entryCount: 1, sameUrl: true }), true);
  }
  for (const state of [null, {}, { type: "reload", entryCount: 0, sameUrl: true },
    { type: "reload", entryCount: 2, sameUrl: true }, { type: "reload", entryCount: 1, sameUrl: false },
    { type: "back_forward", entryCount: 1, sameUrl: true }, { type: "private", entryCount: 1, sameUrl: true }]) {
    assert.throws(() => focusApi.validateInboxCommandDestination(state), assert.AssertionError);
  }
});

test("focus treatment changes only row focus while preserving all common state exactly", () => {
  for (const count of [250, 1000]) {
    const focused = focusFixture(count), blurred = focusFixture(count, true);
    assert.equal(focusApi.validateInboxFocusState(focused, { count, blurred: false }), true);
    assert.equal(focusApi.validateInboxFocusState(blurred, { count, blurred: true }), true);
    assert.equal(focusApi.validateInboxFocusPair(focused, blurred, count), true);
    focused.focusVisible = false;
    assert.equal(focusApi.validateInboxFocusPair(focused, blurred, count), true);
  }
});

test("focus oracle refuses missing treatment, accidental hover or SVG changes and weakened common checks", () => {
  assert.equal(typeof focusApi.validateInboxFocusState, "function");
  for (const change of [state => { state.focusedKey = state.rowKeys.at(-1); }, state => { state.focusedRowCount = 1; },
    state => { state.focusVisible = true; }, state => { state.focusedCheckbox = true; }, state => { state.hoveredRowKeys = []; },
    state => { state.hoveredRowKeys = [state.rowKeys[0]]; }, state => { state.svgUseCount = 1; },
    state => { state.propertyRules = 0; }, state => { state.focusLayoutValue = "16px"; },
    state => { state.checkedKeys = []; }, state => { state.scriptCount = 1; }]) {
    const state = focusFixture(250, true); change(state);
    assert.throws(() => focusApi.validateInboxFocusState(state, { count: 250, blurred: true }), assert.AssertionError);
  }
  for (const blurred of [undefined, null, 0, "true"]) {
    assert.throws(() => focusApi.validateInboxFocusState(focusFixture(), { count: 250, blurred }), assert.AssertionError);
  }
  for (const change of [state => { state.focusedKey = null; }, state => { state.focusedRowCount = 0; },
    state => { state.focusedCheckbox = false; }, state => { delete state.focusedCheckbox; }]) {
    const state = focusFixture(); change(state);
    assert.throws(() => focusApi.validateInboxFocusState(state, { count: 250, blurred: false }), assert.AssertionError);
  }
  for (const change of [state => { state.geometry[2] += 1; }, state => { state.elements++; }, state => { state.extra = true; }]) {
    const blurred = focusFixture(250, true); change(blurred);
    assert.throws(() => focusApi.validateInboxFocusPair(focusFixture(), blurred, 250), assert.AssertionError);
  }
});

const phase = (events, intervalMs = 10) => ({ intervalMs, events });
const prepared = (atMs = 4, durationMs = 0) => ({ name: "inbox:focus-prepared", atMs, durationMs });
const style = (atMs, durationMs) => ({ name: "UpdateLayoutTree", atMs, durationMs });
test("focus phases split crossing style passes, preserve boundary costs and ignore unrelated costs", () => {
  assert.deepEqual(focusApi.summarizeInboxFocusPhases(phase([style(0, 2), prepared(), style(3, 3), style(4, 1),
    style(7, 3), { name: "Layout", atMs: 0, durationMs: 10 }])),
  { preparationMs: 4, navigationMs: 6, styleBeforeMs: 3, styleAfterMs: 6 });
  assert.deepEqual(focusApi.summarizeInboxFocusPhases(phase([prepared(0), style(0, 10)])),
    { preparationMs: 0, navigationMs: 10, styleBeforeMs: 0, styleAfterMs: 10 });
  assert.deepEqual(focusApi.summarizeInboxFocusPhases(phase([style(0, 4), prepared(), style(4, 0)])),
    { preparationMs: 4, navigationMs: 6, styleBeforeMs: 4, styleAfterMs: 0 });
});

test("focus phase summary rejects missing, duplicate or invalid instant markers and unclipped events", () => {
  assert.equal(typeof focusApi.summarizeInboxFocusPhases, "function");
  for (const departure of [null, {}, phase([]), phase([prepared(), prepared()]), phase([prepared(10)]),
    phase([prepared(-1)]), phase([prepared(4, 1)]), phase([{ name: "inbox:focus-prepared", atMs: 4 }]),
    phase([prepared()], 0), phase([prepared()], NaN), phase([prepared()], Infinity),
    phase([prepared(), style(9, 2)]), phase([prepared(), style(-1, 2)])]) {
    assert.throws(() => focusApi.summarizeInboxFocusPhases(departure), assert.AssertionError);
  }
  for (const value of [undefined, null, NaN, Infinity, -1, "1"]) {
    for (const field of ["atMs", "durationMs"]) {
      assert.throws(() => focusApi.summarizeInboxFocusPhases(phase([prepared(), { ...style(1, 1), [field]: value }])), assert.AssertionError);
    }
  }
});
