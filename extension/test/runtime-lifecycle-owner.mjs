import assert from "node:assert/strict";

function chromeEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    async emit(...args) {
      await Promise.all(listeners.map((listener) => listener(...args)));
    },
    get size() { return listeners.length; }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const onInstalled = chromeEvent();
const onStartup = chromeEvent();
const alarmCalls = [];
const alarmClears = [];
globalThis.chrome = {
  runtime: { onInstalled, onStartup },
  alarms: {
    create(name, options) { alarmCalls.push({ name, options }); },
    async clear(name) { alarmClears.push(name); return true; }
  }
};

const { installRuntimeLifecycleOwner } = await import(
  "../js/background/runtime-lifecycle-owner.js"
);

const calls = [];
const delayedTasks = [];
const warnings = [];
const errors = [];
const originalSetTimeout = globalThis.setTimeout;
const originalWarn = console.warn;
const originalError = console.error;
globalThis.setTimeout = (callback, delay) => {
  delayedTasks.push({ callback, delay });
  return delayedTasks.length;
};
console.warn = (...args) => warnings.push(args);
console.error = (...args) => errors.push(args);

let initialization = null;
let blockGuardRecovery = null;
let blockReloadGrace = null;
let rejectDelayedRecovery = false;
let oldFocusCalls = 0;
let preparedCycles = 0;

function lifecycleDomains() {
  return {
    storage: {
      initialize() {
        calls.push("initialize");
        return initialization?.promise ?? Promise.resolve();
      }
    },
    menus: {
      install() { calls.push("menus"); }
    },
    worker: {
      prepareReload() {
        calls.push("prepare-reload");
        return () => calls.push("cancel-reload-preparation");
      },
      start(options) {
        calls.push(options?.recoveringReload
          ? "start-reload"
          : options?.recoverSuspendedTabs === false && options?.captureStartupSnapshot === false
            ? "start-browser-without-suspended-recovery"
            : "start-browser");
      }
    },
    newTabs: {
      resetCreationOrder() { calls.push("reset-new-tabs"); }
    },
    activity: {
      async beginBrowserSession() { calls.push("begin-activity-session"); }
    },
    protection: {
      async beginBrowserSession() { calls.push("begin-protection-session"); }
    },
    suspension: {
      prepareReload() {
        calls.push("prepare-recovery");
        preparedCycles += 1;
        return Object.freeze({ cycleId: `cycle-${preparedCycles}` });
      },
      async cancelPreparedReload(preparation) {
        if (preparation?.cycleId) calls.push("cancel-recovery-preparation");
      },
      async markReloadGrace() {
        calls.push("suspend-grace");
        if (blockReloadGrace) await blockReloadGrace.promise;
      },
      async repairRecoveryMetadata() { calls.push("repair-metadata"); }
    },
    focus: {
      async drainReloadState() { oldFocusCalls += 1; },
      claimFullStart() { oldFocusCalls += 1; },
      async retireFullStart() { oldFocusCalls += 1; },
      claimGuardLifecycle() { calls.push("claim-guard"); },
      async markGuardGrace() { calls.push("guard-grace"); },
      async recoverGuard() {
        calls.push("recover-guard");
        if (blockGuardRecovery) await blockGuardRecovery.promise;
      },
      async recoverGuardTabs() {
        calls.push("recover-guard-tabs");
        if (rejectDelayedRecovery) throw new Error("tab query unavailable");
      }
    },
    async openDashboard() { calls.push("open-dashboard"); }
  };
}

installRuntimeLifecycleOwner(lifecycleDomains());

assert.deepEqual([onInstalled.size, onStartup.size], [1, 1],
  "one owner installs each runtime lifecycle listener once");

const before = Date.now();
await onInstalled.emit({ reason: "update" });
assert.equal(calls[0], "prepare-reload", "reload claims maintenance before any asynchronous setup");
assert.equal(calls[1], "prepare-recovery",
  "an extension update prepares the recovery cycle before storage work");
assert.equal(calls.includes("cancel-reload-preparation"), false,
  "a started recovery owns release, not the lifecycle completion");
