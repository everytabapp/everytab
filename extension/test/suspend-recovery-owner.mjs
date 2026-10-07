import assert from "node:assert/strict";

const timers = [];
const alarmCreates = [];
const alarmClears = [];
const notificationUpdates = [];
const notificationCreates = [];
const notificationClears = [];
const sessionMemory = {};

globalThis.chrome = {
  alarms: {
    create(name, options) { alarmCreates.push({ name, options }); },
    async clear(name) { alarmClears.push(name); return true; }
  },
  i18n: {
    getMessage(key, substitutions = []) {
      if (key === "@@ui_locale") return "en";
      return `${key}:${substitutions.join(",")}`;
    }
  },
  notifications: {
    async update(id, options) {
      notificationUpdates.push({ id, options });
      return notificationCreates.some((entry) => entry.id === id);
    },
    async create(id, options) {
      notificationCreates.push({ id, options });
      return id;
    },
    async clear(id) {
      notificationClears.push(id);
      return true;
    }
  },
  storage: {
    session: {
      async get(key) {
        return key in sessionMemory ? { [key]: sessionMemory[key] } : {};
      },
      async set(values) { Object.assign(sessionMemory, structuredClone(values)); }
    }
  },
  runtime: { getURL: (path) => `chrome-extension://everytab-test/${path}` }
};

const { createSuspendRecoveryOwner } = await import(
  "../js/background/suspend-recovery-owner.js"
);
const { RECOVERY_ALARM } = await import("../js/background/alarm-owner.js");
const { SUSPEND_RECOVERY_CYCLE_KEY, SUSPEND_REGISTRY_KEY } = await import("../js/lib/suspend.js");

const memory = {};
const suspendedRegistry = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [
  String(100 + index),
  {
    originalUrl: `https://suspended-${index}.example/`,
    title: `Suspended ${index}`,
    windowId: 1,
    index,
    pinned: false,
    recoveryOccurrenceId: `occurrence-${index}`
  }
]));
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function mutateStore(keys, mutator) {
  const maps = Object.fromEntries(keys.map((key) => [key, structuredClone(memory[key])]));
  const changes = await mutator(maps);
  if (changes) Object.assign(memory, structuredClone(changes));
}
async function readStore(key) {
  return memory[key] == null ? null : structuredClone(memory[key]);
}

const recoveryCalls = [];
let recoverCount = 0;
async function recover(options) {
  recoveryCalls.push(options);
  if (typeof options.onBrowserRecoveryComplete === "function" && recoverCount > 0) {
    options.onBrowserRecoveryComplete(recoverCount);
    // Prompt delivery begins before the durable recovery receipt settles.
    await Promise.resolve();
    assert.equal(notificationCreates.length, 2);
    assert.equal(notificationUpdates.length, 0);
  }
  if (recoverCount > 0) {
    memory[SUSPEND_RECOVERY_CYCLE_KEY].recoveredOccurrenceIds =
      Array.from({ length: recoverCount }, (_, index) => `occurrence-${index}`);
  }
  return recoverCount;
}

const metadataCalls = [];
let metadataRecovered = 0;
async function repairMetadata(options) {
  metadataCalls.push(options);
  if (metadataRecovered > 0) {
    const cycle = memory[SUSPEND_RECOVERY_CYCLE_KEY];
    cycle.recoveredOccurrenceIds = ["late-occurrence"];
    cycle.total = 1;
    cycle.notificationState = "pending";
  }
  return metadataRecovered;
}

// The suspend domain's readiness refresh needs the production Store; this
// owner test substitutes it so a seeded registry exercises only the owner.
const refreshReady = async () => {};

const owner = createSuspendRecoveryOwner({
  mutateStore,
  readStore,
  recover,
  repairMetadata,
  refreshReady,
  setTimer(callback, delay) { timers.push({ callback, delay }); }
});

