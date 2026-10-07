import test from "node:test";
import assert from "node:assert/strict";
import { hydrateEmbeddedFavicons } from "../js/lib/storage/assets.js";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { STORAGE_SETTINGS_FAMILY, STORAGE_LABEL_META_FAMILY } from "../js/lib/storage/constants.js";
import { NAMED_SESSION_RECORDS_KEY } from "../js/lib/session-identity-index.js";
import { STORE_KEYS } from "../js/lib/types.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

const families = [...Object.values(STORE_KEYS), STORAGE_SETTINGS_FAMILY, STORAGE_LABEL_META_FAMILY];
const embeddedIcon = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";
const withoutIcons = value => JSON.parse(JSON.stringify(value,
  (key, child) => ["favIconUrl", "everytabAsset"].includes(key) ? undefined : child));

function record(id, auto = false) {
  const tabs = [
    { url: "https://fixture.invalid/one", title: "One", favIconUrl: embeddedIcon, pinned: true,
      group: { id: 7, title: "Research", color: "blue" }, labels: ["work", "read"] },
    { url: "https://fixture.invalid/two", title: "Two", favIconUrl: "https://fixture.invalid/icon.png", pinned: false },
    { url: "https://fixture.invalid/three", title: "Three", favIconUrl: "" }
  ];
  return { id, auto, name: "Synthetic saved record", createdAt: 10, modifiedAt: 20,
    labels: ["work"], tabs, windows: [[tabs[1], tabs[0]], [tabs[2]]],
    nested: { items: [{ favIconUrl: embeddedIcon, keep: null }, { keep: [3, false, "favIconUrl"] }],
      unrelatedIconField: embeddedIcon } };
}

function observedAdapter(schema) {
  const adapter = createMemoryIndexedDbAdapter(schema);
  const reads = [];
  const scopes = [];
  return { reads, scopes, clear() { reads.length = 0; scopes.length = 0; },
    adapter: { ...adapter, transaction(names, mode, work) {
      scopes.push({ names: [...names], mode });
      return adapter.transaction(names, mode, transaction => work(new Proxy(transaction, {
        get(target, method) {
          const member = target[method];
          if (typeof member !== "function") return member;
          return (...args) => {
            if (String(method).startsWith("get")) reads.push({ method, store: args[0] });
            return member(...args);
          };
        }
      })));
    } }
  };
}

async function fixture() {
  const libraryIO = observedAdapter(LIBRARY_SCHEMA);
  const recoveryIO = observedAdapter(RECOVERY_SCHEMA);
  const library = createLibraryStore({ adapter: libraryIO.adapter, deviceId: "projection-fixture", now: () => 1000 });
  const recovery = createRecoveryStore({ adapter: recoveryIO.adapter, now: () => 1000 });
  await library.transact(families.flatMap(family => [
    { type: "put", family, id: `saved-${family}`, value: record(`saved-${family}`) },
    { type: "delete", family, id: `deleted-${family}` }
  ]));
  await recovery.captureSnapshot(record("snapshot-old", true), { capturedAt: 100 });
  await recovery.captureSnapshot(record("snapshot-new", true), { capturedAt: 200 });
  await recovery.captureSnapshot(record("snapshot-deleted", true), { capturedAt: 300 });
  await recovery.deleteSnapshot("snapshot-deleted");
  const authority = createStorageAuthority({ library, recovery });
  return { library, recovery, authority, libraryIO, recoveryIO };
}

function assertNoAssets(io) {
  assert.equal(io.reads.filter(read => read.store === "assets").length, 0, "projection issues no asset requests");
  assert.ok(io.scopes.length > 0, "assertion observes real storage transactions");
  assert.ok(io.scopes.every(scope => !scope.names.includes("assets") && scope.mode === "readonly"),
    "projection does not open asset stores or write transactions");
}

test("favicon projection recursively strips public and private keys without looking up assets", () => {
  const value = { nested: [{ everytabAsset: "private-digest", keep: { favIconUrl: embeddedIcon, title: "Kept" } }],
    favIconUrl: "https://fixture.invalid/favicon", preserve: ["everytabAsset", 0, false, null] };
  const original = structuredClone(value);
  const assets = { get() { throw new Error("Projection must not look up any asset"); } };
  assert.deepEqual(hydrateEmbeddedFavicons(value, assets, { includeFavicons: false }), withoutIcons(value));
  assert.deepEqual(value, original);
  const full = hydrateEmbeddedFavicons({ everytabAsset: "icon", title: "Kept" },
    new Map([["icon", { dataUrl: embeddedIcon }]]));
  assert.deepEqual(full, { title: "Kept", favIconUrl: embeddedIcon }, "default hydration remains intact");
});