assert.equal(calls.includes("cancel-recovery-preparation"), false);
assert.equal(calls.includes("initialize"), false,
  "an extension update does not reinitialize permanent storage authority");
assert.equal(calls.includes("open-dashboard"), false,
  "an extension update never opens a first-install Dashboard");
assert.ok(calls.indexOf("menus") < calls.indexOf("suspend-grace"),
  "context menu repair starts independently before reload recovery");
assert.ok(calls.indexOf("suspend-grace") < calls.indexOf("start-reload"),
  "suspended-tab reload grace is durable before worker startup reads tabs");
assert.equal(oldFocusCalls, 0, "an update invokes no retired Focus lifecycle operation");
assert.ok(calls.indexOf("claim-guard") < calls.indexOf("guard-grace"),
  "Focus guard ownership is claimed before its asynchronous grace and recovery");
assert.ok(calls.indexOf("guard-grace") < calls.indexOf("recover-guard"));
assert.ok(calls.indexOf("guard-grace") < calls.indexOf("recover-guard-tabs"));
assert.deepEqual(delayedTasks.map(({ delay }) => delay), [3_000, 2_000, 8_000],
  "reload recovery keeps a prompt retained metadata repair and two bounded Focus safety passes");
assert.equal(alarmCalls.length, 1);
assert.equal(alarmCalls[0].name, "suspend-metadata-repair");
assert.ok(alarmCalls[0].options.when >= before + 30_000,
  "the metadata repair alarm is only a worker-death fallback at or above the packed-build minimum");
assert.equal(calls.includes("repair-metadata"), false,
  "metadata repair waits for its retained timer");

calls.length = 0;
rejectDelayedRecovery = true;
for (const task of delayedTasks.splice(0)) task.callback();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(calls, ["repair-metadata", "recover-guard-tabs", "recover-guard-tabs"],
  "the retained timer runs metadata repair; both delayed safety passes reuse Focus tab recovery");
assert.deepEqual(alarmClears, ["suspend-metadata-repair"],
  "a completed retained repair retires its fallback alarm");
assert.equal(warnings.filter(([message]) => (
  message === "EveryTab: delayed Focus tab recovery failed [name:Error]"
)).length, 2, "a delayed failure is contained and retains its task identity");
rejectDelayedRecovery = false;

// Chrome's own update and shared-module update arrive with a browser launch
// that Chrome's session restore owns. Neither may start a reload cycle.
for (const reason of ["chrome_update", "shared_module_update"]) {
  calls.length = 0;
  alarmCalls.length = 0;
  delayedTasks.length = 0;
  await onInstalled.emit({ reason });
  assert.deepEqual(calls, ["menus"],
    `${reason} repairs menus only and starts no reconstruction cycle`);
  assert.equal(alarmCalls.length, 0, `${reason} schedules no recovery alarm`);
  assert.equal(delayedTasks.length, 0, `${reason} schedules no recovery timer`);
}

calls.length = 0;
initialization = deferred();
let installSettled = false;
const pendingInstall = onInstalled.emit({ reason: "install" });
void pendingInstall.then(() => { installSettled = true; });
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(calls, ["prepare-reload", "initialize", "menus"],
  "first install repairs menus while storage authority is still initializing");
assert.equal(calls.includes("prepare-recovery"), false,
  "a first install never prepares a starting banner before storage authority exists");
assert.equal(installSettled, false,
  "Chrome retains the install event until authority initialization settles");
initialization.resolve();
await pendingInstall;
assert.equal(calls.filter((call) => call === "open-dashboard").length, 1,
  "a successful first install opens exactly one Dashboard");
assert.ok(calls.indexOf("initialize") < calls.indexOf("suspend-grace"),
  "no product state is read before first-install storage authority exists");
assert.equal(calls.includes("prepare-recovery"), false,
  "the recovery owner prepares the install cycle itself once storage exists");

calls.length = 0;
errors.length = 0;
initialization = deferred();
const rejectedInstall = onInstalled.emit({ reason: "install" });
initialization.reject(new Error("private account https://private.example/database"));
await rejectedInstall;
assert.deepEqual(calls, ["prepare-reload", "initialize", "menus", "cancel-reload-preparation"],
  "failed initialization still leaves independent menu repair intact");
