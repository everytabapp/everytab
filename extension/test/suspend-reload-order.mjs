import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const suspendBase = "chrome-extension://test-ext-id/suspend.html";
const mem = {
  suspendedRegistry: {
    // Registry order reflects suspend history, not visual tab order.
    901: {
      originalUrl: "https://kept.example/three",
      title: "Kept three",
      windowId: 42,
      index: 3,
      pinned: false
    },
    903: {
      originalUrl: "https://kept.example/one",
      title: "Kept one",
      windowId: 42,
      index: 1,
      pinned: false
    }
  }
};

const tabs = [
  { id: 420, windowId: 42, index: 0, url: "https://survivor.example/zero" },
  { id: 422, windowId: 42, index: 1, url: "https://survivor.example/two" },
  { id: 424, windowId: 42, index: 2, url: "https://survivor.example/four" }
];
let nextId = 5000;

const reindex = () => tabs.forEach((tab, index) => { tab.index = index; });

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test-ext-id/${path}` },
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === "string") return keys in mem ? { [keys]: structuredClone(mem[keys]) } : {};
        return Object.fromEntries(keys.filter((key) => key in mem)
          .map((key) => [key, structuredClone(mem[key])]));
      },
      set: async (value) => Object.assign(mem, structuredClone(value))
    }
  },
  windows: { getAll: async () => [{ id: 42, type: "normal" }] },
  tabs: {
    query: async () => tabs.map((tab) => ({ ...tab })),
    update: async (id, props) => ({ id, ...props }),
    create: async (props) => {
      const at = Number.isInteger(props.index)
        ? Math.min(props.index, tabs.length)
        : tabs.length;
      const tab = {
        id: nextId++,
        windowId: props.windowId ?? 42,
        index: at,
        url: props.url,
        pinned: Boolean(props.pinned)
      };
      tabs.splice(at, 0, tab);
      reindex();
      return { ...tab };
    }
  }
};

installBrowserMapStorageAuthority();
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const { recoverSuspendedTabs } = await import("../js/lib/suspend.js");

assert.equal(await recoverSuspendedTabs(), 2);
const order = tabs.map((tab) => {
  if (!tab.url.startsWith(suspendBase)) return new URL(tab.url).pathname.slice(1);
  return new URL(tab.url).searchParams.get("originalUrl").split("/").at(-1);
});
assert.deepEqual(order, ["zero", "one", "two", "three", "four"],
  "reload recovery must recreate multiple suspended tabs in visual index order");

console.log("PASS: reload recovery preserves the order of multiple suspended tabs in one window");
