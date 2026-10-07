import assert from "node:assert/strict";

const authority = {
  app: "everytab",
  kind: "storage-authority",
  formatVersion: 1,
  runId: "installed-run",
  createdAt: 123,
  databases: {
    library: "installed-library-database",
    recovery: "installed-recovery-database"
  },
  snapshotRetention: 200
};
const localState = {
  storageAuthority: structuredClone(authority),
  deviceId: "installed-device"
};
const writes = [];
const removals = [];
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted
          .filter((key) => Object.hasOwn(localState, key))
          .map((key) => [key, structuredClone(localState[key])]));
      },
      async set(values) {
        writes.push(structuredClone(values));
        Object.assign(localState, structuredClone(values));
      },
      async remove(keys) {
        removals.push(...(Array.isArray(keys) ? keys : [keys]));
      }
    },
    onChanged: { addListener() {}, removeListener() {} }
  }
};

const runtime = await import(`../js/lib/storage/authority-runtime.js?current=${Date.now()}`);
assert.deepEqual(await runtime.currentStorageAuthorityRecord(), authority,
  "the installed authority carries its exact database names without translation");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(writes, [], "reading the permanent authority performs no storage write");
assert.deepEqual(removals, [], "reading the permanent authority removes no storage data");
assert.deepEqual(localState.storageAuthority, authority,
  "runtime selection cannot change or rename the installed authority");

const missingState = { deviceId: "uninitialized-device" };
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted
          .filter((key) => Object.hasOwn(missingState, key))
          .map((key) => [key, structuredClone(missingState[key])]));
      },
      async set(values) { Object.assign(missingState, structuredClone(values)); }
    },
    onChanged: { addListener() {}, removeListener() {} }
  }
};
const missingRuntime = await import(
  `../js/lib/storage/authority-runtime.js?missing=${Date.now()}`
);
await assert.rejects(missingRuntime.currentStorageAuthorityRecord(),
  /Storage authority is not initialized/,
  "a profile without an authority fails closed");
assert.equal(Object.hasOwn(missingState, "storageAuthority"), false,
  "ordinary runtime reads cannot manufacture an authority");

console.log("PASS: installed Storage authority is the only runtime pointer");
