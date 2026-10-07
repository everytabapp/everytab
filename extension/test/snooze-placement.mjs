import assert from "node:assert/strict";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { STORE_KEYS } from "../js/lib/types.js";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() },
  configurable: true,
  writable: true
});

const dueAt = Date.now() - 1_000;
const snooze = {
  id: "missed-alarm-placement",
  deviceId: "device-a",
  createdAt: 1_000,
  modifiedAt: 1_000,
  schemaVersion: 1,
  url: "https://sleeping.example/article",
  title: "Sleeping",
  dueAt
};
const placement = {
  snoozeId: snooze.id,
  occurrenceDueAt: dueAt,
  sourceWindowId: 91,
  index: 1,
  pinned: false,
  browserSessionId: "old-browser-session",
  peerUrls: [
    "https://before.example/",
    "https://after.example/"
  ],
  capturedAt: 1_000
};

const storage = createInterleavableStorage({
  deviceId: "device-a",
  [STORE_KEYS.snoozes]: { [snooze.id]: snooze },
  snoozePlacements: { [snooze.id]: placement }
});
const sessionMem = {};
const createdTabs = [];
const createdWindows = [];
let liveWindows = [
  {
    id: 6,
    type: "normal",
    incognito: false,
    focused: true,
    tabs: [{ id: 60, windowId: 6, index: 0,
      url: "chrome-extension://test/newtab.html" }]
  },
  {
    id: 42,
    type: "normal",
    incognito: false,
    focused: false,
    tabs: [
      { id: 420, windowId: 42, index: 0, url: "https://before.example/" },
      { id: 999, windowId: 42, index: 1, url: "https://sleeping.example/article" },
      { id: 421, windowId: 42, index: 2, url: "https://after.example/" }
    ]
  }
];

globalThis.chrome = {
  storage: {
    local: storage.local,
    session: {
      get: async (key) => key in sessionMem ? { [key]: sessionMem[key] } : {},
      set: async (values) => Object.assign(sessionMem, structuredClone(values))
    }
  },
  tabs: {
    create: async (props) => {
      createdTabs.push(structuredClone(props));
      return { id: 500 + createdTabs.length, ...props };
    }
  },
  windows: {
    // Chrome restarted: every live window has a new numeric id. Window 6 is
    // the implicit worker destination and contains an EveryTab page; window 42
    // is the restored source, proven by the two pages that surrounded the
    // snoozed tab when it was captured.
    getAll: async () => structuredClone(liveWindows),
    get: async (id) => {
      const win = liveWindows.find((entry) => entry.id === id);
      if (!win) throw new Error("window not found");
      return structuredClone(win);
    },
    create: async (props) => {
      createdWindows.push(structuredClone(props));
      return { id: 700 + createdWindows.length };
    }
  },
  alarms: {
    create: async () => {},
    clear: async () => true
  },
  i18n: createChromeI18nMock(),
  notifications: { create: async () => "notification" },
  action: {
    setBadgeText: async () => { throw new Error("badge unavailable"); },
    setBadgeBackgroundColor: async () => {}
  },
  runtime: { getURL: (path) => `chrome-extension://test/${path}` }
};

const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();

const { captureSnoozePlacement, openSnoozedTab } = await import(
  "../js/lib/snooze-placement.js"
);
const captured = await captureSnoozePlacement({
  id: 999,
  windowId: 42,
  index: 1,
  pinned: true,
  url: "https://sleeping.example/article"
});
assert.deepEqual(captured.peerUrls, [
  "https://before.example/",
  "https://after.example/"
]);
assert.equal(captured.sourceWindowId, 42);
assert.equal(captured.index, 1);
assert.equal(captured.pinned, true);
assert.equal(typeof captured.browserSessionId, "string");

const { createSnooze } = await import("../js/lib/snooze.js");
const placedFuture = await createSnooze({
  url: "https://future.example/",
  title: "Future",
  dueAt: Date.now() + 60_000
}, { placement: captured });
assert.equal(storage.snapshot().snoozePlacements[placedFuture.id].sourceWindowId, 42);
assert.equal("sourceWindowId" in storage.snapshot()[STORE_KEYS.snoozes][placedFuture.id], false,
  "device-local Chrome placement must not enter the portable Snooze record");

// While Chrome remains in the same browser session, the live window id is
// authoritative even if every peer page has changed since the Snooze.
liveWindows[1].tabs = [];
await openSnoozedTab(
  storage.snapshot()[STORE_KEYS.snoozes][placedFuture.id],
  storage.snapshot().snoozePlacements[placedFuture.id]
);
assert.equal(createdTabs[0].windowId, 42);
createdTabs.length = 0;

// A browser restart clears storage.session and assigns new window ids. Restore
// the peer pages under id 42 so the overdue fixture must use context matching.
delete sessionMem.snoozeBrowserSessionId;
liveWindows[1].tabs = [
  { id: 420, windowId: 42, index: 0, url: "https://before.example/" },
  { id: 421, windowId: 42, index: 1, url: "https://after.example/" }
];

