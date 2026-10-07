import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const originalUrl = "https://kept.example/error-five";
const suspendBase = "chrome-extension://test-ext-id/suspend.html";
const parkedUrl = `${suspendBase}?${new URLSearchParams({
  originalUrl, title: "Kept after reload"
})}`;
const tab = {
  id: 501, windowId: 50, index: 3, pinned: false, status: "complete",
  url: parkedUrl, title: "Can't open this page"
};
const mem = {
  suspendRecoveryGraceUntil: Date.now() - 1,
  suspendedRegistry: {
    501: { originalUrl, title: "Kept after reload", windowId: 50, index: 3, pinned: false }
  }
};
const updates = [];

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test-ext-id/${path}` },
  storage: { local: {
    get: async (keys) => {
      if (typeof keys === "string") return keys in mem ? { [keys]: structuredClone(mem[keys]) } : {};
      return Object.fromEntries(keys.filter((key) => key in mem)
        .map((key) => [key, structuredClone(mem[key])]));
    },
    set: async (value) => Object.assign(mem, structuredClone(value))
  } },
  windows: { getAll: async () => [{ id: 50, type: "normal" }] },
  tabs: {
    query: async () => [{ ...tab }],
    update: async (id, props) => {
      updates.push({ id, ...props });
      Object.assign(tab, props);
      return { ...tab };
    },
    create: async () => assert.fail("Error 5 recovery must repair the surviving tab in place")
  }
};
installBrowserMapStorageAuthority();
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const { recoverSuspendedTabs } = await import("../js/lib/suspend.js");
const outsideGrace = await recoverSuspendedTabs();
assert.equal(outsideGrace, 0,
  "ordinary recovery never rewrites a surviving page after reload grace has expired");
assert.equal(updates.length, 0,
  "a normal pass cannot mistake later navigation for a retained Error 5 document");

const recovered = await recoverSuspendedTabs({ allowReloadRepair: true });

assert.equal(recovered, 1,
  "a suspend URL whose current worker never heard from its page is not healthy during reload grace");
assert.equal(updates.length, 1, "the exact Error 5 tab is repaired once in place");
assert.equal(updates[0].id, 501, "recovery keeps the original tab identity and placement");
assert.match(updates[0].url, /recoveryAttempt=/,
  "recovery forces a new navigation even when Chrome still reports the old extension URL");

console.log("PASS: the final reload alarm repairs a retained Error 5 document in place");
