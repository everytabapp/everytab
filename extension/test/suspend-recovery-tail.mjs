import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";

const extensionBase = "chrome-extension://test-ext-id/";
const originalUrl = "https://kept.example/already-recovered";
const recoveryOccurrenceId = "already-recovered-occurrence";
const tab = {
  id: 501,
  windowId: 7,
  index: 3,
  pinned: false,
  url: `${extensionBase}suspend.html?${new URLSearchParams({
    originalUrl,
    title: "Already recovered",
    favIconUrl: "https://kept.example/favicon.ico"
  })}`
};
let liveTabs = [tab];
const mem = {
  suspendRecoveryGraceUntil: Date.now() + 60_000,
  suspendedRegistry: {
    501: {
      originalUrl,
      title: "Already recovered",
      favIconUrl: "https://kept.example/favicon.ico",
      windowId: 7,
      index: 3,
      pinned: false,
      recoveryOccurrenceId
    }
  },
  suspendRecoveryCycle: {
    id: "reload-cycle",
    kind: "reload",
    attemptedOccurrenceIds: [],
    recoveredOccurrenceIds: [recoveryOccurrenceId],
    total: 1,
    complete: true,
    notificationAttempts: 1,
    notificationState: "notified"
  }
};
const updates = [];
const created = [];

globalThis.chrome = {
  runtime: { getURL: (path) => `${extensionBase}${path}` },
  storage: { local: {
    get: async (keys) => {
      const requested = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(requested.filter((key) => key in mem)
        .map((key) => [key, structuredClone(mem[key])]));
    },
    set: async (values) => Object.assign(mem, structuredClone(values))
  } },
  windows: { getAll: async () => [{ id: 7, type: "normal" }] },
  tabs: {
    query: async () => liveTabs.map((entry) => ({ ...entry })),
    update: async (id, props) => {
      updates.push({ id, ...props });
      Object.assign(tab, props);
      return { ...tab };
    },
    create: async (props) => {
      const restored = { id: 800 + created.length, windowId: props.windowId ?? 7,
        index: props.index ?? 0, pinned: Boolean(props.pinned), url: props.url };
      created.push(restored);
      liveTabs.push(restored);
      return { ...restored };
    },
    remove: async () => {}
  }
};

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const { installBrowserMapStorageAuthority } = await import(
  "./storage-authority-fixture.mjs"
);
installBrowserMapStorageAuthority();

const { queueSuspendMetadataRepair } = await import("../js/lib/suspend.js");
await queueSuspendMetadataRepair({
  allowReloadRepair: true,
  recoveryCycleId: "reload-cycle"
});

assert.equal(updates.length, 0,
  "the delayed metadata pass must not navigate an occurrence already recovered by this reload cycle");
assert.equal(created.length, 0,
  "the delayed metadata pass must not recreate an occurrence already recovered by this reload cycle");
assert.deepEqual(mem.suspendRecoveryCycle.recoveredOccurrenceIds, [recoveryOccurrenceId],
  "the delayed pass must retain the recovery cycle's deduplicated occurrence receipt");

const lateOccurrenceId = "late-recovery-occurrence";
liveTabs = [];
mem.suspendedRegistry = {
  777: {
    originalUrl: "https://kept.example/late",
    title: "Late recovery",
    favIconUrl: "https://kept.example/late.ico",
    windowId: 7,
    index: 4,
    pinned: false,
    recoveryOccurrenceId: lateOccurrenceId
  }
};
mem.suspendRecoveryCycle = {
  ...mem.suspendRecoveryCycle,
  recoveredOccurrenceIds: [],
  total: 0,
  notificationState: "none"
};
const lateRecovered = await queueSuspendMetadataRepair({
  allowReloadRepair: true,
  recoveryCycleId: "reload-cycle"
});
assert.equal(lateRecovered, 1);
assert.equal(created.length, 1, "a genuinely late vanished occurrence is recovered once");
assert.deepEqual(mem.suspendRecoveryCycle.recoveredOccurrenceIds, [lateOccurrenceId]);
assert.equal(mem.suspendRecoveryCycle.notificationState, "pending",
  "a genuinely late recovery reopens delivery for the same consolidated notification");
assert.equal(mem.suspendRecoveryCycle.total, 1,
  "a genuinely late recovery refreshes the completed cycle total used by notification copy");

console.log("PASS: delayed suspended metadata work joins the active reload-recovery cycle");
