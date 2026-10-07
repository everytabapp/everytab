import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const mem = {
  suspendedRegistry: {
    701: {
      originalUrl: "https://closed-during-recovery.example/page",
      title: "Closed during recovery",
      windowId: 2,
      index: 3,
      pinned: false,
      recoveryOccurrenceId: "closing-occurrence"
    }
  }
};
const createdTabs = [];
const removedTabs = [];
let queueSuspendedCloseCleanup;

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test-ext-id/${path}` },
  storage: {
    local: {
      async get(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted.filter((key) => key in mem)
          .map((key) => [key, structuredClone(mem[key])]));
      },
      async set(values) { Object.assign(mem, structuredClone(values)); }
    }
  },
  alarms: { async create() {} },
  tabs: {
    async query() { return []; },
    async create(details) {
      // The close begins after recovery's initial snapshot and pre-effect
      // check, while Chrome is creating the replacement page.
      await queueSuspendedCloseCleanup(701);
      const created = { id: 901, windowId: 2, index: 3, ...details };
      createdTabs.push(created);
      return created;
    },
    async remove(tabId) { removedTabs.push(tabId); }
  },
  windows: { async getAll() { return [{ id: 2 }]; } }
};

installBrowserMapStorageAuthority();
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const suspend = await import("../js/lib/suspend.js");
queueSuspendedCloseCleanup = suspend.queueSuspendedCloseCleanup;

assert.equal(await suspend.recoverSuspendedTabs(), 0,
  "a close that wins during recovery must not be reported as recovered");
assert.equal(createdTabs.length, 1,
  "the fixture must reach the browser-effect race window");
assert.deepEqual(removedTabs, [901],
  "a page created from a stale recovery source must be removed immediately");
assert.deepEqual(mem.suspendedRegistry, {},
  "the deliberately closed occurrence must remain absent");
assert.deepEqual(mem.suspendCloseCleanup, {},
  "the successful close cleanup must leave no retry receipt");

console.log("PASS: a close that starts during recovery cannot resurrect its suspended tab");
