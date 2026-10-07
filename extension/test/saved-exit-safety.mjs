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

const library = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), deviceId: "saved-exit-safety"
});
const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
setStorageAuthorityForTests(createStorageAuthority({
  library, recovery, readBrowserLocal: (keys) => storage.local.get(keys)
}));

const { STORE_KEYS } = await import("../js/lib/types.js");
const { upsertItem, tombstoneItem } = await import("../js/lib/store.js");
const { archiveTabsFromItems, labelAndArchive } = await import("../js/lib/labels.js");
const { deleteTabsFromItems } = await import("../js/lib/actions.js");
const { deleteSavedItem } = await import("../js/lib/saved-item-actions.js");
const { listActions, undoActionResult } = await import("../js/lib/journal.js");
const { getLabelMeta } = await import("../js/lib/label-meta.js");

const read = async (store, id, includeDeleted = false) =>
  (await library.readEntity(store, id, { includeDeleted }))?.value ?? null;
const putDirect = async (store, value) => library.transact([
  { type: "put", family: store, id: value.id, value }
]);
let sequence = 20;
const nextId = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
const tab = (title, labels = [], url = `https://${title.toLowerCase().replaceAll(" ", "-")}.example/`) =>
  ({ url, title, labels });
const item = (tabs, extra = {}) => ({
  id: nextId(), deviceId: "saved-exit-safety", schemaVersion: 1,
  createdAt: sequence, modifiedAt: sequence,
  kind: tabs.length === 1 ? "tab" : "window", source: "manual",
  labels: [], tabs, ...extra
});

// A stale one-row selection cannot archive its old row and hide a fresh row
// that arrived in the same Inbox carrier after the view was rendered.
const id = "00000000-0000-4000-8000-000000000010";
const stale = {
  id, deviceId: "saved-exit-safety", schemaVersion: 1,
  createdAt: 1, modifiedAt: 1, kind: "tab", source: "manual", labels: [],
  tabs: [{ url: "https://old.example/", title: "Old", labels: [] }]
};
const fresh = {
  ...stale, modifiedAt: 2, kind: "window", note: "fresh metadata",
  tabs: [...stale.tabs, { url: "https://new.example/", title: "New", labels: ["new"] }]
};
await upsertItem(STORE_KEYS.inbox, fresh);
const freshStored = await read(STORE_KEYS.inbox, id);
const journalBefore = (await listActions()).length;
assert.equal(await archiveTabsFromItems([{ item: stale, indexes: [0] }]), 0);
assert.deepEqual(await read(STORE_KEYS.inbox, id), freshStored);
assert.deepEqual(await library.readFamily(STORE_KEYS.archive), []);
assert.equal((await listActions()).length, journalBefore);

// Ordered occurrence identity, not modifiedAt, protects both selected exits.
const duplicateUrl = "https://duplicate.example/";
const reordered = item([
  tab("First occurrence", [], duplicateUrl),
  tab("Second occurrence", [], duplicateUrl)
]);
await upsertItem(STORE_KEYS.inbox, reordered);
const staleOrder = await read(STORE_KEYS.inbox, reordered.id);
const reorderedCurrent = {
  ...staleOrder, modifiedAt: staleOrder.modifiedAt,
  tabs: [staleOrder.tabs[1], staleOrder.tabs[0]]
};
await putDirect(STORE_KEYS.inbox, reorderedCurrent);
const reorderJournal = (await listActions()).length;
assert.equal(await archiveTabsFromItems([{ item: staleOrder, indexes: [0] }]), 0);
assert.equal(await deleteTabsFromItems([{ item: staleOrder, indexes: [0] }]), 0);
assert.deepEqual(await read(STORE_KEYS.inbox, reordered.id), reorderedCurrent);
assert.equal((await listActions()).length, reorderJournal);

