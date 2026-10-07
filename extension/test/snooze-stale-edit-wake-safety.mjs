import assert from "node:assert/strict";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { STORE_KEYS } from "../js/lib/types.js";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true, writable: true
});

let storage;
let createdTabs;
let createdWindows;
let alarmEvents;
let tabHook;
let windowHook;
let createdWindow;

function install(seed) {
  storage = createInterleavableStorage({ deviceId: "device-a", ...seed });
  chrome.storage.local = storage.local;
  createdTabs = [];
  createdWindows = [];
  alarmEvents = [];
  tabHook = null;
  windowHook = null;
  createdWindow = null;
}

globalThis.chrome = {
  storage: { local: null },
  tabs: {
    create: async (details) => {
      if (tabHook) return tabHook(details);
      const tab = { id: 100 + createdTabs.length, windowId: 7, ...details };
      createdTabs.push(structuredClone(tab));
      return tab;
    }
  },
  windows: {
    create: async (details) => {
      if (windowHook) return windowHook(details);
      const id = 200 + createdWindows.length;
      const tabs = (Array.isArray(details.url) ? details.url : [details.url])
        .map((url, index) => ({ id: id * 10 + index, windowId: id, pendingUrl: url }));
      createdWindow = { id, tabs };
      createdWindows.push(structuredClone(details));
      return structuredClone(createdWindow);
    },
    get: async (id) => id === createdWindow?.id ? structuredClone(createdWindow) : null
  },
  alarms: {
    create: async (name, details) => {
      alarmEvents.push({ kind: "create", name, details: structuredClone(details),
        state: storage.snapshot() });
    },
    clear: async (name) => {
      alarmEvents.push({ kind: "clear", name, state: storage.snapshot() });
      return true;
    }
  },
  i18n: createChromeI18nMock(),
  notifications: { create: async () => "notification" },
  action: {
    setBadgeText: async () => { throw new Error("badge unavailable"); },
    setBadgeBackgroundColor: async () => {}
  },
  runtime: { getURL: (path) => `chrome-extension://test/${path}` }
};

install({});
const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();
const {
  cancelSnoozeJournaled, cancelSnoozeTabs, rescheduleSnooze, wakeSnoozeTabs
} = await import("../js/lib/snooze.js");
const {
  SNOOZE_DELIVERY_KEY, fireSnooze, recoverInterruptedSnoozeDeliveries
} = await import("../js/lib/snooze-delivery.js");
const { undoAction } = await import("../js/lib/journal.js");

function snooze(id, extra = {}) {
  return {
    id, deviceId: "device-a", createdAt: 100, modifiedAt: 200,
    schemaVersion: 1, url: `https://${id}.example/`, title: id,
    dueAt: 50_000, ...extra
  };
}

// Same-millisecond content changes are stale. Edits refuse without storage,
// Alarm, browser, or Journal effects.
{
  const expected = snooze("stale-edit");
  const current = { ...expected, title: "new title" };
  install({ snoozes: { [current.id]: current } });
  assert.deepEqual(await rescheduleSnooze(expected, 90_000), { ok: false, reason: "stale" });
  assert.deepEqual(await cancelSnoozeJournaled(expected), { ok: false, reason: "stale" });
  assert.deepEqual(storage.snapshot().snoozes[current.id], current);
  assert.equal(storage.snapshot().journal, undefined);
  assert.deepEqual(alarmEvents, []);
}

