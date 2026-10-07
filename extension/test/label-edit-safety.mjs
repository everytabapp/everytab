import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

const storage = createInterleavableStorage({});
globalThis.chrome = { storage: { local: storage.local, onChanged: storage.onChanged } };
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const memory = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
let failJournalWrite = false;
const adapter = {
  ...memory,
  transaction: (names, mode, work) => memory.transaction(names, mode, tx => work({
    ...tx,
    put: async (store, value) => {
      if (failJournalWrite && value.key === "journal") throw new Error("Injected label journal failure");
      return tx.put(store, value);
    }
  }))
};
const library = createLibraryStore({ adapter, deviceId: "label-safety" });
const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
setStorageAuthorityForTests(createStorageAuthority({
  library, recovery, readBrowserLocal: (keys) => storage.local.get(keys)
}));

const { STORE_KEYS } = await import("../js/lib/types.js");
const { upsertItem, tombstoneItem } = await import("../js/lib/store.js");
const {
  addLabel, applyLabels, removeLabel, removeLabelFromTab,
  labelSessionTabs, removeSessionLabel, labelTabsFromItems, removeLabelsFromSelections, applyLabelsToSelections
} = await import("../js/lib/labels.js");
const { listActions, undoActionResult } = await import("../js/lib/journal.js");
const { getLabelMeta } = await import("../js/lib/label-meta.js");

let sequence = 1;
const id = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
const tab = (title, labels = [], url = `https://${title.toLowerCase()}.example/`) =>
  ({ url, title, labels });
const item = (tabs, extra = {}) => ({
  id: id(), deviceId: "label-safety", schemaVersion: 1,
  createdAt: sequence, modifiedAt: sequence,
  kind: tabs.length === 1 ? "tab" : "window", source: "manual",
  labels: [], tabs, ...extra
});
const session = (windows, extra = {}) => ({
  id: id(), deviceId: "label-safety", schemaVersion: 1,
  createdAt: sequence, modifiedAt: sequence,
  name: "Research", auto: false, windows, ...extra
});
const read = async (store, recordId, includeDeleted = false) =>
  (await library.readEntity(store, recordId, { includeDeleted }))?.value ?? null;
const putDirect = async (store, value) => library.transact([
  { type: "put", family: store, id: value.id, value }
]);

// A selection across labels and stores is one edit and one Undo. Item-level
// labels must remain on unselected occurrences, including identical URLs.
const bulkInbox = item([tab("Same"), tab("Same"), tab("Other", ["keep"])], { labels: ["work"] });
const bulkArchive = item([tab("Archived", ["work", "keep"])]);
const bulkSession = session([[tab("Saved", ["work", "other", "keep"])]]);
for (const [store, record] of [[STORE_KEYS.inbox, bulkInbox], [STORE_KEYS.archive, bulkArchive], [STORE_KEYS.sessions, bulkSession]]) {
  await upsertItem(store, record);
}
const beforeBulk = await Promise.all([
  read(STORE_KEYS.inbox, bulkInbox.id), read(STORE_KEYS.archive, bulkArchive.id), read(STORE_KEYS.sessions, bulkSession.id)
]);
const selections = [
  { store: STORE_KEYS.inbox, item: beforeBulk[0], i: 0, label: "work" },
  { store: STORE_KEYS.inbox, item: beforeBulk[0], i: 1, label: "work" },
  { store: STORE_KEYS.archive, item: beforeBulk[1], i: 0, label: "work" },
  { store: STORE_KEYS.sessions, item: beforeBulk[2], wi: 0, i: 0, label: "work" },
  { store: STORE_KEYS.sessions, item: beforeBulk[2], wi: 0, i: 0, label: "other" }
];
const bulkJournalCount = (await listActions()).length;
assert.deepEqual(await removeLabelsFromSelections([...selections, selections[0]]), { ok: true, count: 4 });
assert.equal((await listActions()).length, bulkJournalCount + 1);
assert.deepEqual((await read(STORE_KEYS.inbox, bulkInbox.id)).tabs.map(t => t.labels), [[], [], ["keep", "work"]]);
assert.deepEqual((await read(STORE_KEYS.archive, bulkArchive.id)).tabs[0].labels, ["keep"]);
assert.deepEqual((await read(STORE_KEYS.sessions, bulkSession.id)).windows[0][0].labels, ["keep"]);
const bulkUndo = (await listActions())[0];
assert.equal(bulkUndo.puts.length, 3);
assert.equal((await undoActionResult(bulkUndo.id)).status, "undone");
assert.deepEqual((await read(STORE_KEYS.inbox, bulkInbox.id)).tabs, beforeBulk[0].tabs);
assert.deepEqual((await read(STORE_KEYS.inbox, bulkInbox.id)).labels, ["work"]);
assert.deepEqual((await read(STORE_KEYS.sessions, bulkSession.id)).windows, beforeBulk[2].windows);