// Missing, tombstoned, and same-id replacement carriers stay absent/current.
const gone = item([tab("Gone")]);
await upsertItem(STORE_KEYS.inbox, gone);
const goneView = await read(STORE_KEYS.inbox, gone.id);
await tombstoneItem(STORE_KEYS.inbox, gone.id);
const missingView = { ...goneView, id: nextId() };
const replacedView = item([tab("Old replacement")]);
await upsertItem(STORE_KEYS.inbox, replacedView);
const staleReplacement = await read(STORE_KEYS.inbox, replacedView.id);
const replacement = {
  ...staleReplacement, createdAt: staleReplacement.createdAt + 1,
  tabs: [tab("New replacement")]
};
await putDirect(STORE_KEYS.inbox, replacement);
const absentJournal = (await listActions()).length;
const absentLabelMeta = await getLabelMeta();
assert.equal(await archiveTabsFromItems([
  { item: goneView, indexes: [0] },
  { item: missingView, indexes: [0] }
], "ghost"), 0);
assert.equal(await deleteTabsFromItems([
  { item: staleReplacement, indexes: [0] }
]), 0);
assert.equal(await labelAndArchive([goneView, missingView], "ghost"), 0);
assert.equal((await listActions()).length, absentJournal);
assert.deepEqual(await getLabelMeta(), absentLabelMeta);
assert.equal((await library.readEntity(STORE_KEYS.inbox, gone.id, {
  includeDeleted: true
})).lifecycle, "deleted");
assert.deepEqual(await read(STORE_KEYS.inbox, replacedView.id), replacement);

// Whole-item delete checks complete content, including same-millisecond edits.
const sameMillisecond = item([tab("Same millisecond")]);
await upsertItem(STORE_KEYS.inbox, sameMillisecond);
const staleSameMillisecond = await read(STORE_KEYS.inbox, sameMillisecond.id);
const editedSameMillisecond = {
  ...staleSameMillisecond, modifiedAt: staleSameMillisecond.modifiedAt,
  note: "edited without advancing the clock"
};
await putDirect(STORE_KEYS.inbox, editedSameMillisecond);
const sameMillisecondJournal = (await listActions()).length;
assert.deepEqual(
  await deleteSavedItem(STORE_KEYS.inbox, staleSameMillisecond, "Delete stale item"),
  { ok: false, reason: "stale", entry: null }
);
assert.deepEqual(await read(STORE_KEYS.inbox, sameMillisecond.id), editedSameMillisecond);
assert.equal((await listActions()).length, sameMillisecondJournal);

const freshDelete = item([tab("Fresh delete")], { note: "exact delete prestate" });
await upsertItem(STORE_KEYS.inbox, freshDelete);
const freshDeleteView = await read(STORE_KEYS.inbox, freshDelete.id);
const freshDeleteResult = await deleteSavedItem(
  STORE_KEYS.inbox, freshDeleteView, "Delete fresh item"
);
assert.equal(freshDeleteResult.ok, true);
assert.equal((await undoActionResult(freshDeleteResult.entry.id)).status, "undone");
assert.equal((await read(STORE_KEYS.inbox, freshDelete.id)).note, "exact delete prestate");

// Fresh current refs, labels, and carrier metadata supply both sides of a
// partial Archive move, and Undo restores that exact locked prestate.
const rebasedArchive = item([
  tab("Rebase keep"), tab("Rebase move")
], { labels: ["carrier-before"] });
await upsertItem(STORE_KEYS.inbox, rebasedArchive);
const staleRebasedArchive = await read(STORE_KEYS.inbox, rebasedArchive.id);
const freshRebasedArchive = {
  ...staleRebasedArchive,
  note: "fresh metadata",
  labels: ["carrier-before", "carrier-fresh"],
  tabs: [
    { ...staleRebasedArchive.tabs[0], labels: ["keep-fresh"] },
    { ...staleRebasedArchive.tabs[1], labels: ["move-fresh"] }
  ]
};
await putDirect(STORE_KEYS.inbox, freshRebasedArchive);
assert.equal(await archiveTabsFromItems([
  { item: staleRebasedArchive, indexes: [1] }
], "picked"), 1);
let current = await read(STORE_KEYS.inbox, rebasedArchive.id);
assert.equal(current.note, "fresh metadata");
assert.deepEqual(current.labels, ["carrier-before", "carrier-fresh"]);
assert.deepEqual(current.tabs[0].labels, ["keep-fresh"]);
let archiveRecords = (await library.readFamily(STORE_KEYS.archive)).map((entity) => entity.value);
const rebasedDestination = archiveRecords.find((record) =>
  record.tabs[0]?.url === freshRebasedArchive.tabs[1].url);
assert.deepEqual(rebasedDestination.tabs[0].labels, ["move-fresh"]);
assert.deepEqual(rebasedDestination.labels, ["carrier-before", "carrier-fresh", "picked"]);
const rebaseAction = (await listActions())[0];
assert.deepEqual(rebaseAction.puts[0].item, freshRebasedArchive);
assert.equal((await undoActionResult(rebaseAction.id)).status, "undone");
current = await read(STORE_KEYS.inbox, rebasedArchive.id);
assert.deepEqual(current.tabs, freshRebasedArchive.tabs);
assert.equal(current.note, "fresh metadata");
archiveRecords = (await library.readFamily(STORE_KEYS.archive)).map((entity) => entity.value);
assert.equal(archiveRecords.some((record) => record.id === rebasedDestination.id), false);