// A durable reschedule updates the current record and local placement before
// the Alarm call. An incomplete old occurrence is deliberately recoverable by
// choosing a new due time; an active effect still rejects the edit.
{
  const expected = snooze("reschedule");
  const receipt = {
    snoozeId: expected.id, claimId: "old", occurrenceDueAt: expected.dueAt,
    ownerInstanceId: "old", phase: "incomplete"
  };
  install({
    snoozes: { [expected.id]: expected },
    snoozePlacements: { [expected.id]: { snoozeId: expected.id,
      occurrenceDueAt: expected.dueAt, sourceWindowId: 7, index: 2, pinned: false,
      peerUrls: [], capturedAt: 1 } },
    [SNOOZE_DELIVERY_KEY]: { [expected.id]: receipt }
  });
  const result = await rescheduleSnooze(expected, 90_000);
  assert.equal(result.ok, true);
  assert.equal(result.snooze.dueAt, 90_000);
  assert.equal(alarmEvents[0].state.snoozes[expected.id].dueAt, 90_000);
  assert.equal(alarmEvents[0].state.snoozePlacements[expected.id].occurrenceDueAt, 90_000);

  const live = result.snooze;
  await storage.local.set({ [SNOOZE_DELIVERY_KEY]: { [live.id]: {
    ...receipt, occurrenceDueAt: live.dueAt, phase: "effects"
  } } });
  assert.deepEqual(await cancelSnoozeJournaled(live), { ok: false, reason: "busy" });
}

// Cancel and bulk Cancel derive Undo from the exact fresh pre-state, de-dupe
// repeated occurrences, validate bounds, and clear only after commit.
{
  const item = snooze("cancel", { url: "", title: "Window (2 tabs)", tabs: [
    { url: "https://one.example/", title: "One" },
    { url: "https://two.example/", title: "Two" }
  ] });
  install({ snoozes: { [item.id]: item } });
  assert.equal(await cancelSnoozeTabs([
    { snooze: item, indexes: [1, 1] }, { snooze: structuredClone(item), indexes: [1] }
  ]), 1);
  assert.deepEqual(storage.snapshot().snoozes[item.id].tabs,
    [{ url: "https://one.example/", title: "One" }]);
  assert.deepEqual(storage.snapshot().journal[0].puts[0].item, item);
  assert.equal(alarmEvents.length, 0, "a retained split keeps its existing alarm");
  const current = storage.snapshot().snoozes[item.id];
  assert.equal(await cancelSnoozeTabs([{ snooze: current, indexes: [4] }]), 0);
  assert.deepEqual(storage.snapshot().snoozes[item.id], current);
}

// Bulk Wake claims before Chrome, consumes confirmed occurrences, removes the
// known-complete claim atomically, and remains exactly Undoable.
{
  const item = snooze("wake", { url: "", tabs: [
    { url: "https://one.example/", title: "One" },
    { url: "https://two.example/", title: "Two" }
  ] });
  install({ snoozes: { [item.id]: item } });
  windowHook = async (details) => {
    assert.equal(storage.snapshot()[SNOOZE_DELIVERY_KEY][item.id].phase, "effects");
    const id = 300;
    createdWindow = { id, tabs: details.url.map((url, index) =>
      ({ id: 3_000 + index, windowId: id, pendingUrl: url })) };
    createdWindows.push(structuredClone(details));
    return structuredClone(createdWindow);
  };
  assert.equal(await wakeSnoozeTabs([{ snooze: item, indexes: [0, 1, 1] }]), 2);
  assert.ok(storage.snapshot().snoozes[item.id].deletedAt);
  assert.equal(storage.snapshot()[SNOOZE_DELIVERY_KEY]?.[item.id], undefined);
  await undoAction();
  const revived = storage.snapshot().snoozes[item.id];
  assert.equal(revived.deletedAt, undefined);
  assert.equal(await wakeSnoozeTabs([{ snooze: revived, indexes: [0, 1] }]), 2);
}

// A complete receipt left by whole-card/automatic delivery cannot be
// overwritten by a bulk claim for the same id + due occurrence.
{
  const item = snooze("complete-owner");
  install({
    snoozes: { [item.id]: item },
    [SNOOZE_DELIVERY_KEY]: { [item.id]: {
      snoozeId: item.id, claimId: "complete", occurrenceDueAt: item.dueAt,
      ownerInstanceId: "prior", phase: "complete", completedAt: 60_000
    } }
  });
  assert.equal(await wakeSnoozeTabs([{ snooze: item, indexes: [0] }]), 0);
  assert.equal(createdTabs.length, 0);
  assert.deepEqual(storage.snapshot().snoozes[item.id], item);
}

