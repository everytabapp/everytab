// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0
/**
 * A page that loads between installation and the worker's first onInstalled
 * used to fail closed at once ("Storage authority is not initialized") and
 * stay blank. Extension pages now wait briefly for the initializing marker or
 * the authority; the worker and non-page contexts still fail closed at once.
 *
 *     node test/fresh-install-page-grace.mjs      (from extension/)
 */
import assert from "node:assert/strict";
import { createStorageAuthorityRecord } from "../js/lib/storage/authority-record.js";

function installChrome(state) {
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const wanted = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(wanted.filter((key) => Object.hasOwn(state, key))
            .map((key) => [key, structuredClone(state[key])]));
        },
        async set(values) { Object.assign(state, structuredClone(values)); }
      },
      onChanged: { addListener() {}, removeListener() {} }
    }
  };
}
const record = createStorageAuthorityRecord({
  runId: "fresh-install-run",
  databases: { library: "everytab-library-test", recovery: "everytab-recovery-test" }
});
let generation = 0;
const freshRuntime = () => import(`../js/lib/storage/authority-runtime.js?grace=${++generation}`);

// 1. Worker or other non-page context: fails closed immediately, as before.
delete globalThis.document;
delete globalThis.location;
installChrome({});
let started = Date.now();
await assert.rejects((await freshRuntime()).currentStorageAuthorityRecord(),
  /Storage authority is not initialized/);
assert.ok(Date.now() - started < 1_000, "a non-page context does not wait");

// 2. Extension page opened before the marker: waits, then reads the authority.
globalThis.document = {};
globalThis.location = { protocol: "chrome-extension:" };
const state = {};
installChrome(state);
started = Date.now();
const pending = (await freshRuntime()).currentStorageAuthorityRecord();
setTimeout(() => {
  state.deviceId = "fresh-device";
  state.storageAuthorityInitialization = { deviceId: "fresh-device", runId: record.runId, startedAt: Date.now() };
}, 150);
setTimeout(() => { state.storageAuthority = record; }, 300);
assert.deepEqual(await pending, record, "the page receives the authority once setup finishes");
assert.ok(Date.now() - started >= 250, "the page waited for setup instead of failing");

// 3. Extension page where setup never starts: still fails closed after the grace.
installChrome({});
started = Date.now();
await assert.rejects((await freshRuntime()).currentStorageAuthorityRecord(),
  /Storage authority is not initialized/);
const waited = Date.now() - started;
assert.ok(waited >= 3_900 && waited < 8_000, `a page fails closed after the bounded grace (${waited} ms)`);

console.log("PASS: fresh-install pages wait for storage setup; the worker and a profile without setup still fail closed");