// Complete one-row Archive and Delete exits tombstone their source, and their
// production-Library Undo restores the exact source while retiring creations.
const oneRowArchive = item([tab("One row archive")], { windowTitle: "One row" });
await upsertItem(STORE_KEYS.inbox, oneRowArchive);
const oneRowArchiveView = await read(STORE_KEYS.inbox, oneRowArchive.id);
assert.equal(await archiveTabsFromItems([
  { item: oneRowArchiveView, indexes: [0] }
]), 1);
const oneRowDestination = (await library.readFamily(STORE_KEYS.archive))
  .map((entity) => entity.value)
  .find((record) => record.tabs[0]?.url === oneRowArchiveView.tabs[0].url);
assert.ok(oneRowDestination);
assert.equal((await library.readEntity(STORE_KEYS.inbox, oneRowArchive.id, {
  includeDeleted: true
})).lifecycle, "deleted");
const oneRowArchiveAction = (await listActions())[0];
assert.equal((await undoActionResult(oneRowArchiveAction.id)).status, "undone");
assert.deepEqual((await read(STORE_KEYS.inbox, oneRowArchive.id)).tabs, oneRowArchiveView.tabs);
assert.equal(await read(STORE_KEYS.archive, oneRowDestination.id), null);

const oneRowDelete = item([tab("One row delete")], { note: "restore me" });
await upsertItem(STORE_KEYS.inbox, oneRowDelete);
const oneRowDeleteView = await read(STORE_KEYS.inbox, oneRowDelete.id);
assert.equal(await deleteTabsFromItems([
  { item: oneRowDeleteView, indexes: [0] }
]), 1);
assert.equal((await library.readEntity(STORE_KEYS.inbox, oneRowDelete.id, {
  includeDeleted: true
})).lifecycle, "deleted");
const oneRowDeleteAction = (await listActions())[0];
assert.equal((await undoActionResult(oneRowDeleteAction.id)).status, "undone");
assert.equal((await read(STORE_KEYS.inbox, oneRowDelete.id)).note, "restore me");

const archiveDelete = item([tab("Archive store delete")], { archivedAt: 10, labels: ["keep"] });
await upsertItem(STORE_KEYS.archive, archiveDelete);
const archiveDeleteView = await read(STORE_KEYS.archive, archiveDelete.id);
assert.equal(await deleteTabsFromItems([
  { item: archiveDeleteView, indexes: [0] }
], STORE_KEYS.archive), 1);
assert.equal((await library.readEntity(STORE_KEYS.archive, archiveDelete.id, {
  includeDeleted: true
})).lifecycle, "deleted");
const archiveDeleteAction = (await listActions())[0];
assert.equal((await undoActionResult(archiveDeleteAction.id)).status, "undone");
assert.deepEqual((await read(STORE_KEYS.archive, archiveDelete.id)).tabs, archiveDeleteView.tabs);
assert.deepEqual((await read(STORE_KEYS.archive, archiveDelete.id)).labels, ["keep"]);

// Repeated sources and indexes collapse per carrier; a stale sibling is
// skipped, and the result and one inverse count only accepted occurrences.
const bulkGood = item([tab("Bulk one"), tab("Bulk two"), tab("Bulk keep")]);
const bulkStale = item([tab("Stale one"), tab("Stale two")]);
await upsertItem(STORE_KEYS.inbox, bulkGood);
await upsertItem(STORE_KEYS.inbox, bulkStale);
const bulkGoodView = await read(STORE_KEYS.inbox, bulkGood.id);
const bulkStaleView = await read(STORE_KEYS.inbox, bulkStale.id);
await putDirect(STORE_KEYS.inbox, {
  ...bulkStaleView, tabs: [bulkStaleView.tabs[1], bulkStaleView.tabs[0]]
});
assert.equal(await deleteTabsFromItems([
  { item: bulkGoodView, indexes: [0, 0] },
  { item: bulkGoodView, indexes: [0, 1, 1, -1, 99] },
  { item: bulkStaleView, indexes: [0] }
]), 2);
assert.deepEqual((await read(STORE_KEYS.inbox, bulkGood.id)).tabs, [bulkGoodView.tabs[2]]);
assert.deepEqual((await read(STORE_KEYS.inbox, bulkStale.id)).tabs,
  [bulkStaleView.tabs[1], bulkStaleView.tabs[0]]);
