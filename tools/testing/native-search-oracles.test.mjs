// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { expectedSearchRows, assertSearchResults, domRowsMatch, assertPhaseCache, observeFrame, assertWarmCadence } from "../../extension/test/native-search-oracles.mjs";
const primary = expectedSearchRows();
const complete = expectedSearchRows(false, true);
assertSearchResults(primary, primary);
assertSearchResults(complete, complete);
for (const rows of [[], [...complete].reverse(), [complete[0], complete[0]], expectedSearchRows(true, true),
  complete.map(row => ({ ...row, url: "wrong" })), complete.map(row => ({ ...row, type: "open" }))]) {
  assert.throws(() => assertSearchResults(rows, complete));
}
const dom = complete.map(({ title, type }) => ({ title, type, role: "option" }));
assert(domRowsMatch(dom, complete));
assert(!domRowsMatch(dom.slice(0, 1), complete));
assert(!domRowsMatch(dom.map(row => ({ ...row, role: "button" })), complete));
assert(!domRowsMatch(dom, expectedSearchRows(true, true)));
console.log("PASS Search oracle rejects stale, duplicated, reordered, wrong-source and wrong-URL results");

const primaryBuild = { label: "primarySnapshotBuild" };
const inboxRead = { label: "libraryFamilyRead", family: "inbox" };
const sessionRead = { label: "libraryFamilyRead", family: "sessions" };
for (const phase of ["first", "after-edit"]) {
  assertPhaseCache(phase, [primaryBuild, inboxRead, sessionRead]);
  for (const calls of [[inboxRead, sessionRead], [primaryBuild, sessionRead],
    [primaryBuild, inboxRead], [primaryBuild, primaryBuild, inboxRead, sessionRead]]) {
    assert.throws(() => assertPhaseCache(phase, calls));
  }
}
assertPhaseCache("warm-immediate", []);
for (const call of [primaryBuild, inboxRead, sessionRead]) {
  assert.throws(() => assertPhaseCache("warm-immediate", [call]));
}
assertPhaseCache("warm-expired", [sessionRead]);
assert.throws(() => assertPhaseCache("warm-expired", []));
assert.throws(() => assertPhaseCache("warm-expired", [sessionRead, primaryBuild]));
assert.throws(() => assertPhaseCache("warm-expired", [sessionRead, inboxRead]));
assert.throws(() => assertPhaseCache("unknown", []));
console.log("PASS primary snapshot, Store map and completion expiry phase oracles");

function frameFixture() {
  let frameCallback, timerCallback;
  const cancelled = [], stopped = [];
  return {
    cancelled, stopped,
    fireFrame: () => frameCallback(), fireTimer: () => timerCallback(),
    options: {
      request: callback => { frameCallback = callback; return 7; },
      cancel: handle => cancelled.push(handle),
      startTimer: callback => { timerCallback = callback; return 8; },
      stopTimer: handle => stopped.push(handle)
    }
  };
}
const normal = frameFixture();
const observed = observeFrame(() => 42, normal.options);
normal.fireFrame();
assert.equal(await observed, 42);
assert.deepEqual(normal.stopped, [8]);
const stalled = frameFixture();
const missing = observeFrame(() => 0, stalled.options);
stalled.fireTimer();
await assert.rejects(missing, { code: "frame-timeout" });
assert.deepEqual(stalled.cancelled, [7]);
const throws = frameFixture();
const badRead = observeFrame(() => { throw new Error("read failed"); }, throws.options);
throws.fireFrame();
await assert.rejects(badRead, /read failed/);
assert.deepEqual(throws.stopped, [8]);
console.log("PASS rendering opportunity completion, stalled-frame rejection and observer errors");

assertWarmCadence("warm-immediate", 80);
assertWarmCadence("warm-expired", 1_100);
for (const value of [null, -1, 1_000, 2_000, NaN]) {
  assert.throws(() => assertWarmCadence("warm-immediate", value), { code: "warm-cadence" });
}
for (const value of [null, -1, 999, NaN]) {
  assert.throws(() => assertWarmCadence("warm-expired", value), { code: "warm-cadence" });
}
console.log("PASS delayed frame scheduling cannot masquerade as immediate warm cache behavior");
