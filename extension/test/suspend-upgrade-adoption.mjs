import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const extensionBase = "chrome-extension://test-ext-id/";
const suspendBase = `${extensionBase}suspend.html`;
const originalUrl = (n) => n <= 2
  ? "https://legacy.example/shared"
  : `https://legacy.example/${n}`;
const suspendUrl = (n) => `${suspendBase}?${new URLSearchParams({
  originalUrl: originalUrl(n),
  title: `Legacy ${n}`
})}`;

// Exact installed-upgrade symptom: Chrome has 39 live tabs across five windows,
// including 29 EveryTab suspend pages. Only four of those pages still have old
// registry records, so a recovery pass that trusts the registry alone leaves 25
// pages unprotected during the first reload into the repaired build.
let liveTabs = [];
for (let n = 1; n <= 29; n += 1) {
  liveTabs.push({
    id: 1000 + n,
    windowId: 10 + (n % 5),
    index: n,
    url: suspendUrl(n),
    title: `Legacy ${n}`,
    pinned: false
  });
}
for (let n = 1; n <= 10; n += 1) {
  liveTabs.push({
    id: 2000 + n,
    windowId: 10 + (n % 5),
    index: 40 + n,
    url: `https://ordinary.example/${n}`,
    title: `Ordinary ${n}`,
    pinned: false
  });
}

const oldRegistry = {};
for (let n = 1; n <= 4; n += 1) {
  oldRegistry[1000 + n] = {
    originalUrl: originalUrl(n),
    title: `Legacy ${n}`,
    windowId: 10 + (n % 5),
    index: n,
    pinned: false
  };
}

const mem = { suspendedRegistry: oldRegistry };
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
  windows: {
    getAll: async () => [10, 11, 12, 13, 14].map((id) => ({ id, type: "normal" }))
  },
  tabs: {
    query: async () => liveTabs.map((tab) => ({ ...tab })),
    create: async (props) => {
      const tab = {
        id: 3000 + created.length,
        windowId: props.windowId ?? 10,
        index: props.index ?? liveTabs.length,
        url: props.url,
        title: new URL(props.url).searchParams.get("title") || props.url,
        pinned: Boolean(props.pinned)
      };
      created.push(tab);
      liveTabs.push(tab);
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
  getSuspendRegistry,
  adoptSuspendedPage,
  markRecoveryGrace,
  recoverSuspendedTabs,
  unregisterSuspendedOnClose
} = await import("../js/lib/suspend.js");

await markRecoveryGrace();

// The new worker gets one opportunity to see the old mounted suspend pages
// before Chrome tears their extension renderers down.
await recoverSuspendedTabs();
const adoptedBeforeTeardown = await getSuspendRegistry();
assert.equal(
  Object.keys(adoptedBeforeTeardown).length,
  29,
  "the first upgraded worker must adopt every mounted legacy suspend page"
);

// Chrome then removes all 29 old extension pages. The grace window must retain
// their newly adopted entries, and the next pass must recreate all of them.
liveTabs = liveTabs.filter((tab) => !tab.url.startsWith(suspendBase));
for (let n = 1; n <= 29; n += 1) await unregisterSuspendedOnClose(1000 + n);

const recovered = await recoverSuspendedTabs();
const after = await getSuspendRegistry();
assert.equal(recovered, 29, "all 29 legacy suspend pages must return after teardown");
assert.equal(created.length, 29, "recovery must recreate each vanished page exactly once");
assert.equal(Object.keys(after).length, 29, "the registry must retain every adopted page");
assert.equal(liveTabs.length, 39, "the observed 39-tab profile must remain 39 tabs");

// Chrome can reveal one of its pre-reload extension tabs only after EveryTab
// has recreated that same occurrence. A later safety pass must treat the old
// tab as a delayed copy, not adopt it as a second suspended occurrence.
liveTabs.push({
  id: 1001,
  windowId: 11,
  index: 1,
  url: suspendUrl(1),
  title: "Legacy 1",
  pinned: false
});
await recoverSuspendedTabs();
const afterLateResurface = await getSuspendRegistry();
const suspendedAfterLateResurface = liveTabs.filter((tab) =>
  tab.url.startsWith(suspendBase));
assert.equal(
  suspendedAfterLateResurface.length,
  29,
  "a pre-reload suspend page that surfaces late must not create a duplicate"
);
assert.equal(
  Object.keys(afterLateResurface).length,
  29,
  "late Chrome resurfacing must retain one durable occurrence per suspended tab"
);
assert.equal(
  Object.values(afterLateResurface)
    .filter((entry) => entry.originalUrl === originalUrl(1)).length,
  2,
  "two intentional suspended occurrences of the same page remain distinct"
);

// The resurfaced page can mount and self-adopt before the next safety pass.
// That path must make the same one-occurrence decision.
const lateSelfAdoptingTab = {
  id: 1002,
  windowId: 12,
  index: 2,
  url: suspendUrl(2),
  title: "Legacy 2",
  pinned: false
};
liveTabs.push(lateSelfAdoptingTab);
assert.equal(await adoptSuspendedPage(lateSelfAdoptingTab), false,
  "a late pre-reload page must not self-adopt as a second occurrence");
assert.equal(liveTabs.some((tab) => tab.id === lateSelfAdoptingTab.id), false,
  "late self-adoption removes Chrome's delayed duplicate copy");
assert.equal(Object.keys(await getSuspendRegistry()).length, 29,
  "late self-adoption leaves the durable recovery registry unchanged");

console.log("PASS: first upgraded worker adopts unregistered live suspend pages before teardown");