const changedArchive = { ...beforeBulk[1], tabs: [tab("Replaced", ["work"])] };
await putDirect(STORE_KEYS.archive, changedArchive);
const beforeRefusal = (await listActions()).length;
assert.deepEqual(await removeLabelsFromSelections(selections), { ok: false, reason: "stale", count: 0 });
assert.equal((await listActions()).length, beforeRefusal);
assert.deepEqual((await read(STORE_KEYS.inbox, bulkInbox.id)).labels, ["work"], "stale bulk cannot partially edit valid peers");
assert.deepEqual(await removeLabelsFromSelections([{ ...selections[0], i: 50 }]), { ok: false, reason: "stale", count: 0 });
assert.deepEqual(await removeLabelsFromSelections([]), { ok: true, count: 0 });

await putDirect(STORE_KEYS.archive, beforeBulk[1]);
const bulkStores = [STORE_KEYS.inbox, STORE_KEYS.archive, STORE_KEYS.sessions];
const beforeFailure = await Promise.all(bulkStores.map((store, i) => read(store, beforeBulk[i].id)));
failJournalWrite = true;
await assert.rejects(removeLabelsFromSelections(selections), /Injected label journal failure/);
failJournalWrite = false;
assert.deepEqual(await Promise.all(bulkStores.map((store, i) => read(store, beforeBulk[i].id))), beforeFailure,
  "failed Undo persistence rolls back every selected carrier");
assert.equal((await listActions()).length, beforeRefusal);

const addSources = selections.map(({ label, ...source }) => source);
assert.deepEqual(await applyLabelsToSelections(addSources, ["new", "new", "work"]), { ok: true, count: 4 });
const addedAction = (await listActions())[0];
assert.equal(addedAction.puts.length, 3);
assert.equal((await listActions()).length, beforeRefusal + 1);
assert.deepEqual((await read(STORE_KEYS.inbox, bulkInbox.id)).labels, ["work"]);
assert.deepEqual((await read(STORE_KEYS.inbox, bulkInbox.id)).tabs.map(t => t.labels), [["new"], ["new"], ["keep"]]);
assert.deepEqual((await read(STORE_KEYS.sessions, bulkSession.id)).windows[0][0].labels, ["work", "other", "keep", "new"]);
assert.ok((await getLabelMeta()).new > 0, "bulk additions update label recency");
assert.equal((await undoActionResult(addedAction.id)).status, "undone");
assert.deepEqual((await read(STORE_KEYS.inbox, bulkInbox.id)).tabs, beforeBulk[0].tabs);
assert.deepEqual((await read(STORE_KEYS.sessions, bulkSession.id)).windows, beforeBulk[2].windows);