const bulkAction = (await listActions())[0];
assert.equal(bulkAction.puts.length, 1);
assert.equal(bulkAction.puts[0].item.id, bulkGood.id);
assert.equal((await undoActionResult(bulkAction.id)).status, "undone");
assert.deepEqual((await read(STORE_KEYS.inbox, bulkGood.id)).tabs, bulkGoodView.tabs);

// Caller index order cannot reorder the destination; selected occurrences are
// projected in their current carrier order after duplicate indexes collapse.
const unsorted = item([
  tab("Order zero"), tab("Order one"), tab("Order two")
], { windowTitle: "Old window title" });
await upsertItem(STORE_KEYS.inbox, unsorted);
const unsortedView = await read(STORE_KEYS.inbox, unsorted.id);
await putDirect(STORE_KEYS.inbox, { ...unsortedView, windowTitle: "Fresh window title" });
assert.equal(await archiveTabsFromItems([
  { item: unsortedView, indexes: [2, 0, 2] }
]), 2);
const orderedDestination = (await library.readFamily(STORE_KEYS.archive))
  .map((entity) => entity.value)
  .find((record) => record.tabs.some((ref) => ref.url === unsortedView.tabs[0].url));
assert.deepEqual(orderedDestination.tabs.map((ref) => ref.url), [
  unsortedView.tabs[0].url, unsortedView.tabs[2].url
]);
assert.equal(orderedDestination.windowTitle, "Fresh window title");
assert.deepEqual((await read(STORE_KEYS.inbox, unsorted.id)).tabs, [unsortedView.tabs[1]]);
const unsortedAction = (await listActions())[0];
assert.equal((await undoActionResult(unsortedAction.id)).status, "undone");

// Conflicting snapshots invalidate their carrier, while a fresh set of exact
// duplicate refs remains addressable by its ordered index.
const conflicting = item([tab("Conflict one"), tab("Conflict two")]);
await upsertItem(STORE_KEYS.inbox, conflicting);
const conflictView = await read(STORE_KEYS.inbox, conflicting.id);
const conflictOtherView = { ...conflictView, note: "different caller snapshot" };
const conflictJournal = (await listActions()).length;
assert.equal(await deleteTabsFromItems([
  { item: conflictView, indexes: [0] },
  { item: conflictOtherView, indexes: [1] }
]), 0);
assert.equal(await labelAndArchive([conflictView, conflictOtherView]), 0);
assert.equal((await listActions()).length, conflictJournal);

const identicalRef = tab("Exact duplicate", [], duplicateUrl);
const duplicates = item([identicalRef, { ...identicalRef }]);
await upsertItem(STORE_KEYS.inbox, duplicates);
const duplicateView = await read(STORE_KEYS.inbox, duplicates.id);
assert.equal(await deleteTabsFromItems([
  { item: duplicateView, indexes: [0] }
]), 1);
assert.deepEqual((await read(STORE_KEYS.inbox, duplicates.id)).tabs, [duplicateView.tabs[1]]);
const duplicateAction = (await listActions())[0];
assert.equal((await undoActionResult(duplicateAction.id)).status, "undone");

const ambiguousStale = await read(STORE_KEYS.inbox, duplicates.id);
await putDirect(STORE_KEYS.inbox, {
  ...ambiguousStale,
  tabs: [{ ...ambiguousStale.tabs[0], labels: ["newer"] }, ambiguousStale.tabs[1]]
});
const ambiguousJournal = (await listActions()).length;
assert.equal(await archiveTabsFromItems([
  { item: ambiguousStale, indexes: [1] }
]), 0);
assert.equal((await listActions()).length, ambiguousJournal);

// Whole-item Archive exits dedupe repeated snapshots, preserve fresh metadata
// and labels, and refuse a layout change that could broaden the old intent.
const whole = item([tab("Whole")], { labels: ["before"] });
await upsertItem(STORE_KEYS.inbox, whole);
const staleWhole = await read(STORE_KEYS.inbox, whole.id);
const freshWhole = {
  ...staleWhole, note: "current whole metadata", labels: ["before", "fresh"],
  tabs: [{ ...staleWhole.tabs[0], labels: ["row-fresh"] }]
};
await putDirect(STORE_KEYS.inbox, freshWhole);
assert.equal(await labelAndArchive([staleWhole, staleWhole], "added"), 1);
const movedWhole = await read(STORE_KEYS.archive, whole.id);
assert.equal(movedWhole.note, "current whole metadata");
assert.deepEqual(movedWhole.labels, ["before", "fresh", "added"]);
assert.deepEqual(movedWhole.tabs[0].labels, ["row-fresh"]);
assert.deepEqual((await listActions())[0].puts[0].item, freshWhole);

