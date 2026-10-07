import assert from "node:assert/strict";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, LIBRARY_STORES, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { setStorageAuthorityForTests } from "../js/lib/storage/authority-runtime.js";

const storage = createInterleavableStorage({ deviceId: "saved-transfer-test" });
const alarms = [];
let checkAlarm = async () => {};
globalThis.chrome = {
  storage: { local: storage.local, onChanged: storage.onChanged },
  alarms: { create: async (name, options) => {
    await checkAlarm(name, options);
    alarms.push({ name, options });
  } }
};
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const adapter = createMemoryIndexedDbAdapter(LIBRARY_SCHEMA);
let rejectJournalWrite = false;
const library = createLibraryStore({
  adapter: {
    ...adapter,
    transaction: (names, mode, work) => adapter.transaction(names, mode, (transaction) =>
      work({
        ...transaction,
        put: async (store, row) => {
          if (rejectJournalWrite && store === LIBRARY_STORES.local && row.key === "journal") {
            throw new Error("Injected journal failure");
          }
          return transaction.put(store, row);
        }
      }))
  },
  deviceId: "saved-transfer-test"
});
const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
setStorageAuthorityForTests(createStorageAuthority({
  library, recovery, readBrowserLocal: (keys) => storage.local.get(keys)
}));

const { snoozeTabRefs, moveTabsToSession } = await import("../js/lib/actions.js");
const { listActions, undoActionResult } = await import("../js/lib/journal.js");
const put = async (family, value) => library.transact([
  { type: "put", family, id: value.id, value }
]);
const read = async (family, id) => (await library.readEntity(family, id))?.value ?? null;
let sequence = 1;
const item = (tabs, extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
  deviceId: "saved-transfer-test", schemaVersion: 1, createdAt: 1, modifiedAt: 1,
  kind: tabs.length === 1 ? "tab" : "window", source: "manual", labels: [], tabs, ...extra
});
const tab = (name) => ({ url: `https://${name}.example/`, title: name, labels: [] });
const dueAt = Date.now() + 3600_000;
const destinationFamily = (kind) => kind === "snooze" ? "snoozes" : "sessions";
const run = (kind, sources, target = "__new", organization = null) => kind === "snooze"
  ? snoozeTabRefs(sources, dueAt, "weekly")
  : moveTabsToSession(sources, target, "Project", organization);
const transferCount = (result) => typeof result === "number" ? result : result?.moved ?? 0;
const lastAction = async () => (await listActions())[0];
const withoutModifiedAt = ({ modifiedAt, ...record }) => record;
async function expectNoTransfer(kind, sources, target = "__new", organization = null) {
  const inboxBefore = await library.readFamily("inbox", { includeDeleted: true });
  const destinationBefore = await library.readFamily(destinationFamily(kind), { includeDeleted: true });
  const journalBefore = await listActions();
  const alarmBefore = alarms.length;
  const result = await run(kind, sources, target, organization);
  assert.equal(result, kind === "snooze" ? 0 : null);
  assert.deepEqual(await library.readFamily("inbox", { includeDeleted: true }), inboxBefore);
  assert.deepEqual(await library.readFamily(destinationFamily(kind), { includeDeleted: true }), destinationBefore);
  assert.deepEqual(await listActions(), journalBefore);
  assert.equal(alarms.length, alarmBefore);
}

// Both transitions must refuse an old selection after another tab was added.
// The current carrier and its new tab must survive without a destination or Undo.
for (const kind of ["snooze", "session"]) {
  if (process.argv[2] && process.argv[2] !== kind) continue;
  const old = item([tab("selected")]);
  const current = { ...old, kind: "window", tabs: [...old.tabs, tab("newer")] };
  await put("inbox", current);
  const journalBefore = await listActions();
  const result = kind === "snooze"
    ? await snoozeTabRefs([{ item: old, indexes: [0] }], dueAt)
    : await moveTabsToSession([{ item: old, indexes: [0] }], "__new", "Project");
  assert.equal(result, kind === "snooze" ? 0 : null,
    `${kind} must refuse a changed source layout`);
  assert.deepEqual(await read("inbox", old.id), current);
  assert.deepEqual(await library.readFamily(kind === "snooze" ? "snoozes" : "sessions"), []);
  assert.deepEqual(await listActions(), journalBefore);
  assert.deepEqual(alarms, []);
}

