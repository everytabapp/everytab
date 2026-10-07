/** Search-only storage reads must preserve full-read semantics without poisoning edits. */
import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, LIBRARY_STORES, RECOVERY_SCHEMA, RECOVERY_STORES } from "../js/lib/storage/schema.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";

const browser = createInterleavableStorage({ deviceId: "search-parity" });
const openTabs = [
  { id: 11, windowId: 1, url: "https://shared.example/", title: "Needle open", incognito: false },
  { id: 12, windowId: 1, url: "https://private.example/", title: "Needle private", incognito: true },
  { id: 13, windowId: 1, url: "chrome://settings/", title: "Needle settings" }
];
globalThis.chrome = {
  runtime: { getURL: value => `chrome-extension://search-parity/${value}` },
  storage: { local: browser.local, onChanged: browser.onChanged },
  tabs: { query: async () => structuredClone(openTabs) },
  history: { search: async () => [
    { title: "Needle duplicate history", url: "https://shared.example/", lastVisitTime: 700 },
    { title: "Needle history", url: "https://history.example/", lastVisitTime: 600 }
  ] }
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true, value: { locks: createMockLockManager() }
});
const { setStorageAuthorityForTests } = await import("../js/lib/storage/authority-runtime.js");
const { STORE_KEYS } = await import("../js/lib/types.js");
const { SESSION_IDENTITY_INDEX_KEY } = await import("../js/lib/session-identity-index.js");
const { organizationMembershipId } = await import("../js/lib/organization.js");
const { listItems, listSearchItems, mutateStores } = await import("../js/lib/store.js");
const { SEARCH_STORE_KEYS, createSearchSnapshot, buildSearchSnapshot, buildPrimarySearchSnapshot,
  createSearchSession, matchSearchSnapshot, resolveScopeFromSnapshot,
  resolveSearchFiltersFromSnapshot } = await import("../js/lib/search.js");

function storageHarness(schema, assetStore) {
  const base = createMemoryIndexedDbAdapter(schema);
  const reads = { assets: 0 };
  return { reads, adapter: { ...base,
    transaction: (names, mode, work) => base.transaction(names, mode, tx => work({ ...tx,
      get: (store, key) => {
        if (store === assetStore) reads.assets++;
        return tx.get(store, key);
      }
    }))
  } };
}
const libraryHarness = storageHarness(LIBRARY_SCHEMA, LIBRARY_STORES.assets);
const recoveryHarness = storageHarness(RECOVERY_SCHEMA, RECOVERY_STORES.assets);
const library = createLibraryStore({ adapter: libraryHarness.adapter, deviceId: "search-parity", now: () => 10_000 });
const recovery = createRecoveryStore({ adapter: recoveryHarness.adapter, now: () => 9_000 });
const authority = createStorageAuthority({ library, recovery, readBrowserLocal: keys => browser.local.get(keys) });
setStorageAuthorityForTests(authority);

const favicon = `data:image/png;base64,${Buffer.from("synthetic-parity").toString("base64")}`;
const alternateFavicon = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";
const ref = (name, extra = {}) => ({ url: `https://${name}.example/`, title: `Needle ${name}`,
  favIconUrl: favicon, pinned: true, groupIndex: 0, ...extra });
const meta = (id, extra = {}) => ({ id, deviceId: "search-parity", schemaVersion: 1,
  createdAt: 100, modifiedAt: 500, ...extra });