const { fireSnooze } = await import("../js/lib/snooze-delivery.js");
const result = await fireSnooze(snooze.id, { manual: false });

assert.equal(result.status, "delivered");
assert.deepEqual(createdTabs, [{
  url: snooze.url,
  active: false,
  windowId: 42,
  index: 1,
  pinned: false
}], "a missed-alarm wake must return to the restored source window, not the worker's current window");
assert.equal(createdWindows.length, 0);

// Recurrence advances the local placement to the same next occurrence as the
// portable Snooze, so its later wake retains the same source contract.
const recurringPlacement = await captureSnoozePlacement({
  id: 998,
  windowId: 42,
  index: 1,
  pinned: false,
  url: "https://recurring.example/"
});
const recurring = await createSnooze({
  url: "https://recurring.example/",
  title: "Recurring",
  dueAt: Date.now() - 500,
  recurrence: "daily"
}, { placement: recurringPlacement });
await fireSnooze(recurring.id, { manual: true });
const recurringState = storage.snapshot();
assert.equal(
  recurringState.snoozePlacements[recurring.id].occurrenceDueAt,
  recurringState[STORE_KEYS.snoozes][recurring.id].dueAt,
  "a recurring Snooze must advance its portable schedule and local placement together"
);
createdTabs.length = 0;

// If two restored windows fit equally, never pick either one merely because it
// contains an EveryTab page or happens to be focused. A distinct replacement
// makes the uncertain placement visible and keeps both real windows untouched.
liveWindows = [
  { id: 71, type: "normal", incognito: false, tabs: [
    { id: 710, index: 0, url: "https://same.example/" }
  ] },
  { id: 72, type: "normal", incognito: false, tabs: [
    { id: 720, index: 0, url: "https://same.example/" }
  ] }
];
const ambiguous = {
  ...snooze,
  id: "ambiguous",
  dueAt: dueAt + 1
};
await openSnoozedTab(ambiguous, {
  snoozeId: ambiguous.id,
  occurrenceDueAt: ambiguous.dueAt,
  sourceWindowId: 90,
  index: 1,
  pinned: false,
  peerUrls: ["https://same.example/"],
  capturedAt: 1_000
});
assert.deepEqual(createdWindows, [{ url: ambiguous.url, focused: false }],
  "an ambiguous restart match must create a replacement instead of choosing a real window");

// Old or synced Snoozes have no local placement and retain the established
// current-window behavior.
const legacy = { ...snooze, id: "legacy", dueAt: dueAt + 2 };
await openSnoozedTab(legacy, null);
assert.deepEqual(createdTabs.at(-1), { url: legacy.url, active: false });

// A saved record can arrive from a Restore file or a Vault peer. Every single
// tab reopen path refuses a non-web address and reports a failed receipt,
// whichever placement branch would have opened it.
const { wakeUrl } = await import("../js/lib/snooze-placement.js");
assert.equal(wakeUrl("HTTP://Example.com/a"), "http://example.com/a");
assert.equal(wakeUrl("https://example.com/"), "https://example.com/");
createdTabs.length = 0;
createdWindows.length = 0;
const rejectedUrls = [
  "chrome://settings/resetProfileSettings",
  "chrome://extensions/",
  "file:///etc/hosts",
  "data:text/html,<p>hi</p>",
  "javascript:alert(1)",
  "chrome-extension://abcdefghijklmnop/dashboard.html",
  "",
  "not a url"
];
liveWindows = [
  { id: 42, type: "normal", incognito: false, tabs: [
    { id: 420, windowId: 42, index: 0, url: "https://before.example/" },
    { id: 421, windowId: 42, index: 1, url: "https://after.example/" }
  ] }
];
sessionMem.snoozeBrowserSessionId = "same-session";
for (const [index, url] of rejectedUrls.entries()) {
  assert.equal(wakeUrl(url), null, `${url || "(empty)"} is not a wake address`);
  const rejected = { ...snooze, id: `rejected-${index}`, dueAt: dueAt + 10 + index, url };
  const branches = {
    "current-window": null,
    "source-window": { ...placement, snoozeId: rejected.id, occurrenceDueAt: rejected.dueAt,
      browserSessionId: "same-session", sourceWindowId: 42 },
    "replacement-window": { ...placement, snoozeId: rejected.id, occurrenceDueAt: rejected.dueAt,
      browserSessionId: "gone-session", sourceWindowId: 90, peerUrls: ["https://nowhere.example/"] }
  };
  for (const [branch, candidate] of Object.entries(branches)) {
    assert.deepEqual(await openSnoozedTab(rejected, candidate),
      { ok: false, opened: 0, sourceUnavailable: true },
      `${branch}: ${url || "(empty)"} yields a failed receipt`);
  }
}
assert.equal(createdTabs.length, 0, "no rejected address reaches tabs.create");
assert.equal(createdWindows.length, 0, "no rejected address reaches windows.create");

console.log("PASS: Snooze placement is restart-safe, local-only, and ambiguity-safe");