// A reload with nothing suspended has nothing to explain: no banner at all.
{
  const emptyTimers = [];
  const quiet = createSuspendRecoveryOwner({
    mutateStore, readStore, recover: async () => 0, repairMetadata, refreshReady,
    setTimer: (callback) => emptyTimers.push(callback)
  });
  await quiet.start({ recoveringReload: true });
  await settle();
  for (const callback of emptyTimers) await callback();
  assert.equal(notificationCreates.length, 0,
    "a reload with an empty suspend registry shows no starting banner");
  assert.equal(notificationClears.length, 0);
  delete memory[SUSPEND_RECOVERY_CYCLE_KEY];
}

memory[SUSPEND_REGISTRY_KEY] = suspendedRegistry(1);
recoverCount = 1;
let initialSettlements = 0;
const reloadCycleId = await owner.start({
  recoveringReload: true,
  onInitialPassSettled: () => { initialSettlements += 1; }
});
await settle();
assert.equal(notificationCreates.length, 1,
  "a reload cycle with suspended occurrences explains that they will reopen");
assert.match(notificationCreates[0].id, /^suspend-recovering:/,
  "the immediate explanation owns a distinct notification identity");
const startingNotificationId = notificationCreates[0].id;
assert.deepEqual(notificationCreates[0].options, {
  type: "basic",
  iconUrl: "chrome-extension://everytab-test/icon.png",
  title: "notification_recovery_starting_title:",
  message: "notification_recovery_starting_message:"
});
assert.equal(initialSettlements, 0, "scheduling is not initial-pass settlement");
assert.equal(memory[SUSPEND_RECOVERY_CYCLE_KEY].id, reloadCycleId);
assert.equal(memory[SUSPEND_RECOVERY_CYCLE_KEY].kind, "reload");
assert.equal(timers.length, 4, "one owner installs the complete bounded reload schedule");
assert.equal(alarmCreates.at(-1)?.name, RECOVERY_ALARM,
  "starting a cycle retains the worker-death fallback alarm");

await timers[0].callback();
assert.equal(notificationCreates.length, 2,
  "recovery completion creates a separately surfaced receipt");
assert.match(notificationCreates[1].id, /^suspend-recovered:/);
assert.notEqual(notificationCreates[1].id, notificationCreates[0].id,
  "the final receipt cannot silently replace a starting banner Chrome has not shown yet");
assert.deepEqual(notificationCreates[1].options, {
  type: "basic",
  iconUrl: "chrome-extension://everytab-test/icon.png",
  title: "notification_recovered_suspended_title:",
  message: "notification_recovered_suspended_one:"
});
assert.equal(notificationUpdates.length, 0,
  "the final receipt never relies on a platform update that may not raise a banner");
assert.equal(memory[SUSPEND_RECOVERY_CYCLE_KEY].notificationState, "notified");
assert.deepEqual(alarmClears, [RECOVERY_ALARM],
  "durable notification settlement retires its fallback alarm");
assert.deepEqual(notificationClears, [startingNotificationId],
  "the settled final receipt clears the starting banner instead of leaving it in Notification Center");

recoverCount = 0;
await timers[1].callback();
await Promise.all(timers.slice(2).map(({ callback }) => callback()));
assert.equal(initialSettlements, 1, "only the initial pass releases startup maintenance");
assert.equal(notificationCreates.length, 2,
  "later settling and safety passes reuse the completed notification receipt");
assert.deepEqual(notificationClears, [startingNotificationId],
  "later passes do not clear the banner twice");

// Suspended occurrences that need no browser repair: the banner appears, the
// cycle completes with nothing to report, and the banner is cleared.
{
  const quietTimers = [];
  const settled = createSuspendRecoveryOwner({
    mutateStore, readStore, recover: async () => 0, repairMetadata, refreshReady,
    setTimer: (callback) => quietTimers.push(callback)
  });
  memory[SUSPEND_REGISTRY_KEY] = suspendedRegistry(3);
  const createsBefore = notificationCreates.length;
  const clearsBefore = notificationClears.length;
  const cycleId = await settled.start({ recoveringReload: true });
  await settle();
  assert.equal(notificationCreates.length - createsBefore, 1,
    "three suspended occurrences raise the starting banner");
  for (const callback of quietTimers) await callback();
  assert.equal(notificationCreates.length - createsBefore, 1,
    "zero recovered tabs add no final receipt");
  assert.deepEqual(notificationClears.slice(clearsBefore), [`suspend-recovering:${cycleId}`],
    "a completed cycle with nothing to report clears its starting banner");
  assert.equal(memory[SUSPEND_RECOVERY_CYCLE_KEY].notificationState, "none");
}

