/** Session aliases share one physical read per call, never mutable results or later reads. */
import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { NAMED_SESSION_RECORDS_KEY as NAMED } from "../js/lib/session-identity-index.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

const library = createLibraryStore({ adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
  deviceId: "sharing-fixture", now: () => 1_000 });
const recovery = createRecoveryStore({ adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA), now: () => 2_000 });
const calls = { family: [], snapshots: [], markers: 0 };
let beforeFamilyRead = async () => {};
const authority = createStorageAuthority({
  library: { ...library, async readFamily(family, options) {
    calls.family.push({ family, ...options });
    await beforeFamilyRead(family, options);
    return library.readFamily(family, options);
  } },
  recovery: { ...recovery,
    listSnapshots(options) { calls.snapshots.push(options); return recovery.listSnapshots(options); },
    readDeletionMarkers() { calls.markers++; return recovery.readDeletionMarkers(); }
  },
  readBrowserLocal: async () => ({ fixtureLocal: { value: "browser fallback" } })
});
function resetCalls() { calls.family.length = 0; calls.snapshots.length = 0; calls.markers = 0; }
function checkCalls(includeFavicons, withRecovery) {
  assert.equal(calls.family.length, 1, "Session aliases must share exactly one Library family read per call");
  assert.deepEqual(calls.family, [{ family: "sessions", includeDeleted: true, includeFavicons }]);
  assert.deepEqual(calls.snapshots, withRecovery ? [{ limit: 10_000, includeFavicons }] : []);
  assert.equal(calls.markers, withRecovery ? 1 : 0);
}
const record = (id, extra = {}) => ({ id, deviceId: "fixture", schemaVersion: 1,
  createdAt: 100, modifiedAt: 200, name: `Saved ${id}`, auto: false,
  windows: [[{ title: "First tab", url: "https://fixture.invalid/first", pinned: true,
    labels: ["nested-label"], favIconUrl: "data:image/png;base64,Zml4dHVyZQ==" }],
  [{ title: "Second tab", url: "https://fixture.invalid/second", groupIndex: 0,
    favIconUrl: "https://fixture.invalid/favicon.png" }]],
  groups: [[], [{ title: "Group", color: "blue", collapsed: false }]],
  labels: ["record-label"], organization: { fixture: ["metadata"] }, ...extra });
const named = record("named");
delete named.modifiedAt; // Legacy timestamp absence is observable metadata.
const markerShadow = record("marker-shadow");
const snapshotShadow = record("snapshot-shadow");
const snapshot = record("snapshot", { auto: true });
const overridingSnapshot = record("snapshot-shadow", { auto: true, name: "Recovery wins" });
const marker = id => ({ id, deviceId: "fixture", schemaVersion: 1, auto: true,
  createdAt: 300, modifiedAt: 300, deletedAt: 300, deletionRevision: `deleted:${id}` });
function withoutFavicons(value) {
  if (Array.isArray(value)) return value.map(withoutFavicons);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "favIconUrl")
    .map(([key, entry]) => [key, withoutFavicons(entry)]));
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

