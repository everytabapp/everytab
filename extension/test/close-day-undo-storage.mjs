/** Interrupted Close-the-day Undo through the production Library authority. */
import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, LIBRARY_STORES, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

const browserStorage = createInterleavableStorage({ deviceId: "close-day-production" });
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
let liveTabs = [];
let reopened = [];
globalThis.chrome = {
  runtime: { getURL: (name) => `chrome-extension://fixture/${name}` },
  storage: { local: browserStorage.local, onChanged: browserStorage.onChanged },
  tabs: {
    get: async (id) => {
      const tab = liveTabs.find((tab) => tab.id === id);
      if (!tab) throw new Error("Missing synthetic tab");
      return structuredClone(tab);
    },
    remove: async (ids) => { liveTabs = liveTabs.filter((tab) => !ids.includes(tab.id)); },
    query: async ({ windowId }) => reopened.filter((tab) => tab.windowId === windowId),
    update: async () => {},
    create: async (props) => { const tab = { id: 100 + reopened.length, ...props }; reopened.push(tab); return tab; }
  },
  windows: { create: async ({ url }) => {
    const windowId = 200 + reopened.length;
    reopened.push(...url.map((value, index) => ({ id: 100 + reopened.length + index,
      index, windowId, url: value })));
    return { id: windowId };
  } },
  alarms: { clear: async () => true }
};
let rejectUndoCommit = false;
let rejectUndoSettlement = false;
const memory = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const library = createLibraryStore({
  deviceId: "close-day-production",
  adapter: {
    ...memory,
    transaction: (names, mode, work) => memory.transaction(names, mode, (tx) => work({
      ...tx,
      put: async (store, row) => {
        if (rejectUndoCommit && store === LIBRARY_STORES.local && row.key === "closeDayReceipts" &&
            Object.values(row.value ?? {}).some((receipt) => receipt.phase === "undoing")) {
          rejectUndoCommit = false;
          throw new Error("Injected Undo commit failure");
        }
        if (rejectUndoSettlement && store === LIBRARY_STORES.local && row.key === "closeDayReceipts" &&
            Object.values(row.value ?? {}).some((receipt) => receipt.phase === "undone")) {
          rejectUndoSettlement = false;
          throw new Error("Injected Undo settlement failure");
        }
        return tx.put(store, row);
      }
    }))
  }
});
const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
setStorageAuthorityForTests(createStorageAuthority({
  library, recovery, readBrowserLocal: (keys) => browserStorage.local.get(keys)
}));
const { undoCloseDayTransaction, CLOSE_DAY_RECEIPTS_KEY } = await import("../js/lib/close-day.js");
const { closeDayFingerprint } = await import("../js/lib/close-day-planner.js");
const { makeJournalEntry } = await import("../js/lib/journal.js");
const { mutateStores } = await import("../js/lib/store.js");

