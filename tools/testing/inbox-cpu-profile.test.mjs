// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { summarizeInboxCpuProfile } from "./inbox-cpu-profile.mjs";

const origin = `chrome-extension://${"a".repeat(32)}`;
const frame = (url = "", functionName = "private function name") =>
  ({ url, functionName, lineNumber: -1, columnNumber: -1 });
function profile() {
  return { startTime: 100_000, endTime: 120_000,
    nodes: [
      { id: 1, callFrame: frame("", "(root)"), children: [2, 3, 4, 5, 6] },
      { id: 2, callFrame: frame(`${origin}/js/z.js`), children: [7] },
      { id: 3, callFrame: frame(`${origin}/js/a.js?private-query#private-hash`) },
      { id: 4, callFrame: frame(`${origin}/js/a.js`, "different private function") },
      { id: 5, callFrame: frame("", "(idle)") },
      { id: 6, callFrame: frame("https://private.invalid/personal-title") },
      { id: 7, callFrame: frame(`${origin}/js/child.js`) }
    ], samples: [2, 3, 4, 5, 6, 1, 7], timeDeltas: [4_000, 1_000, 3_000, 2_000, 1_000, 500, 500] };
}
function rejects(change) {
  const value = profile(); change(value);
  assert.throws(() => summarizeInboxCpuProfile(value, origin), assert.AssertionError);
}

test("exclusive attribution deduplicates paths, sorts ties and preserves uncovered time", () => {
  const value = profile(), before = structuredClone(value);
  assert.deepEqual(summarizeInboxCpuProfile(value, origin), {
    durationMs: 20, sampledMs: 12, unattributedMs: 8, sampleCount: 7,
    files: [{ path: "js/a.js", sampledMs: 4, samples: 2 },
      { path: "js/z.js", sampledMs: 4, samples: 1 }, { path: "js/child.js", sampledMs: 0.5, samples: 1 }],
    categories: { idleMs: 2, otherMs: 1.5 }
  });
  assert.deepEqual(value, before);
  assert.deepEqual(summarizeInboxCpuProfile(value, `${origin}/`), summarizeInboxCpuProfile(value, origin));
});

test("only exact-origin safe js paths escape; foreign URLs and function names remain private", () => {
  const external = ["https://private.invalid/user-name", "file:///private/user-name", "data:text/javascript,user-name",
    `chrome-extension://${"b".repeat(32)}/js/private.js`, `${origin}.invalid/js/private.js`,
    `${origin}/css/private.css`, `${origin}/js/%75ser-name.js`, `${origin}/js/a%2Fb.js`,
    `${origin}/js/../private.js`, `${origin}/js/`, "private malformed URL"];
  const value = profile();
  value.nodes = [{ id: 1, callFrame: frame(), children: external.map((_, index) => index + 2) },
    ...external.map((url, index) => ({ id: index + 2, callFrame: frame(url, "user-name") }))];
  value.samples = external.map((_, index) => index + 2);
  value.timeDeltas = external.map(() => 1_000);
  const summary = summarizeInboxCpuProfile(value, origin);
  assert.deepEqual(summary.files, []);
  assert.equal(summary.categories.otherMs, external.length);
  assert.ok(!JSON.stringify(summary).includes("private"));
  assert.ok(!JSON.stringify(summary).includes("user-name"));
  const serialized = JSON.stringify(summarizeInboxCpuProfile(profile(), origin));
  for (const secret of ["private", "function", "chrome-extension", "https://", "(root)"]) {
    assert.ok(!serialized.includes(secret));
  }
});

test("invalid origins are rejected without repeating their contents", () => {
  for (const invalid of [undefined, null, "private", "https://private.invalid", "chrome-extension://short",
    `${origin}/js/a.js`, `${origin}?private`, `${origin}#private`, `${origin}:1234`,
    `chrome-extension://private@${"a".repeat(32)}`]) {
    assert.throws(() => summarizeInboxCpuProfile(profile(), invalid), error =>
      error instanceof assert.AssertionError && !error.message.includes("private"));
  }
});