// A later Chrome failure settles confirmed sources only. Unknown sources stay
// intact with an incomplete receipt that blocks manual and automatic replay.
{
  const first = snooze("partial-first");
  const second = snooze("partial-second");
  install({ snoozes: { [first.id]: first, [second.id]: second } });
  let call = 0;
  tabHook = async (details) => {
    call += 1;
    if (call === 2) throw new Error("ambiguous create failure");
    const tab = { id: 400, windowId: 7, ...details };
    createdTabs.push(tab);
    return tab;
  };
  await assert.rejects(
    wakeSnoozeTabs([
      { snooze: first, indexes: [0] }, { snooze: second, indexes: [0] }
    ]),
    (error) => error.name === "SnoozeWakeIncompleteError" && error.opened === 1 &&
      error.reason === "interrupted"
  );
  const state = storage.snapshot();
  assert.ok(state.snoozes[first.id].deletedAt);
  assert.equal(state.snoozes[second.id].deletedAt, undefined);
  assert.equal(state.journal[0].puts.length, 1);
  assert.equal(state[SNOOZE_DELIVERY_KEY][first.id], undefined);
  assert.equal(state[SNOOZE_DELIVERY_KEY][second.id].phase, "incomplete");
  assert.equal((await fireSnooze(second.id, { manual: false })).status, "interrupted");
  assert.equal((await fireSnooze(second.id, { manual: true })).status, "interrupted");
  assert.equal(call, 2);
  const editedSecond = { ...state.snoozes[second.id], title: "same due, newer content" };
  await storage.local.set({ snoozes: {
    ...storage.snapshot().snoozes, [second.id]: editedSecond
  } });
  assert.equal((await fireSnooze(second.id, { manual: false })).status, "interrupted",
    "id + due ownership blocks an unknown effect even after a same-due edit");
}

// A same-due source edit after a confirmed browser effect is preserved. The
// receipt terminalizes uncertainty and no false Journal/counter is recorded.
{
  const item = snooze("post-effect");
  const changed = { ...item, title: "changed after open", modifiedAt: item.modifiedAt };
  install({ snoozes: { [item.id]: item } });
  tabHook = async (details) => {
    await storage.local.set({ snoozes: { [item.id]: changed } });
    return { id: 500, windowId: 7, ...details };
  };
  await assert.rejects(wakeSnoozeTabs([{ snooze: item, indexes: [0] }]),
    (error) => error.opened === 1 && error.reason === "interrupted");
  const state = storage.snapshot();
  assert.deepEqual(state.snoozes[item.id], changed);
  assert.equal(state.journal, undefined);
  assert.equal(state.counters, undefined);
  assert.equal(state[SNOOZE_DELIVERY_KEY][item.id].reason, "source-changed");
}

// Whole-card Wake validates its reviewed snapshot, and automatic delivery
// terminalizes a same-due edit that lands after its browser effect.
{
  const expected = snooze("whole-card");
  const current = { ...expected, title: "new same-ms title" };
  install({ snoozes: { [current.id]: current } });
  assert.equal((await fireSnooze(current.id, { expected })).status, "stale");
  assert.equal(createdTabs.length, 0);

  tabHook = async (details) => {
    const changed = { ...current, title: "changed during delivery" };
    await storage.local.set({ snoozes: { [current.id]: changed } });
    return { id: 550, windowId: 7, ...details };
  };
  assert.equal((await fireSnooze(current.id, { manual: false })).status, "interrupted");
  assert.equal(storage.snapshot().snoozes[current.id].title, "changed during delivery");
  assert.equal(storage.snapshot().counters, undefined);
  assert.equal(storage.snapshot()[SNOOZE_DELIVERY_KEY][current.id].reason, "source-changed");
}