for (const scenario of ["saved", "closing", "failed-undo-write", "concurrent"]) {
  reopened = [];
  const ref = { url: `https://${scenario}.example/`, title: scenario };
  const live = { id: 1, windowId: 7, index: 0, url: ref.url, pinned: false, incognito: false };
  liveTabs = scenario === "concurrent" ? [] : [live];
  const item = { id: `item-${scenario}`, deviceId: "close-day-production", schemaVersion: 1,
    createdAt: 1, modifiedAt: 1, kind: "tab", tabs: [ref], labels: [] };
  const id = `receipt-${scenario}`;
  const journal = makeJournalEntry("Closed day", { closeDayTransactionId: id });
  const receipt = { id, phase: scenario === "concurrent" ? "complete" : scenario === "closing" ? "closing" : "saved",
    journalId: journal.id, storeChanges: [{ store: "inbox", id: item.id, before: null, after: item }],
    windows: [{ windowId: 7, tabs: [{ tabId: 1, ref, pinned: false,
      status: scenario === "concurrent" ? "closed" : "pending", fingerprint: closeDayFingerprint({ ...live, ref }) }] }] };
  await mutateStores(["inbox", "journal", CLOSE_DAY_RECEIPTS_KEY], (maps) => ({
    inbox: { ...(maps.inbox ?? {}), [item.id]: item }, journal: [journal],
    [CLOSE_DAY_RECEIPTS_KEY]: { [id]: receipt }
  }));
  if (scenario === "failed-undo-write") {
    rejectUndoCommit = true;
    await assert.rejects(undoCloseDayTransaction(id), /Injected Undo commit failure/);
    assert.equal(reopened.length, 0, "failed inverse commitment must not reopen pages");
    assert.deepEqual((await library.readEntity("inbox", item.id)).value.tabs, [ref],
      "the production transaction retains saved work when Undo fails");
    const durable = (await library.readLocal([CLOSE_DAY_RECEIPTS_KEY]))[CLOSE_DAY_RECEIPTS_KEY][id];
    assert.equal(durable.phase, "complete");
    assert.equal(durable.windows[0].tabs[0].status, "closed", "retry retains the actual close outcome");
  }
  const results = scenario === "concurrent"
    ? await Promise.all([undoCloseDayTransaction(id), undoCloseDayTransaction(id)])
    : [await undoCloseDayTransaction(id)];
  assert.equal(results.filter((result) => result.status === "undone").length, 1);
  assert.deepEqual(reopened.map((tab) => tab.url), [ref.url]);
  assert.equal((await library.readEntity("inbox", item.id, { includeDeleted: true })).lifecycle, "deleted");
  const state = await library.readLocal([CLOSE_DAY_RECEIPTS_KEY, "journal"]);
  const settled = state[CLOSE_DAY_RECEIPTS_KEY][id];
  assert.equal(settled.windows[0].tabs[0].status, "closed");
  assert.deepEqual(settled.reopenResult, { reopened: 1, expected: 1 });
  assert.equal(state.journal[0].undone, true);
  console.log(`PASS: production-authority Close-the-day Undo ${scenario}`);
}

async function seedUndoCase(name, refs = [{ url: 'https://undo.example/', title: 'Undo' }]) {
  reopened = [];
  const id = `boundary-${name}`;
  const entry = makeJournalEntry('Closed day', { closeDayTransactionId: id });
  const item = { id: `item-${name}`, deviceId: 'close-day-production', schemaVersion: 1,
    createdAt: 1, modifiedAt: 1, kind: 'tab', tabs: refs, labels: [] };
  const receipt = { id, phase: 'complete', journalId: entry.id,
    storeChanges: [{ store: 'inbox', id: item.id, before: null, after: item }],
    windows: [{ windowId: 7, tabs: refs.map((ref, index) => ({ tabId: index + 1, ref,
      pinned: index === 1, status: 'closed' })) }] };
  await mutateStores(['inbox', 'journal', CLOSE_DAY_RECEIPTS_KEY], (maps) => ({
    inbox: { ...(maps.inbox ?? {}), [item.id]: item }, journal: [entry],
    [CLOSE_DAY_RECEIPTS_KEY]: { [id]: receipt }
  }));
  return { id, item, entry };
}
const originalCreateWindow = chrome.windows.create;
const originalQuery = chrome.tabs.query;
const originalCreateTab = chrome.tabs.create;
const readUndoState = () => library.readLocal([CLOSE_DAY_RECEIPTS_KEY, 'journal']);

