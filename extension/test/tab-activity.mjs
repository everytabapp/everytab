import assert from "node:assert/strict";

const { createTabActivityOwner, ACTIVITY_KEY, ACTIVITY_CONTEXT_KEY } = await import(
  "../js/lib/tab-activity.js"
);

let currentNow = 1_000;
let windows = [
  {
    id: 1,
    focused: true,
    tabs: [
      { id: 11, windowId: 1, active: true },
      { id: 12, windowId: 1, active: false }
    ]
  },
  {
    id: 2,
    focused: false,
    tabs: [
      { id: 21, windowId: 2, active: true },
      { id: 22, windowId: 2, active: false }
    ]
  }
];
const stored = {};
let storeChain = Promise.resolve();
let holdNextMutation = false;
let releaseHeldMutation = () => {};
let rejectWindowInventory = false;
let registryBulkReads = 0;
let afterNextMutation = null;

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const readStoreValue = async (key) => clone(stored[key]);
const mutateStores = (keys, mutate) => {
  const run = async () => {
    if (keys.includes("suspendedRegistry")) registryBulkReads += 1;
    if (holdNextMutation) {
      holdNextMutation = false;
      await new Promise((resolve) => { releaseHeldMutation = resolve; });
    }
    const maps = Object.fromEntries(keys
      .filter((key) => key in stored)
      .map((key) => [key, clone(stored[key])]));
    const changes = mutate(maps);
    if (changes) Object.assign(stored, clone(changes));
    const after = afterNextMutation;
    afterNextMutation = null;
    if (after) await after(keys, changes);
    return Boolean(changes);
  };
  const result = storeChain.then(run, run);
  storeChain = result.catch(() => {});
  return result;
};
const tabs = {
  async query(query = {}) {
    const all = windows.flatMap((win) => win.tabs);
    return all.filter((tab) =>
      (query.windowId === undefined || tab.windowId === query.windowId) &&
      (query.active === undefined || tab.active === query.active));
  }
};
const windowsApi = {
  async getAll() {
    if (rejectWindowInventory) throw new Error("window inventory unavailable");
    return clone(windows);
  }
};
const makeOwner = () => createTabActivityOwner({
  readStoreValue,
  mutateStores,
  tabs,
  windows: windowsApi,
  now: () => currentNow,
  windowIdNone: -1
});

let owner = makeOwner();

stored[ACTIVITY_KEY] = { 11: 10, 12: 20 };
registryBulkReads = 0;
await owner.initialize();
assert.deepEqual(stored[ACTIVITY_KEY], {},
  "a profile without foreground context gets one conservative fresh clock");
assert.deepEqual(stored[ACTIVITY_CONTEXT_KEY], {
  focusedWindowId: 1,
  activeByWindow: { 1: 11, 2: 21 }
});
assert.equal(registryBulkReads, 0,
  "a missing-context startup grants grace without reading the recovery registry");
delete stored[ACTIVITY_KEY];
delete stored[ACTIVITY_CONTEXT_KEY];
owner = makeOwner();
registryBulkReads = 0;
await owner.recordActivation(11, 1);
assert.deepEqual(stored[ACTIVITY_KEY] ?? {}, {},
  "missing context seeds the foreground tab without inventing a past leave");
assert.deepEqual(stored[ACTIVITY_CONTEXT_KEY], {
  focusedWindowId: null,
  activeByWindow: { 1: 11 }
});
await owner.recordWindowFocus(1);
assert.equal(registryBulkReads, 0,
  "activation and focus setup with no known departure avoid the recovery registry");

