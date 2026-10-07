import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const extensionBase = "chrome-extension://test-ext-id/";
const originalUrl = "https://reload.example/one";
const occurrenceId = "reload-occurrence-one";
const mem = {
  suspendRecoveryGraceUntil: Date.now() + 30_000,
  suspendedRegistry: {
    701: {
      originalUrl,
      title: "Suspended tab",
      windowId: 1,
      index: 0,
      pinned: false,
      recoveryOccurrenceId: occurrenceId
    }
  }
};

let liveTabs = [];
let liveWindowIds = [1];
let currentWindowId = 1;
let rejectWindowQuery = false;
let nextTabId = 8001;
let adoptDuringCreate;
globalThis.chrome = {
  runtime: { getURL: (path) => `${extensionBase}${path}` },
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === "string") {
          return keys in mem ? { [keys]: structuredClone(mem[keys]) } : {};
        }
        return Object.fromEntries(keys.filter((key) => key in mem)
          .map((key) => [key, structuredClone(mem[key])]));
      },
      set: async (value) => Object.assign(mem, structuredClone(value))
    }
  },
  windows: { getAll: async () => {
    if (rejectWindowQuery) throw new Error("Window inventory unavailable");
    return liveWindowIds.map(id => ({ id, type: "normal" }));
  } },
  tabs: {
    query: async () => liveTabs.map((tab) => ({ ...tab })),
    create: async (props) => {
      const tab = {
        id: nextTabId++,
        windowId: props.windowId ?? currentWindowId,
        index: props.index ?? liveTabs.length,
        url: props.url,
        title: new URL(props.url).searchParams.get("title") || props.url,
        pinned: Boolean(props.pinned)
      };
      liveTabs.push(tab);
      if (adoptDuringCreate) await adoptDuringCreate({ ...tab });
      return { ...tab };
    },
    update: async (id, props) => ({ id, ...props }),
    remove: async (id) => {
      liveTabs = liveTabs.filter((tab) => tab.id !== id);
    }
  }
};

installBrowserMapStorageAuthority();
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const {
  adoptSuspendedPage,
  getSuspendRegistry,
  recoverSuspendedTabs,
  registerSuspended
} = await import("../js/lib/suspend.js");
adoptDuringCreate = adoptSuspendedPage;

assert.equal(await recoverSuspendedTabs(), 1,
  "the vanished suspended occurrence should first be recreated");
assert.equal(liveTabs.length, 1);
assert.equal(Object.keys(await getSuspendRegistry()).length, 1);

// Chrome can expose the old pre-reload page after the replacement has already
// mounted and been re-keyed. Modern pages carry the same stable occurrence id,
// so self-adoption must remove the delayed browser copy rather than register a
// second durable occurrence.
const delayedCopy = {
  id: 701,
  windowId: 1,
  index: 0,
  url: liveTabs[0].url,
  title: "Suspended tab",
  pinned: false
};
liveTabs.push(delayedCopy);
assert.equal(await adoptSuspendedPage(delayedCopy), false,
  "a delayed modern page must not self-adopt a represented occurrence");
assert.equal(liveTabs.length, 1,
  "self-adoption must leave one live tab for the occurrence");
assert.equal(Object.keys(await getSuspendRegistry()).length, 1,
  "self-adoption must leave one registry entry for the occurrence");

// Repair profiles where the race completed before this version was installed.
// registerSuspended deliberately bypasses page adoption to construct that
// already-corrupt durable state at the real registry boundary.
liveTabs.push(delayedCopy);
await registerSuspended(delayedCopy, originalUrl, occurrenceId);
assert.equal(Object.keys(await getSuspendRegistry()).length, 2,
  "the fixture must contain the historical duplicate registry state");
await recoverSuspendedTabs();
assert.equal(liveTabs.length, 1,
  "a recovery safety pass must remove an existing live occurrence duplicate");
assert.equal(Object.keys(await getSuspendRegistry()).length, 1,
  "a recovery safety pass must collapse an existing registry occurrence duplicate");

// Equal URLs are valid when they represent distinct user-created occurrences.
// The repair boundary is the stable occurrence id, never URL equality.
const intentionalCopy = {
  id: 9001,
  windowId: 1,
  index: 1,
  url: `${extensionBase}suspend.html?${new URLSearchParams({
    originalUrl,
    title: "Intentional copy",
    recoveryOccurrenceId: "reload-occurrence-two"
  })}`,
  title: "Intentional copy",
  pinned: false
};
liveTabs.push(intentionalCopy);
await registerSuspended(intentionalCopy, originalUrl, "reload-occurrence-two");
await recoverSuspendedTabs();
assert.equal(liveTabs.length, 2,
  "distinct suspended occurrences of the same URL must remain live");
assert.equal(Object.keys(await getSuspendRegistry()).length, 2,
  "distinct suspended occurrences of the same URL must remain registered");

// Normal Chrome restart does not run reload recovery. The restored pages adopt
// their new tab/window IDs alongside old records. A subsequent extension reload
// removes every suspend page, so only the durable placements remain available.
const { mutateStores } = await import("../js/lib/store.js");
const restartedRegistry = Object.fromEntries([
  [3, 11, "restart-first"], [4, 12, "restart-second"],
  [10003, 101, "restart-first"], [10004, 102, "restart-second"]
].map(([id, windowId, recoveryOccurrenceId]) => [id, {
  originalUrl, title: "Same URL, separate occurrence", windowId,
  index: 1, pinned: false, recoveryOccurrenceId
}]));
await mutateStores(["suspendedRegistry"], () => ({ suspendedRegistry: restartedRegistry }));
liveTabs = [];
liveWindowIds = [101, 102];
currentWindowId = 102;
assert.equal(await recoverSuspendedTabs({ allowReloadRepair: true }), 2);
assert.deepEqual(liveTabs.map(tab => ({
  windowId: tab.windowId,
  occurrenceId: new URL(tab.url).searchParams.get("recoveryOccurrenceId")
})).sort((a, b) => a.windowId - b.windowId), [
  { windowId: 101, occurrenceId: "restart-first" },
  { windowId: 102, occurrenceId: "restart-second" }
], "post-restart reload must preserve each adopted occurrence's current window");
assert.equal(Object.keys(await getSuspendRegistry()).length, 2,
  "recovery retains one record for each intentional same-URL occurrence");

await mutateStores(["suspendedRegistry"], () => ({ suspendedRegistry: restartedRegistry }));
liveTabs = [];
rejectWindowQuery = true;
await assert.rejects(recoverSuspendedTabs({ allowReloadRepair: true }), /Window inventory unavailable/);
assert.equal(liveTabs.length, 0, "unknown window placement cannot start browser effects");
assert.deepEqual(await getSuspendRegistry(), restartedRegistry,
  "failed window inventory must retain all placement evidence for retry");

console.log("PASS: reload recovery keeps one live tab per occurrence and preserves adopted restart placement");
