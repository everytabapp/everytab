// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { validateInventory, selectRuns, nodeInvocation } from "./inventory.mjs";

const platforms = ["linux", "darwin", "win32"];
const fixture = () => ({ schemaVersion: 1, nodeVersion: 22, entries: [
  { path: "extension/test/core.mjs", kind: "suite", lane: "portable", cwd: "extension",
    ciPlatforms: platforms, reason: "Domain regression." },
  { path: "extension/test/perf.mjs", kind: "suite", lane: "performance", cwd: "extension",
    nodeArgs: ["--expose-gc"], ciPlatforms: ["linux"], reason: "Bounded memory measurement." },
  { path: "extension/test/browser.mjs", kind: "suite", lane: "browser", cwd: ".",
    ciPlatforms: platforms, reason: "Installed profile fixture.", variants: [
      { id: "browser-full", platforms: ["linux", "win32"], ciPlatforms: ["linux", "win32"] },
      { id: "browser-worker", platforms: ["darwin"], ciPlatforms: ["darwin"], env: { HEADLESS: "1" } }
    ] },
  { path: "extension/test/cws-package.mjs", kind: "suite", lane: "package", cwd: ".",
    ciPlatforms: platforms, reason: "Explicit authorized package verification." },
  { path: "extension/test/helper.mjs", kind: "helper", owners: ["extension/test/core.mjs"],
    reason: "Imported by the core suite." }
] });
const files = (inventory) => inventory.entries.map((entry) => entry.path);

test("new, deleted and duplicate test files cannot silently escape classification", () => {
  const inventory = fixture();
  assert.deepEqual(validateInventory(inventory, files(inventory)), { files: 5, runs: 5 });
  assert.throws(() => validateInventory(inventory, [...files(inventory), "extension/test/new.mjs"]), /Unclassified file/);
  assert.throws(() => validateInventory(inventory, files(inventory).slice(1)), /Missing or out-of-scope/);
  inventory.entries.push(inventory.entries[0]);
  assert.throws(() => validateInventory(inventory, files(inventory)), /Duplicate classification/);
});

test("support ownership and execution decisions must be explicit", () => {
  const inventory = fixture();
  inventory.entries.at(-1).owners = ["extension/test/absent.mjs"];
  assert.throws(() => validateInventory(inventory, files(inventory)), /Invalid owner/);
  inventory.entries.at(-1).owners = ["extension/test/core.mjs"];
  delete inventory.entries[0].ciPlatforms;
  assert.throws(() => validateInventory(inventory, files(inventory)), /Explicit ciPlatforms/);
});

test("default gate includes required performance flags and cannot accidentally package", () => {
  const inventory = fixture();
  const runs = selectRuns(inventory, { platform: "darwin" });
  assert.deepEqual(runs.map((run) => run.id), ["core.mjs", "perf.mjs"]);
  const root = path.resolve("fixture project with spaces");
  const invocation = nodeInvocation(root, runs[1]);
  assert.deepEqual(invocation.args, ["--expose-gc", path.join(root, "extension/test/perf.mjs")]);
  assert.equal(invocation.cwd, path.join(root, "extension"));
  assert.throws(() => selectRuns(inventory, { id: "cws-package.mjs" }), /Packaging is paused/);
  assert.equal(selectRuns(inventory, { lanes: ["package"], allowPackaging: true }).length, 1);
  assert.throws(() => selectRuns(inventory, { id: "helper.mjs" }), /Unknown executable/);
});

test("CI platform filtering preserves explicit installed-browser variants", () => {
  const inventory = fixture();
  assert.equal(selectRuns(inventory, { platform: "darwin", ci: true }).length, 1);
  assert.equal(selectRuns(inventory, { platform: "linux", ci: true }).length, 2);
  const runs = selectRuns(inventory, { lanes: ["browser"], platform: "darwin", ci: true });
  assert.deepEqual(runs.map((run) => run.id), ["browser-worker"]);
  assert.deepEqual(runs[0].env, { HEADLESS: "1" });
  assert.throws(() => selectRuns(inventory, { id: "browser-full", platform: "darwin" }), /not enabled/);
});

test("raw JSON field types cannot be silently normalized into valid runs", () => {
  for (const [field, value] of [
    ["env", ["1"]], ["env", null], ["args", null], ["nodeArgs", null],
    ["variants", null], ["variants", [null]], ["owners", {}], ["owners", "core.mjs"],
    ["platforms", []], ["platforms", "linux"], ["ciPlatforms", null],
    ["timeoutMs", "1000"], ["id", "   "]
  ]) {
    const inventory = fixture();
    inventory.entries[0][field] = value;
    assert.throws(() => validateInventory(inventory, files(inventory)),
      /Invalid|invalid|Empty|Explicit/i, `${field}: ${JSON.stringify(value)}`);
  }
  const inventory = fixture();
  inventory.entries[0].variants = [{ env: ["1"] }];
  assert.throws(() => validateInventory(inventory, files(inventory)), /environment/i);
});

