/** N44 portable-state / Restore focused suite. Run from extension/: node test/portable-state.mjs */
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";

const storage = createInterleavableStorage({});
globalThis.chrome = {
  storage: { local: storage.local, onChanged: storage.onChanged }
};
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, writable: true, configurable: true
});

const {
  PORTABLE_EXPORT_MAX_BYTES, PORTABLE_EXPORT_VERSION, RESTORE_CHECKPOINT_KEY,
  assertPortableRestoreTextSize,
  buildPortableExport, buildRestoreCheckpointExport, normalizePortableSettings,
  portableStateEntries, portableVaultFileName, previewPortableRestore,
  readPortableRestoreFile, restorePortableState, undoPortableRestore
} = await import("../js/lib/portable-state.js");
const { STORE_KEYS, ARCHIVE_OVERLAY_KEY, DEFAULT_SETTINGS } = await import("../js/lib/types.js");
const { SESSION_IDENTITY_INDEX_KEY } = await import("../js/lib/session-identity-index.js");
const { listActions, recordAction, undoAction } = await import("../js/lib/journal.js");
const { upsertItem } = await import("../js/lib/store.js");
const {
  createCustomSchemeRecord, createDefaultCustomSchemeDraft, customSchemeRef
} = await import("../js/lib/custom-schemes.js");
const { dashboardTasksForStorage } = await import("../js/ui/refresh-scheduler.js");
const {
  captureRestoreFocus, markRestoreFocus, restoreRestoreFocus
} = await import("../js/ui/restore-panel-focus.js");

let failures = 0;
function check(condition, name) {
  if (condition) console.log(`  ok: ${name}`);
  else { console.error(`FAIL: ${name}`); failures++; }
}
async function rejects(fn, pattern, name) {
  try { await fn(); check(false, name); }
  catch (error) { check(pattern.test(String(error?.message ?? error)), name); }
}

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = Date.parse("2026-08-10T10:00:00Z");
function meta(id, modifiedAt, extra = {}) {
  return {
    id, deviceId: "portable-test", createdAt: T0, modifiedAt, schemaVersion: 1,
    ...extra
  };
}
function inbox(id, modifiedAt, url, extra = {}) {
  return meta(id, modifiedAt, {
    kind: "tab", tabs: [{ url, title: url }], source: "manual", labels: [], ...extra
  });
}
function session(id, modifiedAt, name, extra = {}) {
  return meta(id, modifiedAt, {
    name, auto: false, windows: [[{ url: `https://${name}.example`, title: name }]], labels: [],
    ...extra
  });
}
function envelope({ data = {}, settings = {}, settingsModifiedAt = 0, labelMeta = {}, ...extra } = {}) {
  return JSON.stringify({
    app: "tabvault", exportVersion: 2, schemaVersion: 1,
    exportedAt: "2026-08-10T10:00:00.000Z",
    settings, settingsModifiedAt, labelMeta, data, ...extra
  });
}

const recordPolicies = portableStateEntries().filter((entry) => entry.kind === "record-map");
check(
  recordPolicies.map((entry) => entry.key).join(",") === Object.values(STORE_KEYS).join(",") &&
    recordPolicies.every((entry) => entry.merge === "record-lww" && entry.export && entry.checkpoint),
  "N44 registry owns every current record map with merge/export/checkpoint policy"
);
check(
  portableStateEntries().some((entry) => entry.kind === "settings" && entry.vault.kind === "settings") &&
    portableStateEntries().some((entry) => entry.kind === "per-key-max" && entry.vault.kind === "per-key-max"),
  "N44 registry owns the Settings and label-recency Vault routes"
);

/* ---------- v2 export: logical Archive + portable singleton state ---------- */

const exportedInbox = inbox(ID(1), T0 + 1, "https://inbox.example");
const archiveBase = inbox(ID(2), T0 + 2, "https://archive-base.example", { archivedAt: T0 });
const archiveOverlay = inbox(ID(3), T0 + 3, "https://archive-overlay.example", { archivedAt: T0 });
await chrome.storage.local.set({
  [STORE_KEYS.inbox]: { [exportedInbox.id]: exportedInbox },
  [STORE_KEYS.archive]: { [archiveBase.id]: archiveBase },
  [ARCHIVE_OVERLAY_KEY]: { [archiveOverlay.id]: archiveOverlay },
  settings: { uiScheme: "everforest", perfHud: true, unknownOperational: "local" },
  settingsModifiedAt: T0 + 4,
  labelMeta: { work: T0 + 5 },
  sessionWindows: { 12: { sessionId: ID(9), windowIndex: 0 } },
  journal: [{ id: "operational" }], counters: { tabsSaved: 4 },
  snoozeDeliveryReceipts: { [ID(12)]: { phase: "effects" } }
});
const exported = JSON.parse(await buildPortableExport());
check(
  exported.app === "tabvault" && exported.exportVersion === PORTABLE_EXPORT_VERSION &&
    exported.schemaVersion === 1 && Array.isArray(exported.excludedKinds),
  "N44 export writes the compatible tabvault discriminator and independent v2 envelope"
);
check(
  exported.data.archive[archiveBase.id] && exported.data.archive[archiveOverlay.id] &&
    !(ARCHIVE_OVERLAY_KEY in exported.data),
  "N44 export folds the physical Archive overlay into one logical map"
);
check(
  exported.settings.uiScheme === "matcha" && !("perfHud" in exported.settings) &&
    !("unknownOperational" in exported.settings) && exported.settingsModifiedAt === T0 + 4 &&
    exported.labelMeta.work === T0 + 5 && !("journal" in exported) && !("counters" in exported) &&
    !("snoozeDeliveryReceipts" in exported),
  "N44 export normalizes settings and excludes operational receipts, Activity, and counters"
);

