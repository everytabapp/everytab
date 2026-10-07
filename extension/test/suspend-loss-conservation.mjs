import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const suspendBase = "chrome-extension://test-ext-id/suspend.html";
const originalUrl = (n) => `https://kept.example/${n}`;
const suspendUrl = (n) => `${suspendBase}?${new URLSearchParams({
  originalUrl: originalUrl(n),
  title: `Kept ${n}`
})}`;

const registry = {};
const liveTabs = [];
for (let n = 1; n <= 60; n += 1) {
  const id = 1000 + n;
  registry[id] = {
    originalUrl: originalUrl(n),
    title: `Kept ${n}`,
    windowId: 10 + (n % 5),
    index: n,
    pinned: false
  };
  if (n <= 29) {
    liveTabs.push({
      id,
      windowId: 10 + (n % 5),
      index: n,
      url: suspendUrl(n),
      pinned: false
    });
  }
}

const mem = { suspendedRegistry: registry };
const created = [];

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
  windows: {
    getAll: async () => [10, 11, 12, 13, 14].map((id) => ({ id, type: "normal" }))
  },
  tabs: {
    query: async () => liveTabs.map((tab) => ({ ...tab })),
    create: async (props) => {
      const tab = {
        id: 2000 + created.length,
        windowId: props.windowId ?? 10,
        index: props.index ?? liveTabs.length,
        url: props.url,
        pinned: Boolean(props.pinned)
      };
      created.push(tab);
      liveTabs.push(tab);
      return { ...tab };
    },
    update: async (id, props) => ({ id, ...props })
  }
};

installBrowserMapStorageAuthority();
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const {
  adoptSuspendedPage,
  getSuspendRegistry,
  markRecoveryGrace,
  recoverSuspendedTabs,
  unregisterSuspendedOnClose
} = await import("../js/lib/suspend.js");

await markRecoveryGrace();
// These 29 documents really mounted in the new extension generation. Their
// adoption distinguishes them from Chrome Error 5 pages that retain the same
// suspend URL but never execute EveryTab.
await Promise.all(liveTabs.map((tab) => adoptSuspendedPage(tab)));
for (let n = 30; n <= 60; n += 1) {
  await unregisterSuspendedOnClose(1000 + n);
}

const recovered = await recoverSuspendedTabs();
const after = await getSuspendRegistry();
const retainedUrls = new Set(Object.values(after).map((entry) => entry.originalUrl));

assert.equal(recovered, 31, "reload recovery must recreate every vanished suspended tab");
assert.equal(created.length, 31, "reload recovery must not duplicate surviving suspended tabs");
assert.equal(Object.keys(after).length, 60, "the registry must conserve all 60 suspended pages");
for (let n = 1; n <= 60; n += 1) {
  assert.ok(retainedUrls.has(originalUrl(n)), `suspended page ${n} was lost during reload recovery`);
}

console.log("PASS: partial reload teardown conserves every registered suspended tab");
