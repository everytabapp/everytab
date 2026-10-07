import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const occurrence = {
  originalUrl: "https://late-close.example/page",
  title: "Late close",
  windowId: 2,
  index: 3,
  pinned: false,
  recoveryOccurrenceId: "late-close-occurrence"
};
const mem = { suspendedRegistry: { 701: occurrence } };
let queueSuspendedCloseCleanup;
let releaseFinalCommit;
let finalCommitStarted;
const finalCommitReady = new Promise((resolve) => { finalCommitStarted = resolve; });
const finalCommitRelease = new Promise((resolve) => { releaseFinalCommit = resolve; });
let delayedFinalCommit = false;

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test-ext-id/${path}` },
  storage: {
    local: {
      async get(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted.filter((key) => key in mem)
          .map((key) => [key, structuredClone(mem[key])]));
      },
      async set(values) {
        const registry = values.suspendedRegistry;
        if (!delayedFinalCommit && registry?.[901] && !registry?.[701]) {
          delayedFinalCommit = true;
          finalCommitStarted();
          await finalCommitRelease;
        }
        Object.assign(mem, structuredClone(values));
      }
    }
  },
  alarms: { async create() {} },
  tabs: {
    async query() { return []; },
    async create(details) {
      return { id: 901, windowId: 2, index: 3, ...details };
    },
    async remove() {}
  },
  windows: { async getAll() { return [{ id: 2 }]; } }
};

installBrowserMapStorageAuthority();
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const suspend = await import("../js/lib/suspend.js");
queueSuspendedCloseCleanup = suspend.queueSuspendedCloseCleanup;

const recovery = suspend.recoverSuspendedTabs();
await finalCommitReady;
// The handler captures occurrence 701 and publishes its direct-local intent
// while recovery still owns the Store lock immediately before rekeying to 901.
const closing = queueSuspendedCloseCleanup(701);
while (!mem.suspendCloseCleanup?.[701]) await new Promise((resolve) => setTimeout(resolve, 0));
releaseFinalCommit();
await Promise.all([recovery, closing]);

assert.deepEqual(mem.suspendedRegistry, {},
  "late cleanup must follow its occurrence across recovery's 701 to 901 rekey");
assert.deepEqual(mem.suspendCloseCleanup, {},
  "the rekey-aware close must complete without a retained retry");

console.log("PASS: a late close follows its suspended occurrence across recovery rekeying");