/* ---------- whole-file validation: every failure is before a write ---------- */

storage.setLog.splice(0);
await rejects(() => previewPortableRestore("{}"), /not an EveryTab JSON backup/i,
  "N44 validation rejects a non-EveryTab JSON file");
await rejects(() => previewPortableRestore(envelope({ exportVersion: 99 })), /newer EveryTab version/i,
  "N44 validation rejects a future envelope");
const mismatch = inbox(ID(4), T0 + 4, "https://mismatch.example");
await rejects(() => restorePortableState(envelope({
  data: { inbox: { [ID(5)]: mismatch } }
})), /must match its map key/i,
"N44 validation rejects a mismatched record id before commit");
await rejects(() => restorePortableState(envelope({
  data: { inbox: { [ID(4)]: { ...mismatch, schemaVersion: 99 } } }
})), /newer EveryTab version/i,
"N44 validation rejects one future-schema record instead of partially restoring other stores");
for (const invalidId of ["plain-id", "folder/item", "../escape"]) {
  const invalidRecord = inbox(invalidId, T0 + 4, "https://invalid-id.example");
  await rejects(() => restorePortableState(envelope({
    data: { inbox: { [invalidId]: invalidRecord } }
  })), /valid record id/i,
  `N44 validation rejects unsafe record identity ${JSON.stringify(invalidId)} before commit`);
}
const inboxPolicy = recordPolicies.find((entry) => entry.key === STORE_KEYS.inbox);
check(portableVaultFileName(inboxPolicy, ID(4)) === `${ID(4)}.json`,
  "N44 Vault filenames are generated from a validated UUID identity");
for (const unsafeId of ["plain-id", "folder/item", "../escape"]) {
  await rejects(async () => portableVaultFileName(inboxPolicy, unsafeId), /valid record id/i,
    `N44 Vault filename generation rejects ${JSON.stringify(unsafeId)}`);
}
const pollution = `{"app":"tabvault","exportVersion":2,"schemaVersion":1,"settings":{},"settingsModifiedAt":0,"labelMeta":{},"data":{"__proto__":{}}}`;
await rejects(() => restorePortableState(pollution), /reserved key/i,
  "N44 validation rejects prototype-pollution keys in structural maps");
check(storage.setLog.length === 0, "N44 planner errors produce no storage write");

const settingsRefreshTasks = dashboardTasksForStorage({
  settings: { oldValue: { uiScheme: "cream" }, newValue: { uiScheme: "ink" } }
});
check(
  settingsRefreshTasks.includes("settings") && settingsRefreshTasks.includes("focus") &&
    !settingsRefreshTasks.includes("open") && !settingsRefreshTasks.includes("archive"),
  "N44 a restored Settings write schedules the mounted Settings controller without broad list rerenders"
);

/* Labels are user text, not structural keys. These exact names must survive the
 * complete public Export -> Restore seam without becoming object prototypes. */
const reservedLabelText = `{"app":"tabvault","exportVersion":2,"schemaVersion":1,` +
  `"settings":{},"settingsModifiedAt":0,"labelMeta":{` +
  `"constructor":${T0 + 10},"prototype":${T0 + 11},"__proto__":${T0 + 12}},"data":{}}`;
await chrome.storage.local.set({ labelMeta: {} });
const reservedLabelPreview = await previewPortableRestore(reservedLabelText, {
  restoreSettings: false
});
const reservedLabelRestore = await restorePortableState(reservedLabelText, {
  restoreSettings: false,
  confirmationToken: reservedLabelPreview.confirmationToken
});
const reservedLabelExport = JSON.parse(await buildPortableExport());
check(
  reservedLabelRestore.status === "restored" &&
    Object.hasOwn(reservedLabelExport.labelMeta, "constructor") &&
    Object.hasOwn(reservedLabelExport.labelMeta, "prototype") &&
    Object.hasOwn(reservedLabelExport.labelMeta, "__proto__") &&
    reservedLabelExport.labelMeta.constructor === T0 + 10 &&
    reservedLabelExport.labelMeta.prototype === T0 + 11 &&
    reservedLabelExport.labelMeta.__proto__ === T0 + 12,
  "N44 user labels named constructor/prototype/__proto__ survive Export then Restore safely"
);

