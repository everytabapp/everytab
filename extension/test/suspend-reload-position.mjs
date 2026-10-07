import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const originalUrl = "https://kept.example/article";
const suspendBase = "chrome-extension://test-ext-id/suspend.html";
const suspendUrl = `${suspendBase}?${new URLSearchParams({ originalUrl, title: "Kept" })}`;
const mem = {
  suspendRecoveryGraceUntil: Date.now() + 30_000,
  suspendedRegistry: {
    // Persisted before a browser restart. Chrome restores the page with new tab
    // and window ids; recovery must refresh this placement before a later
    // extension reload tears the extension page down.
    901: {
      originalUrl,
      title: "Kept",
      windowId: 91,
      index: 6,
      pinned: false
    }
  }
};

let currentWindowId = 41;
let windows = [
  { id: 41, type: "normal", tabs: [{ id: 410, windowId: 41, index: 0, url: "chrome://extensions/" }] },
  { id: 42, type: "normal", tabs: [
    { id: 420, windowId: 42, index: 0, url: "https://before.example/" },
    { id: 421, windowId: 42, index: 1, url: "https://middle.example/" },
    { id: 2001, windowId: 42, index: 2, url: suspendUrl }
  ] }
];
const created = [];

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
  windows: {
    getAll: async () => windows.map(({ id, type }) => ({ id, type }))
  },
  tabs: {
    query: async () => windows.flatMap((win) => win.tabs.map((tab) => ({ ...tab }))),
    update: async (id, props) => ({ id, ...props }),
    create: async (props) => {
      const hostId = props.windowId ?? currentWindowId;
      const host = windows.find((win) => win.id === hostId);
      const tab = {
        id: 3000 + created.length,
        windowId: hostId,
        index: Number.isInteger(props.index) ? props.index : host.tabs.length,
        url: props.url,
        pinned: Boolean(props.pinned),
        active: Boolean(props.active)
      };
      created.push(tab);
      host.tabs.push(tab);
      return tab;
    }
  }
};

installBrowserMapStorageAuthority();
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const { recoverSuspendedTabs } = await import("../js/lib/suspend.js");

// Browser-restart pass: the live restored page is in window 42 under tab 2001.
await recoverSuspendedTabs();

// The user protects the restored suspended tab during this browser session.
// An extension reload may recreate that page under another numeric id without
// ending the promise attached to the logical tab occurrence.
mem.automationTabProtections = {
  2001: {
    tabId: 2001,
    createdAt: Date.now(),
    permanent: true,
    duration: "always",
    expiresAt: null,
    url: originalUrl,
    hostname: "kept.example"
  },
  3000: {
    tabId: 3000,
    createdAt: Date.now() + 1,
    permanent: true,
    duration: "always",
    expiresAt: null,
    url: "https://newer-target.example/",
    hostname: "newer-target.example"
  }
};

// Extension-reload pass: Chrome removes that extension page. Window 41 is where
// the user clicked Reload; recovery must still recreate it in window 42.
windows[1].tabs = windows[1].tabs.filter((tab) => tab.id !== 2001);
await recoverSuspendedTabs();

assert.deepEqual(created.map(({ windowId, index, pinned }) => ({ windowId, index, pinned })), [
  { windowId: 42, index: 2, pinned: false }
], `reload recovery changed the suspended tab's window or position: ${JSON.stringify(created)}`);
assert.ok(mem.suspendedRegistry[created[0].id], "the recreated tab owns the refreshed registry entry");
assert.ok(mem.automationTabProtections[created[0].id],
  "extension-reload recovery transfers temporary protection to the recreated tab id");
assert.equal(mem.automationTabProtections[created[0].id].hostname, "newer-target.example",
  "recovery preserves a newer permanent protection already owned by the target id");
assert.equal(mem.automationTabProtections[created[0].id].permanent, true,
  "extension-reload recovery preserves no-time-limit tab protection");
assert.equal(mem.automationTabProtections[2001], undefined,
  "the retired pre-reload tab id cannot leak protection to a later tab");
assert.deepEqual(
  (({ windowId, index, pinned }) => ({ windowId, index, pinned }))(mem.suspendedRegistry[created[0].id]),
  { windowId: 42, index: 2, pinned: false },
  "the recreated tab keeps its live placement for the next reload"
);

console.log("PASS: browser restart followed by extension reload preserves suspended-tab window and position");