const preAddFailure = await Promise.all(bulkStores.map((store, i) => read(store, beforeBulk[i].id)));
const preAddMeta = await getLabelMeta();
failJournalWrite = true;
await assert.rejects(applyLabelsToSelections(addSources, "failed-label"), /Injected label journal failure/);
failJournalWrite = false;
assert.deepEqual(await Promise.all(bulkStores.map((store, i) => read(store, beforeBulk[i].id))), preAddFailure);
assert.deepEqual(await getLabelMeta(), preAddMeta, "failed addition rolls back recency too");
await putDirect(STORE_KEYS.archive, changedArchive);
assert.deepEqual(await applyLabelsToSelections(addSources, "must-not-apply"), { ok: false, reason: "stale", count: 0 });
assert.deepEqual((await read(STORE_KEYS.inbox, bulkInbox.id)).tabs, beforeBulk[0].tabs);
assert.deepEqual(await applyLabelsToSelections([], "new"), { ok: true, count: 0 });

// Whole-record edits rebase labels and unrelated metadata, and Undo restores
// the immediate locked prestate rather than the stale caller snapshot.
const rebased = item([tab("Rebase")]);
await upsertItem(STORE_KEYS.inbox, rebased);
const staleRebased = await read(STORE_KEYS.inbox, rebased.id);
await putDirect(STORE_KEYS.inbox, {
  ...staleRebased, note: "newer metadata",
  tabs: [{ ...staleRebased.tabs[0], labels: ["first"] }]
});
assert.equal(await applyLabels(STORE_KEYS.inbox, staleRebased, "second"), 1);
let current = await read(STORE_KEYS.inbox, rebased.id);
assert.deepEqual(current.tabs[0].labels, ["first", "second"]);
assert.equal(current.note, "newer metadata");
const rebaseAction = (await listActions())[0];
assert.equal((await undoActionResult(rebaseAction.id)).status, "undone");
current = await read(STORE_KEYS.inbox, rebased.id);
assert.deepEqual(current.tabs[0].labels, ["first"]);
assert.equal(current.note, "newer metadata");

// Missing/deleted and same-id replacement carriers are never recreated or journaled.
const journalBeforeDelete = (await listActions()).length;
await tombstoneItem(STORE_KEYS.inbox, rebased.id);
assert.equal(await applyLabels(STORE_KEYS.inbox, staleRebased, "third"), 0);
assert.equal((await listActions()).length, journalBeforeDelete);
assert.equal((await library.readEntity(STORE_KEYS.inbox, rebased.id, {
  includeDeleted: true
})).lifecycle, "deleted");
const replacement = { ...staleRebased, createdAt: staleRebased.createdAt + 1, labels: ["replacement"] };
await putDirect(STORE_KEYS.inbox, replacement);
assert.equal(await applyLabels(STORE_KEYS.inbox, staleRebased, "old intent"), 0);
assert.deepEqual((await read(STORE_KEYS.inbox, rebased.id)).labels, ["replacement"]);

// Two callers acting from the same snapshot serialize and rebase rather than
// allowing the later label write to replace the earlier one.
const concurrent = item([tab("Concurrent")]);
await upsertItem(STORE_KEYS.inbox, concurrent);
const concurrentView = await read(STORE_KEYS.inbox, concurrent.id);
await Promise.all([
  applyLabels(STORE_KEYS.inbox, concurrentView, "alpha"),
  applyLabels(STORE_KEYS.inbox, concurrentView, "beta")
]);
assert.deepEqual(new Set((await read(STORE_KEYS.inbox, concurrent.id)).tabs[0].labels),
  new Set(["alpha", "beta"]));

// Retained item-grain add/remove paths also merge with the locked current record.
const grain = item([tab("First"), tab("Second")], { labels: ["shared"] });
await upsertItem(STORE_KEYS.inbox, grain);
const staleGrain = await read(STORE_KEYS.inbox, grain.id);
await putDirect(STORE_KEYS.inbox, {
  ...staleGrain, note: "keep", labels: ["shared", "concurrent"],
  tabs: [staleGrain.tabs[0], { ...staleGrain.tabs[1], labels: ["other"] }]
});
await addLabel(STORE_KEYS.inbox, staleGrain, "item label");
current = await read(STORE_KEYS.inbox, grain.id);
assert.deepEqual(current.labels, ["shared", "concurrent", "item label"]);
await removeLabelFromTab(STORE_KEYS.inbox, staleGrain, 0, "shared");
current = await read(STORE_KEYS.inbox, grain.id);
assert.deepEqual(current.labels, ["concurrent", "item label"]);
assert.deepEqual(current.tabs[0].labels, []);
assert.deepEqual(current.tabs[1].labels, ["other", "shared"],
  "item-grain demotion preserves fresh per-tab labels");
