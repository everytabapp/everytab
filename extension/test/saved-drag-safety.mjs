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
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA), deviceId: "saved-drag-safety"
});
const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA) });
setStorageAuthorityForTests(createStorageAuthority({
  library, recovery, readBrowserLocal: (keys) => storage.local.get(keys)
}));

const { STORE_KEYS } = await import("../js/lib/types.js");
const { upsertItem } = await import("../js/lib/store.js");
const { moveInboxTabs } = await import("../js/lib/actions.js");
const { moveSessionTabsWithin } = await import("../js/lib/sessions.js");
const { listActions } = await import("../js/lib/journal.js");

let sequence = 1;
const meta = () => ({
  id: `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
  deviceId: "saved-drag-safety", schemaVersion: 1,
  createdAt: sequence, modifiedAt: sequence
});
const tab = (name) => ({ url: `https://${name}.example/`, title: name });
const read = async (family, id) =>
  (await library.readEntity(family, id))?.value ?? null;
const putDirect = async (family, value) => library.transact([
  { type: "put", family, id: value.id, value }
]);

const source = {
  ...meta(), kind: "window", source: "manual", labels: [],
  tabs: [tab("inbox-a"), tab("inbox-b")]
};
const target = {
  ...meta(), kind: "tab", source: "manual", labels: [], tabs: [tab("inbox-target")]
};
await upsertItem(STORE_KEYS.inbox, source);
await upsertItem(STORE_KEYS.inbox, target);
const liftedSource = await read(STORE_KEYS.inbox, source.id);
const liftedTarget = await read(STORE_KEYS.inbox, target.id);
const reorderedSource = {
  ...liftedSource,
  tabs: [liftedSource.tabs[1], liftedSource.tabs[0]],
  modifiedAt: liftedSource.modifiedAt
};
await putDirect(STORE_KEYS.inbox, reorderedSource);
const inboxJournalBefore = (await listActions()).length;
const inboxResult = await moveInboxTabs([
  { item: structuredClone(liftedSource), indexes: [0] }
], structuredClone(liftedTarget), 0);

const targetSource = {
  ...meta(), kind: "tab", source: "manual", labels: [], tabs: [tab("target-source")]
};
const changingTarget = {
  ...meta(), kind: "window", source: "manual", labels: [],
  tabs: [tab("target-a"), tab("target-b")]
};
await upsertItem(STORE_KEYS.inbox, targetSource);
await upsertItem(STORE_KEYS.inbox, changingTarget);
const targetSourceLift = await read(STORE_KEYS.inbox, targetSource.id);
const targetLift = await read(STORE_KEYS.inbox, changingTarget.id);
const reorderedTarget = {
  ...targetLift,
  tabs: [targetLift.tabs[1], targetLift.tabs[0]],
  modifiedAt: targetLift.modifiedAt
};
await putDirect(STORE_KEYS.inbox, reorderedTarget);
const targetResult = await moveInboxTabs([
  { item: structuredClone(targetSourceLift), indexes: [0] }
], structuredClone(targetLift), 0);

const batchSource = {
  ...meta(), kind: "window", source: "manual", labels: [],
  tabs: [tab("batch-a"), tab("batch-b")]
};
const batchSibling = {
  ...meta(), kind: "tab", source: "manual", labels: [], tabs: [tab("batch-sibling")]
};
const batchTarget = {
  ...meta(), kind: "tab", source: "manual", labels: [], tabs: [tab("batch-target")]
};
for (const record of [batchSource, batchSibling, batchTarget]) {
  await upsertItem(STORE_KEYS.inbox, record);
}
const batchSourceLift = await read(STORE_KEYS.inbox, batchSource.id);
const batchSiblingLift = await read(STORE_KEYS.inbox, batchSibling.id);
const batchTargetLift = await read(STORE_KEYS.inbox, batchTarget.id);
const batchBefore = (await listActions()).length;
const conflictingBatch = await moveInboxTabs([
  { item: batchSourceLift, indexes: [0] },
  { item: batchSiblingLift, indexes: [0] },
  { item: { ...batchSiblingLift, note: "conflicting lift" }, indexes: [0] }
], batchTargetLift, -1);
const missingBatch = await moveInboxTabs([
  { item: batchSourceLift, indexes: [0] },
  { item: { ...batchSiblingLift, id: "missing-drag-source" }, indexes: [0] }
], batchTargetLift, -1);
const invalidBatch = await moveInboxTabs([
  { item: batchSourceLift, indexes: [0] },
  { item: batchSiblingLift, indexes: [batchSiblingLift.tabs.length] }
], batchTargetLift, -1);

const session = {
  ...meta(), name: "Drag", auto: false, labels: [],
  windows: [[tab("session-a"), tab("session-b")], [tab("session-target")]]
};
await upsertItem(STORE_KEYS.sessions, session);
const liftedSession = await read(STORE_KEYS.sessions, session.id);
const reorderedSession = {
  ...liftedSession,
  windows: [[liftedSession.windows[0][1], liftedSession.windows[0][0]], liftedSession.windows[1]],
  modifiedAt: liftedSession.modifiedAt
};
await putDirect(STORE_KEYS.sessions, reorderedSession);
const sessionJournalBefore = (await listActions()).length;
const sessionResult = await moveSessionTabsWithin(
  structuredClone(liftedSession),
  [{ windowIndex: 0, indexes: [0] }],
  { wi: 1, index: 0 }
);

assert.deepEqual({
  inboxRejected: inboxResult.ok === false && inboxResult.stale === true,
  inboxPreserved: JSON.stringify(await read(STORE_KEYS.inbox, source.id)) ===
    JSON.stringify(reorderedSource),
  targetRejected: targetResult.ok === false && targetResult.stale === true,
  targetPreserved: JSON.stringify(await read(STORE_KEYS.inbox, changingTarget.id)) ===
    JSON.stringify(reorderedTarget),
  targetSourcePreserved: JSON.stringify(await read(STORE_KEYS.inbox, targetSource.id)) ===
    JSON.stringify(targetSourceLift),
  conflictingBatchRejected: conflictingBatch.ok === false && conflictingBatch.stale === true,
  missingBatchRejected: missingBatch.ok === false && missingBatch.stale === true,
  invalidBatchRejected: invalidBatch.ok === false && invalidBatch.stale === true,
  batchPreserved: JSON.stringify(await read(STORE_KEYS.inbox, batchSource.id)) ===
    JSON.stringify(batchSourceLift) &&
    JSON.stringify(await read(STORE_KEYS.inbox, batchSibling.id)) ===
    JSON.stringify(batchSiblingLift) &&
    JSON.stringify(await read(STORE_KEYS.inbox, batchTarget.id)) ===
    JSON.stringify(batchTargetLift) && (await listActions()).length === batchBefore,
  inboxJournalClean: (await listActions()).length === sessionJournalBefore,
  sessionRejected: sessionResult.ok === false && sessionResult.stale === true,
  sessionPreserved: JSON.stringify(await read(STORE_KEYS.sessions, session.id)) ===
    JSON.stringify(reorderedSession),
  sessionJournalClean: (await listActions()).length === sessionJournalBefore,
  noInboxJournal: inboxJournalBefore === 0
}, {
  inboxRejected: true,
  inboxPreserved: true,
  targetRejected: true,
  targetPreserved: true,
  targetSourcePreserved: true,
  conflictingBatchRejected: true,
  missingBatchRejected: true,
  invalidBatchRejected: true,
  batchPreserved: true,
  inboxJournalClean: true,
  sessionRejected: true,
  sessionPreserved: true,
  sessionJournalClean: true,
  noInboxJournal: true
});

console.log("saved-drag-safety: ok");
