/** Real recovery owner/domain/Store with synthetic Chrome lifecycle boundaries. */
import test from "node:test";
import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const base = "chrome-extension://ready-summary/";
const memory = {}, session = {}, timers = [], notifications = [], updates = [], effects = [];
let tabs = [], nextId = 100, rejectUpdates = false;
const clone = value => value == null ? value : structuredClone(value);
const area = values => ({
  async get(keys) {
    const list = typeof keys === "string" ? [keys] : keys;
    return Object.fromEntries(list.filter(key => key in values).map(key => [key, clone(values[key])]));
  },
  async set(values_) { Object.assign(values, clone(values_)); }
});
globalThis.chrome = {
  runtime: { getURL: path => base + path },
  i18n: { getMessage: (key, substitutions = []) => key === "@@ui_locale" ? "en" : `${key}:${substitutions.join(",")}` },
  storage: { local: area(memory), session: area(session) },
  windows: { getAll: async () => [{ id: 7, type: "normal" }] },
  tabs: {
    query: async () => clone(tabs),
    update: async (id, props) => {
      if (rejectUpdates) throw new Error("Synthetic unavailable tab");
      effects.push("update");
      const tab = tabs.find(tab => tab.id === id);
      assert.ok(tab); Object.assign(tab, props); return clone(tab);
    },
    create: async props => { effects.push("create"); const tab = { id: ++nextId, ...props }; tabs.push(tab); return clone(tab); },
    remove: async id => { effects.push("remove"); tabs = tabs.filter(tab => tab.id !== id); }
  },
  alarms: { create: async () => {}, clear: async () => true },
  notifications: {
    create: async (id, options) => { notifications.push({ id, options }); return id; },
    update: async (id, options) => { updates.push({ id, options }); return notifications.some(note => note.id === id); }
  }
};
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: createMockLockManager() } });
installBrowserMapStorageAuthority();
const { mutateStores, readStoreValue } = await import("../js/lib/store.js");
const { adoptSuspendedPage, registerSuspended, unregisterSuspended, markRecoveryGrace,
  recoverSuspendedTabs, refreshAlreadyReadyRecoveryOccurrences } = await import("../js/lib/suspend.js");
const { createSuspendRecoveryOwner } = await import("../js/background/suspend-recovery-owner.js");

async function reset() {
  for (const key of Object.keys(memory)) delete memory[key];
  for (const key of Object.keys(session)) delete session[key];
  for (const list of [timers, notifications, updates, effects]) list.length = 0;
  tabs = []; rejectUpdates = false;
  await markRecoveryGrace();
}
async function add({ ready = true, legacy = false } = {}) {
  const id = ++nextId, originalUrl = `https://fixture.invalid/${id}`;
  const tab = { id, windowId: 7, index: tabs.length, active: false,
    url: `${base}suspend.html?${new URLSearchParams({ originalUrl, title: `Fixture ${id}`,
      ...(!legacy ? { recoveryOccurrenceId: `occurrence-${id}` } : {}) })}` };
  tabs.push(tab);
  if (ready) assert.equal(await adoptSuspendedPage(tab), true);
  else await registerSuspended(tab, originalUrl, `occurrence-${id}`);
  return tab;
}
function owner(options = {}) {
  return createSuspendRecoveryOwner({ mutateStore: mutateStores, readStore: readStoreValue,
    recover: recoverSuspendedTabs, repairMetadata: async () => 0,
    setTimer: callback => timers.push(callback), ...options });
}
const finals = () => notifications.filter(note => note.id.startsWith("suspend-recovered:"));
const cycle = () => memory.suspendRecoveryCycle;
async function drain() { for (const callback of timers) await callback(); }

// The original reproduction: both real pages adopt before the owner starts.
test("already-ready pages receive one truthful summary without browser effects or repeat delivery", async () => {
  await reset(); await add(); await add();
  const recovery = owner(); await recovery.start({ recoveringReload: true }); await drain();
  assert.deepEqual(effects, []);
  assert.equal(finals().length, 1);
  assert.match(finals()[0].options.message, /^notification_ready_suspended_other:2$/);
  assert.equal(cycle().total, 0, "retained pages must never inflate actual repair count");
  assert.equal(cycle().summaryTotal, 2);
  assert.equal(cycle().alreadyReadyOccurrenceIds.length, 2);
  await recovery.finishInterrupted(); await recovery.repairLateMetadata();
  assert.equal(finals().length, 1); assert.deepEqual(updates, []);
});

test("mixed ready and repaired pages produce one aggregate, while repairs-only retain existing copy", async () => {
  for (const mixed of [true, false]) {
    await reset(); if (mixed) await add(); await add({ ready: false });
    await owner().start({ recoveringReload: true }); await drain();
    assert.deepEqual(effects, ["update"]);
    assert.equal(cycle().total, 1); assert.equal(cycle().summaryTotal, mixed ? 2 : 1);
    assert.equal(finals().length, 1); assert.equal(updates.length, 0);
    assert.equal(finals()[0].options.message, mixed
      ? "notification_ready_suspended_other:2" : "notification_recovered_suspended_one:");
  }
});

