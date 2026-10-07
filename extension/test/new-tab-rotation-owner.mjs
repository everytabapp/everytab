import assert from "node:assert/strict";
import { createNewTabRotationOwner } from
  "../js/background/new-tab-rotation-owner.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const events = [];
const rotations = [];
let capture = null;
const rotationQueue = [];
const diagnostics = {
  record(event, details) { events.push({ event, ...details }); },
  capture: () => capture,
  safeScheme(value) {
    return typeof value === "string" ? { id: value } : { kind: "unknown" };
  }
};
const owner = createNewTabRotationOwner({
  rotate() {
    const task = rotationQueue.shift();
    rotations.push(task);
    return task?.promise ?? Promise.resolve({ changed: false });
  },
  diagnostics
});

assert.deepEqual(owner.counts(), { active: 0, handled: 0 });
assert.deepEqual(await owner.run("missing"), { ok: false, reason: "missing-tab" });
assert.deepEqual(events.at(-1), { event: "task-missing-tab", tabId: null });
assert.deepEqual(owner.counts(), { active: 0, handled: 0 });

const first = deferred();
rotationQueue.push(first);
const firstRun = owner.run(7);
const coalescedRun = owner.run(7);
assert.strictEqual(coalescedRun, firstRun, "concurrent readiness shares the exact task");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(rotations.length, 1, "a coalesced readiness performs one scheme draw");
assert.deepEqual(owner.counts(), { active: 1, handled: 1 });
assert.deepEqual(events.slice(-2).map(({ event }) => event), ["task-start", "task-coalesced"]);

first.resolve({ changed: true, scheme: "forest", nextScheme: "cream" });
assert.deepEqual(await firstRun, {
  ok: true,
  result: { changed: true, scheme: "forest", nextScheme: "cream" }
});
assert.deepEqual(owner.counts(), { active: 0, handled: 1 });
assert.deepEqual(events.at(-1), {
  event: "task-complete",
  tabId: 7,
  changed: true,
  scheme: { id: "forest" },
  nextScheme: { id: "cream" }
}, "completion diagnostics retain only masked scheme identities");

capture = { protocol: 1, armedUntil: 9_000 };
assert.deepEqual(await owner.run(7), {
  ok: true,
  alreadyHandled: true,
  diagnosticsCapture: capture
}, "a handled tab does not draw again and still receives an armed capture lease");
assert.equal(rotations.length, 1);

owner.forget(7);
assert.deepEqual(owner.counts(), { active: 0, handled: 0 });
capture = null;

const failed = deferred();
rotationQueue.push(failed);
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args);
const failedRun = owner.run(8);
await new Promise((resolve) => setImmediate(resolve));
failed.reject(new Error("settings unavailable"));
assert.deepEqual(await failedRun, { ok: false, reason: "rotation-failed" });
console.warn = originalWarn;
assert.deepEqual(owner.counts(), { active: 0, handled: 0 },
  "a failed current draw releases its identity for a later retry");
assert.equal(warnings[0]?.[0], "EveryTab: New Tab scheme rotation failed [name:Error]");

const retry = deferred();
rotationQueue.push(retry);
const retryRun = owner.run(8);
await new Promise((resolve) => setImmediate(resolve));
retry.resolve({ changed: false });
assert.deepEqual(await retryRun, { ok: true, result: { changed: false } });

const oldIdentity = deferred();
const reusedIdentity = deferred();
rotationQueue.push(oldIdentity, reusedIdentity);
const oldRun = owner.run(12);
await new Promise((resolve) => setImmediate(resolve));
owner.forget(12);
const reusedRun = owner.run(12);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(owner.counts(), { active: 1, handled: 2 });

console.warn = () => {};
oldIdentity.reject(new Error("old tab disappeared"));
await oldRun;
console.warn = originalWarn;
assert.deepEqual(owner.counts(), { active: 1, handled: 2 },
  "an older reused-id task cannot release the newer task or its handled identity");
assert.strictEqual(owner.run(12), reusedRun,
  "readiness still coalesces with the newer task after the older task settles");
reusedIdentity.resolve({ changed: false });
await reusedRun;
assert.deepEqual(owner.counts(), { active: 0, handled: 2 });

console.log("PASS: New Tab rotation has one directly tested state owner");