test("every Library family projects exact non-icon payloads and tombstones without asset reads", async () => {
  const { library, libraryIO } = await fixture();
  const checkpoint = await library.createExactCheckpoint();
  for (const family of families) {
    libraryIO.clear();
    const full = await library.readFamily(family, { includeDeleted: true });
    assert.ok(libraryIO.reads.some(read => read.store === "assets"), "control full read hydrates assets");
    assert.equal(full.length, 2);
    libraryIO.clear();
    const projected = await library.readFamily(family, { includeDeleted: true, includeFavicons: false });
    assertNoAssets(libraryIO);
    assert.deepEqual(projected, withoutIcons(full), `${family} keeps ordering, metadata and all non-icon fields`);
    assert.deepEqual(projected.find(row => row.lifecycle === "deleted"), full.find(row => row.lifecycle === "deleted"));
    const value = projected.find(row => row.lifecycle === "live").value;
    value.tabs[0].title = "Projection-only mutation";
    value.labels.push("projection-only");
    assert.deepEqual(await library.readFamily(family, { includeDeleted: true }), full);
    assert.deepEqual(await library.readFamily(family, { includeDeleted: true, includeFavicons: true }), full);
    libraryIO.clear();
    const live = await library.readFamily(family, { includeFavicons: false });
    assertNoAssets(libraryIO);
    assert.equal(live.length, 1, "default deleted-record filtering is unchanged");
  }
  assert.deepEqual(await library.createExactCheckpoint(), checkpoint, "projection cannot alter persisted entities or assets");
});

test("Recovery projection keeps Snapshot order, limit and metadata without changing the full pack", async () => {
  const { recovery, recoveryIO } = await fixture();
  const pack = await recovery.exportRecoveryPack();
  const full = await recovery.listSnapshots();
  assert.deepEqual(full.map(snapshot => snapshot.id), ["snapshot-new", "snapshot-old"]);
  recoveryIO.clear();
  const projected = await recovery.listSnapshots({ includeFavicons: false });
  assertNoAssets(recoveryIO);
  assert.deepEqual(projected, withoutIcons(full));
  projected[0].value.windows[0][0].title = "Projection-only mutation";
  projected[0].value.nested.items.push({ keep: "new" });
  assert.deepEqual(await recovery.listSnapshots(), full);
  assert.deepEqual(await recovery.listSnapshots({ includeFavicons: true }), full);
  recoveryIO.clear();
  assert.deepEqual(await recovery.listSnapshots({ limit: 1, includeFavicons: false }), withoutIcons(full.slice(0, 1)));
  assertNoAssets(recoveryIO);
  assert.deepEqual(await recovery.exportRecoveryPack(), pack);
});

test("authority projects ordinary, combined and named Session maps while commits still use full reads", async () => {
  const { library, recovery, authority, libraryIO, recoveryIO } = await fixture();
  const keys = [...Object.values(STORE_KEYS), NAMED_SESSION_RECORDS_KEY];
  const full = await authority.readMaps(keys);
  const checkpoint = await library.createExactCheckpoint();
  const pack = await recovery.exportRecoveryPack();
  libraryIO.clear(); recoveryIO.clear();
  const projected = await authority.readMaps(keys, { includeFavicons: false });
  assertNoAssets(libraryIO); assertNoAssets(recoveryIO);
  assert.deepEqual(projected, withoutIcons(full));
  assert.equal(projected.sessions["snapshot-new"].auto, true);
  assert.ok(projected.sessions["snapshot-deleted"].deletedAt, "Recovery deletion marker survives merging");
  assert.ok(projected.sessions["deleted-sessions"].deletedAt, "Library tombstone survives merging");
  assert.equal(projected[NAMED_SESSION_RECORDS_KEY]["snapshot-new"], undefined, "named projection excludes automatic Snapshots");
  assert.ok(projected[NAMED_SESSION_RECORDS_KEY]["saved-sessions"]);
  projected.inbox["saved-inbox"].tabs[0].title = "Projection-only mutation";
  projected.sessions["snapshot-new"].windows.pop();
  projected[NAMED_SESSION_RECORDS_KEY]["saved-sessions"].labels.push("projection-only");
  assert.deepEqual(await authority.readMaps(keys), full);
  assert.deepEqual(await library.createExactCheckpoint(), checkpoint);
  assert.deepEqual(await recovery.exportRecoveryPack(), pack);

  libraryIO.clear(); recoveryIO.clear();
  await authority.commitMaps({ inbox: full.inbox, sessions: full.sessions });
  assert.ok(libraryIO.reads.some(read => read.store === "assets"), "commitMaps retains full Library comparison inputs");
  assert.ok(recoveryIO.reads.some(read => read.store === "assets"), "commitMaps retains full Recovery comparison inputs");
  assert.deepEqual(await authority.readMaps(keys), full, "an unchanged full map is not rewritten as icon-free data");
  assert.deepEqual(await library.createExactCheckpoint(), checkpoint);
  assert.deepEqual(await recovery.exportRecoveryPack(), pack);
});
