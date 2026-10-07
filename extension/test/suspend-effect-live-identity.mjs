import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
let storage, tab, effects, afterRegistry, additionalTabs;
globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: { local: {} },
  tabs: {
    get: async () => structuredClone(tab),
    query: async () => [structuredClone(tab), ...structuredClone(additionalTabs)],
    update: async (id, patch) => { effects.push({ kind: "update", id, patch }); return { ...tab, ...patch }; },
    discard: async (id) => { effects.push({ kind: "discard", id }); return tab; }
  }
};
installBrowserMapStorageAuthority();
const { suspendTab, suspendOthers, suspendSweep } = await import("../js/lib/suspend.js");

function reset() {
  storage = createInterleavableStorage({ deviceId: "test-device", settings: { suspendLazyReload: true } });
  chrome.storage.local = { ...storage.local, set: async (sets) => {
    await storage.local.set(sets);
    if (sets.suspendedRegistry?.[1]) {
      const callback = afterRegistry;
      afterRegistry = null;
      await callback?.();
    }
  } };
  tab = { id: 1, windowId: 10, index: 0, url: "https://old.example/", active: false,
    pinned: false, incognito: false, groupId: -1 };
  effects = [];
  additionalTabs = [];
  afterRegistry = null;
}

for (const patch of [
  { url: "https://new-work.example/" }, { pendingUrl: "https://new-work.example/" },
  { windowId: 20 }, { pinned: true }, { incognito: true }
]) {
  reset();
  afterRegistry = () => Object.assign(tab, patch);
  assert.equal(await suspendTab(1), false, "manual suspension refuses an identity changed during persistence");
  assert.deepEqual(effects, []);
  assert.equal(storage.snapshot().suspendedRegistry?.[1], undefined, "refused occurrence cannot later recover an old page");
  if (patch.pendingUrl) {
    delete tab.pendingUrl;
    assert.equal(await suspendTab(1), true, "a refused navigation releases ownership so a later retry can suspend");
  }
}

reset();
afterRegistry = async () => {
  tab.url = "https://new-work.example/";
  await storage.local.set({ suspendedRegistry: { 1: { originalUrl: tab.url,
    recoveryOccurrenceId: "newer-occurrence", windowId: 10, index: 0, pinned: false } } });
};
assert.equal(await suspendTab(1), false);
assert.equal(storage.snapshot().suspendedRegistry[1].recoveryOccurrenceId, "newer-occurrence",
  "refusal cleanup must not erase a newer suspension occurrence");

reset();
afterRegistry = () => {
  const entry = storage.snapshot().suspendedRegistry[1];
  tab.url = `chrome-extension://test/suspend.html?originalUrl=${encodeURIComponent(entry.originalUrl)}` +
    `&recoveryOccurrenceId=${entry.recoveryOccurrenceId}`;
};
assert.equal(await suspendTab(1), false);
assert.ok(storage.snapshot().suspendedRegistry[1],
  "a concurrent request that already parked this occurrence retains its recovery record");

for (const patch of [{ active: true }, { audible: true }, { groupId: 5 }, { discarded: true }]) {
  reset();
  afterRegistry = () => Object.assign(tab, patch);
  assert.equal(await suspendOthers(10), 0, "suspend others rechecks live exemptions after persistence");
  assert.deepEqual(effects, []);
}

for (const change of [
  () => { tab.active = true; },
  () => { tab.pendingUrl = "https://new-work.example/"; },
  async () => storage.local.set({ settings: { suspendMaxTabs: 1, suspendLazyReload: true,
    suspendWhitelist: ["old.example"] } }),
  async () => storage.local.set({ suspendTemporaryExemptions: { [tab.url]: Date.now() + 60_000 } }),
  async () => storage.local.set({ automationTabProtections: { 1: {
    tabId: 1, createdAt: Date.now(), expiresAt: Date.now() + 60_000
  } } })
]) {
  reset();
  await storage.local.set({ settings: { suspendMaxTabs: 1, suspendLazyReload: true } });
  additionalTabs = [{ id: 2, windowId: 10, index: 1, url: "https://active.example/", active: true }];
  afterRegistry = change;
  assert.equal(await suspendSweep(), 0, "automatic suspension rechecks protection and navigation after the registry write");
  assert.deepEqual(effects, []);
  assert.equal(storage.snapshot().suspendedRegistry?.[1], undefined);
}

