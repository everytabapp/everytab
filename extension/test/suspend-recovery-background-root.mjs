/** Full worker-root regression: an update recovers without a mounted UI page. */
import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

function event() {
  const listeners = new Set();
  return {
    emissions: 0,
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    async emit(...args) {
      this.emissions += 1;
      await Promise.all([...listeners].map((listener) => listener(...args)));
    }
  };
}

const onInstalled = event();
const onStartup = event();
const onMessage = event();
const onTabCreated = event();
const storageChanged = event();
const localValues = { deviceId: "root-recovery-device" };
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const storageArea = {
  async get(keys) {
    if (keys == null) return clone(localValues);
    if (typeof keys === "string") return keys in localValues
      ? { [keys]: clone(localValues[keys]) } : {};
    const requested = Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(requested.flatMap((key) => key in localValues
      ? [[key, clone(localValues[key])]]
      : !Array.isArray(keys) && keys?.[key] !== undefined ? [[key, clone(keys[key])]] : []));
  },
  async set(values) {
    const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
      oldValue: clone(localValues[key]), newValue: clone(value)
    }]));
    Object.assign(localValues, clone(values));
    await storageChanged.emit(changes, "local");
  },
  async remove(keys) {
    for (const key of typeof keys === "string" ? [keys] : keys) delete localValues[key];
  }
};

const api = (values = {}) => new Proxy(values, {
  get(target, property) {
    if (property in target) return target[property];
    return async () => undefined;
  }
});
const passiveEvent = () => event();
let nextTabId = 2_000;
const recoveredTabs = [];
let firstRecoveryAt = null;

globalThis.chrome = {
  runtime: api({
    id: "root-recovery-extension",
    getManifest: () => ({ version: "0.8.586" }),
    getURL: (path) => `chrome-extension://root-recovery-extension/${path}`,
    onInstalled,
    onStartup,
    onMessage
  }),
  i18n: { getMessage: (key) => key },
  storage: {
    local: storageArea,
    session: storageArea,
    onChanged: storageChanged
  },
  tabs: api({
    onActivated: passiveEvent(),
    onUpdated: passiveEvent(),
    onCreated: onTabCreated,
    onRemoved: passiveEvent(),
    query: async () => [],
    async create(properties) {
      const tab = {
        id: nextTabId++, windowId: properties.windowId ?? 7,
        index: properties.index ?? 0, pinned: Boolean(properties.pinned),
        url: properties.url
      };
      if (String(tab.url).startsWith(chrome.runtime.getURL("suspend.html"))) {
        firstRecoveryAt ??= Date.now();
        recoveredTabs.push(tab);
      }
      return tab;
    },
    update: async (tabId, properties) => ({ id: tabId, windowId: 7, ...properties }),
    remove: async () => {}
  }),
  windows: api({
    WINDOW_ID_NONE: -1,
    onFocusChanged: passiveEvent(),
    onRemoved: passiveEvent(),
    getAll: async ({ populate = false } = {}) => [{
      id: 7, type: "normal", focused: true,
      ...(populate ? { tabs: [{ id: 77, windowId: 7, active: true }] } : {})
    }],
    get: async (windowId) => ({ id: windowId, type: "normal", focused: true }),
    getLastFocused: async () => ({ id: 7, type: "normal", focused: true })
  }),
  alarms: api({ onAlarm: passiveEvent(), create: async () => {}, clear: async () => true }),
  notifications: api({
    onButtonClicked: passiveEvent(), onClicked: passiveEvent(), onClosed: passiveEvent(),
    create: async () => "notification", update: async () => false, clear: async () => true
  }),
  contextMenus: api({
    onClicked: passiveEvent(),
    removeAll(callback) { callback?.(); },
    create() {}
  }),
  commands: api({ onCommand: passiveEvent() }),
  omnibox: api({
    onInputChanged: passiveEvent(), onInputCancelled: passiveEvent(),
    onInputEntered: passiveEvent(), setDefaultSuggestion: async () => {}
  }),
  action: api(),
  search: api(),
  sidePanel: api(),
  permissions: api(),
  sessions: api(),
  history: api(),
  tabGroups: api(),
  declarativeNetRequest: api()
};

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { locks: createMockLockManager() }
});

const realSetTimeout = globalThis.setTimeout;
const scheduledTimers = new Set();
globalThis.setTimeout = (callback, delay, ...args) => {
  const handle = realSetTimeout(() => {
    scheduledTimers.delete(handle);
    callback(...args);
  }, delay);
  scheduledTimers.add(handle);
  return handle;
};

const library = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: "root-recovery-device"
});
const recovery = createRecoveryStore({
  adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA)
});
const authority = createStorageAuthority({
  library, recovery, readBrowserLocal: (keys) => chrome.storage.local.get(keys)
});
await library.commit({
  localSets: {
    suspendedRegistry: {
      901: {
        originalUrl: "https://kept.example/root-reload",
        title: "Root reload recovery",
        windowId: 7,
        index: 0,
        pinned: false,
        recoveryOccurrenceId: "root-reload-occurrence"
      }
    }
  }
});
setStorageAuthorityForTests(authority);

const updateStartedAt = Date.now();
try {
  await import("../js/background.js?suspend-recovery-root-fixture");
  await onInstalled.emit({ reason: "update" });
  // Do not emit a tabs.onCreated or any other UI-page event. Let the real 180 ms
  // first reload pass run within Chrome's ordinary worker idle window, then stop
  // before the independent 650 ms safety pass.
  await new Promise((resolve) => realSetTimeout(resolve, 500));

  assert.equal(onTabCreated.emissions, 0,
    "the fixture sends no New Tab or other tabs.onCreated UI signal");
  assert.equal(recoveredTabs.length, 1,
    "the update lifecycle starts the first suspended-tab recovery attempt");
  assert.match(recoveredTabs[0].url, /originalUrl=https%3A%2F%2Fkept\.example%2Froot-reload/);
} finally {
  for (const handle of scheduledTimers) clearTimeout(handle);
  scheduledTimers.clear();
  globalThis.setTimeout = realSetTimeout;
}

console.log(`PASS: background root recovered without a UI page in ${firstRecoveryAt - updateStartedAt} ms`);