const demotionAction = (await listActions())[0];
assert.equal((await undoActionResult(demotionAction.id)).status, "undone");
current = await read(STORE_KEYS.inbox, grain.id);
assert.deepEqual(current.labels, ["shared", "concurrent", "item label"]);
assert.deepEqual(current.tabs[1].labels, ["other"]);
await removeLabel(STORE_KEYS.inbox, staleGrain, "concurrent");
assert.deepEqual((await read(STORE_KEYS.inbox, grain.id)).labels,
  ["shared", "item label"]);

// Index selection validates the ordered occurrence layout, not modifiedAt.
const duplicateUrl = "https://duplicate.example/";
const reordered = item([tab("Alpha", [], duplicateUrl), tab("Beta", [], duplicateUrl)]);
await upsertItem(STORE_KEYS.inbox, reordered);
const staleOrder = await read(STORE_KEYS.inbox, reordered.id);
await putDirect(STORE_KEYS.inbox, {
  ...staleOrder, modifiedAt: staleOrder.modifiedAt,
  tabs: [staleOrder.tabs[1], staleOrder.tabs[0]]
});
const journalBeforeReorder = (await listActions()).length;
assert.equal(await labelTabsFromItems([
  { item: staleOrder, indexes: [0] }
], "wrong occurrence"), 0);
assert.equal((await listActions()).length, journalBeforeReorder);
assert.deepEqual((await read(STORE_KEYS.inbox, reordered.id)).tabs.map((ref) => ref.labels), [[], []]);

const wholeLayoutChanged = item([tab("Whole A"), tab("Whole B")]);
await upsertItem(STORE_KEYS.inbox, wholeLayoutChanged);
const staleWholeLayout = await read(STORE_KEYS.inbox, wholeLayoutChanged.id);
await putDirect(STORE_KEYS.inbox, {
  ...staleWholeLayout,
  tabs: [...staleWholeLayout.tabs, tab("Added while picker stayed open")]
});
assert.equal(await applyLabels(STORE_KEYS.inbox, staleWholeLayout, "too broad"), 0,
  "a whole-item intent cannot silently include a newly added occurrence");
assert.deepEqual((await read(STORE_KEYS.inbox, wholeLayoutChanged.id)).tabs
  .map((ref) => ref.labels), [[], [], []]);

// Identical duplicate refs remain editable while fresh, but a label-only
// change makes an old indexed snapshot ambiguous and therefore a safe no-op.
const ambiguous = item([
  tab("Same", [], duplicateUrl), tab("Same", [], duplicateUrl)
]);
await upsertItem(STORE_KEYS.inbox, ambiguous);
const ambiguousInitial = await read(STORE_KEYS.inbox, ambiguous.id);
assert.equal(await labelTabsFromItems([
  { item: ambiguousInitial, indexes: [0] }
], "first occurrence"), 1);
const ambiguousFresh = await read(STORE_KEYS.inbox, ambiguous.id);
assert.equal(await labelTabsFromItems([
  { item: ambiguousFresh, indexes: [1] }
], "second occurrence"), 1);
assert.equal(await labelTabsFromItems([
  { item: ambiguousInitial, indexes: [1] }
], "stale ambiguous"), 0);

