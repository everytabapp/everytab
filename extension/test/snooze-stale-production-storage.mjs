import assert from "node:assert/strict";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, LIBRARY_STORES, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const browserStorage = createInterleavableStorage({ deviceId: "snooze-production" });
let opened = [];
globalThis.chrome = {
  storage: { local: browserStorage.local, onChanged: browserStorage.onChanged },
  tabs: { create: async (details) => {
    const tab = { id: 700 + opened.length, windowId: 3, ...details };
    opened.push(structuredClone(tab));
    return tab;
  } },
  windows: { create: async () => ({ id: 8, tabs: [] }), get: async () => ({ id: 8, tabs: [] }) },
  alarms: { create: async () => {}, clear: async () => true },
  i18n: createChromeI18nMock(),
  notifications: { create: async () => "notification" },
  action: {
    setBadgeText: async () => { throw new Error("badge unavailable"); },
    setBadgeBackgroundColor: async () => {}
  },
  runtime: { getURL: (path) => `chrome-extension://test/${path}` }
};

const memory = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
let failReceiptCommit = false;
let failJournalCommit = false;
const adapter = {
  ...memory,
  transaction: (names, mode, work) => memory.transaction(names, mode, (transaction) => work({
    ...transaction,
    put: async (store, row) => {
      if (store === LIBRARY_STORES.local && row.key === "snoozeDeliveryReceipts" &&
          failReceiptCommit) throw new Error("Injected receipt commit failure");
      if (store === LIBRARY_STORES.local && row.key === "journal" && failJournalCommit) {
        throw new Error("Injected settlement commit failure");
      }
      return transaction.put(store, row);
    }
  }))
};
const library = createLibraryStore({ adapter, deviceId: "snooze-production" });
const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
setStorageAuthorityForTests(createStorageAuthority({
  library, recovery, readBrowserLocal: (keys) => browserStorage.local.get(keys)
}));

const { wakeSnoozeSelections, SNOOZE_DELIVERY_KEY } =
  await import("../js/lib/snooze-delivery.js");
const { listActions, undoActionResult } = await import("../js/lib/journal.js");

let sequence = 1;
function item(name) {
  return {
    id: `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    deviceId: "snooze-production", schemaVersion: 1,
    createdAt: sequence, modifiedAt: sequence,
    url: `https://${name}.example/`, title: name, dueAt: 100_000
  };
}
const put = (snooze) => library.transact([
  { type: "put", family: "snoozes", id: snooze.id, value: snooze }
]);
const read = async (id, includeDeleted = false) =>
  (await library.readEntity("snoozes", id, { includeDeleted }))?.value ?? null;
const receipts = async () =>
  (await library.readLocal([SNOOZE_DELIVERY_KEY]))[SNOOZE_DELIVERY_KEY] ?? {};

// Claim and source are one real Library transaction: a failed local receipt
// put cannot reach Chrome or alter the Library entity.
{
  const source = item("claim-failure");
  await put(source);
  failReceiptCommit = true;
  await assert.rejects(
    wakeSnoozeSelections([{ snooze: source, indexes: [0] }]),
    /Injected receipt commit failure/
  );
  failReceiptCommit = false;
  assert.equal(opened.length, 0);
  assert.deepEqual(await read(source.id), source);
  assert.equal((await receipts())[source.id], undefined);
}

// A successful production transaction tombstones the exact occurrence,
// settles its claim, journals the fresh inverse, and Undo revives it.
{
  const source = item("success");
  await put(source);
  assert.deepEqual(await wakeSnoozeSelections([{ snooze: source, indexes: [0] }]),
    { status: "delivered", opened: 1 });
  assert.equal(await read(source.id), null);
  assert.equal((await receipts())[source.id], undefined);
  const entry = (await listActions())[0];
  assert.deepEqual(entry.puts[0].item, source);
  assert.equal((await undoActionResult(entry.id)).status, "undone");
  const revived = await read(source.id);
  assert.equal(revived.url, source.url);
  assert.equal(revived.deletedAt, undefined);
}

// If the atomic source/receipt/Journal settlement rejects after Chrome, the
// exact source and effects claim remain durable. A new worker converts that
// claim to incomplete, so automatic replay stays blocked.
{
  const source = item("settlement-failure");
  await put(source);
  failJournalCommit = true;
  await assert.rejects(
    wakeSnoozeSelections([{ snooze: source, indexes: [0] }]),
    (error) => error.opened === 1 && error.reason === "uncertain"
  );
  failJournalCommit = false;
  assert.deepEqual(await read(source.id), source);
  assert.equal((await receipts())[source.id].phase, "effects");
  const restarted = await import("../js/lib/snooze-delivery.js?production-restart");
  assert.equal(await restarted.recoverInterruptedSnoozeDeliveries(), 1);
  assert.equal((await receipts())[source.id].phase, "incomplete");
  assert.equal((await restarted.fireSnooze(source.id, { manual: false })).status, "interrupted");
  assert.equal(opened.filter((tab) => tab.url === source.url).length, 1);
}

console.log("PASS: Snoozed Wake claims and settlements are atomic in Library storage");