reset();
tab.pendingUrl = "https://already-loading.example/";
assert.equal(await suspendTab(1), false, "a navigation already underway cannot be replaced with its old committed page");
assert.deepEqual(effects, []);

reset();
await storage.local.set({ settings: { suspendLazyReload: false } });
const ordinaryGet = chrome.tabs.get;
let reads = 0;
chrome.tabs.get = async () => {
  if (++reads > 1) tab.url = "https://new-work.example/";
  return structuredClone(tab);
};
assert.equal(await suspendTab(1), false, "discard also rejects navigation after the initial capture");
assert.deepEqual(effects, []);
chrome.tabs.get = ordinaryGet;

reset();
assert.equal(await suspendTab(1), true);
assert.equal(effects[0].kind, "update");
assert.equal(new URL(effects[0].patch.url).searchParams.get("originalUrl"), tab.url);

// Two real suspension requests share the original URL/occurrence. Hold the
// first validation, then let the second Chrome update remain pending until
// the first request's refusal cleanup has read Chrome and queued its write.
for (const automaticSecond of [false, true]) {
  reset();
  if (automaticSecond) {
    await storage.local.set({ settings: { suspendMaxTabs: 1, suspendLazyReload: true } });
    additionalTabs = [{ id: 2, windowId: 10, index: 1, url: "https://active.example/", active: true }];
  }
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const firstValidation = deferred();
  const releaseValidation = deferred();
  const secondEffect = deferred();
  const releaseEffect = deferred();
  const effectCompleted = deferred();
  let heldValidation = false;
  let validationReleased = false;
  let cleanupQueued = false;
  let secondEffectStarted = false;
  const ordinaryUpdate = chrome.tabs.update;
  chrome.tabs.get = async () => {
    if (!heldValidation && storage.snapshot().suspendedRegistry?.[1]) {
      heldValidation = true;
      firstValidation.resolve();
      await releaseValidation.promise;
      validationReleased = true;
      return structuredClone(tab);
    }
    if (validationReleased && tab.pinned) cleanupQueued = true;
    return structuredClone(tab);
  };
  chrome.tabs.update = async (id, patch) => {
    secondEffectStarted = true;
    secondEffect.resolve();
    await releaseEffect.promise;
    Object.assign(tab, patch);
    effectCompleted.resolve();
    return ordinaryUpdate(id, patch);
  };
  const cleanupStorage = chrome.storage.local;
  chrome.storage.local = { ...cleanupStorage,
    get: async (keys) => {
      if (cleanupQueued && (Array.isArray(keys) ? keys : [keys]).includes("suspendedRegistry")) {
        cleanupQueued = false;
        releaseEffect.resolve();
        if (secondEffectStarted) await effectCompleted.promise;
      }
      return cleanupStorage.get(keys);
    },
    set: async (sets) => {
      await cleanupStorage.set(sets);
      if (sets.suspendedRegistry && !sets.suspendedRegistry[1]) tab.pinned = false;
    }
  };
  const firstRequest = suspendTab(1);
  await firstValidation.promise;
  const secondRequest = automaticSecond ? suspendSweep() : suspendTab(1);
  // An uncoordinated second request reaches Chrome within this turn. A request
  // serialized behind the first correctly remains queued instead.
  await Promise.race([secondEffect.promise, new Promise((resolve) => setImmediate(resolve))]);
  tab.pinned = true;
  releaseValidation.resolve();
  assert.equal(await firstRequest, false);
  releaseEffect.resolve();
  assert.equal(await secondRequest, automaticSecond ? 1 : true,
    "manual/automatic overlap completes without inverting protection and per-tab locks");
  assert.ok(storage.snapshot().suspendedRegistry?.[1],
    "refusal cleanup cannot retire recovery used by a concurrent successful suspension");
  assert.equal(storage.snapshot().suspendedRegistry[1].recoveryOccurrenceId,
    new URL(tab.url).searchParams.get("recoveryOccurrenceId"));
  chrome.tabs.get = ordinaryGet;
  chrome.tabs.update = ordinaryUpdate;
}
console.log("PASS: suspension preserves exact live identity and newer recovery occurrences across persistence");
