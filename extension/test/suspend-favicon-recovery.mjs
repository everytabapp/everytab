import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const extensionBase = "chrome-extension://test-ext-id/";
const originalUrl = "https://kept.example/article";
const originalFavicon = "https://kept.example/favicon.ico?v=2";
const suspendUrl = `${extensionBase}suspend.html?${new URLSearchParams({
  originalUrl,
  title: "Kept article",
  favIconUrl: originalFavicon
})}`;

const mem = {};
let liveTabs = [];
const created = [];
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
  windows: { getAll: async () => [{ id: 5, type: "normal" }] },
  tabs: {
    query: async () => liveTabs.map((tab) => ({ ...tab })),
    create: async (props) => {
      const tab = { id: 702, windowId: props.windowId, index: props.index, ...props };
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
  recoverSuspendedTabs
} = await import("../js/lib/suspend.js");

await adoptSuspendedPage({
  id: 701,
  windowId: 5,
  index: 3,
  pinned: false,
  url: suspendUrl,
  title: "Kept article · suspended",
  favIconUrl: `${extensionBase}icons/icon16.png`
});

const registry = await getSuspendRegistry();
assert.equal(registry[701]?.originalUrl, originalUrl);
assert.equal(registry[701]?.title, "Kept article");
assert.equal(
  registry[701]?.favIconUrl,
  originalFavicon,
  "self-adoption must preserve the original page favicon carried by suspend.html"
);

// Upgrade case: the previous build may already have replaced the durable title
// and favicon with the extension page's live identity. While the old suspended
// page is still mounted, recovery must repair that entry from its own URL.
mem.suspendedRegistry[701] = {
  originalUrl,
  title: "Kept article · suspended",
  favIconUrl: `${extensionBase}icons/icon16.png`,
  windowId: 5,
  index: 3,
  pinned: false
};
liveTabs = [{
  id: 701,
  windowId: 5,
  index: 3,
  pinned: false,
  url: suspendUrl,
  title: "Kept article · suspended",
  favIconUrl: `${extensionBase}icons/icon16.png`
}];
assert.equal(await recoverSuspendedTabs(), 0);
const repaired = await getSuspendRegistry();
assert.equal(repaired[701]?.title, "Kept article");
assert.equal(repaired[701]?.favIconUrl, originalFavicon);

// The adopted page disappears during an extension reload. Recovery must carry
// the same original favicon into the newly created suspend page URL, where the
// page renderer installs it as the tab-strip icon.
liveTabs = [];
const recovered = await recoverSuspendedTabs();
assert.equal(recovered, 1);
assert.equal(created.length, 1);
const recreated = new URL(created[0].url);
assert.equal(recreated.searchParams.get("title"), "Kept article");
assert.equal(recreated.searchParams.get("favIconUrl"), originalFavicon);

console.log("PASS: restored suspended-page adoption keeps the original favicon");
