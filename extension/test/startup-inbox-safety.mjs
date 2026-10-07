/** Worker-start composition with the real Inbox sweep and synthetic browser/storage. */
import assert from "node:assert/strict";
import { installSmokeChrome } from "./smoke-chrome.mjs";
import { createMockLockManager } from "./e2-mocks.mjs";
import { createWorkerStartupOwner } from "../js/background/worker-startup-owner.js";

const local = {};
const session = {};
let windows = [];
const tabEffects = { removedIds: [], createdUrls: [], updated: [], discardedIds: [], moves: [] };
const effects = { alarms: {}, notifications: [], badgeTexts: [] };
installSmokeChrome({
  storage: () => ({ local, session }),
  windows: () => ({ live: windows, created: [], removedIds: [], currentId: 1 }),
  tabs: () => tabEffects, effects: () => effects,
  groups: () => ({ records: {}, groupCalls: [], updateCalls: [], fail: false }),
  nextGroupId: () => 1,
  permissions: () => ({ granted: new Set(), requestGrants: false })
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true, value: { locks: createMockLockManager() }
});
const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();
const { archiveSweep } = await import("../js/lib/archive.js");
const { listItems } = await import("../js/lib/store.js");
const { markRecoveryGrace } = await import("../js/lib/suspend.js");
const noop = async () => {};
const now = Date.now();
function seed(settings) {
  delete local.suspendRecoveryGraceUntil;
  local.settings = settings;
  local.inbox = {};
  local.journal = [];
  local.tabActivity = { 11: now - 10 * 86400000, 12: now - 9 * 86400000, 13: now };
  windows = [{ id: 1, type: "normal", focused: true, tabs: [11, 12, 13].map((id, index) => ({
    id, index, windowId: 1, active: id === 13, pinned: false, audible: false,
    groupId: -1, url: `https://startup-fixture.invalid/${id}`, title: `Fixture ${id}`
  })) }];
  tabEffects.removedIds.length = 0;
}
async function start(recoveringReload) {
  let resolveSweep, rejectSweep;
  const swept = new Promise((resolve, reject) => { resolveSweep = resolve; rejectSweep = reject; });
  const owner = createWorkerStartupOwner({
    identity: { ensure: noop },
    schedules: { snapshot: noop, suspension: noop, inbox: noop, rotation: noop },
    snapshots: { take: noop }, assets: { collect: noop },
    snooze: { ready: Promise.resolve(), sweep: noop },
    inbox: { sweep: async () => {
      try { resolveSweep(await archiveSweep(now)); }
      catch (error) { rejectSweep(error); }
    }, expire: noop },
    badge: { refresh: noop }, closeDay: { resume: noop },
    suspension: { retryCloseCleanups: noop, startRecovery: async ({ onInitialPassSettled }) => {
      onInitialPassSettled(); return "synthetic-cycle";
    } },
    deferred: { ensureSessionIdentities: noop, scheduleGuardRecovery() {} },
    warn: message => assert.fail(message)
  });
  owner.start({ recoveringReload, recoverSuspendedTabs: recoveringReload, captureStartupSnapshot: false });
  return swept;
}

for (const reload of [false, true]) {
  for (const settings of [{}, { autoArchiveEnabled: false, autoSaveMaxTabs: 0 }]) {
    seed(settings);
    assert.equal(await start(reload), 0);
    assert.deepEqual(tabEffects.removedIds, [], "disabled automation must not close tabs on worker start/reload");
    assert.deepEqual(await listItems("inbox"), [], "disabled automation must not create Inbox records");
    assert.deepEqual(windows[0].tabs.map(tab => tab.id), [11, 12, 13]);
  }
  seed({ autoArchiveEnabled: false, autoSaveMaxTabs: 2 });
  assert.equal(await start(reload), 1, "the independent enabled cap can save a tab even with the idle timer off");
  assert.deepEqual(tabEffects.removedIds, [11], "only the oldest eligible surplus tab closes");
  const saved = await listItems("inbox");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].source, "auto-archive");
  assert.deepEqual(saved[0].tabs.map(ref => ref.url), ["https://startup-fixture.invalid/11"]);
  assert.deepEqual(windows[0].tabs.map(tab => tab.id), [12, 13], "active and retained tabs survive");
  assert.equal(await start(reload), 0, "a repeated start does not recapture a tab already saved and closed");
  assert.deepEqual(await listItems("inbox"), saved, "repeated starts retain exact saved content without duplicates");
}
// An extension reload opens this existing durable recovery grace before startup.
// The real Inbox sweep must not consume recovering tabs during that interval.
seed({ autoArchiveEnabled: false, autoSaveMaxTabs: 2 });
local.suspendRecoveryGraceUntil = now + 60_000;
assert.equal(await start(true), 0, "Auto-save must preserve the recovered layout while reload grace is active");
assert.deepEqual(tabEffects.removedIds, [], "reload recovery must not close eligible surplus tabs");
assert.deepEqual(await listItems("inbox"), [], "reload recovery must not create an automatic Inbox capture");
assert.deepEqual(windows[0].tabs.map(tab => tab.id), [11, 12, 13]);
local.suspendRecoveryGraceUntil = now - 1;
assert.equal(await archiveSweep(now), 1, "ordinary Auto-save resumes after recovery grace expires");

