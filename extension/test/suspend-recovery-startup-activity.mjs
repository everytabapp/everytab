import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scenario = process.env.EVERYTAB_STARTUP_ACTIVITY_SCENARIO;

// Run each boundary in a fresh module graph. The production activity and
// recovery owners intentionally keep worker-lifetime queues and promises.
if (!scenario) {
  for (const name of ["startup", "window-query", "cleanup", "maintenance", "slow-grace", "failed-grace"]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      encoding: "utf8",
      env: { ...process.env, EVERYTAB_STARTUP_ACTIVITY_SCENARIO: name }
    });
    assert.equal(child.status, 0,
      `${name} boundary failed\n${child.stdout}${child.stderr}`);
  }
  console.log("PASS: first suspended-tab recovery is independent of light activity startup work");
  process.exit(0);
}

const { createMockLockManager } = await import("./e2-mocks.mjs");
const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const context = {
  focusedWindowId: 7,
  activeByWindow: { 7: 901 }
};
const registryEntry = {
  originalUrl: "https://kept.example/first",
  title: "First recovered tab",
  windowId: 7,
  index: 0,
  pinned: false,
  recoveryOccurrenceId: "first-recovery-occurrence"
};
const mem = {
  suspendedRegistry: { 901: registryEntry },
  tabActivity: { 901: 1 },
  tabActivityContext: context
};

function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    async emit(...args) {
      await Promise.all([...listeners].map((listener) => listener(...args)));
    }
  };
}

const onInstalled = event();
const onStartup = event();
const storageListeners = new Set();
let registryReads = 0;
let activityBulkReads = 0;
let holdUnexpectedActivityBulkRead = scenario === "startup";
let releaseActivityBulkRead = () => {};
let markActivityBulkRead = () => {};
const activityBulkReadStarted = new Promise((resolve) => { markActivityBulkRead = resolve; });
const activityBulkReadGate = new Promise((resolve) => { releaseActivityBulkRead = resolve; });

let holdWindowQuery = scenario === "window-query";
let releaseWindowQuery = () => {};
let markWindowQuery = () => {};
const windowQueryStarted = new Promise((resolve) => { markWindowQuery = resolve; });
const windowQueryGate = new Promise((resolve) => { releaseWindowQuery = resolve; });

let firstCreatedTab = null;
let markFirstCreate = () => {};
const firstCreate = new Promise((resolve) => { markFirstCreate = resolve; });
let markFirstRecoveryPass = () => {};
const firstRecoveryPass = new Promise((resolve) => { markFirstRecoveryPass = resolve; });
let recoveryStartNotifications = 0;
let recoveryStartNotificationClears = 0;

globalThis.chrome = {
  runtime: {
    getURL: (path) => `chrome-extension://test-ext-id/${path}`,
    onInstalled,
    onStartup
  },
  i18n: { getMessage: (key) => key },
  storage: {
    local: {
      async get(keys) {
        const requested = typeof keys === "string" ? [keys] : [...keys];
        if (requested.includes("suspendedRegistry")) registryReads += 1;
        if (requested.includes("tabActivity") &&
            requested.includes("tabActivityContext") &&
            requested.includes("suspendedRegistry")) {
          activityBulkReads += 1;
          if (holdUnexpectedActivityBulkRead) {
            holdUnexpectedActivityBulkRead = false;
            markActivityBulkRead();
            await activityBulkReadGate;
          }
        }
        return Object.fromEntries(requested.filter((key) => key in mem)
          .map((key) => [key, clone(mem[key])]));
      },
      async set(values) {
        const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
          oldValue: clone(mem[key]),
          newValue: clone(value)
        }]));
        Object.assign(mem, clone(values));
        for (const listener of storageListeners) listener(changes, "local");
      }
    },
    session: {
      values: {},
      async get(key) {
        return key in this.values ? { [key]: this.values[key] } : {};
      },
      async set(values) { Object.assign(this.values, structuredClone(values)); }
    },
    onChanged: {
      addListener: (listener) => storageListeners.add(listener),
      removeListener: (listener) => storageListeners.delete(listener)
    }
  },
  windows: {
    WINDOW_ID_NONE: -1,
    async getAll(options = {}) {
      if (options.populate && holdWindowQuery) {
        holdWindowQuery = false;
        markWindowQuery();
        await windowQueryGate;
      }
      // Activity starts before Chrome tears down the old extension page. The
      // later recovery tabs.query below observes that the page has vanished.
      return options.populate
        ? [{ id: 7, type: "normal", focused: true, tabs: [
            { id: 901, windowId: 7, index: 0, active: true }
          ] }]
        : [{ id: 7, type: "normal", focused: true }];
    }
  },
  tabs: {
    query: async () => [],
    async create(properties) {
      const tab = {
        id: 2_000,
        windowId: properties.windowId ?? 7,
        index: properties.index ?? 0,
        pinned: Boolean(properties.pinned),
        url: properties.url
      };
      firstCreatedTab ??= tab;
      markFirstCreate(tab);
      return tab;
    },
    remove: async () => {}
  },
  alarms: { create: async () => {}, clear: async () => {} },
  notifications: {
    create: async () => { recoveryStartNotifications += 1; },
    update: async () => false,
    clear: async () => { recoveryStartNotificationClears += 1; return true; }
  }
};

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
installBrowserMapStorageAuthority();

