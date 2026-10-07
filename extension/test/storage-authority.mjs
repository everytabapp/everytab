/** Logical authority tests: map compatibility over split physical stores. */
import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import {
  createStorageAuthority, mapFromLibraryEntities, planLibraryFamilyChanges
} from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import {
  expandStorageChanges, STORAGE_REVISION_KEY
} from "../js/lib/storage/constants.js";
import {
  SESSION_IDENTITY_INDEX_KEY, SESSION_NAVIGATION_REVISION_KEY
} from "../js/lib/session-identity-index.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createMockLockManager } from "./e2-mocks.mjs";

let incompleteAdapterEffects = 0;
const unusedCapability = () => { incompleteAdapterEffects += 1; };
const authorityLibraryAdapter = {
  readEntity: unusedCapability,
  readFamily: unusedCapability,
  commit: unusedCapability,
  readLocal: unusedCapability
};
const authorityRecoveryAdapter = {
  listSnapshots: unusedCapability,
  captureSnapshot: unusedCapability,
  deleteSnapshot: unusedCapability,
  readDeletionMarkers: unusedCapability,
  readReplicationState: unusedCapability
};
assert.throws(() => createStorageAuthority({
  library: { ...authorityLibraryAdapter, readEntity: undefined },
  recovery: authorityRecoveryAdapter
}), /Library and Recovery stores are required/,
"the authority rejects a Library without one-record reads");
assert.throws(() => createStorageAuthority({
  library: authorityLibraryAdapter,
  recovery: { ...authorityRecoveryAdapter, readReplicationState: undefined }
}), /Library and Recovery stores are required/,
"the authority rejects Recovery without its bounded replication read");
assert.equal(incompleteAdapterEffects, 0,
"authority capability rejection precedes every database effect");

let now = 10_000;
const library = createLibraryStore({
  adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: "authority-device",
  now: () => now
});
const recovery = createRecoveryStore({
  adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA),
  now: () => now,
  createId: () => "generated-snapshot"
});
await library.transact([
  {
    type: "put", family: "inbox", id: "kept",
    value: {
      id: "kept", deviceId: "old", createdAt: 1, modifiedAt: 2, schemaVersion: 1,
      kind: "tab", tabs: [{ url: "https://kept.example", title: "Kept" }],
      source: "manual", labels: []
    }
  },
  { type: "delete", family: "inbox", id: "gone" },
  {
    type: "put", family: "settings", id: "current",
    value: { value: { uiScheme: "ink" }, modifiedAt: 50 }
  },
  {
    type: "put", family: "labelMeta", id: "current",
    value: { value: { work: 8 } }
  },
  {
    type: "put", family: "sessions", id: "named-one",
    value: {
      id: "named-one", deviceId: "old", createdAt: 3, modifiedAt: 4, schemaVersion: 1,
      name: "Named", auto: false, windows: [[]], labels: []
    }
  }
]);
await recovery.captureSnapshot({
  id: "snapshot-one", deviceId: "old", createdAt: 3, modifiedAt: 4, schemaVersion: 1,
  name: "Snapshot", auto: true,
  windows: [[{ url: "https://recovery.example", title: "Recovery" }]], labels: []
}, { id: "snapshot-one", capturedAt: 4, retention: 2 });

const authority = createStorageAuthority({
  library,
  recovery,
  snapshotRetention: 2,
  readBrowserLocal: async (keys) => Object.fromEntries(
    keys.flatMap((key) => key === "journal"
      ? [[key, { entries: ["legacy"] }]]
      : key === "duplicateDomainRules"
        ? [[key, [{ hostname: "tickets.authority", mode: "include-fragment" }]]]
        : [])
  )
});
const initial = await authority.readMaps([
  "inbox", "sessions", "namedSessionRecords", "settings", "settingsModifiedAt",
  "labelMeta", "journal"
]);
assert.equal(initial.inbox.kept.tabs[0].url, "https://kept.example");
assert.equal(initial.inbox.gone.deletedAt, 10_000,
  "compact deletions expose the legacy map lifecycle without retaining payload");
assert.equal(initial.sessions["snapshot-one"].auto, true);
assert.equal(initial.namedSessionRecords["named-one"].name, "Named");
assert.equal(initial.namedSessionRecords["snapshot-one"], undefined,
  "the named-Session fast path never opens Recovery");
assert.equal((await authority.readItem("sessions", "named-one")).name, "Named",
  "one named Session can be read without materializing its family");
