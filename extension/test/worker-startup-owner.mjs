import assert from "node:assert/strict";
import { createWorkerStartupOwner } from "../js/background/worker-startup-owner.js";

const calls = [];
const warnings = [];
const timers = [];
let recoveryResult = "recovery-cycle";
let recoveryRejects = false;
const task = (name, { reject = false } = {}) => async (...args) => {
  calls.push([name, ...args]);
  if (reject) throw new Error(`private Session https://private.example/${name}`);
};

const owner = createWorkerStartupOwner({
  assets: { collect: task("assets-collect") },
  identity: { ensure: task("identity") },
  schedules: {
    snapshot: task("snapshot-schedule"),
    suspension: task("suspension-schedule"),
    inbox: task("inbox-schedule"),
    rotation: task("rotation-schedule")
  },
  snapshots: { take: task("snapshot-take", { reject: true }) },
  collections: { migrate: task("retired-collections-migration") },
  snooze: { ready: Promise.resolve(), sweep: task("snooze-sweep") },
  inbox: { sweep: task("inbox-sweep"), expire: task("inbox-expire") },
  badge: { refresh: task("badge") },
  closeDay: { resume: task("close-day", { reject: true }) },
  suspension: {
    retryCloseCleanups: task("close-cleanup", { reject: true }),
    startRecovery: async (options) => {
      calls.push(["suspend-recovery", options]);
      if (recoveryRejects) throw new Error("recovery rejected");
      return recoveryResult;
    }
  },
  deferred: {
    ensureSessionIdentities: task("session-identities"),
    scheduleFocusRetirement: () => calls.push(["retired-focus-scheduled"]),
    scheduleGuardRecovery: () => calls.push(["guard-recovery-scheduled"])
  },
  schedule(callback, delay) { timers.push({ callback, delay }); },
  warn: (...args) => warnings.push(args)
});

owner.installDeferredWork();
assert.deepEqual(calls, [
  ["guard-recovery-scheduled"]
]);
assert.equal(timers.length, 1);
assert.equal(timers[0].delay, 1_000);
timers[0].callback();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(calls.at(-1), ["session-identities"]);

calls.length = 0;
const recoveryPreparation = Object.freeze({ cycleId: "prepared-reload-cycle" });
owner.start({ recoveringReload: true, recoveryPreparation });
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));

const names = calls.map(([name]) => name);
for (const expected of [
  "identity", "snapshot-schedule", "suspension-schedule", "inbox-schedule",
  "rotation-schedule", "snooze-sweep",
  "badge", "close-day", "close-cleanup",
  "suspend-recovery"
]) assert.ok(names.includes(expected), `startup launches ${expected}`);
assert.equal(names.includes("retired-collections-migration"), false,
  "startup no longer invokes the retired collection migration");
assert.equal(names.includes("retired-focus-scheduled"), false,
  "deferred startup no longer schedules retired Focus cleanup");
const recoveryOptions = calls.find(([name]) => name === "suspend-recovery")[1];
assert.equal(recoveryOptions.recoveringReload, true,
  "recovery receives reload context even after cleanup fails");
assert.equal(recoveryOptions.recoveryPreparation, recoveryPreparation,
  "recovery receives the notification preparation claimed before reload grace");
const optional = ["snapshot-take", "inbox-sweep", "inbox-expire", "assets-collect"];
await owner.collectAssetsWhenReady();
assert.ok(!calls.some(([name]) => name === "assets-collect"),
  "a maintenance alarm also defers asset scanning until recovery settles");
assert.ok(optional.every((name) => !names.includes(name)),
  "scheduling recovery is not its completion: heavy maintenance stays deferred");
recoveryOptions.onInitialPassSettled();
recoveryOptions.onInitialPassSettled();
await new Promise((resolve) => setTimeout(resolve, 0));
for (const name of optional) {
  assert.equal(calls.filter(([called]) => called === name).length, 1,
    `${name} runs exactly once after the initial recovery pass`);
}

assert.deepEqual(warnings.map(([message]) => message).sort(), [
  "EveryTab: Close-the-day recovery failed [name:Error]",
  "EveryTab: automatic Snapshot startup capture failed [name:Error]",
  "EveryTab: retained suspended close cleanup failed [name:Error]"
].sort(), "independent startup failures are named and contained");
assert.ok(warnings.every((args) => args.length === 1 && !args[0].includes("private")),
  "startup work never forwards private error objects to its injected sink");

for (const outcome of ["no-cycle", "rejected", "ordinary-start"]) {
  calls.length = 0;
  recoveryResult = outcome === "no-cycle" ? null : "cycle";
  recoveryRejects = outcome === "rejected";
  owner.start({
    recoveringReload: outcome !== "ordinary-start",
    recoverSuspendedTabs: outcome !== "ordinary-start",
    captureStartupSnapshot: outcome !== "ordinary-start"
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.some(([called]) => called === "suspend-recovery"),
    outcome !== "ordinary-start",
    `${outcome} invokes suspended-tab reconstruction only for extension reloads`);
  for (const name of optional) {
    const expected = outcome === "ordinary-start" && name === "snapshot-take" ? 0 : 1;
    assert.equal(calls.filter(([called]) => called === name).length, expected,
      `${outcome} ${expected ? "runs" : "skips"} ${name} exactly as intended`);
  }
}

let releaseHeldCleanup;
const heldCleanup = new Promise((resolve) => { releaseHeldCleanup = resolve; });
let promptRecoveryStarted = false;
const promptOrder = [];
const noop = async () => {};
const promptOwner = createWorkerStartupOwner({
  assets: { collect: noop }, identity: { ensure: noop },
  schedules: { snapshot: noop, suspension: noop, inbox: noop, rotation: noop },
  snapshots: { take: noop }, snooze: { ready: Promise.resolve(), sweep: noop },
  inbox: { sweep: noop, expire: noop }, badge: { refresh: noop },
  closeDay: { resume: noop },
  suspension: {
    retryCloseCleanups: () => { promptOrder.push("cleanup"); return heldCleanup; },
    startRecovery: async () => {
      promptOrder.push("recovery");
      promptRecoveryStarted = true;
      return "prompt-cycle";
    }
  },
  deferred: { ensureSessionIdentities: noop, scheduleGuardRecovery() {} },
  schedule() {}
});
promptOwner.start({ recoveringReload: true });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(promptRecoveryStarted, true,
  "suspended recovery must start while retained-close cleanup is still pending");
assert.deepEqual(promptOrder, ["recovery", "cleanup"],
  "suspended recovery claims the Store lane before retained-close cleanup");
releaseHeldCleanup();

console.log("PASS: worker startup owns independent maintenance and recovery ordering");
