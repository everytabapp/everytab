// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { parseOptions } from "../test.mjs";

test("typos and ambiguous arguments never select an unintended full gate", () => {
  for (const args of [["--laen", "browser"], ["--lane"], ["--lane", "all"],
    ["--all"], ["one.mjs", "two.mjs"], ["one.mjs", "--lane", "portable"],
    ["--check-inventory", "--allow-packaging"], ["--lane", "portable", "--lane", "browser"]]) {
    assert.throws(() => parseOptions(args));
  }
});

test("ordinary, targeted, CI and listing modes preserve their explicit scope", () => {
  assert.deepEqual(parseOptions([]).lanes, ["portable", "performance"]);
  assert.equal(parseOptions(["core.mjs"]).id, "core.mjs");
  const browser = parseOptions(["--lane", "browser", "--ci"]);
  assert.deepEqual(browser.lanes, ["browser"]);
  assert.equal(browser.ci, true);
  assert.equal(browser.allowPackaging, false);
  assert.equal(parseOptions(["--list", "--all"]).all, true);
  assert.equal(parseOptions(["--lane", "package", "--allow-packaging"]).allowPackaging, true);
});
