import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true, writable: true
});

const storage = createInterleavableStorage({ deviceId: "import-test-device" });
globalThis.chrome = {
  storage: { local: storage.local, onChanged: storage.onChanged },
  tabs: { create: async () => ({ id: 1 }), move: async () => null },
  windows: { create: async () => ({ id: 2 }) }
};

const { STORE_KEYS, ARCHIVE_OVERLAY_KEY } = await import("../js/lib/types.js");
const { LABEL_META_KEY } = await import("../js/lib/label-meta.js");
const { JOURNAL_KEY, undoAction } = await import("../js/lib/journal.js");
const { commitParsedImport } = await import("../js/lib/import-commit.js");

const parsed = {
  name: "Imported work",
  source: "onetab",
  groups: [
    { name: "One", tabs: [
      { url: "https://one.example/", title: "One", labels: ["Work"] },
      { url: "https://two.example/", title: "Two", labels: ["Read"] }
    ] },
    { name: "Two", tabs: [
      { url: "https://three.example/", title: "Three", labels: ["Work"] }
    ] }
  ]
};

const sessionResult = await commitParsedImport(parsed, {
  destination: "session", keepLabels: true
});
assert.equal(sessionResult.ok, true);
assert.equal(sessionResult.createdCount, 1);
assert.equal(sessionResult.tabCount, 3);
let snapshot = storage.snapshot();
assert.equal(Object.values(snapshot[STORE_KEYS.sessions]).filter((record) => !record.deletedAt).length, 1);
assert.equal(snapshot[LABEL_META_KEY].Work > 0, true);
assert.equal(snapshot[JOURNAL_KEY][0].undoContractVersion, 1,
  "the import inverse is sealed in the same commit as its records");
assert.deepEqual(storage.setLog.at(-1),
  [JOURNAL_KEY, LABEL_META_KEY, "sessionIdentityIndex", STORE_KEYS.sessions].sort(),
  "one storage set carries the complete Session import, label recency, index, and Undo");

await undoAction(sessionResult.entry.id);
snapshot = storage.snapshot();
assert.equal(Object.values(snapshot[STORE_KEYS.sessions]).filter((record) => !record.deletedAt).length, 0,
  "one Undo removes the complete imported Session");

const archiveResult = await commitParsedImport(parsed, {
  destination: "archive", keepLabels: false
});
assert.equal(archiveResult.ok, true);
snapshot = storage.snapshot();
assert.equal(Object.keys(snapshot[ARCHIVE_OVERLAY_KEY]).length, 2);
assert.equal(snapshot[STORE_KEYS.archive], undefined,
  "an Archive import writes only the small overlay instead of rebuilding the base");
assert.equal(Object.values(snapshot[ARCHIVE_OVERLAY_KEY])
  .every((item) => item.tabs.every((tab) => !Object.hasOwn(tab, "labels"))), true);
assert.deepEqual(storage.setLog.at(-1),
  [ARCHIVE_OVERLAY_KEY, JOURNAL_KEY].sort(),
  "one storage set carries every Archive bundle and its one Undo");

const failing = createInterleavableStorage({ deviceId: "import-test-device" });
globalThis.chrome.storage = {
  local: {
    get: failing.local.get,
    set: async () => { throw new Error("simulated context loss before commit"); }
  },
  onChanged: failing.onChanged
};
await assert.rejects(
  commitParsedImport(parsed, { destination: "inbox", keepLabels: true }),
  /simulated context loss/
);
const failedSnapshot = failing.snapshot();
assert.equal(failedSnapshot[STORE_KEYS.inbox], undefined);
assert.equal(failedSnapshot[JOURNAL_KEY], undefined,
  "a failed atomic commit leaves neither partial records nor an orphan Undo");

console.log("PASS: parsed imports commit atomically with one exact Undo");