test("new suspensions after cycle creation cannot inflate the reload summary", async () => {
  await reset(); const first = await add();
  await owner().start({ recoveringReload: true }); const later = await add(); await drain();
  assert.deepEqual(cycle().initialOccurrenceIds, [`occurrence-${first.id}`]);
  assert.deepEqual(cycle().alreadyReadyOccurrenceIds, [`occurrence-${first.id}`]);
  assert.equal(cycle().summaryTotal, 1); assert.equal(cycle().total, 0);
  assert.ok(memory.suspendedRegistry[later.id], "the new suspension remains normally owned");
  assert.deepEqual(effects, []);
});

test("closed, navigated, incognito and pending-navigation pages never earn ready credit", async () => {
  for (const boundary of ["closed", "navigated", "incognito", "pending"]) {
    await reset(); const tab = await add();
    await owner().start({ recoveringReload: true });
    if (boundary === "closed") { tabs = []; await unregisterSuspended(tab.id); }
    if (boundary === "navigated") tab.url = "https://fixture.invalid/new-page";
    if (boundary === "incognito") tab.incognito = true;
    if (boundary === "pending") tab.pendingUrl = "https://fixture.invalid/new-page";
    await drain();
    assert.equal(cycle().summaryTotal, 0, boundary);
    assert.deepEqual(cycle().alreadyReadyOccurrenceIds, [], boundary);
    assert.equal(finals().length, 0, boundary); assert.deepEqual(effects, [], boundary);
  }
});

test("failed pages stay uncounted, but later real adoption completes the same cycle once", async () => {
  await reset(); const tab = await add({ ready: false }); rejectUpdates = true;
  await owner().start({ recoveringReload: true }); await timers[0]();
  assert.equal(cycle().total, 0); assert.equal(cycle().summaryTotal, 0); assert.equal(finals().length, 0);
  assert.equal(await adoptSuspendedPage(tab), true);
  for (const callback of timers.slice(1)) await callback();
  assert.equal(cycle().total, 0); assert.equal(cycle().summaryTotal, 1);
  assert.equal(finals().length, 1); assert.deepEqual(effects, []);
});

test("a close after Chrome observation but before the receipt commit vetoes stale ready credit", async () => {
  await reset(); const tab = await add();
  let checked = false;
  const query = chrome.tabs.query;
  const recovery = owner({ refreshReady: async id => {
    chrome.tabs.query = async () => {
      const snapshot = await query();
      if (!checked) { checked = true; tabs = []; await unregisterSuspended(tab.id); }
      return snapshot;
    };
    try { await refreshAlreadyReadyRecoveryOccurrences(id); }
    finally { chrome.tabs.query = query; }
  } });
  await recovery.start({ recoveringReload: true }); await drain();
  assert.equal(checked, true); assert.equal(cycle().summaryTotal, 0); assert.equal(finals().length, 0);
  assert.deepEqual(effects, []);
});

test("legacy registry identities are upgraded once and already-ready legacy pages remain eligible", async () => {
  await reset(); const tab = await add({ legacy: true });
  delete memory.suspendedRegistry[tab.id].recoveryOccurrenceId;
  await owner().start({ recoveringReload: true });
  const initial = [...cycle().initialOccurrenceIds];
  assert.equal(initial.length, 1); assert.equal(typeof initial[0], "string");
  await drain();
  assert.deepEqual(cycle().alreadyReadyOccurrenceIds, initial);
  assert.equal(cycle().summaryTotal, 1); assert.equal(cycle().total, 0); assert.deepEqual(effects, []);
});

test("ordinary browser startup and a stale session claim never emit a ready summary", async () => {
  await reset(); await add();
  const recovery = owner();
  assert.equal(await recovery.start({ recoveringReload: false }), null);
  assert.equal(timers.length, 0); assert.equal(notifications.length, 0); assert.equal(cycle(), undefined);
  await recovery.start({ recoveringReload: true });
  delete session.suspendRecoverySessionClaim;
  await recovery.finishInterrupted();
  assert.equal(cycle().notificationState, "none"); assert.equal(cycle().summaryTotal, 0);
  assert.equal(finals().length, 0); assert.deepEqual(effects, []);
});

