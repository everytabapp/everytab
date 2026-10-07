// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Execute the maintained runner's actual catch/finally statements. Stubbing the
// enclosing scope avoids Chrome, localhost servers and fixture profile writes;
// no second implementation of the cleanup behavior lives in this test.
const source = await readFile(new URL("../check-installed-recovery-ui.mjs", import.meta.url), "utf8");
const handlerStart = source.lastIndexOf('} catch (error) {\n');
assert.ok(handlerStart >= 0, "installed runner exposes its terminal error handler");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction("scope", `
  const { primaryFailure, evidence, page, worker, evaluate, capture,
    terminateOwnedChrome, browser, rm, temporary, server, writeFile,
    path, output, console } = scope;
  let failure;
  try { if (primaryFailure) throw primaryFailure; }
  ${source.slice(handlerStart + 2)}
`);

async function runFixture({ primaryFailure, receiptFailure, failedCleanup } = {}) {
  const calls = [];
  let writtenEvidence;
  const cleanupError = new Error("Synthetic cleanup failure");
  const effect = name => {
    calls.push(name);
    if (name === failedCleanup) throw cleanupError;
  };
  const worker = { close: () => effect("worker.close") };
  const page = { close: () => effect("page.close") };
  const evidence = { status: primaryFailure ? "fail" : "pass" };
  let thrown;
  try {
    await execute({
      primaryFailure, evidence, worker, page,
      async evaluate(owner, expression) {
        if (owner === worker) {
          assert.match(expression, /chrome\.windows\.create=globalThis\.__recoveryUiInjection\.original/);
          effect("restore injection");
        } else return { text: "Synthetic failure context" };
      },
      capture: async () => {},
      terminateOwnedChrome: async () => effect("terminate Chrome"),
      browser: {}, temporary: "/synthetic-owned-profile",
      rm: async filename => {
        assert.equal(filename, "/synthetic-owned-profile");
        effect("remove profile");
      },
      server: { close(callback) {
        calls.push("close server");
        callback(failedCleanup === "close server" ? cleanupError : undefined);
      } },
      async writeFile(filename, value) {
        assert.equal(filename, path.join("synthetic-evidence", "verification.json"));
        effect("write receipt");
        if (receiptFailure) throw receiptFailure;
        writtenEvidence = JSON.parse(value);
      },
      path, output: "synthetic-evidence", console: { log() {} }
    });
  } catch (error) { thrown = error; }
  return { calls, thrown, cleanupError, writtenEvidence };
}

const cleanupOrder = ["restore injection", "worker.close", "page.close",
  "terminate Chrome", "remove profile", "close server", "write receipt"];

function assertCompleteCleanup(calls, label = "all owned resources receive cleanup") {
  assert.deepEqual(calls.filter(name => name !== "write receipt"), cleanupOrder.slice(0, -1), label);
  assert.equal(calls.filter(name => name === "write receipt").length, 1, label);
}

test("receipt-write rejection cannot bypass any owned-resource cleanup", async () => {
  const receiptFailure = new Error("Synthetic ENOSPC");
  const result = await runFixture({ receiptFailure });
  assertCompleteCleanup(result.calls);
  assert.equal(result.thrown, receiptFailure, "receipt failure still fails an otherwise successful run");
});

test("the original test failure survives a rejected failure-receipt write", async () => {
  const primaryFailure = new Error("Synthetic browser assertion failure");
  const result = await runFixture({ primaryFailure, receiptFailure: new Error("Synthetic EACCES") });
  assert.equal(result.thrown, primaryFailure);
  assertCompleteCleanup(result.calls);
});

test("each cleanup rejection leaves later cleanup and evidence persistence reachable", async () => {
  for (const failedCleanup of cleanupOrder.slice(0, -1)) {
    const result = await runFixture({ failedCleanup });
    assertCompleteCleanup(result.calls, failedCleanup);
    assert.equal(result.thrown, result.cleanupError, failedCleanup);
    assert.equal(result.writtenEvidence.status, "fail", failedCleanup);
    assert.match(result.writtenEvidence.cleanupFailure, /Synthetic cleanup failure/);
  }
});

test("successful finalization preserves the passing receipt", async () => {
  const result = await runFixture();
  assertCompleteCleanup(result.calls);
  assert.equal(result.thrown, undefined);
  assert.equal(result.writtenEvidence.status, "pass");
  assert.equal(result.writtenEvidence.cleanupFailure, undefined);
});
