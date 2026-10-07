import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";

const registry = {
  101: {
    originalUrl: "https://kept.example/create",
    title: "Create retry",
    windowId: 7,
    index: 1,
    pinned: false
  },
  102: {
    originalUrl: "https://kept.example/update",
    title: "Update retry",
    windowId: 7,
    index: 2,
    pinned: false
  }
};
const mem = { suspendedRegistry: structuredClone(registry) };
const liveTabs = [{
  id: 102,
  windowId: 7,
  index: 2,
  url: "about:blank",
  pinned: false
}];
let rejectBrowserEffects = true;
let nextTabId = 200;

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test-ext-id/${path}` },
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
  windows: { getAll: async () => [{ id: 7, type: "normal" }] },
  tabs: {
    query: async () => liveTabs.map((tab) => ({ ...tab })),
    create: async (props) => {
      if (rejectBrowserEffects) throw new Error("Chrome is still restoring windows");
      const tab = {
        id: nextTabId++,
        windowId: props.windowId ?? 7,
        index: props.index ?? liveTabs.length,
        url: props.url,
        pinned: Boolean(props.pinned)
      };
      liveTabs.push(tab);
      return { ...tab };
    },
    update: async (id, props) => {
      if (rejectBrowserEffects) throw new Error("Tab changed during recovery");
      const tab = liveTabs.find((candidate) => candidate.id === id);
      if (!tab) throw new Error(`Missing tab ${id}`);
      Object.assign(tab, props);
      return { ...tab };
    }
  }
};

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const { installBrowserMapStorageAuthority } = await import(
  "./storage-authority-fixture.mjs"
);
installBrowserMapStorageAuthority();

const {
  getSuspendRegistry,
  markRecoveryGrace,
  recoverSuspendedTabs
} = await import("../js/lib/suspend.js");

await markRecoveryGrace();
assert.equal(await recoverSuspendedTabs(), 0);
let after = await getSuspendRegistry();
assert.deepEqual(
  new Set(Object.values(after).map((entry) => entry.originalUrl)),
  new Set(Object.values(registry).map((entry) => entry.originalUrl)),
  "a transient Chrome failure must retain every recovery occurrence"
);

rejectBrowserEffects = false;
assert.equal(await recoverSuspendedTabs(), 2);
after = await getSuspendRegistry();
assert.deepEqual(
  new Set(Object.values(after).map((entry) => entry.originalUrl)),
  new Set(Object.values(registry).map((entry) => entry.originalUrl)),
  "the next pass must recover every retained occurrence"
);

console.log("PASS: transient suspend recovery failures retain exact retry records");