test("a page closed while the starting notification waits cannot be announced ready", async () => {
  await reset(); const tab = await add();
  const create = chrome.notifications.create;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  chrome.notifications.create = async (id, options) => {
    if (id.startsWith("suspend-recovering:")) await blocked;
    return create(id, options);
  };
  try {
    await owner().start({ recoveringReload: true });
    const running = timers[0]();
    for (let turn = 0; turn < 100 && !cycle().complete; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(cycle().summaryTotal, 1, "the initial ready receipt was established before the notification wait");
    tabs = []; await unregisterSuspended(tab.id); release(); await running;
    assert.equal(cycle().summaryTotal, 0); assert.equal(cycle().notificationState, "none");
    assert.equal(finals().length, 0); assert.deepEqual(effects, []);
  } finally { release(); chrome.notifications.create = create; }
});

test("overlapping completion paths share one final notification", async () => {
  await reset(); await add();
  const recovery = owner(); await recovery.start({ recoveringReload: true });
  await Promise.all([timers[0](), timers[1](), recovery.finishInterrupted()]);
  assert.equal(finals().length, 1); assert.equal(updates.length, 0);
  assert.equal(cycle().notificationAttempts, 1);
  for (const callback of timers.slice(2)) await callback();
  assert.equal(finals().length, 1);
});

test("notification retries revalidate ready pages and never claim a closed page", async () => {
  for (const closeBeforeRetry of [false, true]) {
    await reset(); const tab = await add();
    const create = chrome.notifications.create, warn = console.warn;
    let failed = false;
    chrome.notifications.create = async (id, options) => {
      if (id.startsWith("suspend-recovered:") && !failed) { failed = true; throw new Error("Synthetic notification rejection"); }
      return create(id, options);
    };
    console.warn = () => {};
    try {
      const recovery = owner(); await recovery.start({ recoveringReload: true }); await timers[0]();
      assert.equal(cycle().notificationState, "pending"); assert.equal(finals().length, 0);
      if (closeBeforeRetry) { tabs = []; await unregisterSuspended(tab.id); }
      await recovery.finishInterrupted();
      assert.equal(finals().length, closeBeforeRetry ? 0 : 1);
      assert.equal(cycle().notificationState, closeBeforeRetry ? "none" : "notified");
      assert.deepEqual(effects, []);
    } finally { chrome.notifications.create = create; console.warn = warn; }
  }
});

test("a repaired page closed before mixed delivery is not included in the ready aggregate", async () => {
  await reset(); await add(); const repaired = await add({ ready: false });
  const create = chrome.notifications.create;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  chrome.notifications.create = async (id, options) => {
    if (id.startsWith("suspend-recovering:")) await blocked;
    return create(id, options);
  };
  try {
    await owner().start({ recoveringReload: true }); const running = timers[0]();
    for (let turn = 0; turn < 100 && !cycle().complete; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(cycle().summaryTotal, 2);
    tabs = tabs.filter(tab => tab.id !== repaired.id); await unregisterSuspended(repaired.id);
    release(); await running;
    assert.equal(cycle().total, 1, "historical repairs stay recorded");
    assert.equal(cycle().summaryTotal, 1, "ready copy only includes pages still present at delivery");
    assert.equal(finals().length, 1);
    assert.equal(finals()[0].options.message, "notification_ready_suspended_one:");
  } finally { release(); chrome.notifications.create = create; }
});

test("closing the retained member switches mixed completion back to truthful repaired-only copy", async () => {
  await reset(); const ready = await add(); await add({ ready: false });
  const create = chrome.notifications.create;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  chrome.notifications.create = async (id, options) => {
    if (id.startsWith("suspend-recovering:")) await blocked;
    return create(id, options);
  };
  try {
    await owner().start({ recoveringReload: true }); const running = timers[0]();
    for (let turn = 0; turn < 100 && !cycle().complete; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(cycle().summaryTotal, 2);
    tabs = tabs.filter(tab => tab.id !== ready.id); await unregisterSuspended(ready.id);
    release(); await running;
    assert.equal(cycle().total, 1); assert.equal(cycle().summaryTotal, 1);
    assert.deepEqual(cycle().alreadyReadyOccurrenceIds, []);
    assert.equal(finals().length, 1);
    assert.equal(finals()[0].options.message, "notification_recovered_suspended_one:");
  } finally { release(); chrome.notifications.create = create; }
});

test("later safety passes update an already-delivered mixed count when a repaired member closes", async () => {
  await reset(); await add(); const repaired = await add({ ready: false });
  const recovery = owner(); await recovery.start({ recoveringReload: true }); await timers[0]();
  assert.equal(finals().length, 1);
  assert.equal(finals()[0].options.message, "notification_ready_suspended_other:2");
  tabs = tabs.filter(tab => tab.id !== repaired.id); await unregisterSuspended(repaired.id);
  await timers[1]();
  assert.equal(cycle().total, 1, "actual repair history remains unchanged");
  assert.equal(cycle().summaryTotal, 1);
  assert.equal(cycle().notificationState, "notified");
  assert.equal(updates.length, 1, "the receipt cannot claim the changed count was delivered before updating it");
  assert.equal(updates[0].id, finals()[0].id, "correction updates the existing final identity");
  assert.equal(updates[0].options.message, "notification_ready_suspended_one:");
  for (const callback of timers.slice(2)) await callback();
  await recovery.finishInterrupted();
  assert.equal(finals().length, 1); assert.equal(updates.length, 1, "unchanged later passes do not repeat the update");
});
