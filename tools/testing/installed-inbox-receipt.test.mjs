// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { validateInboxTrial } from "./installed-inbox-receipt.mjs";

function receipt(count = 250, trial = 1) {
  return { count, trial, motion: { nativeDefault: true, injected: true, frame: true }, token: `${count}/${trial}`,
    rows: Array.from({ length: count }, (_, index) => {
      const suffix = String(index).padStart(4, "0");
      return { key: `inbox-fixture-${suffix}::0`, title: `Inbox fixture ${suffix}`,
        url: `https://inbox-fixture.invalid/item/${suffix}` };
    }),
    timing: { firstRowsMs: 1, allRowsMs: 20, nextFrameMs: 24 },
    visible: { width: 1100, height: 800, firstRowHeight: 36, firstRowTop: 140,
      firstRowBottom: 176, viewportHeight: 900, documentVisible: true, focused: true },
    selected: { first: true, last: true, count: 2,
      classKeys: ["inbox-fixture-0000::0", `inbox-fixture-${String(count - 1).padStart(4, "0")}::0`],
      checkedKeys: ["inbox-fixture-0000::0", `inbox-fixture-${String(count - 1).padStart(4, "0")}::0`] },
    disclosures: 0 };
}
function rejects(change) {
  const value = receipt();
  change(value);
  assert.throws(() => validateInboxTrial(value), assert.AssertionError);
}

test("both complete fixture sizes and all trials pass without mutation", () => {
  for (const count of [250, 1000]) for (const trial of [1, 2, 3]) {
    const value = receipt(count, trial);
    const original = structuredClone(value);
    assert.strictEqual(validateInboxTrial(value), value);
    assert.deepEqual(value, original);
  }
});

test("invalid receipt structure and trial dimensions fail", () => {
  for (const value of [undefined, null, [], "receipt"]) {
    assert.throws(() => validateInboxTrial(value), assert.AssertionError);
  }
  for (const count of [0, 249, 251, 999, 1001, "250", NaN]) rejects(value => { value.count = count; });
  for (const trial of [0, 4, 1.5, "1", NaN, undefined]) rejects(value => { value.trial = trial; });
  for (const field of ["rows", "timing", "visible", "selected"]) {
    for (const invalid of [undefined, null, "missing"]) rejects(value => { value[field] = invalid; });
  }
});

test("document token rejects prior-trial completion and wrong fixture datasets", () => {
  for (const invalid of [undefined, null, 250, "250/0", "250/2", "1000/1", "250/1/extra"]) {
    rejects(value => { value.token = invalid; });
  }
  const priorTrial = receipt(250, 1);
  priorTrial.trial = 2;
  assert.throws(() => validateInboxTrial(priorTrial), assert.AssertionError);
  const otherDataset = receipt(1000, 3);
  otherDataset.token = "250/3";
  assert.throws(() => validateInboxTrial(otherDataset), assert.AssertionError);
});

test("empty, capped, missing, extra, reordered and duplicated rows fail", () => {
  for (const change of [
    rows => [], rows => rows.slice(0, 50), rows => rows.slice(1),
    rows => [...rows, rows[0]], rows => [...rows].reverse(),
    rows => rows.map((row, index) => index === 200 ? rows[0] : row),
    rows => rows.map((row, index) => index === 120 ? null : row)
  ]) rejects(value => { value.rows = change(value.rows); });
});

test("every row requires its exact key, title and URL", () => {
  for (const index of [0, 123, 249]) for (const field of ["key", "title", "url"]) {
    for (const invalid of [undefined, null, "wrong"]) rejects(value => { value.rows[index][field] = invalid; });
  }
  rejects(value => { value.rows[0].key = "inbox-fixture-0000::1"; });
  rejects(value => { value.rows[0].url += "?wrong"; });
});

test("all timings must be finite nonnegative numbers in observation order", () => {
  for (const field of ["firstRowsMs", "allRowsMs", "nextFrameMs"]) {
    for (const invalid of [undefined, null, "1", NaN, Infinity, -1]) {
      rejects(value => { value.timing[field] = invalid; });
    }
  }
  rejects(value => { value.timing.firstRowsMs = 21; });
  rejects(value => { value.timing.nextFrameMs = 19; });
  const equal = receipt();
  equal.timing = { firstRowsMs: 0, allRowsMs: 0, nextFrameMs: 0 };
  validateInboxTrial(equal);
});

test("hidden, unfocused, absent layout and offscreen first rows fail", () => {
  for (const field of ["width", "height", "firstRowHeight", "viewportHeight"]) {
    for (const invalid of [undefined, null, "36", NaN, Infinity, 0, -1]) {
      rejects(value => { value.visible[field] = invalid; });
    }
  }
  for (const field of ["firstRowTop", "firstRowBottom"]) {
    for (const invalid of [undefined, null, "1", NaN, Infinity]) rejects(value => { value.visible[field] = invalid; });
  }
  for (const field of ["documentVisible", "focused"]) {
    for (const invalid of [false, undefined, 1, "true"]) rejects(value => { value.visible[field] = invalid; });
  }
  rejects(value => { Object.assign(value.visible, { firstRowTop: -36, firstRowBottom: 0 }); });
  rejects(value => { Object.assign(value.visible, { firstRowTop: 900, firstRowBottom: 936 }); });
  rejects(value => { value.visible.firstRowBottom = value.visible.firstRowTop; });
  for (const [top, bottom] of [[-20, 16], [899, 935]]) {
    const value = receipt();
    Object.assign(value.visible, { firstRowTop: top, firstRowBottom: bottom });
    validateInboxTrial(value);
  }
});

test("selection must observe both distant endpoints and exactly two rows", () => {
  for (const field of ["first", "last"]) {
    for (const invalid of [false, undefined, 1, "true"]) rejects(value => { value.selected[field] = invalid; });
  }
  for (const invalid of [0, 1, 3, "2", NaN, undefined]) rejects(value => { value.selected.count = invalid; });
});

test("class and checkbox selection must independently match the ordered endpoints", () => {
  for (const field of ["classKeys", "checkedKeys"]) {
    for (const invalid of [undefined, null, "keys", [], ["inbox-fixture-0000::0"]]) {
      rejects(value => { value.selected[field] = invalid; });
    }
    rejects(value => { value.selected[field].splice(1, 0, "inbox-fixture-0123::0"); });
    rejects(value => { value.selected[field].reverse(); });
    rejects(value => { value.selected[field][1] = value.selected[field][0]; });
    rejects(value => { value.selected[field][1] = "inbox-fixture-0123::0"; });
  }
});

test("collapsed disclosure surfaces cannot pass as a full Inbox render", () => {
  for (const invalid of [1, -1, "0", NaN, undefined, null]) rejects(value => { value.disclosures = invalid; });
});


test("reduced motion must be verified before emulation, at injection and at the measured frame", () => {
  for (const motion of [undefined, null, {}, true, []]) rejects(value => { value.motion = motion; });
  for (const field of ["nativeDefault", "injected", "frame"]) {
    for (const invalid of [undefined, null, false, 1, "true"]) rejects(value => { value.motion[field] = invalid; });
  }
});
