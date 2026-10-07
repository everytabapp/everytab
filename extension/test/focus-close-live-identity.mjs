import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const guardUrl = "chrome-extension://test/focus.html#attempt";
let storage, tab, effects, afterSave, afterQuery, lastTab;
globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: { local: {} },
  tabs: {
    get: async () => structuredClone(tab),
    query: async () => {
      const tabs = lastTab ? [structuredClone(tab)] : [structuredClone(tab), { id: 2 }];
      afterQuery?.();
      return tabs;
    },
    remove: async (id) => { effects.push({ kind: "remove", id }); },
    update: async (id, patch) => { effects.push({ kind: "update", id, patch }); return { ...tab, ...patch }; }
  },
  windows: { get: async () => ({ id: 10, type: "normal", incognito: false }) },
  alarms: { clear: async () => {} }
};
installBrowserMapStorageAuthority();
const { returnAndClose } = await import("../js/lib/focus-guard.js");

function reset() {
  storage = createInterleavableStorage({
    deviceId: "test-device",
    focusBlockedAttempts: { 1: { id: "attempt", url: "https://blocked.example/", domain: "blocked.example" } }
  });
  chrome.storage.local = { ...storage.local, set: async (sets) => {
    await storage.local.set(sets);
    if (sets.inbox) afterSave?.();
  } };
  tab = { id: 1, windowId: 10, index: 0, url: guardUrl, pinned: false, incognito: false };
  effects = [];
  afterSave = afterQuery = null;
  lastTab = false;
}

for (const single of [false, true]) {
  for (const boundary of ["save", "query"]) {
    for (const patch of [
      { url: "https://new-work.example/" },
      { pendingUrl: "https://new-work.example/" },
      { windowId: 20 }, { pinned: true }, { incognito: true }
    ]) {
      reset();
      lastTab = single;
      const change = () => Object.assign(tab, patch);
      if (boundary === "save") afterSave = change;
      else afterQuery = change;
      const result = await returnAndClose(1, "attempt", true);
      assert.equal(result.ok, false, `${boundary}: changed guard must be refused`);
      assert.deepEqual(effects, [], `${boundary}: no close or last-tab replacement after identity changes`);
      assert.equal(Object.values(storage.snapshot().inbox)[0].tabs[0].url, "https://blocked.example/");
      assert.ok(storage.snapshot().focusBlockedAttempts[1], "refusal retains the attempt for recovery");
    }
  }
  reset();
  lastTab = single;
  const result = await returnAndClose(1, "attempt", true);
  assert.equal(result.ok, true);
  assert.equal(effects[0].kind, single ? "update" : "remove", "unchanged guard still leaves normally");
}

reset();
tab.pendingUrl = "https://already-leaving.example/";
assert.equal((await returnAndClose(1, "attempt", true)).ok, false);
assert.deepEqual(effects, [], "a guard already navigating elsewhere cannot authorize a close");
console.log("PASS: Focus close preserves navigation, pending URL, window, pin and privacy identity through save/query");