const changedWhole = item([tab("Whole old")]);
await upsertItem(STORE_KEYS.inbox, changedWhole);
const staleChangedWhole = await read(STORE_KEYS.inbox, changedWhole.id);
const freshChangedWhole = {
  ...staleChangedWhole,
  tabs: [...staleChangedWhole.tabs, tab("Whole added")]
};
await putDirect(STORE_KEYS.inbox, freshChangedWhole);
const changedWholeJournal = (await listActions()).length;
const changedWholeLabels = await getLabelMeta();
assert.equal(await labelAndArchive([staleChangedWhole], "must not broaden"), 0);
assert.deepEqual(await read(STORE_KEYS.inbox, changedWhole.id), freshChangedWhole);
assert.equal((await listActions()).length, changedWholeJournal);
assert.deepEqual(await getLabelMeta(), changedWholeLabels);

// Labeled whole-window exits still split from fresh refs into per-tab records.
const split = item([tab("Split one"), tab("Split two")], { labels: ["base"] });
await upsertItem(STORE_KEYS.inbox, split);
const staleSplit = await read(STORE_KEYS.inbox, split.id);
const freshSplit = {
  ...staleSplit, note: "split fresh",
  tabs: [staleSplit.tabs[0], { ...staleSplit.tabs[1], labels: ["row-fresh"] }]
};
await putDirect(STORE_KEYS.inbox, freshSplit);
assert.equal(await labelAndArchive([staleSplit], "split-label"), 1);
archiveRecords = (await library.readFamily(STORE_KEYS.archive)).map((entity) => entity.value);
const splitRecords = archiveRecords.filter((record) => record.note === undefined &&
  record.labels?.includes("split-label"));
assert.equal(splitRecords.length, 2);
assert.equal(splitRecords.every((record) => record.kind === "tab"), true);
assert.deepEqual(splitRecords.find((record) =>
  record.tabs[0].url === freshSplit.tabs[1].url).tabs[0].labels, ["row-fresh"]);

// A pre-existing same-id Archive record is never overwritten by a whole-item
// move. The conservative no-op has no journal or label-recency side effect.
const collision = item([tab("Collision source")]);
const unrelatedDestination = {
  ...collision, deviceId: "other-device", createdAt: collision.createdAt + 100,
  tabs: [tab("Collision destination")], archivedAt: 5
};
await upsertItem(STORE_KEYS.inbox, collision);
await upsertItem(STORE_KEYS.archive, unrelatedDestination);
const collisionInbox = await read(STORE_KEYS.inbox, collision.id);
const collisionArchive = await read(STORE_KEYS.archive, collision.id);
const collisionJournal = (await listActions()).length;
const collisionLabels = await getLabelMeta();
assert.equal(await labelAndArchive([collisionInbox]), 0);
assert.deepEqual(await read(STORE_KEYS.inbox, collision.id), collisionInbox);
assert.deepEqual(await read(STORE_KEYS.archive, collision.id), collisionArchive);
assert.equal((await listActions()).length, collisionJournal);
assert.deepEqual(await getLabelMeta(), collisionLabels);

// Undo leaves a compact Archive tombstone. A revived Inbox item can be moved
// again through that same-id slot, and both production-Library Undos are exact.
const repeated = item([tab("Repeated whole archive")]);
await upsertItem(STORE_KEYS.inbox, repeated);
let repeatedView = await read(STORE_KEYS.inbox, repeated.id);
assert.equal(await labelAndArchive([repeatedView]), 1);
let repeatedAction = (await listActions())[0];
assert.equal((await undoActionResult(repeatedAction.id)).status, "undone");
assert.equal(await read(STORE_KEYS.archive, repeated.id), null);
repeatedView = await read(STORE_KEYS.inbox, repeated.id);
assert.equal(await labelAndArchive([repeatedView]), 1);
repeatedAction = (await listActions())[0];
assert.equal((await undoActionResult(repeatedAction.id)).status, "undone");
assert.deepEqual((await read(STORE_KEYS.inbox, repeated.id)).tabs, repeatedView.tabs);
assert.equal(await read(STORE_KEYS.archive, repeated.id), null);

console.log("saved-exit-safety: ok");
