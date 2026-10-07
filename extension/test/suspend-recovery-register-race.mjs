import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const mem = {
  suspendRecoveryGraceUntil: Date.now() + 30_000,
  suspendedRegistry: {
    701: {
      originalUrl: "https://reload.example/old",
      title: "Old suspended tab",
      windowId: 1,
      index: 0,
      pinned: false
    }
  }
};

let registerSuspended;
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
  windows: { getAll: async () => [{ id: 1, type: "normal" }] },
  tabs: {
    query: async () => [],
    update: async (id, props) => ({ id, ...props }),
    create: async (props) => {
      // While reload recovery is awaiting Chrome, the user manually suspends a
      // different tab. Its persisted registry entry must survive the recovery
      // pass's final reconciliation.
      await registerSuspended({
        id: 9001,
        title: "Newly suspended tab",
        windowId: 1,
        index: 4,
        pinned: false
      }, "https://manual.example/new");
      const tab = {
        id: 8001,
        windowId: props.windowId ?? 1,
        index: props.index ?? 0,
        url: props.url,
        pinned: Boolean(props.pinned)
      };
      created.push(tab);
      return tab;
    }
  }
};

installBrowserMapStorageAuthority();
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

({ registerSuspended } = await import("../js/lib/suspend.js"));
const { getSuspendRegistry, recoverSuspendedTabs } = await import("../js/lib/suspend.js");

await recoverSuspendedTabs();
const after = await getSuspendRegistry();

assert.equal(created.length, 1, "the vanished pre-reload tab should be recovered once");
assert.equal(after[8001]?.originalUrl, "https://reload.example/old");
assert.equal(
  after[9001]?.originalUrl,
  "https://manual.example/new",
  "recovery must not overwrite a suspended tab registered while the pass was in flight"
);

console.log("PASS: reload recovery preserves concurrently registered suspended tabs");
