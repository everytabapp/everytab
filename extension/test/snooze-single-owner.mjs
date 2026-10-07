import assert from "node:assert/strict";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { STORE_KEYS } from "../js/lib/types.js";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() },
  configurable: true,
  writable: true
});

let storage = createInterleavableStorage({ deviceId: "device-a" });
let createdTabs = [];
let createdWindows = [];
let alarms = {};
let failTabs = false;
let failWindowNumber = 0;

globalThis.chrome = {
  storage: { local: storage.local },
  tabs: {
    create: async (props) => {
      if (failTabs) throw new Error("tab create failed");
      createdTabs.push(structuredClone(props));
      return { id: 100 + createdTabs.length, ...props };
    }
  },
  windows: {
    create: async (props) => {
      if (failWindowNumber && createdWindows.length + 1 === failWindowNumber) {
        throw new Error("window create failed");
      }
      createdWindows.push(structuredClone(props));
      const id = 200 + createdWindows.length;
      return { id, tabs: (Array.isArray(props.url) ? props.url : [props.url])
        .map((url, index) => ({ id: id * 10 + index, windowId: id, pendingUrl: url })) };
    }
  },
  alarms: {
    create: async (name, details) => { alarms[name] = structuredClone(details); },
    clear: async (name) => delete alarms[name]
  },
  i18n: createChromeI18nMock(),
  notifications: { create: async () => "notification" },
  action: {
    // Avoid the six-second badge-clear timer in this focused data-path test.
    setBadgeText: async () => { throw new Error("badge unavailable"); },
    setBadgeBackgroundColor: async () => {}
  },
  runtime: { getURL: (path) => `chrome-extension://test/${path}` }
};

const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();

const {
  SNOOZE_DELIVERY_KEY, fireSnooze, recoverInterruptedSnoozeDeliveries
} = await import("../js/lib/snooze-delivery.js");
const { sweepOverdueSnoozes } = await import("../js/lib/snooze.js");

function snooze(id, extra = {}) {
  return {
    id,
    deviceId: "device-a",
    createdAt: 1_000,
    modifiedAt: 1_000,
    schemaVersion: 1,
    url: `https://${id}.example/`,
    title: id,
    dueAt: Date.now() - 1_000,
    ...extra
  };
}

function install(seed) {
  storage = createInterleavableStorage({ deviceId: "device-a", ...seed });
  chrome.storage.local = storage.local;
  createdTabs = [];
  createdWindows = [];
  alarms = {};
  failTabs = false;
  failWindowNumber = 0;
}

// Two independent extension contexts still converge through the persisted
// claim, even though their in-memory coalescers cannot see one another.
{
  const item = snooze("cross-context");
  install({ [STORE_KEYS.snoozes]: { [item.id]: item } });
  const contextA = await import("../js/lib/snooze-delivery.js?context=a");
  const contextB = await import("../js/lib/snooze-delivery.js?context=b");
  const results = await Promise.all([
    contextA.fireSnooze(item.id),
    contextB.fireSnooze(item.id)
  ]);
  assert.equal(createdTabs.length, 1);
  assert.equal(results.some((result) => result.status === "delivered"), true);
  assert.equal(results.filter((result) => result.status === "delivered").length, 1);
  assert.equal(storage.snapshot().counters.snoozesFired, 1);
}

// One-shot: startup/alarm/manual overlap has one owner and one terminal commit.
{
  const item = snooze("concurrent-one-shot");
  install({ [STORE_KEYS.snoozes]: { [item.id]: item } });
  const results = await Promise.all([
    fireSnooze(item.id),
    fireSnooze(item.id),
    fireSnooze(item.id)
  ]);
  assert.equal(createdTabs.length, 1);
  assert.equal(results.every((result) => result.status === "delivered"), true,
    "overlapping same-worker callers join the one delivery result");
  assert.equal(storage.snapshot().counters?.snoozesFired, 1);
  assert.ok(storage.snapshot()[STORE_KEYS.snoozes][item.id].deletedAt);
  assert.equal(storage.snapshot()[SNOOZE_DELIVERY_KEY][item.id].phase, "complete");
}

// Recurring: the next occurrence and counter advance exactly once.
{
  const item = snooze("concurrent-recurring", { recurrence: "daily" });
  install({ [STORE_KEYS.snoozes]: { [item.id]: item } });
  await Promise.all([fireSnooze(item.id), fireSnooze(item.id)]);
  const state = storage.snapshot();
  assert.equal(createdTabs.length, 1);
  assert.equal(state.counters.snoozesFired, 1);
  assert.ok(state[STORE_KEYS.snoozes][item.id].dueAt > Date.now());
  assert.equal(state[STORE_KEYS.snoozes][item.id].deletedAt, undefined);
}

// Whole-window Snooze: one Chrome window with the complete saved order.
{
  const item = snooze("window", {
    url: "",
    tabs: [
      { url: "https://one.example/", title: "One" },
      { url: "chrome://settings/", title: "Internal" },
      { url: "https://two.example/", title: "Two" }
    ]
  });
  install({ [STORE_KEYS.snoozes]: { [item.id]: item } });
  await Promise.all([fireSnooze(item.id), fireSnooze(item.id)]);
  assert.deepEqual(createdWindows, [{ url: ["https://one.example/", "https://two.example/"] }]);
}