// A prepared reload that never starts clears only a banner it actually showed.
{
  const clearsBefore = notificationClears.length;
  const createsBefore = notificationCreates.length;
  delete memory[SUSPEND_REGISTRY_KEY];
  const unshown = owner.prepareReload();
  await owner.cancelPreparedReload(unshown);
  assert.equal(notificationCreates.length, createsBefore, "no registry, no banner");
  assert.equal(notificationClears.length, clearsBefore, "nothing shown, nothing cleared");
  memory[SUSPEND_REGISTRY_KEY] = suspendedRegistry(2);
  const shown = owner.prepareReload();
  await owner.cancelPreparedReload(shown);
  assert.equal(notificationCreates.length - createsBefore, 1);
  assert.deepEqual(notificationClears.slice(clearsBefore), [`suspend-recovering:${shown.cycleId}`],
    "a cancelled prepared reload clears the banner it showed");
  delete memory[SUSPEND_REGISTRY_KEY];
}

memory[SUSPEND_RECOVERY_CYCLE_KEY] = {
  id: "interrupted-reload",
  kind: "reload",
  recoveredOccurrenceIds: [],
  complete: false,
  notificationAttempts: 0,
  notificationState: "collecting"
};
sessionMemory.suspendRecoverySessionClaim = "interrupted-reload";
recoverCount = 1;
await owner.finishInterrupted();
assert.deepEqual(recoveryCalls.at(-1), {
  allowReloadRepair: true,
  recoveryCycleId: "interrupted-reload"
}, "a worker restart in the same browser session may finish extension reload recovery");

memory[SUSPEND_RECOVERY_CYCLE_KEY] = {
  id: "interrupted-startup",
  kind: "startup",
  recoveredOccurrenceIds: [],
  complete: false,
  notificationAttempts: 0,
  notificationState: "collecting"
};
recoverCount = 1;
const callsBeforeUnsafeStartupTail = recoveryCalls.length;
await owner.finishInterrupted();
assert.equal(recoveryCalls.length, callsBeforeUnsafeStartupTail,
  "a legacy ordinary-startup cycle cannot reconstruct tabs after Chrome restart");
assert.equal(memory[SUSPEND_RECOVERY_CYCLE_KEY].complete, true);
assert.equal(memory[SUSPEND_RECOVERY_CYCLE_KEY].notificationState, "none",
  "the stale startup cycle is retired without a recovery notification");

memory[SUSPEND_RECOVERY_CYCLE_KEY] = {
  id: "late-reload",
  kind: "reload",
  recoveredOccurrenceIds: [],
  total: 0,
  complete: true,
  notificationAttempts: 1,
  notificationState: "notified"
};
sessionMemory.suspendRecoverySessionClaim = "late-reload";
metadataRecovered = 1;
await owner.repairLateMetadata();
assert.deepEqual(metadataCalls.at(-1), {
  allowReloadRepair: true,
  recoveryCycleId: "late-reload"
});
assert.equal(memory[SUSPEND_RECOVERY_CYCLE_KEY].notificationState, "notified",
  "late metadata recovery updates the existing cycle and settles its receipt");

delete memory[SUSPEND_RECOVERY_CYCLE_KEY];
const recoveryCallsBefore = recoveryCalls.length;
const metadataCallsBefore = metadataCalls.length;
await owner.finishInterrupted();
await owner.repairLateMetadata();
assert.equal(recoveryCalls.length, recoveryCallsBefore);
assert.equal(metadataCalls.length, metadataCallsBefore,
  "stale recovery alarms have no browser or metadata effects");