try {
  await library.transact([named, markerShadow, snapshotShadow, record("deleted")]
    .map(value => ({ type: "put", family: "sessions", id: value.id, value })));
  await library.transact([{ type: "delete", family: "sessions", id: "deleted" }]);
  const tombstone = { id: "deleted", deviceId: "sharing-fixture", createdAt: 1_000, modifiedAt: 1_000,
    schemaVersion: 1, deletedAt: 1_000,
    deletionRevision: '{"deviceId":"sharing-fixture","logicalCounter":4,"wallTime":1000}' };
  for (const id of ["marker-shadow", "deleted", "recovery-deleted"]) {
    await recovery.captureSnapshot(record(id, { auto: true }));
    await recovery.deleteSnapshot(id, { marker: marker(id) });
  }
  await recovery.captureSnapshot(snapshot);
  await recovery.captureSnapshot(overridingSnapshot);
  const expectedNamed = { named, "marker-shadow": markerShadow, "snapshot-shadow": snapshotShadow, deleted: tombstone };
  const expectedSessions = { ...expectedNamed, snapshot, "snapshot-shadow": overridingSnapshot,
    "recovery-deleted": marker("recovery-deleted") };
  const expected = { sessions: expectedSessions, [NAMED]: expectedNamed };

  for (const includeFavicons of [true, false]) {
    const projected = includeFavicons ? expected : withoutFavicons(expected);
    for (const keys of [["sessions", NAMED, "sessions", NAMED], [NAMED, "sessions"], [NAMED], ["sessions"]]) {
      resetCalls();
      const result = await authority.readMaps(keys, { includeFavicons });
      checkCalls(includeFavicons, keys.includes("sessions"));
      assert.deepEqual(result, Object.fromEntries([...new Set(keys)].map(key => [key, projected[key]])),
        "exact metadata, compact tombstones and Recovery precedence survive both read modes");
      if (keys.includes("sessions") && keys.includes(NAMED)) {
        result.sessions.named.windows[0][0].labels.push("mutated");
        result.sessions.named.organization.fixture[0] = "mutated";
        assert.deepEqual(result[NAMED].named, projected[NAMED].named, "Session map cannot mutate named alias");
        result[NAMED]["marker-shadow"].groups[1][0].title = "mutated";
        assert.deepEqual(result.sessions["marker-shadow"], projected.sessions["marker-shadow"],
          "named alias cannot mutate Session map");
      }
    }
  }
  resetCalls();
  assert.deepEqual(await authority.readMaps(["sessions", NAMED]), expected,
    "prior caller mutations cannot alter physical records or poison later reads");
  checkCalls(true, true);

  const edited = { ...structuredClone(named), name: "Fresh saved edit", modifiedAt: 400 };
  await library.transact([{ type: "put", family: "sessions", id: edited.id, value: edited }]);
  expectedNamed.named = edited; expectedSessions.named = edited;
  resetCalls();
  assert.deepEqual(await authority.readMaps(["sessions", NAMED]), expected, "a later call reads the committed edit");
  checkCalls(true, true);

  // Hold both calls outside the real adapter transaction so they overlap without
  // introducing a fake database deadlock. Each invocation owns its favicon mode.
  resetCalls();
  const release = deferred();
  beforeFamilyRead = async () => release.promise;
  const fullPromise = authority.readMaps(["sessions", NAMED]);
  const projectionPromise = authority.readMaps([NAMED, "sessions"], { includeFavicons: false });
  try {
    assert.deepEqual(calls.family, [
      { family: "sessions", includeDeleted: true, includeFavicons: true },
      { family: "sessions", includeDeleted: true, includeFavicons: false }
    ], "overlapping calls share only within their own invocation");
  } finally { release.resolve(); }
  const [full, projection] = await Promise.all([fullPromise, projectionPromise]);
  beforeFamilyRead = async () => {};
  assert.deepEqual(full, expected);
  assert.deepEqual(projection, withoutFavicons(expected));
  assert.equal(calls.snapshots.length, 2); assert.equal(calls.markers, 2);
  full[NAMED].named.windows[0][0].title = "Changed full result";
  assert.deepEqual(projection, withoutFavicons(expected), "concurrent results have independent nested payloads");

  resetCalls();
  const failure = new Error("synthetic-family-read-failure");
  beforeFamilyRead = async () => { throw failure; };
  await assert.rejects(authority.readMaps(["sessions", NAMED]), error => error === failure);
  checkCalls(true, true);
  beforeFamilyRead = async () => {};
  resetCalls();
  assert.deepEqual(await authority.readMaps(["sessions", NAMED]), expected, "failed reads are retried by the next call");
  checkCalls(true, true);

  for (const keys of [[], ["fixtureLocal"], ["inbox", "fixtureLocal"]]) {
    resetCalls();
    const result = await authority.readMaps(keys);
    assert.deepEqual(result, keys.length ? {
      ...(keys.includes("inbox") ? { inbox: {} } : {}), fixtureLocal: { value: "browser fallback" }
    } : {});
    assert.deepEqual(calls.family, keys.includes("inbox")
      ? [{ family: "inbox", includeDeleted: true, includeFavicons: true }] : []);
    assert.deepEqual(calls.snapshots, []); assert.equal(calls.markers, 0);
  }
  console.log("PASS authority Session read sharing: full/projection aliases, isolation, freshness, failures and unrelated keys");
} finally {
  await Promise.all([library.close(), recovery.close()]);
}