// Session Snooze: read the latest Session live, restore each window once, and
// never consume or rewrite the Session template.
{
  const item = snooze("session-wake", { url: "", sessionId: "session-1" });
  const session = {
    id: "session-1", deviceId: "device-a", createdAt: 500, modifiedAt: 700,
    schemaVersion: 1, name: "Work", auto: false, labels: [],
    windows: [
      [{ url: "https://a.example/", title: "A" }],
      [{ url: "https://b.example/", title: "B" }, { url: "https://c.example/", title: "C" }]
    ]
  };
  install({
    [STORE_KEYS.snoozes]: { [item.id]: item },
    [STORE_KEYS.sessions]: { [session.id]: session }
  });
  await Promise.all([fireSnooze(item.id), fireSnooze(item.id)]);
  assert.deepEqual(createdWindows, [
    { url: ["https://a.example/"] },
    { url: ["https://b.example/", "https://c.example/"] }
  ]);
  assert.deepEqual(storage.snapshot()[STORE_KEYS.sessions][session.id], session);
}

// A multi-window Session that stops after a partial Chrome effect becomes an
// interrupted, user-recoverable Snooze. Automatic owners never repeat it.
{
  const item = snooze("partial-session", { url: "", sessionId: "session-partial" });
  const session = {
    id: "session-partial", deviceId: "device-a", createdAt: 500, modifiedAt: 700,
    schemaVersion: 1, name: "Partial", auto: false, labels: [],
    windows: [
      [{ url: "https://first-window.example/", title: "First" }],
      [{ url: "https://second-window.example/", title: "Second" }]
    ]
  };
  install({
    [STORE_KEYS.snoozes]: { [item.id]: item },
    [STORE_KEYS.sessions]: { [session.id]: session }
  });
  failWindowNumber = 2;
  assert.equal((await fireSnooze(item.id)).status, "interrupted");
  assert.equal(createdWindows.length, 1);
  assert.equal(storage.snapshot()[SNOOZE_DELIVERY_KEY][item.id].phase, "incomplete");
  assert.equal(storage.snapshot().counters, undefined);
  assert.equal((await fireSnooze(item.id, { manual: false })).status, "interrupted");
  assert.equal(createdWindows.length, 1);
}

// A rejected Chrome create has an ambiguous outcome. Its claim stays terminal
// for the occurrence, and neither automatic nor explicit Wake can replay it.
{
  const item = snooze("known-failure");
  install({ [STORE_KEYS.snoozes]: { [item.id]: item } });
  failTabs = true;
  assert.equal((await fireSnooze(item.id)).status, "interrupted");
  assert.equal(storage.snapshot()[SNOOZE_DELIVERY_KEY]?.[item.id].phase, "incomplete");
  assert.equal(alarms[`snooze:${item.id}`], undefined);
  failTabs = false;
  assert.equal((await fireSnooze(item.id)).status, "interrupted");
  assert.equal(createdTabs.length, 0);
}

// A stopped worker's uncertain browser-effect phase is never replayed by an
// automatic path. The Snooze remains live until the user reschedules or cancels it.
{
  const item = snooze("interrupted");
  install({
    [STORE_KEYS.snoozes]: { [item.id]: item },
    [SNOOZE_DELIVERY_KEY]: {
      [item.id]: {
        snoozeId: item.id,
        claimId: "old-claim",
        ownerDeviceId: "device-a",
        ownerInstanceId: "stopped-worker",
        occurrenceDueAt: item.dueAt,
        sourceModifiedAt: item.modifiedAt,
        claimedAt: Date.now() - 5_000,
        phase: "effects"
      }
    }
  });
  assert.equal(await recoverInterruptedSnoozeDeliveries(), 1);
  assert.equal(storage.snapshot()[SNOOZE_DELIVERY_KEY][item.id].phase, "incomplete");
  assert.equal((await fireSnooze(item.id, { manual: false })).status, "interrupted");
  assert.equal(createdTabs.length, 0, "startup/alarm recovery cannot duplicate an uncertain wake");
  assert.equal((await fireSnooze(item.id, { manual: true })).status, "interrupted");
  assert.equal(createdTabs.length, 0, "an explicit Wake cannot duplicate an unknown effect");
}

// Automatic ownership stays on the Snooze's originating device; an explicit
// user Wake remains available on a synced device.
{
  const item = snooze("foreign", { deviceId: "device-b" });
  install({ [STORE_KEYS.snoozes]: { [item.id]: item } });
  assert.equal((await fireSnooze(item.id, { manual: false })).status, "other-device");
  assert.equal(createdTabs.length, 0);
  assert.equal((await fireSnooze(item.id, { manual: true })).status, "delivered");
  assert.equal(createdTabs.length, 1);
}

// Startup's missed-alarm sweep uses the same automatic owner and stays
// idempotent when invoked more than once.
{
  const item = snooze("missed-alarm");
  install({ [STORE_KEYS.snoozes]: { [item.id]: item } });
  await Promise.all([sweepOverdueSnoozes(), sweepOverdueSnoozes()]);
  assert.equal(createdTabs.length, 1);
  assert.equal(storage.snapshot().counters.snoozesFired, 1);
}

console.log("PASS: Snooze delivery has one persisted owner and honest recovery");