test("explicit variants compose argv and environment without mutating the catalogue", () => {
  const inventory = fixture();
  inventory.entries[0].nodeArgs = ["--expose-gc"];
  inventory.entries[0].args = ["--base"];
  inventory.entries[0].env = { KEEP: "base", MODE: "base" };
  inventory.entries[0].variants = [{ id: "explicit", args: ["value with spaces"],
    env: { MODE: "variant" }, ciPlatforms: [], timeoutMs: 2_000 }];
  const before = structuredClone(inventory);
  const run = selectRuns(inventory, { id: "explicit", platform: "linux" })[0];
  assert.deepEqual(run.nodeArgs, ["--expose-gc"]);
  assert.deepEqual(run.args, ["--base", "value with spaces"]);
  assert.deepEqual(run.env, { KEEP: "base", MODE: "variant" });
  assert.deepEqual(run.platforms, platforms, "omitted runtime platforms default to all supported hosts");
  assert.equal(run.timeoutMs, 2_000);
  assert.throws(() => selectRuns(inventory, { id: "explicit", platform: "linux", ci: true }), /not enabled/);
  assert.deepEqual(inventory, before);
});

test("run identities, scoped paths, owner references and CI subsets remain explicit", () => {
  for (const badPath of ["../escape.mjs", "tools/../escape.mjs", "tools//empty.mjs", "/tools/absolute.mjs"]) {
    const inventory = fixture();
    inventory.entries[0].path = badPath;
    assert.throws(() => validateInventory(inventory, files(inventory)), /Invalid inventory path/);
  }
  const inventory = fixture();
  inventory.entries[0].platforms = ["linux"];
  assert.throws(() => validateInventory(inventory, files(inventory)), /CI platform cannot execute/);
  inventory.entries[0].ciPlatforms = ["linux"];
  inventory.entries[0].variants = [{ id: "duplicated" }, { id: "duplicated" }];
  assert.throws(() => validateInventory(inventory, files(inventory)), /Duplicate or invalid run ID/);
  delete inventory.entries[0].variants;
  inventory.entries.at(-1).owners = [inventory.entries.at(-1).path];
  assert.throws(() => validateInventory(inventory, files(inventory)), /Invalid owner/);
});

test("variants cannot select another file or move package work into an ordinary lane", () => {
  const inventory = fixture();
  inventory.entries[0].variants = [{ path: "extension/test/helper.mjs" }];
  assert.throws(() => validateInventory(inventory, files(inventory)), /variant/i);
  inventory.entries[0].variants = [{ kind: "helper" }];
  assert.throws(() => validateInventory(inventory, files(inventory)), /variant/i);
  delete inventory.entries[0].variants;
  inventory.entries[3].path = "tools/package-verification.mjs";
  inventory.entries[3].variants = [{ lane: "portable" }];
  assert.throws(() => selectRuns(inventory), /Packaging|package/i);
});

test("invalid selection options cannot turn the gate into an accidental empty success", () => {
  for (const options of [
    { platform: "windows" }, { lanes: [] }, { lanes: "portable" },
    { id: "" }, { ci: "false" }, { allowPackaging: "false", lanes: ["package"] }
  ]) assert.throws(() => selectRuns(fixture(), options), /Invalid|Unknown|Empty/i);
});

test("runtime flags must execute the suite while preserving exact script arguments", () => {
  for (const flag of ["--check", "--eval=console.log('not the suite')", "--print=1", "--help", "--version", "--run=build", "--v8-options", "--completion-bash", "--experimental-vm-modules --check", "--experimental-vm-modules=true"]) {
    const inventory = fixture();
    inventory.entries[0].nodeArgs = [flag];
    assert.throws(() => validateInventory(inventory, files(inventory)), /argument|flag/i);
  }
  const inventory = fixture();
  inventory.entries[0].args = ["--name", "a path with spaces", "$(not-a-shell)"];
  const run = selectRuns(inventory, { id: "core.mjs" })[0];
  assert.deepEqual(nodeInvocation(path.resolve("project"), run).args.slice(-3), inventory.entries[0].args);
  assert.throws(() => nodeInvocation(path.resolve("project"), { ...run, cwd: ".." }), /working directory/i);
});

test("VM module flag executes the selected suite with entry and variant arguments intact", () => {
  for (const variant of [false, true]) {
    const inventory = fixture();
    const entry = inventory.entries[0];
    if (variant) entry.variants = [{ id: "vm-suite", nodeArgs: ["--experimental-vm-modules"] }];
    else entry.nodeArgs = ["--experimental-vm-modules"];
    entry.args = ["--fixture", "value with spaces"];
    assert.deepEqual(validateInventory(inventory, files(inventory)), { files: 5, runs: 5 });
    const root = path.resolve("fixture project with spaces");
    const run = selectRuns(inventory, { id: variant ? "vm-suite" : "core.mjs" })[0];
    assert.deepEqual(nodeInvocation(root, run).args,
      ["--experimental-vm-modules", path.join(root, entry.path), "--fixture", "value with spaces"]);
  }
});
