import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, LIBRARY_STORES, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

const storage = createInterleavableStorage({ deviceId: "inbox-restore-test" });
const effects = [];
let onCreate = async () => {};
let tabId = 1;
let queriedTabs = [];
let queryError = null;
let queryCount = 0;
let windowResult = { id: 1 };
let tabResult;
let rejectJournalWrite = false;
globalThis.chrome = {
  storage: { local: storage.local, onChanged: storage.onChanged },
  tabs: { create: async (options) => {
    effects.push(options);
    await onCreate(options);
    return tabResult === undefined ? { id: tabId++, url: options.url } : tabResult;
  }, query: async ({ windowId }) => {
    assert.equal(windowId, 1);
    queryCount++;
    if (queryError) throw queryError;
    return queriedTabs;
  } },
  windows: { create: async (options) => {
    effects.push(options);
    queriedTabs = options.url.map((url) => ({ id: tabId++, url, windowId: 1 }));
    await onCreate(options);
    return windowResult;
  } }
};
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const adapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
const library = createLibraryStore({ adapter: {
  ...adapter,
  transaction: (names, mode, work) => adapter.transaction(names, mode, (transaction) => work({
    ...transaction,
    put: async (store, row) => {
      if (rejectJournalWrite && store === LIBRARY_STORES.local && row.key === "journal") {
        throw new Error("Injected journal failure");
      }
      return transaction.put(store, row);
    }
  }))
}, deviceId: "inbox-restore-test" });
const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
setStorageAuthorityForTests(createStorageAuthority({
  library, recovery, readBrowserLocal: (keys) => storage.local.get(keys)
}));
const { restoreTabsFromItems, restoreSingleTab, restoreInboxItem, openTabsFromItems } =
  await import("../js/lib/actions.js");
const { listActions, undoActionResult } = await import("../js/lib/journal.js");
const put = (value) => library.transact([{ type: "put", family: "inbox", id: value.id, value }]);
const read = async (id) => (await library.readEntity("inbox", id))?.value ?? null;
const ref = (name) => ({ url: `https://${name}.example/`, title: name, labels: [] });
let sequence = 1;
const item = (tabs, extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
  deviceId: "inbox-restore-test", schemaVersion: 1, createdAt: 1, modifiedAt: 1,
  kind: tabs.length > 1 ? "window" : "tab", source: "manual", tabs, labels: [], ...extra
});
const selectedCase = process.argv[2];
const select = (source, indexes = source.tabs.map((_, index) => index)) => [{ item: source, indexes }];
const withoutModifiedAt = ({ modifiedAt, ...value }) => value;
async function undoTo(source) {
  assert.equal((await undoActionResult((await listActions())[0].id)).status, "undone");
  assert.deepEqual(withoutModifiedAt(await read(source.id)), withoutModifiedAt(source));
}
async function expectNoOpen(sources) {
  const before = await library.readFamily("inbox", { includeDeleted: true });
  const journal = await listActions();
  const count = effects.length;
  assert.equal(await restoreTabsFromItems(sources), 0);
  assert.equal(effects.length, count);
  assert.deepEqual(await library.readFamily("inbox", { includeDeleted: true }), before);
  assert.deepEqual(await listActions(), journal);
}

if (!selectedCase || selectedCase === "preflight") {
  const old = item([ref("old")]);
  const current = { ...old, kind: "window", tabs: [...old.tabs, ref("new")] };
  await put(current);
  assert.equal(await restoreTabsFromItems([{ item: old, indexes: [0] }]), 0);
  assert.deepEqual(effects, [], "stale selections must not open browser tabs");
  assert.deepEqual(await read(old.id), current);
  assert.deepEqual(await listActions(), []);
}

if (!selectedCase || selectedCase === "postflight") {
  const old = item([ref("opening")]);
  const current = { ...old, kind: "window", tabs: [...old.tabs, ref("concurrent")] };
  await put(old);
  onCreate = () => put(current);
  await restoreTabsFromItems([{ item: old, indexes: [0] }]);
  onCreate = async () => {};
  assert.deepEqual(await read(old.id), current,
    "tabs added while Chrome opens must not be consumed by the old selection");
  assert.deepEqual(await listActions(), []);
}

