import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

let localState = {
  storageAuthorityInitialization: {
    deviceId: "fresh-device",
    runId: "fresh-run",
    startedAt: 1
  },
  deviceId: "fresh-device"
};
const listeners = new Set();
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted
          .filter((key) => Object.hasOwn(localState, key))
          .map((key) => [key, structuredClone(localState[key])]));
      },
      // Keep the worker's independent resume attempt pending. This fixture
      // controls the final publication below and is testing only whether a
      // second surface can escape through the initializing boundary.
      async set() { return new Promise(() => {}); }
    },
    onChanged: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); }
    }
  }
};

const runtime = await import(`../js/lib/storage/authority-runtime.js?race=${Date.now()}`);
let settled = false;
const selectedAuthority = runtime.currentStorageAuthorityRecord().then((value) => {
  settled = true;
  return value;
});

await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(settled, false,
  "a concurrent surface must wait while the fresh-install authority is initializing");

localState = {
  storageAuthority: {
    app: "everytab",
    kind: "storage-authority",
    formatVersion: 1,
    runId: "fresh-run",
    createdAt: 1,
    databases: {
      library: "everytab-library-v2",
      recovery: "everytab-recovery-v2"
    },
    snapshotRetention: 200
  }
};
for (const listener of listeners) {
  listener({
    storageAuthority: { newValue: structuredClone(localState.storageAuthority) },
    storageAuthorityInitialization: { oldValue: { runId: "fresh-run" } }
  }, "local");
}
assert.deepEqual(await selectedAuthority, localState.storageAuthority,
  "the waiting surface must observe the final authority, never another storage route");

const source = await readFile(
  new URL("../js/lib/storage/authority-runtime.js", import.meta.url), "utf8"
);
const initialize = source.slice(source.indexOf("export function initializeStorageAuthority"));
assert.ok(initialize.indexOf("chrome.storage.local.set") < initialize.indexOf("await markerWritten"),
  "fresh installation must publish its fail-closed marker before its first await");
assert.match(initialize, /STORAGE_AUTHORITY_INITIALIZATION_KEY/,
  "the initializing marker must retain enough identity to resume after worker termination");
assert.match(source, /export async function resumeStorageAuthorityInitialization/,
  "an interrupted fresh installation must have an explicit resume path");
assert.match(source,
  /void resumeStorageAuthorityInitialization\(\)\.catch/,
  "every new worker must resume an interrupted fresh installation during module boot");

// Simulate the next worker after termination. Only the durable initialization
// marker survives; no in-memory promise or database connection does.
delete globalThis.chrome;
const resumedRuntime = await import(
  `../js/lib/storage/authority-runtime.js?resume=${Date.now()}`
);
const resumedListeners = new Set();
const resumedState = {
  storageAuthorityInitialization: {
    deviceId: "interrupted-device",
    runId: "interrupted-run",
    startedAt: 42
  },
  deviceId: "interrupted-device"
};
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted
          .filter((key) => Object.hasOwn(resumedState, key))
          .map((key) => [key, structuredClone(resumedState[key])]));
      },
      async set(values) { Object.assign(resumedState, structuredClone(values)); },
      async remove(key) { delete resumedState[key]; }
    },
    onChanged: {
      addListener(listener) { resumedListeners.add(listener); },
      removeListener(listener) { resumedListeners.delete(listener); }
    }
  }
};

let libraryOpened = 0;
let recoveryOpened = 0;
let libraryVerified = 0;
let recoveryVerified = 0;
let storesClosed = 0;
const resumedLibraryAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
let resumedLibrary;
const openLibrary = ({ databaseName, deviceId }) => {
  assert.equal(databaseName, "everytab-library-v2");
  assert.equal(deviceId, "interrupted-device");
  libraryOpened += 1;
  const store = createLibraryStore({
    adapter: resumedLibraryAdapter,
    deviceId
  });
  resumedLibrary = store;
  return {
    ...store,
    async readFamily(...args) {
      libraryVerified += 1;
      return store.readFamily(...args);
    },
    async close() {
      storesClosed += 1;
      return store.close();
    }
  };
};
const openRecovery = ({ databaseName }) => {
  assert.equal(databaseName, "everytab-recovery-v2");
  recoveryOpened += 1;
  const store = createRecoveryStore({
    adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA)
  });
  return {
    ...store,
    async listSnapshots(...args) {
      recoveryVerified += 1;
      return store.listSnapshots(...args);
    },
    async close() {
      storesClosed += 1;
      return store.close();
    }
  };
};

const resumed = await resumedRuntime.resumeStorageAuthorityInitialization({
  openLibrary,
  openRecovery,
  now: () => 84
});
assert.equal(resumed.initialized, true,
  "a new worker resumes the interrupted installation from its durable marker");
assert.deepEqual((await resumedLibrary.readEntity("settings", "current")).value,
  { value: { autoArchiveEnabled: false, suspendEnabled: false }, modifiedAt: 84 },
  "fresh installation persists opt-in automatic closing and suspension before publishing authority");
assert.deepEqual(resumedState.storageAuthority, {
  app: "everytab",
  kind: "storage-authority",
  formatVersion: 1,
  runId: "interrupted-run",
  createdAt: 84,
  databases: {
    library: "everytab-library-v2",
    recovery: "everytab-recovery-v2"
  },
  snapshotRetention: 200
}, "resume publishes the exact permanent authority after both stores verify");
assert.equal(resumedState.storageAuthorityInitialization, undefined,
  "resume removes the initializing marker only after authority publication");
assert.deepEqual({ libraryOpened, recoveryOpened, libraryVerified, recoveryVerified, storesClosed }, {
  libraryOpened: 1,
  recoveryOpened: 1,
  libraryVerified: 1,
  recoveryVerified: 1,
  storesClosed: 2
}, "resume verifies and closes exactly one Library and Recovery store");

const repeated = await resumedRuntime.resumeStorageAuthorityInitialization({
  openLibrary,
  openRecovery,
  now: () => 126
});
assert.deepEqual(repeated, { initialized: false },
  "a second resume is an idempotent no-op once authority exists");
assert.deepEqual({ libraryOpened, recoveryOpened }, { libraryOpened: 1, recoveryOpened: 1 },
  "an idempotent resume does not reopen either database");

// Rehearse interruption after the first preference commit, before authority
// publication. The same initialization must not reset an existing choice.
await resumedLibrary.commit({ operations: [{ type: "put", family: "settings", id: "current",
  value: { value: { suspendEnabled: true, suspendAfterMinutes: 47 }, modifiedAt: 99 } }] });
delete resumedState.storageAuthority;
resumedState.storageAuthorityInitialization = { deviceId: "interrupted-device", runId: "interrupted-run", startedAt: 42 };
await resumedRuntime.resumeStorageAuthorityInitialization({ openLibrary, openRecovery, now: () => 126 });
assert.deepEqual((await resumedLibrary.readEntity("settings", "current")).value,
  { value: { suspendEnabled: true, suspendAfterMinutes: 47 }, modifiedAt: 99 },
  "resuming initialization never overwrites preferences already committed");

console.log("PASS: fresh-install surfaces wait and interrupted initialization resumes exactly");