stored[ACTIVITY_KEY] = { 12: 50 };
stored.suspendedRegistry = { 11: { recoveryOccurrenceId: "exact-11" } };
registryBulkReads = 0;
afterNextMutation = async (keys) => {
  assert.deepEqual(keys, [ACTIVITY_CONTEXT_KEY],
    "the first departure decision is a lightweight context-only mutation");
  stored.suspendedRegistry[11] = {
    ...stored.suspendedRegistry[11],
    concurrentRegistryField: "preserved"
  };
};
currentNow = 2_000;
windows[0].tabs[0].active = false;
windows[0].tabs[1].active = true;
await owner.recordActivation(12, 1);
assert.deepEqual(stored[ACTIVITY_KEY], { 11: 2_000, 12: 50 },
  "switching tabs starts the prior tab's away clock without consuming the new tab's grace");
assert.equal(stored.suspendedRegistry[11].awayAt, 2_000,
  "leaving a suspended occurrence preserves the same clock for an internal recovery rekey");
assert.equal(stored.suspendedRegistry[11].concurrentRegistryField, "preserved",
  "the full departure mutation rereads and preserves a registry update after its lightweight decision");
assert.equal(registryBulkReads, 1,
  "one actual suspended departure performs exactly one coherent registry read");

registryBulkReads = 0;
for (let index = 100; index < 200; index += 1) {
  stored.suspendedRegistry[index] = { recoveryOccurrenceId: `mature-${index}` };
}
for (let index = 0; index < 12; index += 1) {
  await owner.recordActivation(12, 1);
  await owner.recordWindowFocus(1);
}
stored[ACTIVITY_KEY][99] = 99;
stored[ACTIVITY_CONTEXT_KEY].activeByWindow[99] = 99;
await owner.forgetTab(99);
stored[ACTIVITY_CONTEXT_KEY].activeByWindow[98] = 98;
await owner.forgetWindow(98);
await owner.forgetTab(9_999);
await owner.forgetWindow(9_999);
assert.equal(registryBulkReads, 0,
  "a burst of no-op activation/focus and real or no-op cleanup never reads a mature recovery registry");
delete stored.suspendedRegistry;

currentNow = 3_000;
windows[1].tabs[0].active = false;
windows[1].tabs[1].active = true;
await owner.recordActivation(22, 2);
assert.deepEqual(stored[ACTIVITY_KEY], { 11: 2_000, 12: 50 },
  "a selected-tab change in an unfocused window does not claim human activity");
assert.equal(stored[ACTIVITY_CONTEXT_KEY].activeByWindow[2], 22);
assert.equal(registryBulkReads, 0,
  "an unfocused-window activation updates context without reading the recovery registry");

currentNow = 4_000;
windows[0].focused = false;
windows[1].focused = true;
await owner.recordWindowFocus(2);
assert.equal(stored[ACTIVITY_KEY][12], 4_000,
  "moving to another window starts the tab actually left in the prior foreground window");
assert.equal(stored[ACTIVITY_KEY][22], undefined,
  "the arriving foreground tab is not stamped while it is being read");

currentNow = 5_000;
await owner.recordWindowFocus(-1);
assert.equal(stored[ACTIVITY_KEY][22], 5_000,
  "losing browser focus starts the last foreground tab's away clock");
currentNow = 6_000;
await owner.recordWindowFocus(2);
assert.equal(stored[ACTIVITY_KEY][22], 5_000,
  "returning from WINDOW_ID_NONE does not reset the selected tab before it is left again");

stored[ACTIVITY_KEY] = { 11: 1, 12: 2, 21: 3, 22: 4 };
stored[ACTIVITY_CONTEXT_KEY] = {
  focusedWindowId: 99,
  activeByWindow: { 99: 11 }
};
currentNow = 7_000;
await owner.beginBrowserSession();
assert.deepEqual(stored[ACTIVITY_KEY], {},
  "a full browser start clears reusable tab-id clocks and grants fresh grace");
assert.deepEqual(stored[ACTIVITY_CONTEXT_KEY], {
  focusedWindowId: 2,
  activeByWindow: { 1: 12, 2: 22 }
}, "browser start seeds selected tabs in every live window and the exact focused window");

