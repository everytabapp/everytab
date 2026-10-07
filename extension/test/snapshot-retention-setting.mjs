import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";
import {
  DEFAULT_SETTINGS, SNAPSHOT_KEEP_MAX, SNAPSHOT_KEEP_MIN, STORE_KEYS, effectiveSnapshotKeep
} from "../js/lib/types.js";

/*
 * The Recovery database must honor the visible "Snapshots to keep" setting.
 * The control is bounded 1 to 1000; a stored 0 (formerly "keep all") or a
 * value above 1000 reads as 1000 without rewriting the stored setting.
 */

assert.equal(SNAPSHOT_KEEP_MIN, 1);
assert.equal(SNAPSHOT_KEEP_MAX, 1000);
assert.equal(DEFAULT_SETTINGS.snapshotKeep, 200, "the default stays 200");
assert.equal(effectiveSnapshotKeep(0), 1000, "a legacy 0 reads as the maximum");
assert.equal(effectiveSnapshotKeep(10_000), 1000, "a legacy value above the maximum reads as the maximum");
assert.equal(effectiveSnapshotKeep(1000), 1000);
assert.equal(effectiveSnapshotKeep(50), 50);
assert.equal(effectiveSnapshotKeep(1), 1);
assert.equal(effectiveSnapshotKeep(-5), 1000);
assert.equal(effectiveSnapshotKeep(undefined), 200, "an absent value reads as the default");
assert.equal(effectiveSnapshotKeep("abc"), 200, "a malformed value reads as the default");

const storage = createInterleavableStorage({});
globalThis.chrome = { storage: { local: storage.local, onChanged: storage.onChanged } };
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const libraryAdapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const recoveryAdapter = createMemoryIndexedDbAdapter(RECOVERY_SCHEMA);
const library = createLibraryStore({ adapter: libraryAdapter, deviceId: "retention-review" });
const recovery = createRecoveryStore({ adapter: recoveryAdapter });
const authority = createStorageAuthority({
  library, recovery, readBrowserLocal: (keys) => storage.local.get(keys)
});
setStorageAuthorityForTests(authority);

const { getSettings, mutateStores, readFreshStoreMap, settingsFromStored } = await import("../js/lib/store.js");

assert.equal(settingsFromStored({ snapshotKeep: 0 }).snapshotKeep, 1000,
  "read-time normalization treats a stored 0 as 1000");
assert.equal(settingsFromStored({ snapshotKeep: 5000 }).snapshotKeep, 1000);
assert.equal(settingsFromStored({ snapshotKeep: 50 }).snapshotKeep, 50);
assert.equal(settingsFromStored({}).snapshotKeep, 200);

let sequence = 0;
const automaticSnapshot = () => {
  sequence += 1;
  const stamp = 1_000 + sequence;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    deviceId: "retention-review", schemaVersion: 1, createdAt: stamp, modifiedAt: stamp,
    name: `Snapshot ${sequence}`, auto: true, labels: [],
    windows: [[{ url: `https://snapshot-${sequence}.example/`, title: `Tab ${sequence}` }]]
  };
};
const addSnapshots = (count) => mutateStores([STORE_KEYS.sessions], (maps) => {
  const sessions = { ...(maps[STORE_KEYS.sessions] ?? {}) };
  for (let index = 0; index < count; index += 1) {
    const snapshot = automaticSnapshot();
    sessions[snapshot.id] = snapshot;
  }
  return { [STORE_KEYS.sessions]: sessions };
});
const storeSnapshotKeep = (snapshotKeep) => mutateStores(["settings", "settingsModifiedAt"], (maps) => ({
  settings: { ...(maps.settings ?? {}), snapshotKeep },
  settingsModifiedAt: Date.now()
}));
const retained = async () => (await recovery.listSnapshots({ limit: 10_000 })).length;

// Setting 1000: 201 captures keep all 201 (the old fixed 200 would prune one).
await storeSnapshotKeep(1000);
assert.equal((await getSettings()).snapshotKeep, 1000);
await addSnapshots(201);
assert.equal(await retained(), 201, "with the setting at 1000, 201 automatic Snapshots all remain");

// Setting 0 behaves as 1000 without rewriting the stored value.
await storeSnapshotKeep(0);
assert.equal((await readFreshStoreMap("settings")).snapshotKeep, 0,
  "the stored legacy value is left untouched");
assert.equal((await getSettings()).snapshotKeep, 1000, "the effective value is the maximum");
await addSnapshots(1);
assert.equal(await retained(), 202, "a stored 0 keeps capturing up to the maximum");

// Setting 50 prunes the Recovery database to the newest 50.
await storeSnapshotKeep(50);
assert.equal((await getSettings()).snapshotKeep, 50);
await addSnapshots(1);
assert.equal(await retained(), 50, "the Recovery database honors the effective setting");
const retainedIds = (await recovery.listSnapshots({ limit: 10_000 })).map(({ id }) => id);
assert.ok(retainedIds.includes(`00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`),
  "the newest capture is retained");
assert.ok(!retainedIds.includes("00000000-0000-4000-8000-000000000001"),
  "the oldest capture is pruned");
const logical = await authority.readMaps([STORE_KEYS.sessions]);
const liveAutomatic = Object.values(logical[STORE_KEYS.sessions]).filter((s) => s.auto && !s.deletedAt);
assert.equal(liveAutomatic.length, 50, "the logical Session view agrees with Recovery retention");

// A settings commit that carries captures in the same mutation uses the
// committed value, not the previous one.
await mutateStores([STORE_KEYS.sessions, "settings", "settingsModifiedAt"], (maps) => {
  const sessions = { ...(maps[STORE_KEYS.sessions] ?? {}) };
  const snapshot = automaticSnapshot();
  sessions[snapshot.id] = snapshot;
  return {
    [STORE_KEYS.sessions]: sessions,
    settings: { ...(maps.settings ?? {}), snapshotKeep: 10 },
    settingsModifiedAt: Date.now()
  };
});
assert.equal(await retained(), 10, "captures in a settings commit use the newly committed retention");

console.log("PASS: automatic Snapshot retention follows the bounded Settings value in Recovery");