const groupId = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const labelGroup = groupId(1), sessionGroup = groupId(2);
const namedId = "a-legacy-session";
const records = {
  [STORE_KEYS.starred]: [meta("star", { ...ref("starred"), position: 2 }),
    meta("shared-star", { ...ref("shared", { title: "Needle shared star" }) })],
  [STORE_KEYS.inbox]: [
    meta("a-inbox-legacy", { kind: "window", tabs: [ref("inbox-first", { labels: ["tab-label", "shared-label"] }),
      ref("inbox-second", { favIconUrl: alternateFavicon, labels: [] })], labels: ["item-label", "shared-label"] }),
    meta("b-inbox-new", { modifiedAt: 900, tabs: [ref("inbox-new")], labels: ["new-label"] })
  ],
  [STORE_KEYS.snoozes]: [
    meta("scalar-snooze", { ...ref("scalar-snooze", { title: "" }), dueAt: 15_000 }),
    meta("window-snooze", { url: "", title: "Window", tabs: [ref("snooze-first"), ref("snooze-second")], dueAt: 16_000 })
  ],
  [STORE_KEYS.archive]: [meta("archived", { tabs: [ref("archive", { labels: ["tab-label"] })], labels: ["archive-label"] })],
  [STORE_KEYS.collections]: [meta("collection", { name: "Needle collection name",
    tabs: [ref("collection", { favIconUrl: "https://icons.example/remote.png" })], labels: [] })],
  [STORE_KEYS.sessions]: [
    meta(namedId, { name: "Needle named bundle", auto: false, windows: [[ref("named-first", { labels: ["named-label"] }),
      ref("named-second", { favIconUrl: alternateFavicon })], [ref("named-third")]], labels: ["session-level-unused"],
      groups: [[{ title: "Saved group", color: "blue", collapsed: true }], []] }),
    meta("b-new-session", { name: "Needle second bundle", auto: false, modifiedAt: 800,
      windows: [[ref("new-session")]], labels: [] })
  ],
  [STORE_KEYS.organizationGroups]: [meta(labelGroup, { organizationKind: "label", name: "Needle label group" }),
    meta(sessionGroup, { organizationKind: "session", name: "Needle session group" })],
  [STORE_KEYS.organizationMemberships]: []
};
delete records.inbox[0].modifiedAt;
delete records.sessions[0].modifiedAt;
for (const [kind, memberKey, id] of [["label", "item-label", labelGroup], ["label", "orphan-label", labelGroup],
  ["session", namedId, sessionGroup], ["session", "snapshot-old", sessionGroup]]) {
  records.organizationMemberships.push(meta(organizationMembershipId(kind, memberKey, id), {
    organizationKind: kind, memberKey, groupId: id
  }));
}