/* ---------- preview/commit P4 freshness contract ---------- */

const raceId = ID(5);
const raceIncoming = inbox(raceId, T0 + 500, "https://incoming-race.example");
const raceText = envelope({ data: { inbox: { [raceId]: raceIncoming } } });
await chrome.storage.local.set({
  ...Object.fromEntries(Object.values(STORE_KEYS).map((key) => [key, {}])),
  [ARCHIVE_OVERLAY_KEY]: {}, settings: {}, settingsModifiedAt: 0, labelMeta: {}, journal: []
});
const harmlessPreview = await previewPortableRestore(raceText, { restoreSettings: false });
check(!harmlessPreview.requiresConfirmation,
  "N44 preview can identify an add-only Restore that does not need P4 confirmation");
await chrome.storage.local.set({
  [STORE_KEYS.inbox]: { [raceId]: inbox(raceId, T0 + 100, "https://newly-arrived.example") }
});
storage.setLog.splice(0);
const escalated = await restorePortableState(raceText, { restoreSettings: false });
check(
  escalated.status === "confirmation-required" && escalated.summary.requiresConfirmation &&
    typeof escalated.summary.confirmationToken === "string" && storage.setLog.length === 0 &&
    storage.snapshot().inbox[raceId].tabs[0].url === "https://newly-arrived.example",
  "N44 lock-held replan never overwrites a newly arrived record without fresh confirmation"
);
const firstRiskToken = escalated.summary.confirmationToken;
await chrome.storage.local.set({
  [STORE_KEYS.inbox]: { [raceId]: inbox(raceId, T0 + 200, "https://newer-arrival.example") }
});
storage.setLog.splice(0);
const tokenWentStale = await restorePortableState(raceText, {
  restoreSettings: false, confirmationToken: firstRiskToken
});
check(
  tokenWentStale.status === "confirmation-required" &&
    tokenWentStale.summary.confirmationToken !== firstRiskToken && storage.setLog.length === 0 &&
    storage.snapshot().inbox[raceId].tabs[0].url === "https://newer-arrival.example",
  "N44 a confirmation token is bound to the exact fresh destructive plan"
);
const confirmedRace = await restorePortableState(raceText, {
  restoreSettings: false, confirmationToken: tokenWentStale.summary.confirmationToken
});
check(confirmedRace.status === "restored" &&
  storage.snapshot().inbox[raceId].tabs[0].url === "https://incoming-race.example",
  "N44 a freshly confirmed destructive plan commits once under the lock");

/* ---------- populated merge, settings policy, one commit, idempotency ---------- */

const localNewer = inbox(ID(6), T0 + 600, "https://local-newer.example");
const localOlder = inbox(ID(7), T0 + 100, "https://incoming-newer.example");
const incomingTie = { ...localNewer, tabs: [{ url: "https://must-not-win.example", title: "tie" }] };
const incomingNewer = { ...localOlder, tabs: [{ url: "https://did-win.example", title: "new" }], modifiedAt: T0 + 700 };
const incomingAdded = inbox(ID(8), T0 + 800, "https://added.example");
const incomingTombstone = { ...inbox(ID(9), T0 + 900, "https://deleted.example"), deletedAt: T0 + 900 };
const deletedLocallyId = crypto.randomUUID();
const localTombstone = { ...inbox(deletedLocallyId, T0 + 650, "https://deleted-locally.example"), deletedAt: T0 + 650 };
const incomingOlderLive = inbox(deletedLocallyId, T0 + 550, "https://must-stay-deleted.example");
const localArchiveOverlay = inbox(ID(10), T0 + 100, "https://archive-old.example", { archivedAt: T0 });
const incomingArchive = { ...localArchiveOverlay, modifiedAt: T0 + 1000,
  tabs: [{ url: "https://archive-restored.example", title: "archive" }] };
const localSession = session(ID(11), T0 + 100, "local-session");
const incomingSession = { ...localSession, name: "restored-session", modifiedAt: T0 + 1100 };