// Duplicate bulk selections collapse per carrier; stale carriers are skipped,
// and only actual changed tabs count and appear in the one Undo prestate.
const bulkGood = item([tab("Bulk A"), tab("Bulk B", ["already"])]);
const bulkBad = item([tab("Old A"), tab("Old B")]);
await upsertItem(STORE_KEYS.archive, bulkGood);
await upsertItem(STORE_KEYS.archive, bulkBad);
const staleGood = await read(STORE_KEYS.archive, bulkGood.id);
const staleBad = await read(STORE_KEYS.archive, bulkBad.id);
await putDirect(STORE_KEYS.archive, {
  ...staleBad, tabs: [staleBad.tabs[1], staleBad.tabs[0]], modifiedAt: staleBad.modifiedAt
});
assert.equal(await labelTabsFromItems([
  { item: staleGood, indexes: [0, 0] },
  { item: staleGood, indexes: [0, 1] },
  { item: staleBad, indexes: [0] }
], "already", STORE_KEYS.archive), 1);
const bulkAction = (await listActions())[0];
assert.equal(bulkAction.puts.length, 1);
assert.equal(bulkAction.puts[0].item.id, bulkGood.id);
assert.deepEqual((await read(STORE_KEYS.archive, bulkGood.id)).tabs.map((ref) => ref.labels),
  [["already"], ["already"]]);
assert.equal((await undoActionResult(bulkAction.id)).status, "undone");
assert.deepEqual((await read(STORE_KEYS.archive, bulkGood.id)).tabs.map((ref) => ref.labels),
  [[], ["already"]]);

// Named Session label writes use the same current-record and layout contract.
const savedSession = session([[tab("Session A"), tab("Session B")]]);
await upsertItem(STORE_KEYS.sessions, savedSession);
const staleSession = await read(STORE_KEYS.sessions, savedSession.id);
await putDirect(STORE_KEYS.sessions, {
  ...staleSession, name: "Renamed while open", note: "keep",
  windows: [[{ ...staleSession.windows[0][0], labels: ["prior"] }, staleSession.windows[0][1]]]
});
assert.equal(await labelSessionTabs(staleSession, "next"), 2);
current = await read(STORE_KEYS.sessions, savedSession.id);
assert.equal(current.name, "Renamed while open");
assert.equal(current.note, "keep");
assert.deepEqual(current.windows[0].map((ref) => ref.labels), [["prior", "next"], ["next"]]);
const sessionAction = (await listActions())[0];
assert.equal((await undoActionResult(sessionAction.id)).status, "undone");
current = await read(STORE_KEYS.sessions, savedSession.id);
assert.deepEqual(current.windows[0].map((ref) => ref.labels), [["prior"], []]);
await removeSessionLabel(current, "prior", { wi: 0, i: 0 });
assert.deepEqual((await read(STORE_KEYS.sessions, savedSession.id)).windows[0][0].labels, []);

// A fresh automatic Snapshot with a stale named-Session identity is immutable.
const staleNamed = session([[tab("Named")]]);
await upsertItem(STORE_KEYS.sessions, staleNamed);
const staleNamedView = await read(STORE_KEYS.sessions, staleNamed.id);
await putDirect(STORE_KEYS.sessions, { ...staleNamedView, auto: true, name: "Snapshot" });
const journalBeforeSnapshot = (await listActions()).length;
assert.equal(await labelSessionTabs(staleNamedView, "forbidden"), 0);
await removeSessionLabel(staleNamedView, "forbidden");
assert.equal((await listActions()).length, journalBeforeSnapshot);
assert.equal((await read(STORE_KEYS.sessions, staleNamed.id)).auto, true);

// Duplicate existing label arrays must not hide a newly requested label merely
// because normalization happens to keep the same array length.
const duplicateLabels = item([tab("Duplicate labels", ["a", "a"])]);
await upsertItem(STORE_KEYS.inbox, duplicateLabels);
const duplicateLabelsView = await read(STORE_KEYS.inbox, duplicateLabels.id);
assert.equal(await applyLabels(STORE_KEYS.inbox, duplicateLabelsView, "b"), 1);
assert.deepEqual((await read(STORE_KEYS.inbox, duplicateLabels.id)).tabs[0].labels, ["a", "b"]);