// Full-read references deliberately bypass the new projection and its cache.
function fullData(maps, { primary = false, transient = false } = {}) {
  const items = (key, fresh = false) => Object.values(maps[key] ?? {}).filter(item => !item.deletedAt)
    .sort(fresh ? (a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) : (a, b) => b.modifiedAt - a.modifiedAt);
  return { openTabs: structuredClone(openTabs), starred: items("starred"), inbox: items("inbox"),
    snoozes: items("snoozes"), archive: items("archive"), collections: items("collections"),
    organizationGroups: items("organizationGroups"), organizationMemberships: items("organizationMemberships"),
    ...(primary ? { sessionIdentities: Object.values(maps[SESSION_IDENTITY_INDEX_KEY].sessionsById) }
      : { sessions: items("sessions", transient) }) };
}
const sessions = [];
try {
  await library.transact(Object.entries(records).flatMap(([family, values]) => values.map(value =>
    ({ type: "put", family, id: value.id, value }))));
  await library.transact([{ type: "put", family: "inbox", id: "deleted-inbox",
    value: meta("deleted-inbox", { tabs: [ref("deleted")], labels: ["deleted-label"] }) }]);
  await library.transact([{ type: "delete", family: "inbox", id: "deleted-inbox" }]);
  await recovery.captureSnapshot(meta("snapshot-old", { auto: true, name: "Automatic old", createdAt: 200,
    modifiedAt: 200, windows: [[ref("snapshot-first", { labels: ["snapshot-label"] }), ref("snapshot-second")]] }));
  const legacySnapshot = meta("snapshot-legacy", { auto: true, name: "Automatic legacy", createdAt: 300,
    windows: [[ref("snapshot-legacy", { favIconUrl: alternateFavicon })]] });
  delete legacySnapshot.modifiedAt;
  await recovery.captureSnapshot(legacySnapshot);
  await recovery.captureSnapshot(meta("snapshot-deleted", { auto: true, windows: [[ref("snapshot-deleted")]] }));
  await recovery.deleteSnapshot("snapshot-deleted");
  await authority.commitLibraryRevision(["sessions"]);
  const full = await authority.readMaps([...SEARCH_STORE_KEYS, SESSION_IDENTITY_INDEX_KEY]);
  assert(libraryHarness.reads.assets > 0 && recoveryHarness.reads.assets > 0,
    "full-read reference must exercise both asset-store read paths");
  const reference = createSearchSnapshot(fullData(full));
  const primaryReference = createSearchSnapshot(fullData(full, { primary: true }));
  const transientReference = createSearchSnapshot(fullData(full, { transient: true }));
  assert.notDeepEqual(reference.sources.sessions, transientReference.sources.sessions,
    "legacy timestamp fixture must distinguish normal and transient Session ordering");
  assert.deepEqual(reference.sources.inbox[0].labels, ["item-label", "shared-label", "tab-label"]);
  assert(reference.sources.snoozed.some(item => item.result.title === "https://scalar-snooze.example/"));
  assert.deepEqual(reference.organizationEntities.map(item => [item.organizationKind, item.memberCount]),
    [["label", 1], ["session", 1]], "orphan labels and automatic Snapshots are not group members");
  assert(!reference.labelCounts.some(item => ["snapshot-label", "deleted-label", "session-level-unused"].includes(item.label)));
  assert(reference.sources.sessions.findIndex(item => item.result.snapshot) >= 4,
    "named Session tabs precede automatic Snapshot tabs");

  libraryHarness.reads.assets = recoveryHarness.reads.assets = 0;
  const projected = await buildSearchSnapshot();
  const projectedPrimary = await buildPrimarySearchSnapshot();
  assert.deepEqual(projected, reference, "complete source order, candidates, labels, domains and entities match full reads");
  assert.deepEqual(projectedPrimary, primaryReference, "primary identities and ordinary sources match full reads");
  for (const [query, options] of [["needle", {}], ["n", {}], ["not-found", {}],
    ["", { scope: { type: "in", value: "inbox" } }], ["needle", { labels: ["item-label", "tab-label"] }],
    ["needle", { scope: { type: "domain", value: "inbox-first.example" } }],
    ["needle", { scope: { type: "session", value: "Needle named bundle" } }],
    ["needle", { includeHistory: true }], ["needle", { scope: { type: "in", value: "history" }, includeHistory: true }]]) {
    assert.deepEqual(await matchSearchSnapshot(projected, query, options), await matchSearchSnapshot(reference, query, options));
  }
  const progressiveSession = createSearchSession(); sessions.push(progressiveSession);
  const progressive = await progressiveSession.searchProgressively("needle");
  assert.deepEqual(progressive.results, await matchSearchSnapshot(primaryReference, "needle"));
  assert(progressive.complete, "Session tab completion is exercised");
  assert.deepEqual(await progressive.complete, await matchSearchSnapshot(transientReference, "needle"),
    "actual transient completion preserves its historical missing-timestamp ordering");
  assert.deepEqual(await progressiveSession.labelCounts(), transientReference.labelCounts);
  assert.deepEqual(await progressiveSession.scopeNames("session"), transientReference.sessionNames);
  assert.deepEqual(await progressiveSession.scopeNames("domain"), transientReference.domainCounts.map(item => item.domain));
  for (const raw of ["session:Needle named bundle needle", "domain:inbox-first.example needle", "label:item-label needle"]) {
    assert.deepEqual(await progressiveSession.resolveScope(raw), resolveScopeFromSnapshot(raw, transientReference));
    assert.deepEqual(await progressiveSession.resolveFilters(raw), resolveSearchFiltersFromSnapshot(raw, transientReference));
  }
  assert.equal(libraryHarness.reads.assets, 0, "Search builders and facets never fetch Library favicon payloads");
  assert.equal(recoveryHarness.reads.assets, 0, "transient Search never fetches Recovery favicon payloads");

  for (const key of SEARCH_STORE_KEYS) {
    const expected = Object.values(full[key]).filter(item => !item.deletedAt).sort((a, b) => b.modifiedAt - a.modifiedAt);
    assert.deepEqual(await listItems(key), expected, `${key}: projected Search cache cannot supply a full read`);
    const detached = await listSearchItems(key);
    assert(!JSON.stringify(detached).includes("favIconUrl"), `${key}: projection omits remote and embedded favicon fields`);
  }
  await mutateStores(["inbox", "snoozes", "sessions"], maps => {
    for (const key of ["inbox", "snoozes", "sessions"]) assert.deepEqual(maps[key], full[key], `${key}: edit receives full payload`);
    return { inbox: { ...maps.inbox, "a-inbox-legacy": { ...maps.inbox["a-inbox-legacy"], labels: ["edited-label"] } },
      snoozes: { ...maps.snoozes, "scalar-snooze": { ...maps.snoozes["scalar-snooze"], dueAt: 20_000 } },
      sessions: { ...maps.sessions, [namedId]: { ...maps.sessions[namedId], name: "Edited named bundle" } } };
  });
  const after = await authority.readMaps([...SEARCH_STORE_KEYS, SESSION_IDENTITY_INDEX_KEY]);
  assert.deepEqual(after.inbox["a-inbox-legacy"], { ...full.inbox["a-inbox-legacy"], labels: ["edited-label"] });
  assert.deepEqual(after.snoozes["scalar-snooze"], { ...full.snoozes["scalar-snooze"], dueAt: 20_000 });
  assert.deepEqual(after.sessions[namedId], { ...full.sessions[namedId], name: "Edited named bundle" });
  assert.deepEqual(after.sessions["snapshot-old"], full.sessions["snapshot-old"], "named edit leaves full automatic Snapshot untouched");
  assert.deepEqual(await buildSearchSnapshot(), createSearchSnapshot(fullData(after)), "committed edits invalidate projected reads");
  console.log("PASS: projected Search matches full-read snapshots, progressive results, facets and legacy ordering; later edits retain full payloads");
} finally {
  for (const session of sessions) session.invalidate();
  setStorageAuthorityForTests(null);
  await library.close();
  await recovery.close();
}
