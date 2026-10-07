/** A close owns one stable occurrence across the registry aliases left by restart. */
import assert from "node:assert/strict";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const base = "chrome-extension://test-ext-id/";
const url = "https://closed-after-restart.example/page";
const mem = {};
let liveTabs = [], created = [], nextId = 900;
let failRegistryWrite = false, failLedgerWrite = false, beforeCreate = null;
globalThis.chrome = {
  runtime: { getURL: path => base + path },
  storage: { local: {
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .filter(key => key in mem).map(key => [key, structuredClone(mem[key])]));
    },
    async set(values) {
      if (failRegistryWrite && "suspendedRegistry" in values) {
        failRegistryWrite = false;
        throw new Error("Registry write rejected");
      }
      if (failLedgerWrite && "suspendCloseCleanup" in values) {
        throw new Error("Ledger write rejected");
      }
      Object.assign(mem, structuredClone(values));
    }
  } },
  alarms: { async create() {} },
  windows: { async getAll() { return [{ id: 101 }, { id: 102 }]; } },
  tabs: {
    async query() { return structuredClone(liveTabs); },
    async create(props) {
      await beforeCreate?.();
      const tab = { id: nextId++, windowId: 102, index: 0, ...props };
      created.push(tab); liveTabs.push(tab); return { ...tab };
    },
    async update(id, props) { return { id, ...props }; },
    async remove(id) { liveTabs = liveTabs.filter(tab => tab.id !== id); }
  }
};
Object.defineProperty(globalThis, "navigator", { value: { locks: createMockLockManager() }, configurable: true });
installBrowserMapStorageAuthority();
const { mutateStores } = await import("../js/lib/store.js");
const { adoptSuspendedPage, queueSuspendedCloseCleanup, recoverSuspendedTabs,
  retrySuspendedCloseCleanups, getSuspendRegistry } = await import("../js/lib/suspend.js");
const entry = occurrence => ({ originalUrl: url, title: "Fixture", windowId: 11,
  index: 1, pinned: false, recoveryOccurrenceId: occurrence });

async function restartFixture(label) {
  const occurrence = `closed-${label}`;
  const other = `intentional-${label}`;
  await mutateStores(["suspendedRegistry", "suspendRecoveryGraceUntil"], () => ({
    suspendedRegistry: { 3: entry(occurrence), 4: { ...entry(other), windowId: 102 } },
    suspendRecoveryGraceUntil: 0
  }));
  liveTabs = [{ id: 103, windowId: 101, index: 1, pinned: false,
    url: base + "suspend.html?" + new URLSearchParams({ originalUrl: url,
      title: "Fixture", recoveryOccurrenceId: occurrence }) }];
  assert.equal(await adoptSuspendedPage(liveTabs[0]), true);
  assert.ok((await getSuspendRegistry())[3]);
  assert.ok((await getSuspendRegistry())[103], "real adoption leaves an old/current alias pair");
  liveTabs = []; created = []; beforeCreate = null;
  return { occurrence, other };
}

for (const mode of ["success", "failed-registry", "failed-ledger"]) {
  const { occurrence, other } = await restartFixture(mode);
  failRegistryWrite = mode === "failed-registry";
  failLedgerWrite = mode === "failed-ledger";
  if (mode === "success") {
    assert.equal(await queueSuspendedCloseCleanup(103), "removed");
    assert.ok(!Object.values(await getSuspendRegistry()).some(item => item.recoveryOccurrenceId === occurrence),
      "successful close removes every alias of the closed occurrence");
  } else {
    await assert.rejects(queueSuspendedCloseCleanup(103), /write rejected/);
    if (mode === "failed-registry") assert.equal(mem.suspendCloseCleanup[103].recoveryOccurrenceId, occurrence);
  }
  assert.equal(await recoverSuspendedTabs({ allowReloadRepair: true }), 1,
    "only the independent same-URL occurrence may recover while close cleanup is pending");
  assert.deepEqual(created.map(tab => new URL(tab.url).searchParams.get("recoveryOccurrenceId")), [other]);
  failLedgerWrite = false;
  if (mode === "failed-ledger") await queueSuspendedCloseCleanup(103);
  else await retrySuspendedCloseCleanups();
  assert.ok(!Object.values(await getSuspendRegistry()).some(item => item.recoveryOccurrenceId === occurrence));
  assert.deepEqual(mem.suspendCloseCleanup, {});
}

// A late receipt may refer to an alias whose numeric ID now belongs to new work.
const closed = entry("old-closed");
await mutateStores(["suspendedRegistry"], () => ({ suspendedRegistry: {
  3: closed, 103: entry("reused-id-new-occurrence"), 104: entry("same-url-independent")
} }));
await chrome.storage.local.set({ suspendCloseCleanup: { 103: { ...closed, tabId: 103 } } });
await retrySuspendedCloseCleanups();
assert.deepEqual(Object.keys(await getSuspendRegistry()).sort(), ["103", "104"],
  "retire exact stale aliases without deleting a reused numeric ID or equal-URL occurrence");

// The close begins after recovery selected the old alias but before Chrome replies.
const { occurrence, other } = await restartFixture("in-flight");
beforeCreate = async () => {
  beforeCreate = null;
  failRegistryWrite = true;
  await assert.rejects(queueSuspendedCloseCleanup(103), /Registry write rejected/);
};
await recoverSuspendedTabs();
assert.ok(!liveTabs.some(tab => new URL(tab.url).searchParams.get("recoveryOccurrenceId") === occurrence),
  "a pending close invalidates an already-selected sibling before the recovery effect settles");
assert.ok(liveTabs.some(tab => new URL(tab.url).searchParams.get("recoveryOccurrenceId") === other));
await retrySuspendedCloseCleanups();
console.log("PASS: restart aliases, failed writes and in-flight recovery preserve exact close intent");