const [{ tabActivity }, suspend, store, { createSuspendRecoveryOwner },
  { createWorkerStartupOwner }, { installRuntimeLifecycleOwner }] = await Promise.all([
  import("../js/lib/tab-activity.js"),
  import("../js/lib/suspend.js"),
  import("../js/lib/store.js"),
  import("../js/background/suspend-recovery-owner.js"),
  import("../js/background/worker-startup-owner.js"),
  import("../js/background/runtime-lifecycle-owner.js")
]);

const recovery = createSuspendRecoveryOwner({
  mutateStore: store.mutateStores,
  readStore: store.readStoreValue,
  recover: (options) => {
    markFirstRecoveryPass();
    return suspend.queueRecovery(options);
  },
  repairMetadata: suspend.queueSuspendMetadataRepair,
  // Exercise the reload-only branch without introducing a time budget.
  setTimer(callback, delay) {
    if (delay === 180) queueMicrotask(callback);
  }
});

const resolved = async () => {};
let releaseGrace;
const graceGate = new Promise((resolve) => { releaseGrace = resolve; });
let indexTimer;
let indexReads = 0;
let releaseMaintenance;
const maintenanceGate = new Promise((resolve) => { releaseMaintenance = resolve; });
let maintenanceStarted = 0;
const heavyMaintenance = scenario === "maintenance" ? async () => {
  maintenanceStarted += 1;
  // Replay the captured startup Snapshot/expiry contention at the real Store
  // lock boundary, without tying this regression to machine-specific timings.
  await store.withStoreLock(() => maintenanceGate);
} : resolved;
const worker = createWorkerStartupOwner({
  assets: { collect: resolved },
  identity: { ensure: resolved },
  schedules: { snapshot: resolved, suspension: resolved, inbox: resolved, rotation: resolved },
  snapshots: { take: heavyMaintenance },
  snooze: { ready: Promise.resolve(), sweep: resolved },
  inbox: { sweep: heavyMaintenance, expire: heavyMaintenance },
  badge: { refresh: resolved },
  closeDay: { resume: resolved },
  suspension: {
    retryCloseCleanups: suspend.retrySuspendedCloseCleanups,
    startRecovery: recovery.start
  },
  deferred: {
    ensureSessionIdentities: async () => { indexReads += 1; },
    scheduleGuardRecovery() {}
  },
  schedule: (callback) => { indexTimer = callback; }
});
worker.installDeferredWork();

installRuntimeLifecycleOwner({
  storage: { initialize: resolved },
  menus: { install() {} },
  worker: { prepareReload: worker.prepareReload, start: worker.start },
  newTabs: { resetCreationOrder() {} },
  activity: { beginBrowserSession: tabActivity.beginBrowserSession },
  suspension: {
    prepareReload: recovery.prepareReload,
    cancelPreparedReload: recovery.cancelPreparedReload,
    markReloadGrace: async () => {
      if (scenario === "slow-grace" || scenario === "failed-grace") await graceGate;
      if (scenario === "failed-grace") throw new Error("expected grace failure");
      return suspend.markRecoveryGrace();
    }
  },
  focus: {
    claimGuardLifecycle() {},
    markGuardGrace: resolved,
    recoverGuard: resolved,
    recoverGuardTabs: resolved
  },
  openDashboard: resolved
});

