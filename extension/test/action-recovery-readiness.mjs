import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMessageListener } from "../js/lib/message-handler-registry.js";
import { reportFailure } from "../js/lib/failure-diagnostic.js";
import { createCloseDayMessageHandlers } from "../js/background/close-day-message-handlers.js";
import { createLiveCloseMessageHandlers } from "../js/background/live-close-message-handlers.js";

// Execute the actual startup boundary without loading Chrome or unrelated worker
// owners. The optional source path supports a regression run against the archive.
const source = await readFile(process.env.ACTION_RECOVERY_SOURCE ??
  new URL("../js/background.js", import.meta.url), "utf8");
const start = source.indexOf("const actionRecoveryReady =");
const end = source.indexOf("const snoozeRecoveryReady =", start);
assert.ok(start >= 0 && end > start, "the worker exposes its action recovery boundary");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction("scope", `
  const { recoverInterruptedCloseDayUndos, recoverInterruptedUndos,
    recoverPendingLiveCloses, reportFailure } = scope;
  ${source.slice(start, end)}
  return { ready: actionRecoveryReady };
`);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function authorityAbsent() {
  return Object.assign(new Error("Storage authority is not initialized"), {
    code: "storage-authority-not-initialized"
  });
}

async function fixture() {
  const recoveries = [deferred(), deferred(), deferred()];
  const started = [];
  const diagnostics = [];
  const recovery = (index) => () => {
    started.push(index);
    return recoveries[index].promise;
  };
  const { ready } = await execute({
    recoverInterruptedCloseDayUndos: recovery(0),
    recoverInterruptedUndos: recovery(1),
    recoverPendingLiveCloses: recovery(2),
    reportFailure: (operation, error) => reportFailure(operation, error,
      (message) => diagnostics.push(message))
  });
  const state = { settled: false, error: null };
  const observed = ready.then(() => { state.settled = true; }, (error) => {
    state.settled = true;
    state.error = error;
  });
  const actions = [];
  const listener = createMessageListener([
    ...createCloseDayMessageHandlers({ ready,
      async undo() { actions.push("undo"); return { status: "undone" }; }
    }),
    ...createLiveCloseMessageHandlers({ ready,
      async tabs() { actions.push("close"); return { ok: true, closed: 1 }; }
    })
  ]);
  const responses = [];
  const invoke = (message) => new Promise((resolve) => {
    assert.equal(listener(message, {}, (response) => {
      responses.push(response);
      resolve(response);
    }), true, "the public route keeps the response channel open");
  });
  const pending = Promise.all([
    invoke({ type: "close-day-undo", transactionId: "synthetic-transaction" }),
    invoke({ type: "close-tabs", tabIds: [1] })
  ]);
  return { recoveries, started, diagnostics, state, observed, actions, responses, pending };
}

test("startup waits for every recovery before releasing public actions", async () => {
  const run = await fixture();
  assert.deepEqual(run.started, [0, 1, 2], "all three recovery owners participate");
  run.recoveries[0].resolve();
  run.recoveries[1].resolve();
  await flush();
  assert.equal(run.state.settled, false);
  assert.deepEqual(run.actions, []);
  assert.deepEqual(run.responses, []);
  run.recoveries[2].resolve();
  assert.deepEqual(await run.pending, [
    { ok: true, status: "undone" }, { ok: true, closed: 1 }
  ]);
  await run.observed;
  assert.equal(run.state.error, null);
  assert.deepEqual(run.actions, ["undo", "close"]);
  assert.deepEqual(run.diagnostics, []);
});

test("fresh-install authority absence from every owner releases the gate quietly", async () => {
  const run = await fixture();
  for (const recovery of run.recoveries) recovery.reject(authorityAbsent());
  assert.deepEqual(await run.pending, [
    { ok: true, status: "undone" }, { ok: true, closed: 1 }
  ]);
  await run.observed;
  assert.equal(run.state.error, null);
  assert.deepEqual(run.actions, ["undo", "close"]);
  assert.deepEqual(run.diagnostics, [], "expected pre-install absence is not a failure diagnostic");
});

test("expected authority absence still waits for pending sibling recovery", async () => {
  const run = await fixture();
  run.recoveries[0].reject(authorityAbsent());
  run.recoveries[1].resolve();
  await flush();
  assert.equal(run.state.settled, false);
  assert.deepEqual(run.actions, []);
  assert.deepEqual(run.responses, []);
  run.recoveries[2].resolve();
  await run.pending;
  await run.observed;
  assert.equal(run.state.error, null);
  assert.deepEqual(run.actions, ["undo", "close"]);
  assert.deepEqual(run.diagnostics, []);
});

test("expected authority absence cannot hide another owner's real read failure", async () => {
  const run = await fixture();
  const failure = Object.assign(new Error("Private read failure"), {
    code: "storage-authority-read-failed"
  });
  run.recoveries[0].reject(authorityAbsent());
  run.recoveries[1].reject(authorityAbsent());
  await flush();
  assert.equal(run.state.settled, false);
  assert.deepEqual(run.actions, []);
  run.recoveries[2].reject(failure);
  assert.deepEqual(await run.pending, [
    { ok: false, status: "failed" }, { ok: false, reason: "error", closed: 0 }
  ]);
  await run.observed;
  assert.equal(run.state.error, failure);
  assert.deepEqual(run.actions, []);
  assert.deepEqual(run.diagnostics, ["EveryTab: pending live-close recovery failed [name:Error]"],
    "only the actual read failure is diagnosed, without private messages or unknown codes");
});

for (const failedOwner of [0, 1, 2]) {
  test(`recovery owner ${failedOwner} failure waits for siblings and refuses public actions`, async () => {
    const run = await fixture();
    const failure = new Error("Private title https://private.example/page /private/vault");
    failure.cause = { title: "Private saved record" };
    const siblings = [0, 1, 2].filter((index) => index !== failedOwner);
    run.recoveries[failedOwner].reject(failure);
    run.recoveries[siblings[0]].resolve();
    await flush();
    assert.equal(run.state.settled, false,
      "an early rejection cannot settle readiness while another recovery is pending");
    assert.deepEqual(run.actions, []);
    assert.deepEqual(run.responses, []);
    run.recoveries[siblings[1]].resolve();
    assert.deepEqual(await run.pending, [
      { ok: false, status: "failed" }, { ok: false, reason: "error", closed: 0 }
    ]);
    await run.observed;
    assert.equal(run.state.error, failure, "observing rejection does not turn the gate into success");
    assert.deepEqual(run.actions, [], "failed startup cannot enter public domain actions");
    const operation = failedOwner === 2 ? "pending live-close recovery" : "interrupted Undo recovery";
    assert.deepEqual(run.diagnostics, [`EveryTab: ${operation} failed [name:Error]`],
      "diagnostics contain a fixed operation and classification, never private failure payloads");
  });
}