if (!selectedCase || selectedCase === "filtered") {
  const source = item([ref("web"), { url: "chrome://extensions", title: "Extensions" }]);
  await put(source);
  assert.equal(await restoreTabsFromItems([{ item: source, indexes: [0, 1] }]), 1);
  assert.deepEqual((await read(source.id))?.tabs, [source.tabs[1]],
    "a filtered-out address must remain saved");
}

if (!selectedCase) {
  // Every invalid source is rejected before any browser effect, even within
  // the same timestamp. Wrapper exports must not bypass this preflight.
  const original = item([ref("first"), ref("second")]);
  await expectNoOpen(select(original));
  await put(original);
  await library.transact([{ type: "delete", family: "inbox", id: original.id }]);
  await expectNoOpen(select(original));
  for (const change of [
    { createdAt: 2 }, { deviceId: "replacement" }, { tabs: [...original.tabs].reverse() }
  ]) {
    await put({ ...original, ...change });
    await expectNoOpen(select(original));
  }
  const beforeWrappers = effects.length;
  await restoreSingleTab(original, 0);
  await restoreInboxItem(original);
  assert.equal(effects.length, beforeWrappers);
  await put(original);
  await expectNoOpen(select(original, [-1, 9, 0.5, NaN]));
  await expectNoOpen([
    ...select(original, [0]), ...select({ ...original, labels: ["conflict"] }, [1])
  ]);

  // Labels and carrier metadata can rebase at both boundaries. Chrome calls
  // do not hold the Store lock; Undo must restore the immediate pre-state.
  const fresh = { ...original, labels: ["before"], tabs: original.tabs.map((tab) => ({ ...tab, labels: ["fresh"] })) };
  const latest = { ...fresh, labels: ["during"], source: "auto" };
  await put(fresh);
  onCreate = async () => {
    await navigator.locks.request("everytab-store", { ifAvailable: true }, (lock) => assert.ok(lock));
    await put(latest);
  };
  assert.equal(await restoreTabsFromItems([
    ...select(original, [1, 0, 1]), ...select(original, [0])
  ]), 2);
  onCreate = async () => {};
  assert.equal(await read(original.id), null);
  await undoTo(latest);

  // A later browser failure still commits and journals earlier confirmed
  // opens. It neither retries nor attempts to close a created tab.
  const success = item([ref("success")]);
  const failed = item([ref("failed")]);
  const unattempted = item([ref("unattempted")]);
  for (const source of [success, failed, unattempted]) await put(source);
  const failure = new Error("Injected Chrome failure");
  const beforePartial = effects.length;
  onCreate = async ({ url }) => { if (url === failed.tabs[0].url) throw failure; };
  await assert.rejects(restoreTabsFromItems([
    ...select(success), ...select(failed), ...select(unattempted)
  ]), (error) => error === failure);
  onCreate = async () => {};
  assert.equal(effects.length - beforePartial, 2);
  assert.equal(await read(success.id), null);
  assert.deepEqual(await read(failed.id), failed);
  assert.deepEqual(await read(unattempted.id), unattempted);
  await undoTo(success);

  // The same partial accounting applies to multiple loose refs in one carrier.
  const loose = item([ref("loose-first"), ref("loose-failed")], { kind: "tab" });
  await put(loose);
  onCreate = async ({ url }) => { if (url === loose.tabs[1].url) throw failure; };
  await assert.rejects(restoreTabsFromItems(select(loose)), (error) => error === failure);
  onCreate = async () => {};
  assert.deepEqual((await read(loose.id)).tabs, [loose.tabs[1]]);
  await undoTo(loose);

  // Query the actual new window, even if create returns populated tabs.
  // Match browser serialization and pending addresses, retaining fragments.
  const windowSource = item([
    { ...ref("serialized"), url: "https://serialized.example" }, ref("second-window")
  ]);
  await put(windowSource);
  const queriesBefore = queryCount;
  windowResult = { id: 1, tabs: [{ id: 99, url: "https://wrong.example/" }] };
  onCreate = async () => { queriedTabs[0] = { id: 31, pendingUrl: "https://serialized.example/", windowId: 1 }; };
  assert.equal(await restoreTabsFromItems(select(windowSource)), 2);
  assert.equal(queryCount, queriesBefore + 1);
  assert.deepEqual(effects.at(-1).url, windowSource.tabs.map((tab) => tab.url));
  await undoTo(windowSource);

  // A partial window result consumes only distinct, confirmed occurrences.
  onCreate = async () => { queriedTabs = queriedTabs.slice(0, 1); };
  await assert.rejects(restoreTabsFromItems(select(windowSource)), /could not be confirmed/);
  assert.deepEqual((await read(windowSource.id)).tabs, [windowSource.tabs[1]]);
  await undoTo(windowSource);
  const duplicates = item([ref("same"), { ...ref("same"), labels: ["distinct saved occurrence"] }]);
  await put(duplicates);
  const beforeDuplicates = await listActions();
  await assert.rejects(restoreTabsFromItems(select(duplicates)), /could not be confirmed/);
  assert.deepEqual(await read(duplicates.id), duplicates);
  assert.deepEqual(await listActions(), beforeDuplicates);

  // Unknown browser outcomes retain everything. No speculative index matching.
  for (const setup of [
    () => { windowResult = undefined; },
    () => { queryError = failure; },
    () => { queriedTabs = queriedTabs.map((tab) => ({ ...tab, url: `${tab.url}#changed` })); },
    () => { queriedTabs = queriedTabs.map((tab) => ({ ...tab, windowId: 2 })); }
  ]) {
    windowResult = { id: 1 };
    queryError = null;
    onCreate = async () => setup();
    const journal = await listActions();
    await assert.rejects(restoreTabsFromItems(select(windowSource)));
    assert.deepEqual(withoutModifiedAt(await read(windowSource.id)), withoutModifiedAt(windowSource));
    assert.deepEqual(await listActions(), journal);
  }
  windowResult = { id: 1 };
  queryError = null;
  onCreate = async () => {};
  tabResult = {};
  await assert.rejects(restoreTabsFromItems(select(failed)), /could not be confirmed/);
  assert.deepEqual(await read(failed.id), failed);
  tabResult = undefined;

  // Deletion/replacement/reorder during opening cannot be revived or rewritten.
  for (const change of ["delete", "replace", "reorder"]) {
    const source = item([ref("during-a"), ref("during-b")]);
    await put(source);
    onCreate = async () => change === "delete"
      ? library.transact([{ type: "delete", family: "inbox", id: source.id }])
      : put(change === "replace" ? { ...source, createdAt: 2 } : { ...source, tabs: [...source.tabs].reverse() });
    const journal = await listActions();
    await restoreTabsFromItems(select(source));
    assert.deepEqual(await listActions(), journal);
    assert.deepEqual(await read(source.id), change === "delete" ? null
      : change === "replace" ? { ...source, createdAt: 2 } : { ...source, tabs: [...source.tabs].reverse() });
  }
  onCreate = async () => {};

  // Failure of the atomic Inbox/Journal commit preserves the full saved copy.
  const atomic = item([ref("atomic")]);
  await put(atomic);
  const beforeAtomic = await listActions();
  rejectJournalWrite = true;
  await assert.rejects(restoreTabsFromItems(select(atomic)), /Injected journal failure/);
  rejectJournalWrite = false;
  assert.deepEqual(await read(atomic.id), atomic);
  assert.deepEqual(await listActions(), beforeAtomic);

  // Archive's copy path never mutates Inbox or creates an Undo entry.
  assert.equal(await openTabsFromItems(select(atomic)), 1);
  assert.deepEqual(await read(atomic.id), atomic);
  assert.deepEqual(await listActions(), beforeAtomic);
}

if (!selectedCase || selectedCase === "concurrent") {
  const source = item([ref("double-click")]);
  await put(source);
  const count = effects.length;
  const results = await Promise.all([
    restoreTabsFromItems(select(source)), restoreTabsFromItems(select(source))
  ]);
  assert.deepEqual(results, [1, 0]);
  assert.equal(effects.length - count, 1, "repeated Restore must recheck after the first commit");
}

console.log("PASS: Inbox Restore safety");
