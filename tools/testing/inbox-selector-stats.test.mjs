// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { createInboxSelectorStats } from "./inbox-selector-stats.mjs";

const allowlist = [{ file: "css/rows.css", selector: ".item > .row" },
  { file: "css/base.css", selector: ".item > .row" }, { file: "css/base.css", selector: ".a, :is(.b, .c)" }];
const marker = (name, ts, extra = {}) => ({ name, ts, pid: 1, tid: 2, ph: "R", ...extra });
const layout = (ts = 1500, dur = 200, extra = {}) => ({ name: "UpdateLayoutTree", ts, dur, pid: 1, tid: 2, ph: "X", ...extra });
const row = (selector = ".item > .row", extra = {}) => ({ selector, style_sheet_id: "private-sheet-id", "elapsed (us)": 12.5,
  match_attempts: 10, fast_reject_count: 4, match_count: 3, ...extra });
const stats = (ts = 1700, rows = [row()], extra = {}) => ({ name: "SelectorStats", ts, dur: 0, pid: 1, tid: 2, ph: "X",
  args: { selector_stats: { selector_timings: rows }, private: "private-args" }, ...extra });
function collect(events, selectors = allowlist) {
  const collector = createInboxSelectorStats({ selectors });
  collector.accept([marker("inbox:departure", 1000), ...events, marker("inbox:injected", 5000)]);
  return collector;
}

test("paired complete passes aggregate exact allowlisted selectors and files with deterministic fresh output", () => {
  const collector = collect([layout(), stats(1700, [row()]), layout(2500), stats(2700),
    layout(3500), stats(3700, [row(".a, :is(.b, .c)", { "elapsed (us)": 1 })])]);
  const result = collector.read();
  assert.equal(result.intervalMs, 4);
  assert.equal(result.observedStatsEvents, 3); assert.equal(result.includedStatsEvents, 3);
  assert.deepEqual(result.selectors, [
    { selector: ".item > .row", files: ["css/base.css", "css/rows.css"], elapsedUs: 25, matchAttempts: 20,
      fastRejectCount: 8, matchCount: 6, samples: 2 },
    { selector: ".a, :is(.b, .c)", files: ["css/base.css"], elapsedUs: 1, matchAttempts: 10,
      fastRejectCount: 4, matchCount: 3, samples: 1 }
  ]);
  assert.ok(Object.values(result.excluded).every(value => value === 0));
  result.selectors[0].files.push("changed"); result.selectors[0].elapsedUs = 999;
  assert.equal(collector.read().selectors[0].elapsedUs, 25);
  assert.equal(collector.read().selectors[0].files.length, 2);
});

test("quoted and escaped selector whitespace must match the exact CSSOM allowlist", () => {
  const quoted = '[data-label="a b"]', escaped = String.raw`.escaped\ name`;
  const selectors = [{ file: "css/base.css", selector: quoted }, { file: "css/base.css", selector: escaped }];
  const result = collect([layout(), stats(1700, [row(quoted), row(escaped),
    row('[data-label="a  b"]'), row(String.raw`.escaped\  name`)])], selectors).read();
  assert.equal(result.excluded.unknownSelectorRows, 2,
    "internal whitespace changes in quoted values and escapes must not alias allowed selectors");
  assert.equal(result.excluded.unknownElapsedUs, 25);
  assert.equal(result.selectors.length, 2);
  assert.ok(result.selectors.every(entry => entry.samples === 1 && entry.elapsedUs === 12.5));
  assert.deepEqual(result.selectors.map(entry => entry.selector).sort(), [quoted, escaped].sort());
});

test("unmatched selectors, grouped-rule fragments, IDs and raw event metadata never survive", () => {
  const original = row();
  const collector = collect([layout(), stats(1700, [original, row("private-user-selector"), row(".a"), row(".item")])]);
  original.selector = "private-mutated"; original["elapsed (us)"] = 900;
  const result = collector.read();
  assert.equal(result.selectors.length, 1); assert.equal(result.selectors[0].elapsedUs, 12.5);
  assert.equal(result.excluded.unknownSelectorRows, 3); assert.equal(result.excluded.unknownElapsedUs, 37.5);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("style_sheet_id"), false);
});