const originalWarn = console.warn;
const expectedWarnings = [];
console.warn = (...args) => expectedWarnings.push(args);
try {
  for (const failure of ["none", "pass", "begin"]) {
    const localTimers = [];
    let settled = 0;
    const recovery = createSuspendRecoveryOwner({
      mutateStore: failure === "begin" ? async () => { throw new Error("unavailable"); } : mutateStore,
      readStore,
      recover: async () => {
        if (failure === "pass") throw new Error("browser unavailable");
        return 0;
      },
      repairMetadata,
      setTimer: (callback) => localTimers.push(callback)
    });
    const notificationsBefore = notificationCreates.length;
    await recovery.start({
      recoveringReload: true,
      onInitialPassSettled: () => { settled += 1; }
    });
    for (const callback of localTimers) await callback();
    assert.equal(settled, 1, `${failure}: empty/failed recovery releases maintenance once`);
    if (failure === "none") {
      assert.equal(memory[SUSPEND_RECOVERY_CYCLE_KEY].total, 0);
      assert.equal(memory[SUSPEND_RECOVERY_CYCLE_KEY].notificationState, "none");
      const notifications = notificationCreates.slice(notificationsBefore);
      assert.equal(notifications.length, 0,
        "zero suspended tabs emit no notification at all, not even the starting explanation");
    }
  }
} finally {
  console.warn = originalWarn;
}
assert.equal(expectedWarnings.length, 5, "all four failed passes and failed begin remain diagnosed");

console.log("PASS: suspended reload recovery has one directly tested state owner");

// Compose both production owners: the one-second index timer can fire while
// the initial recovery pass is still working (as in the installed slow trace).
const { createWorkerStartupOwner } = await import("../js/background/worker-startup-owner.js");
for (const scenario of ["timer-first", "recovery-first", "pass-failure", "begin-failure"]) {
  const timerFirst = scenario !== "recovery-first";
  let releasePass;
  const heldPass = new Promise((resolve) => { releasePass = resolve; });
  const passTimers = [];
  let indexTimer;
  let indexReads = 0;
  const recovery = createSuspendRecoveryOwner({
    mutateStore: scenario === "begin-failure"
      ? async () => { throw new Error("expected cycle failure"); } : mutateStore,
    readStore, repairMetadata,
    recover: async () => {
      await heldPass;
      if (scenario === "pass-failure") throw new Error("expected pass failure");
      return 0;
    },
    setTimer: (callback) => passTimers.push(callback)
  });
  const noop = async () => {};
  const worker = createWorkerStartupOwner({
    assets: { collect: noop },
    identity: { ensure: noop },
    schedules: { snapshot: noop, suspension: noop, inbox: noop, rotation: noop },
    snapshots: { take: noop },
    snooze: { ready: Promise.resolve(), sweep: noop },
    inbox: { sweep: noop, expire: noop }, badge: { refresh: noop },
    closeDay: { resume: noop },
    suspension: { retryCloseCleanups: noop, startRecovery: recovery.start },
    deferred: {
      ensureSessionIdentities: async () => { indexReads += 1; },
      scheduleGuardRecovery() {}
    },
    schedule: (callback) => { indexTimer = callback; }
  });
  worker.installDeferredWork();
  worker.start({ recoveringReload: true });
  await new Promise((resolve) => setImmediate(resolve));
  if (scenario === "begin-failure") {
    indexTimer();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(indexReads, 1, "failed cycle creation still releases index maintenance");
    continue;
  }
  const initialPass = passTimers[0]();
  if (timerFirst) {
    indexTimer();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(indexReads, 0,
      "Session-index timer must not begin its read during initial reload recovery");
  }
  releasePass();
  await initialPass;
  if (!timerFirst) {
    assert.equal(indexReads, 0, "early recovery must retain the minimum index delay");
    indexTimer();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(indexReads, 1, "index runs once after both timer and recovery settle");
  for (const callback of passTimers.slice(1)) await callback();
  assert.equal(indexReads, 1, "later recovery passes do not repeat index maintenance");
}
console.log("PASS: deferred Session indexing yields to initial reload recovery");