stored.suspendedRegistry = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
  300 + index,
  { recoveryOccurrenceId: `startup-${index}` }
]));
stored.suspendedRegistry[22] = { recoveryOccurrenceId: "startup-foreground" };
registryBulkReads = 0;
owner = makeOwner();
await owner.initialize();
assert.equal(registryBulkReads, 0,
  "an unchanged ordinary worker startup avoids a mature recovery registry");

// Recreating only the module owner models an ordinary MV3 worker restart. The
// durable context must survive so the next leave can still stamp the prior tab.
currentNow = 8_000;
windows[1].tabs[0].active = true;
windows[1].tabs[1].active = false;
await owner.initialize();
assert.equal(stored[ACTIVITY_KEY][22], 8_000,
  "worker initialization reconciles a foreground selection changed while it was asleep");
assert.equal(registryBulkReads, 1,
  "a changed foreground identity performs the one legitimate startup registry read");
assert.equal(stored.suspendedRegistry[22].awayAt, 8_000,
  "changed-foreground startup reconciliation preserves the suspended occurrence clock");
await owner.recordActivation(21, 2);
assert.equal(stored[ACTIVITY_KEY][22], 8_000,
  "an ordinary worker restart retains the previous foreground identity");

const sweepSnapshot = { 11: 100, 77: 100 };
stored[ACTIVITY_KEY] = clone(sweepSnapshot);
stored[ACTIVITY_CONTEXT_KEY] = {
  focusedWindowId: 1,
  activeByWindow: { 1: 11 }
};
holdNextMutation = true;
const pendingSweep = owner.reconcileSweep({
  snapshot: sweepSnapshot,
  liveIds: new Set([11, 12]),
  firstSeenIds: new Set([12]),
  forgetIds: new Set()
});
const pendingActivation = owner.recordActivation(12, 1, 9_000);
await new Promise((resolve) => setImmediate(resolve));
releaseHeldMutation();
await Promise.all([pendingSweep, pendingActivation]);
assert.deepEqual(stored[ACTIVITY_KEY], { 11: 9_000, 12: 8_000 },
  "an activation queued during sweep reconciliation wins without restoring a stale snapshot");

assert.equal(await owner.isOlderThan(11, 8_500), false,
  "timer revalidation reads the fresh leave clock");
stored[ACTIVITY_KEY][21] = 100;
assert.equal(await owner.isOlderThan(21, 8_500), true,
  "timer revalidation retains a genuinely old away clock");
stored[ACTIVITY_KEY][12] = 1;
assert.equal(await owner.isOlderThan(12, 8_500), false,
  "an old retained timestamp can never make the current foreground tab eligible");
stored[ACTIVITY_KEY][31] = 200;
await owner.reconcileSweep({
  snapshot: { 31: 100 },
  liveIds: new Set(),
  firstSeenIds: new Set(),
  forgetIds: new Set([31])
});
assert.equal(stored[ACTIVITY_KEY][31], 200,
  "cleanup cannot delete a newer clock that reused a planned tab id");

stored[ACTIVITY_KEY] = { 91: 1 };
holdNextMutation = true;
const pendingInitialization = owner.initialize();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(await owner.getMap({ waitForContext: false }), {},
  "a count cap can use Chrome age without waiting on clock initialization");
releaseHeldMutation();
await pendingInitialization;

stored[ACTIVITY_KEY] = { 92: 1 };
rejectWindowInventory = true;
await owner.beginBrowserSession().catch(() => {});
rejectWindowInventory = false;
assert.deepEqual(await owner.getMap({ waitForContext: false }), {},
  "a cap falls back to Chrome age after activity initialization fails");
assert.deepEqual(stored[ACTIVITY_KEY], {},
  "a rejected browser inventory still leaves the durable old-session clock cleared");
owner = makeOwner();
await owner.initialize();
assert.equal(stored[ACTIVITY_KEY][92], undefined,
  "a later MV3 worker cannot revive a reused id after the failed browser start");

console.log("PASS: the local activity owner measures time after leaving a tab");