await chrome.storage.local.set({
  [STORE_KEYS.inbox]: {
    [localNewer.id]: localNewer, [localOlder.id]: localOlder,
    [localTombstone.id]: localTombstone
  },
  [STORE_KEYS.archive]: {},
  [ARCHIVE_OVERLAY_KEY]: { [localArchiveOverlay.id]: localArchiveOverlay },
  [STORE_KEYS.sessions]: { [localSession.id]: localSession },
  [STORE_KEYS.collections]: {}, [STORE_KEYS.snoozes]: {},
  [STORE_KEYS.smartviews]: {}, [STORE_KEYS.starred]: {},
  settings: { ...DEFAULT_SETTINGS, uiScheme: "cream", perfHud: true, localOnly: "keep" },
  settingsModifiedAt: T0,
  labelMeta: { work: 500, home: 100 },
  journal: []
});
const restoreText = envelope({
  data: {
    inbox: {
      [incomingTie.id]: incomingTie, [incomingNewer.id]: incomingNewer,
      [incomingAdded.id]: incomingAdded, [incomingTombstone.id]: incomingTombstone,
      [incomingOlderLive.id]: incomingOlderLive
    },
    archive: { [incomingArchive.id]: incomingArchive },
    sessions: { [incomingSession.id]: incomingSession }
  },
  settings: { ...DEFAULT_SETTINGS, uiScheme: "ink", perfHud: false, importedUnknown: "drop" },
  settingsModifiedAt: T0 - 1000,
  labelMeta: { work: 100, home: 300, orphan: 200 }
});
const preview = await previewPortableRestore(restoreText);
check(
  preview.records.added === 2 && preview.records.updated === 3 &&
    preview.records.keptIncoming === 2 && preview.labelMeta.advanced === 2 &&
    preview.settings.changed && preview.requiresConfirmation,
  "N44 preview reports deterministic add/update/keep, label-max, and settings outcomes"
);
storage.setLog.splice(0);
const restored = await restorePortableState(restoreText, {
  source: { name: "backup.json", size: restoreText.length, lastModified: T0 },
  confirmationToken: preview.confirmationToken
});
const afterRestore = storage.snapshot();
check(restored.status === "restored" && restored.checkpointId && restored.journalEntry,
  "N44 Restore returns one checkpoint-linked result and Activity entry");
check(
  storage.setLog.length === 1 && storage.setLog[0].includes(RESTORE_CHECKPOINT_KEY) &&
    storage.setLog[0].includes("journal") && storage.setLog[0].includes(ARCHIVE_OVERLAY_KEY) &&
    storage.setLog[0].includes(SESSION_IDENTITY_INDEX_KEY),
  "N44 Restore is one atomic commit including affected Archive fold, Session index, checkpoint, and Activity"
);
check(
  afterRestore.inbox[localNewer.id].tabs[0].url === "https://local-newer.example" &&
    afterRestore.inbox[localOlder.id].tabs[0].url === "https://did-win.example" &&
    afterRestore.inbox[incomingTombstone.id].deletedAt === T0 + 900 &&
    afterRestore.inbox[localTombstone.id].deletedAt === T0 + 650,
  "N44 record LWW keeps ties and newer tombstones local, accepts newer records, and carries incoming tombstones"
);
check(
  afterRestore.archive[incomingArchive.id].tabs[0].url === "https://archive-restored.example" &&
    Object.keys(afterRestore[ARCHIVE_OVERLAY_KEY]).length === 0 &&
    afterRestore.sessions[localSession.id].name === "restored-session" &&
    afterRestore[SESSION_IDENTITY_INDEX_KEY].sessionsById[localSession.id].name === "restored-session",
  "N44 commit folds an affected Archive and rebuilds the Session identity index"
);
check(
  afterRestore.settings.uiScheme === "ink" && afterRestore.settings.perfHud === true &&
    afterRestore.settings.localOnly === "keep" && !("importedUnknown" in afterRestore.settings) &&
    afterRestore.settingsModifiedAt > T0 && afterRestore.labelMeta.work === 500 &&
    afterRestore.labelMeta.home === 300 && afterRestore.labelMeta.orphan === 200,
  "N44 explicit settings Restore wins freshly without importing unknown state; label recency only moves forward"
);
const firstTimestamp = afterRestore.settingsModifiedAt;
const firstCheckpoint = afterRestore[RESTORE_CHECKPOINT_KEY];
check(
  Object.keys(firstCheckpoint.changes.records).sort().join(",") ===
    [STORE_KEYS.archive, STORE_KEYS.inbox, STORE_KEYS.sessions].sort().join(",") &&
    !firstCheckpoint.before && !firstCheckpoint.expected &&
    typeof firstCheckpoint.changes.records[STORE_KEYS.inbox][incomingAdded.id].expected.hash === "string" &&
    !("tabs" in firstCheckpoint.changes.records[STORE_KEYS.inbox][incomingAdded.id].expected),
  "N44 checkpoint stores exact affected pre-state plus compact post descriptors, not duplicate full maps"
);
storage.setLog.splice(0);
const repeated = await restorePortableState(restoreText);
check(
  repeated.status === "no-op" && storage.setLog.length === 0 &&
    storage.snapshot().settingsModifiedAt === firstTimestamp &&
    storage.snapshot()[RESTORE_CHECKPOINT_KEY].id === firstCheckpoint.id,
  "N44 repeated Restore is a complete no-op and does not restamp settings or replace Undo"
);