const settleTurn = () => new Promise((resolve) => setImmediate(resolve));

if (scenario === "slow-grace" || scenario === "failed-grace") {
  await tabActivity.initialize();
  const reloadLifecycle = onInstalled.emit({ reason: "update" });
  await settleTurn();
  assert.equal(recoveryStartNotifications, 1,
    "the recovery-start notification must not wait behind reload-grace storage");
  indexTimer();
  await settleTurn();
  assert.equal(indexReads, 0,
    "index maintenance must wait even when reload grace outlasts its timer");
  releaseGrace();
  if (scenario === "failed-grace") {
    await reloadLifecycle;
    await settleTurn();
    assert.equal(firstCreatedTab, null, "failed grace never starts browser recovery");
    assert.equal(recoveryStartNotificationClears, 1,
      "failed grace clears its prepared recovery notification");
    assert.equal(indexReads, 1, "failed grace releases independent index maintenance once");
    process.exit(0);
  }
  await Promise.all([reloadLifecycle, firstCreate]);
  await settleTurn();
  assert.equal(indexReads, 1, "completed recovery releases the due index exactly once");
  process.exit(0);
}

if (scenario === "maintenance") {
  await tabActivity.initialize();
  const reloadLifecycle = onInstalled.emit({ reason: "update" });
  await settleTurn();
  await settleTurn();
  const recoveredBeforeMaintenanceRelease = firstCreatedTab !== null;
  releaseMaintenance();
  assert.equal(recoveredBeforeMaintenanceRelease, true,
    "reload recovery creates tabs before optional startup maintenance can hold the Store lock");
  await Promise.all([reloadLifecycle, firstCreate]);
  await settleTurn();
  assert.equal(maintenanceStarted, 3, "all deferred maintenance still runs exactly once");
  process.exit(0);
}

if (scenario === "cleanup") {
  await tabActivity.initialize();
  const before = clone(mem);
  const registryReadsBefore = registryReads;
  const bulkReadsBefore = activityBulkReads;
  await tabActivity.forgetTab(999);
  assert.deepEqual(mem, before, "cleanup of an unknown tab is a storage no-op");
  assert.equal(registryReads, registryReadsBefore,
    "cleanup with no departure never reads the suspended registry");
  assert.equal(activityBulkReads, bulkReadsBefore,
    "cleanup with no departure never opens a combined activity/registry transaction");
  process.exit(0);
}

if (scenario === "window-query") {
  const activityInitialization = tabActivity.initialize();
  await windowQueryStarted;
  const reloadLifecycle = onInstalled.emit({ reason: "update" });
  await firstRecoveryPass;
  await settleTurn();
  const createdBeforeQueryReleased = firstCreatedTab !== null;
  releaseWindowQuery();
  await Promise.all([activityInitialization, reloadLifecycle, firstCreate]);
  assert.equal(createdBeforeQueryReleased, true,
    "first recovery browser effect does not wait for activity window inventory");
  process.exit(0);
}

assert.equal(scenario, "startup", `unknown scenario: ${scenario}`);
const activityInitialization = tabActivity.initialize();
const initializationBoundary = await Promise.race([
  activityInitialization.then(() => "settled"),
  activityBulkReadStarted.then(() => "registry")
]);
const unchangedInitialization = initializationBoundary === "settled" &&
  JSON.stringify(mem.tabActivity) === JSON.stringify({ 901: 1 }) &&
  JSON.stringify(mem.tabActivityContext) === JSON.stringify(context) &&
  JSON.stringify(mem.suspendedRegistry) === JSON.stringify({ 901: registryEntry });
const reloadLifecycle = onInstalled.emit({ reason: "update" });
await settleTurn();
await settleTurn();
const firstCreateBeforeActivityRelease = firstCreatedTab !== null;

// Let the old implementation settle too, so a red result cannot strand a
// lock or an asynchronous production owner in the child process.
releaseActivityBulkRead();
await Promise.all([activityInitialization, reloadLifecycle, firstCreate]);

assert.equal(activityBulkReads, 0,
  "unchanged activity initialization never reads the suspended registry");
assert.equal(unchangedInitialization, true,
  "unchanged initialization preserves the activity, context, and registry values");
assert.equal(firstCreateBeforeActivityRelease, true,
  "first suspended-tab browser effect never waits for an activity registry read");
process.exit(0);