for (const kind of ["snooze", "session"]) {
  if (process.argv[2] && process.argv[2] !== kind) continue;
  const original = item([tab("first"), tab("second")]);
  await put("inbox", original);
  await library.transact([{ type: "delete", family: "inbox", id: original.id }]);
  await expectNoTransfer(kind, [{ item: original, indexes: [0] }]);
  await expectNoTransfer(kind, [{ item: item([tab("absent")]), indexes: [0] }]);

  const replaced = { ...original, createdAt: 2 };
  await put("inbox", replaced);
  await expectNoTransfer(kind, [{ item: original, indexes: [0] }]);
  await put("inbox", { ...original, deviceId: "replacement-device" });
  await expectNoTransfer(kind, [{ item: original, indexes: [0] }]);
  await put("inbox", { ...original, tabs: [...original.tabs].reverse() });
  await expectNoTransfer(kind, [{ item: original, indexes: [0] }]);

  await put("inbox", original);
  await expectNoTransfer(kind, [{ item: original, indexes: [-1, 8, NaN, 0.5] }]);
  await expectNoTransfer(kind, [
    { item: original, indexes: [0] },
    { item: { ...original, labels: ["conflicting view"] }, indexes: [1] }
  ]);

  // Indistinguishable occurrences cannot be selected safely after labels change.
  const ambiguous = item([tab("same"), tab("same")]);
  await put("inbox", { ...ambiguous, tabs: [
    { ...ambiguous.tabs[0], labels: ["new"] }, ambiguous.tabs[1]
  ] });
  await expectNoTransfer(kind, [{ item: ambiguous, indexes: [0] }]);

  // Duplicate/unsorted inputs apply once in source order, with fresh labels and
  // metadata in the retained source and exact inverse, not the caller snapshot.
  const old = item([tab("a"), tab("b"), tab("c")], { labels: ["old carrier"] });
  const current = {
    ...old, labels: ["new carrier"], windowTitle: "Current name", note: "keep me",
    tabs: old.tabs.map((ref, index) => ({ ...ref, labels: [`new ${index}`] }))
  };
  await put("inbox", current);
  const destinationBefore = new Set((await library.readFamily(destinationFamily(kind))).map((entry) => entry.id));
  checkAlarm = async (name, options) => {
    const entry = await lastAction();
    const destination = entry.dels.find((target) => name.endsWith(target.id));
    assert.ok(destination, "an alarm must belong to a committed Undo entry");
    assert.equal((await read("snoozes", destination.id)).dueAt, options.when);
    assert.equal((await read("inbox", old.id)).tabs.length, 1,
      "source consumption must commit before its alarm");
  };
  const result = await run(kind, [
    { item: old, indexes: [2, 0, 2, 99] }, { item: old, indexes: [0] }
  ]);
  checkAlarm = async () => {};
  assert.equal(transferCount(result), 2);
  const created = (await library.readFamily(destinationFamily(kind)))
    .filter((entry) => !destinationBefore.has(entry.id));
  assert.equal(created.length, 1);
  const expectedTransferred = [
    { ...current.tabs[0], labels: ["new carrier", "new 0"] },
    { ...current.tabs[2], labels: ["new carrier", "new 2"] }
  ];
  assert.deepEqual(kind === "snooze" ? created[0].value.tabs : created[0].value.windows[0],
    expectedTransferred);
  if (kind === "snooze") assert.equal(created[0].value.recurrence, "weekly");
  const remaining = await read("inbox", old.id);
  assert.deepEqual(remaining.tabs, [current.tabs[1]]);
  assert.equal(remaining.note, current.note);
  assert.deepEqual(remaining.labels, current.labels);
  const entry = await lastAction();
  assert.deepEqual(entry.puts.find((target) => target.store === "inbox").item, current);
  assert.equal((await undoActionResult(entry.id)).status, "undone");
  assert.deepEqual(withoutModifiedAt(await read("inbox", old.id)), withoutModifiedAt(current));
  assert.equal(await read(destinationFamily(kind), created[0].id), null);

  // Exact duplicate occurrences work from a fresh view; whole-source deletion
  // still has a usable Undo through the real compact-tombstone authority.
  const duplicates = item([tab("duplicate"), tab("duplicate")]);
  await put("inbox", duplicates);
  assert.equal(transferCount(await run(kind, [{ item: duplicates, indexes: [0, 1] }])), 2);
  assert.equal(await read("inbox", duplicates.id), null);
  assert.equal((await undoActionResult((await lastAction()).id)).status, "undone");
  assert.deepEqual(withoutModifiedAt(await read("inbox", duplicates.id)), withoutModifiedAt(duplicates));

  // A stale sibling does not block a valid source or pollute the inverse/count.
  const valid = item([tab("valid")]);
  const stale = item([tab("stale")]);
  const changed = { ...stale, tabs: [...stale.tabs, tab("added")], kind: "window" };
  await put("inbox", valid);
  await put("inbox", changed);
  assert.equal(transferCount(await run(kind, [
    { item: stale, indexes: [0] }, { item: valid, indexes: [0] }
  ])), 1);
  assert.deepEqual(await read("inbox", stale.id), changed);
  assert.equal((await lastAction()).puts.filter((target) => target.store === "inbox").length, 1);
  assert.equal((await undoActionResult((await lastAction()).id)).status, "undone");

  // A failed storage commit cannot consume sources, write a destination/journal,
  // schedule alarms, or assign a new Session group.
  const source = item([tab("rollback")]);
  await put("inbox", source);
  const before = await library.readFamily(destinationFamily(kind), { includeDeleted: true });
  const journalBefore = await listActions();
  const alarmBefore = alarms.length;
  rejectJournalWrite = true;
  try {
    await assert.rejects(run(kind, [{ item: source, indexes: [0] }], "__new",
      { createNames: ["Should not exist"] }), /Injected journal failure/);
  } finally {
    rejectJournalWrite = false;
  }
  assert.deepEqual(await read("inbox", source.id), source);
  assert.deepEqual(await library.readFamily(destinationFamily(kind), { includeDeleted: true }), before);
  assert.deepEqual(await listActions(), journalBefore);
  assert.equal(alarms.length, alarmBefore);
  assert.deepEqual(await library.readFamily("organizationGroups"), []);
}