/* ---------- exact Undo through the ordinary journal ---------- */

storage.setLog.splice(0);
const undoneEntry = await undoAction(restored.journalEntry.id);
const afterUndo = storage.snapshot();
check(undoneEntry?.id === restored.journalEntry.id && storage.setLog.length === 1,
  "N44 journal Undo delegates to one atomic checkpoint restore");
check(
  afterUndo.inbox[localOlder.id].tabs[0].url === "https://incoming-newer.example" &&
    afterUndo.sessions[localSession.id].name === "local-session" &&
    afterUndo[ARCHIVE_OVERLAY_KEY][localArchiveOverlay.id] &&
    Object.keys(afterUndo.archive).length === 0,
  "N44 Undo restores exact record maps plus the physical Archive base and overlay"
);
check(
  afterUndo.settings.uiScheme === "cream" && afterUndo.settings.perfHud === true &&
    afterUndo.settings.localOnly === "keep" && afterUndo.settingsModifiedAt === T0 &&
    afterUndo.labelMeta.work === 500 && afterUndo.labelMeta.home === 100,
  "N44 Undo restores the exact pre-Restore Settings timestamp and label recency"
);

/* ---------- settings toggle, stale refusal, downloadable checkpoint ---------- */

const settingsOnly = envelope({ settings: { ...DEFAULT_SETTINGS, uiScheme: "phosphor" } });
storage.setLog.splice(0);
const disabled = await restorePortableState(settingsOnly, { restoreSettings: false });
check(disabled.status === "no-op" && storage.setLog.length === 0 && storage.snapshot().settings.uiScheme === "cream",
  "N44 Restore settings toggle leaves settings and timestamp untouched when off");

const staleIncoming = inbox(ID(12), T0 + 1200, "https://stale-checkpoint.example");
storage.setLog.splice(0);
const staleResult = await restorePortableState(envelope({
  data: { inbox: { [staleIncoming.id]: staleIncoming } }, settings: normalizePortableSettings(afterUndo.settings)
}));
check(
  storage.setLog.length === 1 && !storage.setLog[0].includes(STORE_KEYS.archive) &&
    !storage.setLog[0].includes(ARCHIVE_OVERLAY_KEY) &&
    !storage.setLog[0].includes(SESSION_IDENTITY_INDEX_KEY),
  "N44 an Inbox-only Restore leaves Archive and the Session projection untouched"
);
await upsertItem(STORE_KEYS.inbox, {
  ...storage.snapshot().inbox[staleIncoming.id], tabs: [{ url: "https://later-edit.example", title: "later" }]
});
const writesBeforeStaleUndo = storage.setLog.length;
const refused = await undoPortableRestore(staleResult.checkpointId);
check(
  refused.status === "stale" && refused.staleKeys.includes(STORE_KEYS.inbox) &&
    storage.setLog.length === writesBeforeStaleUndo + 1 &&
    storage.setLog.at(-1).join(",") === "journal" &&
    storage.snapshot().inbox[staleIncoming.id].tabs[0].url === "https://later-edit.example",
  "N44 stale-aware Undo overwrites no saved data and terminalizes its Activity entry"
);
const checkpointDownload = JSON.parse(await buildRestoreCheckpointExport(staleResult.checkpointId));
check(
  checkpointDownload.exportVersion === 2 && checkpointDownload.app === "tabvault" &&
    checkpointDownload.recovery?.kind === "affected-pre-restore" &&
    !checkpointDownload.data.inbox[staleIncoming.id],
  "N44 a refused Undo downloads an honestly labelled affected-state recovery backup"
);

/* ---------- terminal Restore entries never wedge global Undo ---------- */

