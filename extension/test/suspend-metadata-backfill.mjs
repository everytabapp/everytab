import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const extensionBase = "chrome-extension://test-ext-id/";
const suspendBase = `${extensionBase}suspend.html`;
const originalUrl = "https://kept.example/article";
const originalTitle = "A title retained by an automatic Snapshot";
const originalFavicon = "https://kept.example/favicon.ico";
const damagedUrl = `${suspendBase}?${new URLSearchParams({
  originalUrl,
  title: "Suspended"
})}`;

const liveTabs = [{
  id: 701,
  windowId: 5,
  index: 3,
  pinned: false,
  url: damagedUrl,
  title: "Suspended · suspended"
}];
const mem = {
  suspendedRegistry: {
    701: {
      originalUrl,
      title: "Suspended",
      windowId: 5,
      index: 3,
      pinned: false
    }
  },
  sessions: {
    "00000000-0000-4000-8000-000000000001": {
      id: "00000000-0000-4000-8000-000000000001",
      auto: true,
      createdAt: 100,
      modifiedAt: 100,
      windows: [[{
        url: originalUrl,
        title: originalTitle,
        favIconUrl: originalFavicon
      }]]
    }
  }
};
const updates = [];
const storageGets = [];

globalThis.chrome = {
  runtime: { getURL: (path) => `${extensionBase}${path}` },
  storage: {
    local: {
      get: async (keys) => {
        storageGets.push(Array.isArray(keys) ? [...keys] : keys);
        if (typeof keys === "string") {
          return keys in mem ? { [keys]: structuredClone(mem[keys]) } : {};
        }
        return Object.fromEntries(keys.filter((key) => key in mem)
          .map((key) => [key, structuredClone(mem[key])]));
      },
      set: async (value) => Object.assign(mem, structuredClone(value))
    }
  },
  windows: { getAll: async () => [{ id: 5, type: "normal" }] },
  tabs: {
    query: async () => liveTabs.map((tab) => ({ ...tab })),
    create: async () => { throw new Error("the live suspended tab must not be duplicated"); },
    update: async (id, props) => {
      updates.push({ id, props });
      const tab = liveTabs.find((candidate) => candidate.id === id);
      if (tab && props.url) tab.url = props.url;
      return { ...tab, ...props };
    }
  }
};

installBrowserMapStorageAuthority();
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const {
  getSuspendRegistry, queueSuspendMetadataRepair, recoverSuspendedTabs
} = await import("../js/lib/suspend.js");

assert.equal(await recoverSuspendedTabs(), 0, "ordinary recovery must not create another tab");
assert.equal(updates.length, 0, "ordinary recovery must leave historical metadata repair deferred");
assert.equal(storageGets.some((keys) => keys === "sessions" || keys?.includes?.("sessions")), false,
  "ordinary recovery must not read the potentially large Session store");

assert.equal(await queueSuspendMetadataRepair(), 0, "metadata repair must not create another tab");
assert.equal(storageGets.filter((keys) => keys === "sessions" || keys?.includes?.("sessions")).length, 1,
  "the explicit upgrade repair reads Snapshots exactly once");
assert.equal(updates.length, 1, "the damaged suspended page is repaired in place once");
assert.equal(updates[0].id, 701);
const repairedUrl = new URL(updates[0].props.url);
assert.equal(repairedUrl.searchParams.get("originalUrl"), originalUrl);
assert.equal(repairedUrl.searchParams.get("title"), originalTitle);
assert.equal(repairedUrl.searchParams.get("favIconUrl"), originalFavicon);

const registry = await getSuspendRegistry();
assert.equal(registry[701]?.title, originalTitle);
assert.equal(registry[701]?.favIconUrl, originalFavicon);

console.log("PASS: damaged suspended metadata backfills from a local automatic Snapshot");