// Browser creation already happened: a later observation failure must not replay it.
{
  const { id } = await seedUndoCase('query-failure');
  let fallbackCalls = 0;
  chrome.tabs.query = async () => { throw new Error('Synthetic query failure'); };
  chrome.tabs.create = async (props) => { fallbackCalls++; return originalCreateTab(props); };
  const result = await undoCloseDayTransaction(id);
  assert.equal(reopened.length, 1, 'query failure must not duplicate a successfully created window');
  assert.equal(fallbackCalls, 0);
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.receipt.reopenResult, { reopened: 0, expected: 1, uncertain: 1 });
  chrome.tabs.query = originalQuery;
  chrome.tabs.create = originalCreateTab;
  console.log('PASS: created window observation failure is incomplete without replay');
}
{
  const refs = ['a', 'b', 'c'].map((name) => ({ url: `https://${name}.example/` }));
  const { id } = await seedUndoCase('partial-window', refs);
  const pins = [];
  chrome.windows.create = async () => ({ id: 80, tabs: [
    { id: 81, index: 0, url: refs[0].url }, { id: 83, index: 1, url: refs[2].url },
    { id: 84, index: 2, url: 'about:blank' }
  ] });
  chrome.tabs.update = async (id) => { pins.push(id); };
  const result = await undoCloseDayTransaction(id);
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.receipt.reopenResult, { reopened: 2, expected: 3, failed: 1 });
  assert.deepEqual(pins, [], 'missing B must not apply its pin to C or an unrelated tab');
  chrome.windows.create = originalCreateWindow;
  console.log('PASS: partial window counts matching occurrences and preserves pin identity');
}
for (const createdBeforeReject of [false, true]) {
  const { id } = await seedUndoCase(`create-rejection-${createdBeforeReject}`);
  let fallbackCalls = 0;
  chrome.windows.create = async (props) => {
    if (createdBeforeReject) await originalCreateWindow(props);
    throw new Error('Synthetic window failure');
  };
  chrome.tabs.create = async (props) => { fallbackCalls++; return originalCreateTab(props); };
  const result = await undoCloseDayTransaction(id);
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.receipt.reopenResult, { reopened: 0, expected: 1, uncertain: 1 });
  const state = await readUndoState();
  assert.equal(state.journal[0].undoStatus, 'incomplete');
  assert.ok(!state.journal[0].undone);
  assert.equal(fallbackCalls, 0, 'rejected creation cannot safely authorize a repeat');
  assert.equal(reopened.length, createdBeforeReject ? 1 : 0);
  chrome.windows.create = originalCreateWindow;
  chrome.tabs.create = originalCreateTab;
  console.log(`PASS: window creation rejection ${createdBeforeReject ? 'after' : 'before'} effect remains uncertain without replay`);
}
{
  const { id } = await seedUndoCase('unrestorable-address', [{ url: 'file:///synthetic-fixture.html' }]);
  const result = await undoCloseDayTransaction(id);
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.receipt.reopenResult, { reopened: 0, expected: 1, failed: 1 });
  assert.equal(reopened.length, 0);
  assert.equal((await readUndoState()).journal[0].undoStatus, 'incomplete');
  console.log('PASS: excluded address is a confirmed incomplete browser outcome');
}
{
  const { recoverInterruptedUndos, clearJournalSafely, undoActionResult } = await import('../js/lib/journal.js');
  const { recoverInterruptedCloseDayUndos, applyCloseDayCloses } = await import('../js/lib/close-day.js');
  for (const afterCreate of [false, true]) {
    const { id, item } = await seedUndoCase(`interruption-${afterCreate}`);
    let reached;
    const boundary = new Promise((resolve) => { reached = resolve; });
    let release;
    chrome.windows.create = async (props) => {
      const created = afterCreate ? await originalCreateWindow(props) : { id: 90, tabs: [] };
      reached();
      await new Promise((resolve) => { release = resolve; });
      return created;
    };
    const running = undoCloseDayTransaction(id);
    await boundary;
    const state = await readUndoState();
    assert.equal(state[CLOSE_DAY_RECEIPTS_KEY][id].phase, 'undoing');
    assert.equal(state.journal[0].undoClaim.id, state[CLOSE_DAY_RECEIPTS_KEY][id].undoClaim.id);
    assert.ok(!state.journal[0].undone);
    assert.equal(await recoverInterruptedUndos(), 0, 'generic recovery leaves domain claims alone');
    assert.equal((await clearJournalSafely()).reason, 'busy');
    assert.equal((await undoActionResult(state.journal[0].id)).status, 'busy');
    assert.equal((await undoCloseDayTransaction(id)).status, 'busy');
    assert.equal((await applyCloseDayCloses(id)).phase, 'undoing');
    assert.equal(await recoverInterruptedCloseDayUndos(), 1);
    assert.equal(await recoverInterruptedCloseDayUndos(), 0);
    const recovered = await readUndoState();
    assert.equal(recovered[CLOSE_DAY_RECEIPTS_KEY][id].phase, 'undo-incomplete');
    assert.deepEqual(recovered[CLOSE_DAY_RECEIPTS_KEY][id].reopenResult,
      { reopened: 0, expected: 1, uncertain: 1 });
    assert.equal(recovered.journal[0].undoStatus, 'incomplete');
    assert.ok(!recovered.journal[0].undoClaim);
    assert.equal((await library.readEntity('inbox', item.id, { includeDeleted: true })).lifecycle, 'deleted');
    release();
    assert.equal((await running).status, 'incomplete', 'late owner cannot overwrite recovery');
    assert.equal(reopened.length, afterCreate ? 1 : 0, 'recovery creates no tabs');
    assert.equal((await readUndoState())[CLOSE_DAY_RECEIPTS_KEY][id].phase, 'undo-incomplete');
    chrome.windows.create = originalCreateWindow;
    console.log(`PASS: interrupted Undo ${afterCreate ? 'after' : 'before'} creation settles without replay`);
  }
  const { id } = await seedUndoCase('legacy');
  await mutateStores([CLOSE_DAY_RECEIPTS_KEY, 'journal'], (maps) => ({
    [CLOSE_DAY_RECEIPTS_KEY]: { [id]: { ...maps[CLOSE_DAY_RECEIPTS_KEY][id], phase: 'undoing' } },
    journal: maps.journal.map((entry) => ({ ...entry, undone: true }))
  }));
  assert.equal(await recoverInterruptedCloseDayUndos(), 1);
  assert.equal((await readUndoState()).journal[0].undoStatus, 'incomplete');
  assert.ok(!(await readUndoState()).journal[0].undone);
  console.log('PASS: legacy interrupted receipt replaces premature Journal success');
}