const olderId = crypto.randomUUID();
const olderBefore = inbox(olderId, T0 + 1, "https://older-before.example");
const olderAfter = inbox(olderId, T0 + 2, "https://older-after.example");
await chrome.storage.local.set({
  ...Object.fromEntries(Object.values(STORE_KEYS).map((key) => [key, {}])),
  [STORE_KEYS.inbox]: { [olderId]: olderAfter },
  [ARCHIVE_OVERLAY_KEY]: {}, settings: {}, settingsModifiedAt: 0, labelMeta: {},
  journal: []
});
const olderAction = await recordAction("Older eligible action", {
  puts: [{ store: STORE_KEYS.inbox, item: olderBefore }]
});
const staleHeadId = crypto.randomUUID();
const staleHead = inbox(staleHeadId, T0 + 10, "https://stale-head.example");
const staleHeadResult = await restorePortableState(envelope({
  data: { inbox: { [staleHeadId]: staleHead } }
}), { restoreSettings: false });
await chrome.storage.local.set({
  [STORE_KEYS.inbox]: {
    ...storage.snapshot().inbox,
    [staleHeadId]: { ...staleHead, modifiedAt: T0 + 11,
      tabs: [{ url: "https://edited-after-restore.example", title: "later" }] }
  }
});
const advancedPastStale = await undoAction();
const staleJournal = await listActions();
check(
  advancedPastStale?.id === olderAction.id &&
    staleJournal.find((entry) => entry.id === staleHeadResult.journalEntry.id)?.restoreUndoStatus === "stale" &&
    storage.snapshot().inbox[olderId].tabs[0].url === "https://older-before.example",
  "N44 global Undo terminalizes a stale Restore and advances to the next eligible action"
);

await chrome.storage.local.set({
  ...Object.fromEntries(Object.values(STORE_KEYS).map((key) => [key, {}])),
  [STORE_KEYS.inbox]: { [olderId]: olderAfter },
  [ARCHIVE_OVERLAY_KEY]: {}, settings: {}, settingsModifiedAt: 0, labelMeta: {},
  journal: []
});
const supersededOlderAction = await recordAction("Older action behind superseded Restore", {
  puts: [{ store: STORE_KEYS.inbox, item: olderBefore }]
});
const restoreAId = crypto.randomUUID();
const restoreA = await restorePortableState(envelope({ data: {
  inbox: { [restoreAId]: inbox(restoreAId, T0 + 20, "https://restore-a.example") }
} }), { restoreSettings: false });
const restoreBId = crypto.randomUUID();
const restoreB = await restorePortableState(envelope({ data: {
  inbox: { [restoreBId]: inbox(restoreBId, T0 + 21, "https://restore-b.example") }
} }), { restoreSettings: false });
await undoAction(restoreB.journalEntry.id);
const advancedPastSuperseded = await undoAction();
const supersededJournal = await listActions();
check(
  advancedPastSuperseded?.id === supersededOlderAction.id &&
    supersededJournal.find((entry) => entry.id === restoreA.journalEntry.id)?.restoreUndoStatus === "unavailable",
  "N44 global Undo terminalizes a superseded Restore and advances to an older action"
);

/* ---------- legacy acceptance and large-profile planning ---------- */

const legacyItem = inbox(ID(13), T0 + 1300, "https://legacy.example");
const legacyText = JSON.stringify({
  app: "tabvault", schemaVersion: 1, exportedAt: "2026-07-01T00:00:00.000Z",
  settings: { uiScheme: "tide" }, data: { inbox: { [legacyItem.id]: legacyItem } }
});
const legacyPreview = await previewPortableRestore(legacyText);
check(legacyPreview.legacy && legacyPreview.settings.available && legacyPreview.labelMeta.incoming === 0,
  "N44 legacy exports remain valid without exportVersion, settings timestamp, or labelMeta");

const largeSessions = {};
for (let index = 0; index < 2000; index++) {
  const id = crypto.randomUUID();
  largeSessions[id] = session(id, T0 + index, `snapshot-${index}`, { auto: true });
}
const largeText = envelope({ data: { sessions: largeSessions } });
const started = performance.now();
const largePreview = await previewPortableRestore(largeText, { restoreSettings: false });
const elapsed = performance.now() - started;
check(
  largePreview.records.incoming === 2000 && elapsed < 1500,
  `N44 planner validates and previews 2,000 Snapshots within the focused budget (${elapsed.toFixed(1)}ms)`
);

/* ---------- bounded selective checkpoint on a mature profile ---------- */