// Every retained public edit path treats missing and tombstoned targets as a
// complete no-op: no carrier, label-recency, or Activity write is manufactured.
const goneItem = item([tab("Gone", ["remove"])]);
const goneSession = session([[tab("Gone Session", ["remove"])]]);
await upsertItem(STORE_KEYS.inbox, goneItem);
await upsertItem(STORE_KEYS.sessions, goneSession);
const goneItemView = await read(STORE_KEYS.inbox, goneItem.id);
const goneSessionView = await read(STORE_KEYS.sessions, goneSession.id);
await tombstoneItem(STORE_KEYS.inbox, goneItem.id);
await tombstoneItem(STORE_KEYS.sessions, goneSession.id);
const missingItemView = { ...goneItemView, id: id() };
const missingSessionView = { ...goneSessionView, id: id() };
const editMissingOrDeleted = async (savedItem, savedSession) => {
  await addLabel(STORE_KEYS.inbox, savedItem, "ghost");
  assert.equal(await applyLabels(STORE_KEYS.inbox, savedItem, "ghost"), 0);
  assert.equal(await removeLabel(STORE_KEYS.inbox, savedItem, "remove"), undefined);
  assert.equal(await removeLabelFromTab(STORE_KEYS.inbox, savedItem, 0, "remove"), undefined);
  assert.equal(await labelTabsFromItems([{ item: savedItem, indexes: [0] }], "ghost"), 0);
  assert.equal(await labelSessionTabs(savedSession, "ghost", { wi: 0, i: 0 }), 0);
  assert.equal(await removeSessionLabel(savedSession, "remove", { wi: 0, i: 0 }), undefined);
};
const noOpJournalCount = (await listActions()).length;
const noOpLabelMeta = await getLabelMeta();
await editMissingOrDeleted(goneItemView, goneSessionView);
await editMissingOrDeleted(missingItemView, missingSessionView);
assert.equal((await listActions()).length, noOpJournalCount);
assert.deepEqual(await getLabelMeta(), noOpLabelMeta);
assert.equal((await library.readEntity(STORE_KEYS.inbox, goneItem.id, {
  includeDeleted: true
})).lifecycle, "deleted");
assert.equal((await library.readEntity(STORE_KEYS.sessions, goneSession.id, {
  includeDeleted: true
})).lifecycle, "deleted");

// Session window and tab-coordinate edits reject same-millisecond reorders.
const reorderedWindows = session([
  [tab("Window One")], [tab("Window Two")]
]);
await upsertItem(STORE_KEYS.sessions, reorderedWindows);
const staleWindows = await read(STORE_KEYS.sessions, reorderedWindows.id);
await putDirect(STORE_KEYS.sessions, {
  ...staleWindows, modifiedAt: staleWindows.modifiedAt,
  windows: [staleWindows.windows[1], staleWindows.windows[0]]
});
assert.equal(await labelSessionTabs(staleWindows, "wrong window", { wi: 0 }), 0);

const reorderedIndexes = session([[
  tab("Index One", ["remove"], duplicateUrl),
  tab("Index Two", ["remove"], duplicateUrl)
]]);
await upsertItem(STORE_KEYS.sessions, reorderedIndexes);
const staleIndexes = await read(STORE_KEYS.sessions, reorderedIndexes.id);
await putDirect(STORE_KEYS.sessions, {
  ...staleIndexes, modifiedAt: staleIndexes.modifiedAt,
  windows: [[staleIndexes.windows[0][1], staleIndexes.windows[0][0]]]
});
assert.equal(await labelSessionTabs(staleIndexes, "wrong index", { wi: 0, i: 0 }), 0);
await removeSessionLabel(staleIndexes, "remove", { wi: 0, i: 0 });
assert.deepEqual((await read(STORE_KEYS.sessions, reorderedIndexes.id)).windows[0]
  .map((ref) => ref.labels), [["remove"], ["remove"]]);

console.log("label-edit-safety: ok");