assert.equal(await authority.readItem("sessions", "snapshot-one"), null,
  "the one-record Session path cannot open automatic Snapshot recovery data");
assert.deepEqual(initial.settings, { uiScheme: "ink" });
assert.equal(initial.settingsModifiedAt, 50);
assert.deepEqual(initial.labelMeta, { work: 8 });
assert.deepEqual(initial.journal, { entries: ["legacy"] });

const unchanged = planLibraryFamilyChanges("inbox", initial.inbox, initial.inbox);
assert.deepEqual(unchanged, []);
const nextInbox = structuredClone(initial.inbox);
nextInbox.kept.labels = ["work"];
nextInbox.added = {
  id: "added", deviceId: "authority-device", createdAt: 11, modifiedAt: 11,
  schemaVersion: 1, kind: "tab", tabs: [], source: "manual", labels: []
};
assert.deepEqual(
  planLibraryFamilyChanges("inbox", initial.inbox, nextInbox).map(({ type, id }) => ({ type, id })),
  [{ type: "put", id: "kept" }, { type: "put", id: "added" }]
);

const nextSessions = structuredClone(initial.sessions);
nextSessions["snapshot-two"] = {
  id: "snapshot-two", deviceId: "authority-device", createdAt: 12, modifiedAt: 12,
  schemaVersion: 1, name: "Snapshot", auto: true,
  windows: [[{ url: "https://two.example", title: "Two" }]], labels: []
};
delete nextSessions["snapshot-one"];
const nextNamed = structuredClone(initial.namedSessionRecords);
nextNamed["named-one"].name = "Renamed";
nextSessions["named-one"].name = "Renamed";
const committed = await authority.commitMaps({
  inbox: nextInbox,
  sessions: nextSessions,
  settings: { uiScheme: "aladdin" },
  settingsModifiedAt: 60,
  labelMeta: { work: 9 },
  journal: { entries: ["v2"] },
  namedSessionRecords: nextNamed
});
assert.equal(committed.changed, true);
assert.equal(committed.recoveryCaptures, 1);
assert.equal(committed.recoveryDeletes, 1);
assert.equal(committed.entityOperations, 5,
  "a full Session map and its named projection plan one named-Session write");
assert.deepEqual(committed.logicalChanges.settings, {
  oldValue: { uiScheme: "ink" },
  newValue: { uiScheme: "aladdin" }
});
assert.deepEqual(committed.logicalChanges[SESSION_NAVIGATION_REVISION_KEY], {
  newValue: {
    namedSessions: [{
      id: "named-one", name: "Renamed", tabCount: 0, modifiedAt: 4
    }],
    snapshotCount: 1
  }
}, "Session commits publish bounded navigation data without tab records");
assert.ok(JSON.stringify(committed.revision).length < 1_500,
  "the cross-context revision stays bounded independently of Session contents");
assert.equal((await authority.readPendingRevision()).id, committed.revision.id,
  "the exact revision is durable beside the authoritative commit");
assert.deepEqual(expandStorageChanges({
  [STORAGE_REVISION_KEY]: {
    newValue: {
      changedKeys: ["settings", SESSION_NAVIGATION_REVISION_KEY, "journal"],
      logicalChanges: committed.logicalChanges
    }
  }
}), {
  [STORAGE_REVISION_KEY]: {
    newValue: {
      changedKeys: ["settings", SESSION_NAVIGATION_REVISION_KEY, "journal"],
      logicalChanges: committed.logicalChanges
    }
  },
  settings: committed.logicalChanges.settings,
  [SESSION_NAVIGATION_REVISION_KEY]:
    committed.logicalChanges[SESSION_NAVIGATION_REVISION_KEY],
  journal: {}
});
assert.deepEqual((await authority.readMaps(["inbox"])).inbox.kept.labels, ["work"]);
assert.ok((await authority.readMaps(["sessions"])).sessions["snapshot-one"].deletedAt);
assert.equal(await recovery.readSnapshot("snapshot-one"), null);
assert.equal((await authority.readMaps(["sessions"])).sessions["snapshot-two"].auto, true);
assert.equal((await authority.readMaps(["namedSessionRecords"]))
  .namedSessionRecords["named-one"].name, "Renamed");
assert.deepEqual(await library.readLocal(["journal"]), { journal: { entries: ["v2"] } });
assert.equal((await authority.readMaps(["settings"])).settings.uiScheme, "aladdin");