const matureInbox = {};
for (let index = 0; index < 2000; index++) {
  const id = crypto.randomUUID();
  matureInbox[id] = inbox(id, T0 + index, `https://mature-${index}.example`);
}
const matureTargetId = Object.keys(matureInbox)[1000];
const matureIncoming = {
  ...matureInbox[matureTargetId], modifiedAt: T0 + 5000,
  tabs: [{ url: "https://mature-updated.example", title: "updated" }]
};
await chrome.storage.local.set({
  ...Object.fromEntries(Object.values(STORE_KEYS).map((key) => [key, {}])),
  [STORE_KEYS.inbox]: matureInbox, [ARCHIVE_OVERLAY_KEY]: {},
  settings: {}, settingsModifiedAt: 0, labelMeta: {}, journal: []
});
const matureText = envelope({ data: { inbox: { [matureTargetId]: matureIncoming } } });
const maturePlan = await previewPortableRestore(matureText, { restoreSettings: false });
const matureResult = await restorePortableState(matureText, {
  restoreSettings: false, confirmationToken: maturePlan.confirmationToken
});
const matureCheckpoint = storage.snapshot()[RESTORE_CHECKPOINT_KEY];
const matureCheckpointBytes = JSON.stringify(matureCheckpoint).length;
const matureProfileBytes = JSON.stringify(matureInbox).length;
check(
  matureResult.status === "restored" && matureCheckpoint.version >= 2 &&
    !matureCheckpoint.before?.records && matureCheckpointBytes < matureProfileBytes * 0.02,
  `N44 one-record Restore checkpoint stays bounded on 2,000 records (${matureCheckpointBytes}/${matureProfileBytes} chars)`
);
const unrelatedId = Object.keys(matureInbox)[1500];
await upsertItem(STORE_KEYS.inbox, {
  ...storage.snapshot().inbox[unrelatedId],
  tabs: [{ url: "https://unrelated-later-edit.example", title: "unrelated" }]
});
const selectiveUndo = await undoPortableRestore(matureResult.checkpointId);
check(
  selectiveUndo.status === "undone" &&
    storage.snapshot().inbox[matureTargetId].tabs[0].url === matureInbox[matureTargetId].tabs[0].url &&
    storage.snapshot().inbox[unrelatedId].tabs[0].url === "https://unrelated-later-edit.example",
  "N44 selective Undo restores affected exact state without erasing unrelated later edits"
);

/* ---------- byte-safe file boundary ---------- */

let oversizedTextCalled = false;
await rejects(() => readPortableRestoreFile({
  size: PORTABLE_EXPORT_MAX_BYTES + 1,
  text: async () => { oversizedTextCalled = true; return "{}"; }
}), /too large/i, "N44 rejects an oversized File before allocating file text");
check(!oversizedTextCalled, "N44 oversized File rejection happens before file.text()");
await rejects(async () => assertPortableRestoreTextSize("💾", { maxBytes: 3 }), /too large/i,
  "N44 parser fallback bounds UTF-8 bytes rather than JavaScript characters");

/* ---------- focus identity survives workflow rerenders ---------- */

const fakeBody = { isConnected: true };
const fakeDocument = { activeElement: fakeBody, body: fakeBody };
const oldAction = markRestoreFocus({
  dataset: {}, isConnected: true,
  focus() { fakeDocument.activeElement = this; }
}, "restore-action");
const actionHost = { contains: (node) => node === oldAction };
oldAction.focus();
const focusSnapshot = captureRestoreFocus(fakeDocument, [actionHost]);
oldAction.isConnected = false;
fakeDocument.activeElement = fakeBody;
const freshAction = markRestoreFocus({
  dataset: {}, isConnected: true,
  focus() { fakeDocument.activeElement = this; }
}, "restore-action");
restoreRestoreFocus({
  document: fakeDocument,
  snapshot: focusSnapshot,
  findIdentity: (identity) => identity === "restore-action" ? freshAction : null,
  fallback: null
});
check(fakeDocument.activeElement === freshAction,
  "N44 P4/result rerenders restore focus to the equivalent workflow control");
const staleUndoSnapshot = {
  active: oldAction,
  inside: true,
  identity: "restore-undo:old"
};
const recoveryAction = markRestoreFocus({
  dataset: {}, isConnected: true,
  focus() { fakeDocument.activeElement = this; }
}, "restore-recovery:new");
fakeDocument.activeElement = fakeBody;
restoreRestoreFocus({
  document: fakeDocument,
  snapshot: staleUndoSnapshot,
  findIdentity: () => null,
  fallback: recoveryAction
});
check(fakeDocument.activeElement === recoveryAction,
  "N44 stale Undo rerenders move focus to the available recovery action");

/* ---------- every registered record family survives an empty-profile round trip ---------- */