assert.equal(errors[0]?.[0],
  "EveryTab: extension installation failed [name:Error]");
initialization = null;

calls.length = 0;
blockGuardRecovery = deferred();
let startupSettled = false;
const pendingStartup = onStartup.emit();
void pendingStartup.then(() => { startupSettled = true; });
assert.deepEqual(calls.slice(0, 6), [
  "reset-new-tabs",
  "begin-protection-session",
  "begin-activity-session",
  "start-browser-without-suspended-recovery",
  "claim-guard",
  "guard-grace"
], "browser start runs maintenance without reconstructing Chrome-restored suspended tabs");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(calls.includes("recover-guard"), true);
assert.equal(calls.includes("recover-guard-tabs"), false,
  "ordinary browser start restores the guard without running reload tab repair");
assert.equal(startupSettled, false,
  "Chrome retains the startup event while current Focus recovery is still running");
assert.equal(oldFocusCalls, 0, "browser startup invokes no retired Focus lifecycle operation");
blockGuardRecovery.resolve();
await pendingStartup;

// Launch-time update, browser start first: Chrome already fired onStartup in
// this worker, so a pending Store update applied at launch must not
// reconstruct what session restore is rebuilding.
calls.length = 0;
alarmCalls.length = 0;
delayedTasks.length = 0;
await onInstalled.emit({ reason: "update" });
assert.deepEqual(calls, ["menus"],
  "an update after the browser-start claim repairs menus only");
assert.equal(alarmCalls.length, 0);
assert.equal(delayedTasks.length, 0);

// Launch-time update, update first: onStartup arrives while the update path
// is still awaiting its setup. The update yields and releases its claims.
async function raceUpdateAgainstStartup({ startupDuringGrace }) {
  const racedInstalled = chromeEvent();
  const racedStartup = chromeEvent();
  globalThis.chrome.runtime = { onInstalled: racedInstalled, onStartup: racedStartup };
  installRuntimeLifecycleOwner(lifecycleDomains());
  calls.length = 0;
  alarmCalls.length = 0;
  delayedTasks.length = 0;
  blockReloadGrace = startupDuringGrace ? deferred() : null;
  const pendingUpdate = racedInstalled.emit({ reason: "update" });
  if (startupDuringGrace) {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(calls.includes("suspend-grace"), "the update reached its grace write before onStartup");
  }
  const pendingBrowserStart = racedStartup.emit();
  blockReloadGrace?.resolve();
  await Promise.all([pendingUpdate, pendingBrowserStart]);
  const label = startupDuringGrace ? "startup during grace" : "startup before grace";
  assert.equal(calls.filter((call) => call === "start-reload").length, 0,
    `${label}: the update yields and never starts the reload cycle`);
  assert.equal(calls.filter((call) => call === "start-browser-without-suspended-recovery").length, 1,
    `${label}: browser start runs exactly once and owns the session`);
  assert.deepEqual(calls.filter((call) => call.startsWith("cancel-")).sort(),
    ["cancel-recovery-preparation", "cancel-reload-preparation"],
    `${label}: the yielded update releases its worker claim and its prepared recovery cycle`);
  assert.equal(calls.includes("suspend-grace"), startupDuringGrace,
    `${label}: the grace marker is written only when the claim arrived after it began`);
  assert.equal(alarmCalls.length, 0, `${label}: no metadata repair alarm for a yielded update`);
  assert.equal(delayedTasks.length, 0, `${label}: no retained reload timers for a yielded update`);
}
await raceUpdateAgainstStartup({ startupDuringGrace: false });
await raceUpdateAgainstStartup({ startupDuringGrace: true });

globalThis.setTimeout = originalSetTimeout;
assert.ok(errors.every((args) => args.length === 1 && typeof args[0] === "string" && !args[0].includes("private")),
  "fatal lifecycle failures preserve error severity without forwarding error payloads");
console.warn = originalWarn;
console.error = originalError;

console.log("PASS: one background owner coordinates install and browser startup");