test("pairing uses the style pass rather than dump duration and excludes crossings and other threads", () => {
  const result = collect([layout(500, 1000), stats(1500), layout(2000, 500), stats(2500, [row()], { dur: 9000 }),
    layout(4500, 1000), stats(5500), layout(1600, 100, { tid: 9 }), stats(1700, [row()], { tid: 9 })]).read();
  assert.equal(result.includedStatsEvents, 1);
  assert.equal(result.selectors[0].elapsedUs, 12.5, "dump overhead is not prorated into matching totals");
  assert.equal(result.excluded.outsideIntervalEvents, 2);
  assert.equal(result.excluded.wrongThreadEvents, 1);
});

test("missing or ambiguous pass pairing cannot duplicate totals", () => {
  assert.equal(collect([stats()]).read().excluded.unpairedStatsEvents, 1);
  const duplicate = collect([layout(), stats(), stats(1800)]).read();
  assert.equal(duplicate.excluded.ambiguousStatsEvents, 2); assert.deepEqual(duplicate.selectors, []);
  const sameEnd = collect([layout(), layout(1600, 100), stats()]).read();
  assert.equal(sameEnd.excluded.ambiguousStatsEvents, 1);
  const active = collect([layout(), layout(1750, 1000), stats(1800)]).read();
  assert.equal(active.excluded.ambiguousStatsEvents, 1);
});

test("marker identity, uniqueness and ordering are required regardless of delivery order", () => {
  for (const pair of [[], [marker("inbox:departure", 1000)],
    [marker("inbox:departure", 1000), marker("inbox:injected", 5000, { tid: 3 })],
    [marker("inbox:departure", 1000), marker("inbox:injected", 500)],
    [marker("inbox:departure", 1000), marker("inbox:injected", 5000), marker("inbox:injected", 5000)]]) {
    const collector = createInboxSelectorStats({ selectors: allowlist }); collector.accept(pair);
    assert.throws(() => collector.read(), /ordered marker pair/);
  }
  const collector = createInboxSelectorStats({ selectors: allowlist });
  collector.accept([marker("inbox:injected", 5000), stats()]);
  collector.accept([layout(), marker("inbox:departure", 1000)]);
  assert.equal(collector.read().includedStatsEvents, 1);
});

test("malformed numeric rows and schemas are counted without retaining payloads", () => {
  const bad = [];
  for (const value of [undefined, null, NaN, Infinity, -1, "private"]) {
    for (const field of ["elapsed (us)", "match_attempts", "fast_reject_count", "match_count"]) bad.push(row(undefined, { [field]: value }));
  }
  bad.push(row(""), row(" "), row(undefined, { match_count: 0.5 }));
  const result = collect([layout(), stats(1700, [...bad, row(undefined, { invalidation_count: "ignored-private" })]),
    stats(1800, [], { ph: "B" }), stats(1900, [], { args: {} })]).read();
  assert.equal(result.excluded.invalidRows, bad.length);
  assert.equal(result.excluded.invalidEvents, 2);
  assert.equal(result.selectors[0].samples, 1);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("unsafe allowlist paths, empty selectors and capacity or sum overflow fail safely", () => {
  for (const file of ["../private.css", "css/../private.css", "css//private.css", "https://private/css/a.css", "js/a.js"]) {
    assert.throws(() => createInboxSelectorStats({ selectors: [{ file, selector: ".row" }] }), /allowlist entry is invalid/);
  }
  for (const selector of ["", " ", null, "x".repeat(8193), "a\u0000b"]) {
    assert.throws(() => createInboxSelectorStats({ selectors: [{ file: "css/a.css", selector }] }), /allowlist entry is invalid/);
  }
  assert.throws(() => createInboxSelectorStats({ selectors: [] }), /bounded static/);
  const collector = createInboxSelectorStats({ selectors: allowlist });
  assert.throws(() => collector.accept(Array(100001)), /batch is invalid/);
  assert.throws(() => collect([layout(), stats(1700, [row(undefined, { match_count: Number.MAX_SAFE_INTEGER }), row()])]).read(), /total is invalid/);
});