const familyIds = Array.from({ length: 8 }, () => crypto.randomUUID());
const familyCustom = createCustomSchemeRecord(
  createDefaultCustomSchemeDraft("Round-trip Harbor").value,
  meta(familyIds[7], T0 + 8)
).value;
const familyData = {
  [STORE_KEYS.inbox]: { [familyIds[0]]: inbox(familyIds[0], T0 + 1, "https://family-inbox.example") },
  [STORE_KEYS.archive]: { [familyIds[1]]: inbox(familyIds[1], T0 + 2,
    "https://family-archive.example", { archivedAt: T0 }) },
  [STORE_KEYS.sessions]: { [familyIds[2]]: session(familyIds[2], T0 + 3, "family-session") },
  [STORE_KEYS.collections]: { [familyIds[3]]: meta(familyIds[3], T0 + 4, {
    name: "Legacy collection", tabs: [{ url: "https://collection.example", title: "Collection" }], labels: []
  }) },
  [STORE_KEYS.snoozes]: { [familyIds[4]]: meta(familyIds[4], T0 + 5, {
    url: "https://snooze.example", title: "Snooze", dueAt: T0 + 50_000
  }) },
  [STORE_KEYS.smartviews]: { [familyIds[5]]: meta(familyIds[5], T0 + 6, {
    name: "Docs", field: "domain", pattern: "docs", scope: "all"
  }) },
  [STORE_KEYS.starred]: { [familyIds[6]]: meta(familyIds[6], T0 + 7, {
    url: "https://starred.example", title: "Starred", position: 0
  }) },
  [STORE_KEYS.customSchemes]: { [familyIds[7]]: familyCustom }
};
const familyCustomRef = customSchemeRef(familyIds[7]);
await chrome.storage.local.set({
  ...familyData,
  [ARCHIVE_OVERLAY_KEY]: {},
  settings: {
    ...DEFAULT_SETTINGS, uiScheme: familyCustomRef,
    schemeFavorites: ["tide", familyCustomRef],
    uiQuickTheme: false, uiEmphasis: "muted", dedupIgnoreQuery: true,
    snoozeWakeQuiet: true, popupDupHint: false
  },
  settingsModifiedAt: T0 + 20,
  labelMeta: { family: T0 + 21 }
});
const roundTripSource = await buildPortableExport();
await chrome.storage.local.set({
  ...Object.fromEntries(Object.values(STORE_KEYS).map((key) => [key, {}])),
  [ARCHIVE_OVERLAY_KEY]: {}, settings: {}, settingsModifiedAt: 0, labelMeta: {}
});
const roundTripPlan = await previewPortableRestore(roundTripSource);
const roundTripResult = await restorePortableState(roundTripSource, {
  confirmationToken: roundTripPlan.confirmationToken
});
const roundTripExport = JSON.parse(await buildPortableExport());
const sourceEnvelope = JSON.parse(roundTripSource);
check(
  roundTripResult.status === "restored" &&
    JSON.stringify(roundTripExport.data) === JSON.stringify(sourceEnvelope.data) &&
    JSON.stringify(roundTripExport.settings) === JSON.stringify(sourceEnvelope.settings) &&
    JSON.stringify(roundTripExport.labelMeta) === JSON.stringify(sourceEnvelope.labelMeta) &&
    roundTripExport.data.customSchemes[familyIds[7]].name === "Round-trip Harbor" &&
    roundTripExport.settings.uiScheme === familyCustomRef &&
    roundTripExport.settings.uiQuickTheme === false &&
    roundTripExport.settings.uiEmphasis === "muted" &&
    roundTripExport.settings.dedupIgnoreQuery === true &&
    roundTripExport.settings.snoozeWakeQuiet === true &&
    roundTripExport.settings.popupDupHint === false,
  "N44 empty-profile Export then Restore recreates every registered logical record map, ordinary setting, and label date"
);

const { readFileSync } = await import("node:fs");
const panelSource = readFileSync(new URL("../js/ui/restore-panel.js", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
const dataSurfaceSource = readFileSync(new URL("../js/ui/data-surface.js", import.meta.url), "utf8");
const activitySource = readFileSync(new URL("../js/ui/activity-surface.js", import.meta.url), "utf8");
check(
  /previewPortableRestore/.test(panelSource) && /restoreSettings\.checked = true/.test(panelSource) &&
    /confirmationToken/.test(panelSource) && /status === "confirmation-required"/.test(panelSource) &&
    /armTimeoutMs = 4000/.test(panelSource) && /showLoadingFeedback/.test(panelSource) &&
    /yieldForRestoreValidation/.test(panelSource) && /readPortableRestoreFile/.test(panelSource) &&
    /undoPortableRestore/.test(panelSource) && /buildRestoreCheckpointExport/.test(panelSource),
  "N44 Data-route adapter includes byte bounds, fresh P4 confirmation, result, stale Undo, and recovery download"
);
check(
  /restoreUndoStatus/.test(activitySource) && /buildRestoreCheckpointExport/.test(activitySource) &&
    /focusEntry/.test(activitySource) && /could not be prepared/.test(activitySource) &&
    /showNotice/.test(activitySource),
  "N44 Activity reports terminal Restore Undo state, handles recovery failure, and preserves focus"
);
check(
  /createRestorePanel/.test(dataSurfaceSource) &&
    /import\("\.\/data-surface\.js"\)/.test(dashboardSource) &&
    !/importJson\(await file\.text\(\)\)/.test(dataSurfaceSource),
  "N44 Dashboard delegates backup Restore to the deep module through one bounded UI adapter"
);

if (failures > 0) {
  console.error(`\n${failures} portable-state test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll portable-state tests passed");