const overlayId = "archive-overlay";
const overlayRecord = {
  id: overlayId, deviceId: "authority-device", createdAt: 70, modifiedAt: 70,
  schemaVersion: 1, kind: "tab", source: "manual", archivedAt: 70, labels: ["work"],
  tabs: [{ url: "https://overlay.example", title: "Overlay" }]
};
await authority.commitMaps({ archiveOverlay: { [overlayId]: overlayRecord } });
assert.equal((await authority.readMaps(["archive"])).archive[overlayId].tabs[0].url,
  "https://overlay.example",
"a legacy small Archive-overlay commit becomes a real Library Archive entity");

await assert.rejects(() => authority.commitMaps({
  sessions: nextSessions,
  namedSessionRecords: {
    ...nextNamed,
    "named-one": { ...nextNamed["named-one"], name: "Conflicting name" }
  }
}), /projection disagree/,
"the authority boundary rejects inconsistent duplicate Session representations");

await library.transact([{
  type: "put", family: "sessions", id: "remote-session",
  value: {
    id: "remote-session", deviceId: "remote", createdAt: 80, modifiedAt: 81,
    schemaVersion: 1, name: "Remote", auto: false,
    windows: [[{ url: "https://remote.example", title: "Remote" }]], labels: []
  }
}]);
const remoteRevision = await authority.commitRemoteRevision(["sessions"]);
assert.ok(remoteRevision.changedKeys.includes(SESSION_IDENTITY_INDEX_KEY) &&
  remoteRevision.changedKeys.includes(SESSION_NAVIGATION_REVISION_KEY),
"a remote Session merge republishes both bounded navigation read models");
assert.deepEqual(
  remoteRevision.logicalChanges[SESSION_NAVIGATION_REVISION_KEY].newValue.namedSessions
    .find(({ id }) => id === "remote-session"),
  { id: "remote-session", name: "Remote", tabCount: 1, modifiedAt: 81 },
  "remote Session navigation is rebuilt from authoritative post-merge data"
);
assert.equal((await library.readLocal([SESSION_IDENTITY_INDEX_KEY]))
  [SESSION_IDENTITY_INDEX_KEY].sessionsById["remote-session"].name, "Remote",
"the compact Session identity index is updated before the remote revision is visible");

const entities = await library.readFamily("inbox", { includeDeleted: true });
assert.equal(mapFromLibraryEntities(entities).gone.tabs, undefined,
  "the compatibility view cannot resurrect deleted record payload");

// Exercise the real split authority for the one-time local-array to portable-
// family migration. The legacy bytes come from browser-local fallback, while
// the rule record must land in the Library and the marker in Library local.
const storageListeners = new Set();
globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://authority/${path}` },
  storage: {
    local: {
      get: async (keys) => {
        const list = typeof keys === "string" ? [keys] : keys;
        return Object.fromEntries(list.flatMap((key) =>
          key === "deviceId" ? [[key, "authority-device"]] : []));
      },
      set: async () => {}
    },
    onChanged: {
      addListener: (listener) => storageListeners.add(listener),
      removeListener: (listener) => storageListeners.delete(listener)
    }
  }
};
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true, writable: true
});
const { setStorageAuthorityForTests } = await import("../js/lib/storage/authority-runtime.js");
setStorageAuthorityForTests(authority);
const {
  DUPLICATE_DOMAIN_RULES_MIGRATION_KEY,
  readDuplicateDomainRules
} = await import("../js/lib/duplicate-domain-rules.js");
assert.deepEqual(await readDuplicateDomainRules(), [
  { hostname: "tickets.authority", mode: "include-fragment" }
], "the production authority migrates a legacy exact-host rule without changing behavior");
const portableSettings = (await library.readEntity("settings", "current")).value.value;
assert.equal(portableSettings.uiScheme, "aladdin",
  "migration preserves existing portable Settings fields");
assert.deepEqual(portableSettings.duplicateDomainRules,
  [{ hostname: "tickets.authority", mode: "include-fragment" }],
  "the migrated rule is stored in the rolling-compatible portable Settings entity");
assert.equal((await library.readLocal([DUPLICATE_DOMAIN_RULES_MIGRATION_KEY]))
  [DUPLICATE_DOMAIN_RULES_MIGRATION_KEY].version, 1,
"the production authority stores the migration marker outside the portable family");
assert.deepEqual((await authority.readMaps(["duplicateDomainRules"])).duplicateDomainRules,
  [{ hostname: "tickets.authority", mode: "include-fragment" }],
"the retired local source remains available as recovery data after migration");

console.log("PASS: storage logical authority adapter");
