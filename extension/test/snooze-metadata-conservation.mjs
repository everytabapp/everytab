import assert from "node:assert/strict";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

const storage = createInterleavableStorage({ deviceId: "snooze-metadata-test" });
const createdTabs = [];
const createdWindows = [];
globalThis.setTimeout = () => 0;
globalThis.chrome = {
  storage: { local: storage.local, onChanged: storage.onChanged },
  alarms: { create: async () => {} },
  tabs: { create: async (options) => {
    createdTabs.push(structuredClone(options));
    return { id: 100 + createdTabs.length, windowId: 7, ...options };
  } },
  windows: { create: async (options) => {
    createdWindows.push(structuredClone(options));
    return { id: 20 + createdWindows.length, ...options };
  } },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {}
  },
  i18n: createChromeI18nMock(),
  notifications: { create: async () => {} },
  runtime: { getURL: (path) => `chrome-extension://test/${path}` }
};
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const library = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: "snooze-metadata-test"
});
const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
setStorageAuthorityForTests(createStorageAuthority({
  library, recovery, readBrowserLocal: (keys) => storage.local.get(keys)
}));

const { STORE_KEYS } = await import("../js/lib/types.js");
const { snoozeTabRefs, moveTabsToSession } = await import("../js/lib/actions.js");
const { isWindowSnooze, snoozeRefs } = await import("../js/lib/snooze.js");
const { fireSnooze } = await import("../js/lib/snooze-delivery.js");
const { buildPortableExport } = await import("../js/lib/portable-state.js");
const { parsePortableExport } = await import("../js/lib/portable-state-registry.js");

let sequence = 1;
const meta = () => ({
  id: `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
  deviceId: "snooze-metadata-test", schemaVersion: 1,
  createdAt: sequence, modifiedAt: sequence
});
const put = async (family, value) => library.transact([
  { type: "put", family, id: value.id, value }
]);
const read = async (family, id) =>
  (await library.readEntity(family, id))?.value ?? null;

const snoozedRef = {
  url: "https://snoozed.example/article",
  title: "Saved article",
  favIconUrl: "https://snoozed.example/favicon.ico",
  pinned: true,
  labels: ["Per-tab", "Shared"],
  groupIndex: 2
};
const effectiveSnoozedRef = {
  ...snoozedRef,
  labels: ["Carrier-only", "Per-tab", "Shared"]
};
const snoozeSource = {
  ...meta(), kind: "window", source: "manual", labels: ["Carrier-only"],
  tabs: [
    { ...snoozedRef, pageContent: "must not become portable metadata" },
    { url: "https://awake.example/", title: "Keep saved" }
  ]
};
await put(STORE_KEYS.inbox, snoozeSource);
assert.equal(await snoozeTabRefs(
  [{ item: structuredClone(snoozeSource), indexes: [0] }],
  Date.now() + 3_600_000
), 1);
const storedSnooze = (await library.readFamily(STORE_KEYS.snoozes))[0].value;

const existingRef = {
  url: "https://existing.example/", title: "Existing",
  labels: ["Existing only"], groupIndex: 0
};
const targetSession = {
  ...meta(), name: "Existing target", auto: false, labels: ["Session label"],
  windows: [[existingRef]],
  groups: [[{ title: "Existing group", color: "blue", collapsed: false }]]
};
const movedRef = {
  url: "https://moved.example/", title: "Moved",
  favIconUrl: "https://moved.example/favicon.ico",
  pinned: false,
  labels: ["Per-tab", "Shared"],
  groupIndex: 3
};
const sessionSource = {
  ...meta(), kind: "window", source: "manual", labels: ["Carrier", "Shared"],
  tabs: [
    { ...movedRef, pageContent: "must not become portable metadata" },
    { url: "https://left.example/", title: "Left" }
  ]
};
await put(STORE_KEYS.sessions, targetSession);
await put(STORE_KEYS.inbox, sessionSource);
const moved = await moveTabsToSession(
  [{ item: structuredClone(sessionSource), indexes: [0] }],
  targetSession.id
);
assert.equal(moved?.moved, 1);
const storedSession = await read(STORE_KEYS.sessions, targetSession.id);

const portable = parsePortableExport(await buildPortableExport());
const portableSnooze = portable.records[STORE_KEYS.snoozes][storedSnooze.id];
const portableSession = portable.records[STORE_KEYS.sessions][targetSession.id];

const delivery = await fireSnooze(storedSnooze.id);
const actual = {
  singleSnoozeKeepsRef: JSON.stringify(storedSnooze.tabs) ===
    JSON.stringify([effectiveSnoozedRef]),
  snoozeProjectionKeepsRef: JSON.stringify(snoozeRefs(storedSnooze)) ===
    JSON.stringify([effectiveSnoozedRef]),
  savedSingleClassifiedAsTab: isWindowSnooze(storedSnooze) === false,
  oneRefWindowBundleStillClassifiedAsWindow: isWindowSnooze({
    ...storedSnooze, url: "", tabs: [effectiveSnoozedRef]
  }) === true,
  existingSessionRefUntouched: JSON.stringify(storedSession.windows[0]) ===
    JSON.stringify([existingRef]),
  movedSessionRefGetsEffectiveLabels: JSON.stringify(storedSession.windows[1]) ===
    JSON.stringify([{ ...movedRef, labels: ["Carrier", "Shared", "Per-tab"] }]),
  portableSnoozeKeepsRef: JSON.stringify(portableSnooze.tabs) ===
    JSON.stringify([effectiveSnoozedRef]),
  portableSessionKeepsLabels: JSON.stringify(portableSession.windows[1]) ===
    JSON.stringify([{ ...movedRef, labels: ["Carrier", "Shared", "Per-tab"] }]),
  singleDeliveryUsesTabPath: delivery.status === "delivered" &&
    JSON.stringify(createdTabs) === JSON.stringify([{ url: snoozedRef.url, active: false }]) &&
    createdWindows.length === 0
};

assert.deepEqual(actual, {
  singleSnoozeKeepsRef: true,
  snoozeProjectionKeepsRef: true,
  savedSingleClassifiedAsTab: true,
  oneRefWindowBundleStillClassifiedAsWindow: true,
  existingSessionRefUntouched: true,
  movedSessionRefGetsEffectiveLabels: true,
  portableSnoozeKeepsRef: true,
  portableSessionKeepsLabels: true,
  singleDeliveryUsesTabPath: true
});

console.log("snooze-metadata-conservation: ok");