{
  const { recoverInterruptedCloseDayUndos } = await import('../js/lib/close-day.js');
  const { undoActionResult } = await import('../js/lib/journal.js');
  const { id, entry } = await seedUndoCase('failed-final-write');
  rejectUndoSettlement = true;
  await assert.rejects(undoCloseDayTransaction(id), /Injected Undo settlement failure/);
  assert.equal(reopened.length, 1);
  assert.equal((await undoCloseDayTransaction(id)).status, 'busy');
  assert.equal(await recoverInterruptedCloseDayUndos(), 1);
  assert.equal((await undoActionResult(entry.id)).status, 'unavailable');
  assert.equal((await undoCloseDayTransaction(id)).status, 'incomplete');
  assert.equal(reopened.length, 1, 'retry after uncommitted final receipt never duplicates effects');
  console.log('PASS: failed final settlement retains claim and recovers without replay');
}
{
  const refs = [{ url: 'https://same.example/' }, { url: 'https://same.example/' }];
  for (const partial of [false, true]) {
    const { id } = await seedUndoCase(`duplicate-pins-${partial}`, refs);
    const pins = [];
    chrome.windows.create = async () => ({ id: 80, tabs: partial
      ? [{ id: 82, index: 0, url: refs[0].url }]
      : [{ id: 82, index: 1, url: refs[0].url }, { id: 81, index: 0, url: refs[0].url }] });
    chrome.tabs.update = async (id) => { pins.push(id); throw new Error('Synthetic pin failure'); };
    const result = await undoCloseDayTransaction(id);
    assert.equal(result.status, partial ? 'incomplete' : 'undone');
    assert.deepEqual(pins, partial ? [] : [82]);
    assert.equal(result.receipt.reopenResult.reopened, partial ? 1 : 2);
    assert.equal(reopened.length, 0, 'pin failure must not create fallback pages');
    chrome.windows.create = originalCreateWindow;
    console.log(`PASS: ${partial ? 'ambiguous' : 'complete'} duplicate URL pin occurrences`);
  }
}