const policies = [
  { name: "timer", settings: { autoArchiveEnabled: true, autoDumpAfterMinutes: 1, autoSaveMaxTabs: 0 }, expected: 2 },
  { name: "cap", settings: { autoArchiveEnabled: false, autoSaveMaxTabs: 2 }, expected: 1 },
  { name: "timer plus cap", settings: { autoArchiveEnabled: true, autoDumpAfterMinutes: 1, autoSaveMaxTabs: 2 }, expected: 2 }
];
for (const policy of policies) {
  seed(policy.settings);
  const settingsBefore = structuredClone(local.settings);
  await markRecoveryGrace();
  assert.equal(await archiveSweep(now), 0, `${policy.name}: direct alarm/settings/tab-created sweep observes durable grace`);
  assert.deepEqual(tabEffects.removedIds, []);
  assert.deepEqual(await listItems("inbox"), []);
  assert.deepEqual(local.settings, settingsBefore, "grace must not disable or rewrite user settings");
  local.suspendRecoveryGraceUntil = now - 1;
  assert.equal(await archiveSweep(now), policy.expected, `${policy.name}: ordinary policy resumes after expiry`);
}

function seedBundle(protectedTab = false) {
  seed(policies[0].settings);
  const tabs = windows[0].tabs;
  windows = [
    { id: 1, type: "normal", focused: false, tabs: tabs.slice(0, 2).map(tab => ({ ...tab,
      active: tab.id === 12, pinned: protectedTab && tab.id === 11 })) },
    { id: 2, type: "normal", focused: true, tabs: [{ ...tabs[2], windowId: 2 }] }
  ];
}
for (const protectedTab of [false, true]) {
  seedBundle(protectedTab);
  await markRecoveryGrace();
  assert.equal(await archiveSweep(now), 0, "whole-window candidates remain untouched during reload grace");
  assert.deepEqual(tabEffects.removedIds, []);
  assert.deepEqual(await listItems("inbox"), []);
  local.suspendRecoveryGraceUntil = now - 1;
  assert.equal(await archiveSweep(now), protectedTab ? 0 : 2,
    "expiry preserves normal whole-window capture and protection semantics");
  const saved = await listItems("inbox");
  if (!protectedTab) {
    assert.equal(saved[0].kind, "window");
    assert.deepEqual(saved[0].tabs.map(ref => ref.url),
      ["https://startup-fixture.invalid/11", "https://startup-fixture.invalid/12"]);
  }
}

// Real browser/storage seams introduce grace during awaited planning and just
// before the actual commit. The writer itself uses the production Store lock.
for (const boundary of ["planning", "metadata"]) {
  seed(policies[1].settings);
  let triggered = false;
  const getWindows = chrome.windows.getAll, getStorage = chrome.storage.local.get;
  try {
    if (boundary === "planning") chrome.windows.getAll = async (...args) => {
      const result = await getWindows(...args);
      if (!triggered) { triggered = true; await markRecoveryGrace(); }
      return result;
    };
    else chrome.storage.local.get = async keys => {
      const result = await getStorage(keys);
      if (keys === "deviceId" && !triggered) { triggered = true; await markRecoveryGrace(); }
      return result;
    };
    assert.equal(await archiveSweep(now), 0, `${boundary}: late grace prevents Inbox/Journal capture`);
    assert.equal(triggered, true, `${boundary} interleaving must actually execute`);
    assert.deepEqual(tabEffects.removedIds, []);
    assert.deepEqual(await listItems("inbox"), []);
    assert.deepEqual(local.journal, [], "a cancelled capture leaves no misleading Undo action");
  } finally {
    chrome.windows.getAll = getWindows;
    chrome.storage.local.get = getStorage;
  }
}

// Capture already persisted before grace starts. Keep that saved data, but do
// not close recovering pages or claim that Undo must reopen them.
for (const bundle of [false, true]) {
  if (bundle) seedBundle(); else seed(policies[1].settings);
  let triggered = false;
  const getTab = chrome.tabs.get;
  try {
    chrome.tabs.get = async id => {
      const result = await getTab(id);
      if (!triggered && Object.keys(local.inbox).length > 0) {
        triggered = true;
        await markRecoveryGrace();
      }
      return result;
    };
    assert.equal(await archiveSweep(now), bundle ? 2 : 1,
      "a completed durable capture remains recorded when later close is vetoed");
    assert.equal(triggered, true, "grace must start during close identity revalidation");
    assert.deepEqual(tabEffects.removedIds, []);
    const saved = await listItems("inbox");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].tabs.length, bundle ? 2 : 1);
    const entry = local.journal.find(item => item.actionKind === "auto-saved-tabs");
    assert.equal(entry.forwardReceipt.status, "complete");
    assert.equal(entry.forwardReceipt.closedCount, 0);
    assert.deepEqual(entry.reopen, []);
  } finally { chrome.tabs.get = getTab; }
}

// Once the close owns the final Store boundary, a newly requested grace write
// must wait for the Chrome effect, not commit between eligibility and removal.
seed(policies[1].settings);
const removeTabs = chrome.tabs.remove;
let graceWrite, removeEntered = false;
try {
  chrome.tabs.remove = async ids => {
    removeEntered = true;
    graceWrite = markRecoveryGrace();
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    assert.equal(local.suspendRecoveryGraceUntil, undefined,
      "the grace writer must not interleave with a close already owning the Store boundary");
    return removeTabs(ids);
  };
  assert.equal(await archiveSweep(now), 1);
  assert.equal(removeEntered, true);
  await graceWrite;
  assert.ok(local.suspendRecoveryGraceUntil > Date.now());
  assert.deepEqual(tabEffects.removedIds, [11]);
  assert.equal(await archiveSweep(now), 0, "subsequent sweeps observe the grace that followed the close");
} finally { chrome.tabs.remove = removeTabs; }

console.log("PASS: real Inbox sweep respects reload grace at startup, planning, capture and close; timer/cap, bundles, protection and expiry retain ordinary semantics");