const session = (windows, extra = {}) => {
  const { tabs, kind, source, ...meta } = item([]);
  return { ...meta, name: "Existing", auto: false, windows, ...extra };
};
async function withGeneratedId(id, operation) {
  const original = crypto.randomUUID;
  crypto.randomUUID = () => id;
  try { return await operation(); }
  finally { crypto.randomUUID = original; }
}

for (const kind of ["snooze", "session"]) {
  if (process.argv[2] && process.argv[2] !== kind) continue;
  const source = item([tab("collision-source")]);
  await put("inbox", source);
  const destination = kind === "snooze"
    ? { ...item([]), url: "https://existing.example/", title: "Existing", dueAt }
    : session([[tab("existing")]]);
  await put(destinationFamily(kind), destination);
  await withGeneratedId(destination.id, () => expectNoTransfer(kind, [{ item: source, indexes: [0] }]));
  await library.transact([{ type: "delete", family: destinationFamily(kind), id: destination.id }]);
  await withGeneratedId(destination.id, () => expectNoTransfer(kind, [{ item: source, indexes: [0] }]));
}

if (!process.argv[2] || process.argv[2] === "snooze") {
  // A repeated generated ID cannot overwrite the first destination in a batch.
  const a = item([tab("id-first")]);
  const b = item([tab("id-second")]);
  await put("inbox", a);
  await put("inbox", b);
  const generatedId = item([]).id;
  const alarmBefore = alarms.length;
  assert.equal(await withGeneratedId(generatedId, () => snoozeTabRefs([
    { item: a, indexes: [0] }, { item: b, indexes: [0] }
  ], dueAt)), 1);
  assert.equal((await read("snoozes", generatedId)).url, a.tabs[0].url);
  assert.equal(await read("inbox", a.id), null);
  assert.deepEqual(await read("inbox", b.id), b);
  assert.equal(alarms.length, alarmBefore + 1);
  assert.equal((await undoActionResult((await lastAction()).id)).status, "undone");
}