test("sample arrays and node references must be structurally valid", () => {
  for (const value of [undefined, null, [], {}]) {
    assert.throws(() => summarizeInboxCpuProfile(value, origin), assert.AssertionError);
  }
  rejects(value => { value.nodes = []; });
  rejects(value => { value.nodes[1].id = 1; });
  rejects(value => { value.nodes[1].id = -1; });
  rejects(value => { value.nodes[1].id = "2"; });
  rejects(value => { value.nodes[0].children.push(999); });
  rejects(value => { value.nodes[0].children.push(2); });
  rejects(value => { value.nodes[0].children.push(1); });
  rejects(value => { value.samples[0] = 999; });
  rejects(value => { value.samples[0] = "2"; });
  rejects(value => { value.samples.pop(); });
  rejects(value => { value.timeDeltas.pop(); });
  for (const field of ["samples", "timeDeltas"]) rejects(value => { delete value[field]; });
  rejects(value => { value.nodes[0].callFrame = null; });
  rejects(value => { value.nodes[0].callFrame.url = null; });
  rejects(value => { value.nodes[0].callFrame.functionName = null; });
  rejects(value => { value.nodes[0].callFrame.lineNumber = NaN; });
  rejects(value => { value.nodes[0].callFrame.columnNumber = -2; });
});

test("timestamps and deltas reject negative, nonnumeric and nonfinite values", () => {
  for (const invalid of [undefined, null, "100", -1, NaN, Infinity]) {
    for (const field of ["startTime", "endTime"]) rejects(value => { value[field] = invalid; });
    rejects(value => { value.timeDeltas[0] = invalid; });
  }
  rejects(value => { value.endTime = value.startTime - 1; });
  rejects(value => { value.timeDeltas[0] = Number.MAX_VALUE; value.timeDeltas[1] = Number.MAX_VALUE; });
});

test("boundary overshoot is bounded and is never silently rescaled", () => {
  const value = profile();
  value.samples = [2, 3]; value.timeDeltas = [10_000, 10_500];
  const result = summarizeInboxCpuProfile(value, origin);
  assert.equal(result.sampledMs, 20.5);
  assert.equal(result.unattributedMs, 0);
  assert.equal(result.files.reduce((sum, file) => sum + file.sampledMs, 0), 20.5);
  value.timeDeltas[1] = 11_001;
  assert.throws(() => summarizeInboxCpuProfile(value, origin), /exceeds/);
  value.startTime = value.endTime;
  value.samples = [2]; value.timeDeltas = [1];
  assert.throws(() => summarizeInboxCpuProfile(value, origin), /exceeds/);
});

test("empty sampling and zero-duration profiles remain explicit", () => {
  const value = profile(); value.samples = []; value.timeDeltas = [];
  assert.deepEqual(summarizeInboxCpuProfile(value, origin), {
    durationMs: 20, sampledMs: 0, unattributedMs: 20, sampleCount: 0,
    files: [], categories: { idleMs: 0, otherMs: 0 }
  });
  value.startTime = value.endTime;
  assert.equal(summarizeInboxCpuProfile(value, origin).unattributedMs, 0);
});


test("optional source locations are one-based, exclusive and omit unknown or foreign frames", () => {
  const value = profile();
  value.nodes[1].callFrame.lineNumber = 20; value.nodes[1].callFrame.columnNumber = 4;
  value.nodes[2].callFrame.lineNumber = 10; value.nodes[2].callFrame.columnNumber = 0;
  value.nodes[3].callFrame.lineNumber = 10; value.nodes[3].callFrame.columnNumber = 0;
  value.nodes[5].callFrame.lineNumber = 999; value.nodes[5].callFrame.columnNumber = 5;
  const result = summarizeInboxCpuProfile(value, origin, { includeLocations: true });
  assert.deepEqual(result.locations, [
    { path: "js/a.js", line: 11, column: 1, samples: 2, sampledMs: 4 },
    { path: "js/z.js", line: 21, column: 5, samples: 1, sampledMs: 4 }
  ]);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.ok(!JSON.stringify(result).includes("999"));
  assert.ok(!("locations" in summarizeInboxCpuProfile(value, origin)));
});
