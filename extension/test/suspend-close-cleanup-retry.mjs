import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";

const mem = {
  suspendedRegistry: {
    701: {
      originalUrl: "https://closed.example/page",
      title: "Closed page",
      windowId: 2,
      index: 3,
      pinned: false
    }
  }
};
let rejectRegistryCommit = true;
const alarms = [];
const createdTabs = [];

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
        if (rejectRegistryCommit && Object.hasOwn(values, "suspendedRegistry")) {
          rejectRegistryCommit = false;
          throw new Error("temporary registry failure");
        }
        Object.assign(mem, structuredClone(values));
      }
    }
  },
  alarms: {
    async create(name, details) { alarms.push({ name, details }); }
  },
  tabs: {
    async query() { return []; },
    async create(details) {
      createdTabs.push(details);
      return { id: 900 + createdTabs.length, ...details };
    }
  },
  windows: { async getAll() { return [{ id: 2 }]; } }
};

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const { installBrowserMapStorageAuthority } = await import(
  "./storage-authority-fixture.mjs"
);
installBrowserMapStorageAuthority();

const {
  queueSuspendedCloseCleanup,
  recoverSuspendedTabs,
  retrySuspendedCloseCleanups,
  SUSPEND_CLOSE_CLEANUP_ALARM
} = await import("../js/lib/suspend.js");

await assert.rejects(queueSuspendedCloseCleanup(701), /temporary registry failure/);
assert.ok(mem.suspendCloseCleanup?.[701],
  "a failed close cleanup must retain its tab id outside the failed registry transaction");
assert.equal(alarms.at(-1)?.name, SUSPEND_CLOSE_CLEANUP_ALARM,
  "a retained close cleanup must arm a durable retry");

assert.equal(await recoverSuspendedTabs(), 0,
  "recovery must skip a registry occurrence with a retained user-close intent");
assert.equal(createdTabs.length, 0,
  "a failed close cleanup must never recreate the deliberately closed tab");

mem.suspendRecoveryGraceUntil = Date.now() + 60_000;
assert.deepEqual(await retrySuspendedCloseCleanups(), { attempted: 1, failed: 0, pending: 1 });
assert.ok(mem.suspendedRegistry[701],
  "a close receipt encountered during reload grace must preserve its registry entry");
assert.ok(mem.suspendCloseCleanup?.[701],
  "a preserved cleanup must remain durable until grace ends");

mem.suspendRecoveryGraceUntil = Date.now() - 1;
assert.deepEqual(await retrySuspendedCloseCleanups(), { attempted: 1, failed: 0, pending: 0 });
assert.equal(mem.suspendedRegistry[701], undefined,
  "the retry must remove the deliberately closed suspended occurrence");
assert.deepEqual(mem.suspendCloseCleanup, {},
  "a completed retry must clear its operational receipt");

mem.suspendedRegistry[701] = {
  originalUrl: "https://replacement.example/page",
  title: "Replacement page",
  windowId: 9,
  index: 1,
  pinned: false,
  recoveryOccurrenceId: "replacement-occurrence"
};
mem.suspendCloseCleanup[701] = {
  tabId: 701,
  recordedAt: Date.now() - 60_000,
  originalUrl: "https://closed.example/page",
  title: "Closed page",
  windowId: 2,
  index: 3,
  pinned: false,
  recoveryOccurrenceId: "closed-occurrence"
};
assert.deepEqual(await retrySuspendedCloseCleanups(), { attempted: 1, failed: 0, pending: 0 });
assert.equal(mem.suspendedRegistry[701]?.recoveryOccurrenceId, "replacement-occurrence",
  "a late receipt must not delete a different occurrence that reused the tab id");
assert.deepEqual(mem.suspendCloseCleanup, {},
  "a stale tab-id receipt must be discarded after its identity mismatch");

console.log("PASS: failed suspended-close cleanup is retained and retried before recovery");