if (!process.argv[2] || process.argv[2] === "session") {
  const source = item([tab("append")]);
  await put("inbox", source);
  await expectNoTransfer("session", [{ item: source, indexes: [0] }], item([]).id);
  const deletedTarget = session([[tab("deleted-target")]]);
  await put("sessions", deletedTarget);
  await library.transact([{ type: "delete", family: "sessions", id: deletedTarget.id }]);
  await expectNoTransfer("session", [{ item: source, indexes: [0] }], deletedTarget.id);
  const snapshot = session([[tab("automatic")]], { auto: true });
  await recovery.captureSnapshot(snapshot);
  const snapshotBefore = await recovery.readSnapshot(snapshot.id);
  await expectNoTransfer("session", [{ item: source, indexes: [0] }], snapshot.id);
  assert.deepEqual(await recovery.readSnapshot(snapshot.id), snapshotBefore);

  // Existing Session updates are append-only against its fresh locked windows,
  // retaining current name/labels/group templates; Undo restores both sides.
  const destination = session([[tab("original")]]);
  await put("sessions", destination);
  const current = {
    ...destination, name: "Renamed", labels: ["session-label"], note: "current metadata",
    windows: [...destination.windows, [tab("concurrent-window")]],
    groups: [[{ title: "Keep group", color: "blue" }], []]
  };
  await put("sessions", current);
  const result = await moveTabsToSession([{ item: source, indexes: [0] }], destination.id);
  assert.equal(result.moved, 1);
  assert.equal(result.name, "Renamed");
  assert.equal(result.id, destination.id);
  const after = await read("sessions", destination.id);
  assert.deepEqual(after.windows, [...current.windows, source.tabs]);
  assert.deepEqual(after.groups, current.groups);
  assert.deepEqual(after.labels, current.labels);
  assert.equal(after.note, current.note);
  assert.deepEqual(result.entry.puts.find((target) => target.store === "sessions").item, current);
  assert.equal((await undoActionResult(result.entry.id)).status, "undone");
  assert.deepEqual(withoutModifiedAt(await read("sessions", destination.id)), withoutModifiedAt(current));
  assert.deepEqual(withoutModifiedAt(await read("inbox", source.id)), withoutModifiedAt(source));

  // A rejected new Session move must not create an optional organization group.
  const stale = item([tab("stale-group-source")]);
  await expectNoTransfer("session", [{ item: stale, indexes: [0] }], "__new",
    { createNames: ["No source, no group"] });
  assert.deepEqual(await library.readFamily("organizationGroups"), []);
  const grouped = await moveTabsToSession([{ item: source, indexes: [0] }], "__new", "Grouped", {
    createNames: ["Project group"]
  });
  assert.equal(grouped.moved, 1);
  assert.equal((await library.readFamily("organizationGroups")).length, 1);
  const memberships = await library.readFamily("organizationMemberships");
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].value.memberKey, grouped.id);
}

console.log("PASS: saved transfer safety");
