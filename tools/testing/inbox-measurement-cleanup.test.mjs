// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { cleanupInboxMeasurement } from "./inbox-measurement-cleanup.mjs";

function fixture(failures = {}) {
  const calls = [];
  const action = label => {
    calls.push(label);
    if (Object.hasOwn(failures, label)) throw failures[label];
  };
  const sessions = [0, 1].map(index => ({ close() {
    assert.strictEqual(this, sessions[index]);
    action(`session-${index}`);
  } }));
  const client = { async close() {
    assert.strictEqual(this, client);
    await Promise.resolve();
    action("client");
  } };
  const browser = {};
  const profile = "/synthetic/owned-profile";
  return { calls, resources: { sessions, client, browser, profile }, effects: {
    async terminateOwnedChrome(value) {
      assert.strictEqual(value, browser);
      await Promise.resolve();
      action("terminate");
    },
    async removeProfile(value) {
      assert.equal(value, profile);
      await Promise.resolve();
      action("remove");
    }
  } };
}
const allCalls = ["session-0", "session-1", "client", "terminate", "remove"];

test("successful cleanup awaits every close, termination and profile removal", async () => {
  const f = fixture();
  assert.equal(await cleanupInboxMeasurement(f.resources, f.effects), undefined);
  assert.deepEqual(f.calls, allCalls);
});

test("each throwing session or rejecting client still permits all remaining cleanup", async () => {
  for (const stage of ["session-0", "session-1", "client"]) {
    const failure = new Error("synthetic private failure");
    const f = fixture({ [stage]: failure });
    await assert.rejects(cleanupInboxMeasurement(f.resources, f.effects), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "Inbox measurement cleanup failed");
      assert.deepEqual(error.errors, [failure]);
      return true;
    });
    assert.deepEqual(f.calls, allCalls, stage);
  }
});

test("an asynchronous session rejection cannot skip later sessions", async () => {
  const f = fixture(), failure = new Error("session rejection");
  f.resources.sessions[0].close = async () => {
    f.calls.push("session-0");
    await Promise.resolve();
    throw failure;
  };
  await assert.rejects(cleanupInboxMeasurement(f.resources, f.effects), error => error.errors[0] === failure);
  assert.deepEqual(f.calls, allCalls);
});

test("failed browser termination preserves the profile and rejects", async () => {
  const failure = new Error("termination failed");
  const f = fixture({ terminate: failure });
  await assert.rejects(cleanupInboxMeasurement(f.resources, f.effects), error => error.errors[0] === failure);
  assert.deepEqual(f.calls, allCalls.slice(0, -1));
});

test("profile removal waits for confirmed asynchronous termination", async () => {
  let confirmStopped, reachedTermination;
  const started = new Promise(resolve => { reachedTermination = resolve; });
  const stopped = new Promise(resolve => { confirmStopped = resolve; });
  const calls = [];
  const cleanup = cleanupInboxMeasurement({ profile: "/synthetic/owned-profile" }, {
    async terminateOwnedChrome(browser) {
      assert.equal(browser, undefined);
      calls.push("terminate");
      reachedTermination();
      await stopped;
      calls.push("stopped");
    },
    removeProfile() { calls.push("remove"); }
  });
  await started;
  assert.deepEqual(calls, ["terminate"]);
  confirmStopped();
  await cleanup;
  assert.deepEqual(calls, ["terminate", "stopped", "remove"]);
});

test("profile removal failure rejects after browser termination", async () => {
  const failure = new Error("removal failed");
  const f = fixture({ remove: failure });
  await assert.rejects(cleanupInboxMeasurement(f.resources, f.effects), error => error.errors[0] === failure);
  assert.deepEqual(f.calls, allCalls);
});

test("multiple failures retain their original identity and cleanup order", async () => {
  const failures = Object.fromEntries(allCalls.map(label => [label, new Error(label)]));
  const f = fixture(failures);
  await assert.rejects(cleanupInboxMeasurement(f.resources, f.effects), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, allCalls.slice(0, -1).map(label => failures[label]));
    return true;
  });
  assert.deepEqual(f.calls, allCalls.slice(0, -1));

  delete failures.terminate;
  const afterStop = fixture(failures);
  await assert.rejects(cleanupInboxMeasurement(afterStop.resources, afterStop.effects), error => {
    assert.deepEqual(error.errors, [failures["session-0"], failures["session-1"], failures.client, failures.remove]);
    return true;
  });
  assert.deepEqual(afterStop.calls, allCalls);
});

test("partial setup with no clients or profile still delegates owned-browser cleanup", async () => {
  const calls = [];
  await cleanupInboxMeasurement({}, {
    terminateOwnedChrome(browser) { assert.equal(browser, undefined); calls.push("terminate"); },
    removeProfile() { assert.fail("No profile was created"); }
  });
  assert.deepEqual(calls, ["terminate"]);
});