// An expected-bearing caller never inherits another same-id delivery promise;
// it reaches persisted exact arbitration and reports its own stale snapshot.
{
  const current = snooze("active-expected");
  const stale = { ...current, title: "stale" };
  install({ snoozes: { [current.id]: current } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  tabHook = async (details) => {
    entered();
    await gate;
    return { id: 575, windowId: 7, ...details };
  };
  const automatic = fireSnooze(current.id, { manual: false });
  await started;
  assert.equal((await fireSnooze(current.id, { expected: stale })).status, "stale");
  release();
  assert.equal((await automatic).status, "delivered");
}

// A fulfilled whole-window create without returned/queryable tab identities is
// not evidence that all requested occurrences opened, even when it returns an id.
{
  const item = snooze("undefined-window", { url: "", tabs: [
    { url: "https://one.example/", title: "One" },
    { url: "https://two.example/", title: "Two" }
  ] });
  install({ snoozes: { [item.id]: item } });
  windowHook = async () => ({ id: 626 });
  assert.equal((await fireSnooze(item.id, { manual: false })).status, "interrupted");
  assert.equal(storage.snapshot().snoozes[item.id].deletedAt, undefined);
  assert.equal(storage.snapshot()[SNOOZE_DELIVERY_KEY][item.id].phase, "incomplete");
}

// Missing/duplicate browser evidence never consumes a saved occurrence, and a
// large favicon is never copied into the bounded ownership receipt.
{
  const item = snooze("unconfirmed-window", { url: "", favIconUrl: "x".repeat(200_000), tabs: [
    { url: "https://same.example/", title: "First" },
    { url: "https://same.example/", title: "Second" }
  ] });
  install({ snoozes: { [item.id]: item } });
  windowHook = async () => {
    createdWindow = { id: 600, tabs: [
      { id: 6_001, windowId: 600, pendingUrl: "https://same.example/" }
    ] };
    return structuredClone(createdWindow);
  };
  await assert.rejects(wakeSnoozeTabs([{ snooze: item, indexes: [0, 1] }]),
    (error) => error.opened === 0);
  const state = storage.snapshot();
  assert.deepEqual(state.snoozes[item.id], item);
  assert.equal(state.journal, undefined);
  const receiptJson = JSON.stringify(state[SNOOZE_DELIVERY_KEY][item.id]);
  assert.ok(receiptJson.length < 1_000 && !receiptJson.includes("xxxx"),
    "delivery ownership never copies the Snooze payload into its receipt");
}

// Returned tabs without the exact created-window identity are not confirmation.
{
  const item = snooze("malformed-window", { url: "", tabs: [
    { url: "https://first.example/", title: "First" },
    { url: "https://second.example/", title: "Second" }
  ] });
  install({ snoozes: { [item.id]: item } });
  windowHook = async () => {
    createdWindow = { id: 625, tabs: [
      { id: 6_251, pendingUrl: "https://first.example/" },
      { id: 6_252, windowId: 999, pendingUrl: "https://second.example/" }
    ] };
    return structuredClone(createdWindow);
  };
  await assert.rejects(wakeSnoozeTabs([{ snooze: item, indexes: [0, 1] }]),
    (error) => error.opened === 0);
  assert.deepEqual(storage.snapshot().snoozes[item.id], item);
}

// A settlement commit failure exposes confirmed opens while the durable claim
// remains recoverable to a non-replayable incomplete state after restart.
{
  const item = snooze("settlement-failure");
  install({ snoozes: { [item.id]: item } });
  const realSet = storage.local.set;
  let failSettlement = true;
  chrome.storage.local = {
    ...storage.local,
    set: async (sets) => {
      if (failSettlement && sets.snoozes && sets.journal && sets[SNOOZE_DELIVERY_KEY]) {
        failSettlement = false;
        throw new Error("settlement storage failed");
      }
      return realSet(sets);
    }
  };
  await assert.rejects(wakeSnoozeTabs([{ snooze: item, indexes: [0] }]),
    (error) => error.opened === 1 && error.reason === "uncertain");
  assert.equal(storage.snapshot()[SNOOZE_DELIVERY_KEY][item.id].phase, "effects");
  const restarted = await import("../js/lib/snooze-delivery.js?restart=stale-safety");
  assert.equal(await restarted.recoverInterruptedSnoozeDeliveries(), 1);
  assert.equal((await restarted.fireSnooze(item.id, { manual: false })).status, "interrupted");
}

console.log("PASS: Snoozed edits and Wake use exact current records and durable claims");
