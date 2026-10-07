import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";

/*
 * Upgrade evidence: a Library and Recovery database written by the 0.8.632
 * storage modules (the last Store candidate) must read back unchanged with the
 * current modules, with no migration step and no record rejected. The old
 * modules run from the archived release zip under dist/, extracted into a
 * temporary directory for this process only. The memory adapter stands in for
 * IndexedDB, so on-disk version upgrades are outside this test; schema.js is
 * compared byte-for-byte instead.
 */

const zipPath = fileURLToPath(new URL("../../dist/everytab-0.8.632.zip", import.meta.url));
assert.ok(existsSync(zipPath), `release archive required at ${zipPath}`);

function extractZip(buffer, destination, accept) {
  const EOCD = 0x06054b50;
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== EOCD) eocd -= 1;
  assert.ok(eocd >= 0, "zip central directory found");
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const extracted = [];
  for (let index = 0; index < entries; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "central directory entry");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!accept(name) || name.endsWith("/")) continue;
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, "local file header");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressedSize);
    const content = method === 0 ? data : method === 8 ? inflateRawSync(data) : null;
    assert.ok(content, `supported compression for ${name}`);
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    extracted.push(name);
  }
  return extracted;
}

const scratch = mkdtempSync(join(tmpdir(), "everytab-v632-"));
const extracted = extractZip(readFileSync(zipPath), scratch, (name) =>
  name.startsWith("js/lib/") || name === "manifest.json");
assert.ok(extracted.includes("js/lib/storage/library-store.js"), "0.8.632 storage modules extracted");
assert.equal(JSON.parse(readFileSync(join(scratch, "manifest.json"), "utf8")).version, "0.8.632");

const importOld = (path) => import(pathToFileURL(join(scratch, path)).href);
const currentRoot = fileURLToPath(new URL("../js/", import.meta.url));
// The MPL-2.0 copyright/SPDX header was added after 0.8.632; it is a comment,
// not part of the contract, so it is removed before the byte comparison.
const withoutLicenseHeader = (source) => source.replace(/^(?:\/\/ (?:Copyright|SPDX-License-Identifier)[^\n]*\n){2}\n?/, "");
for (const contract of ["storage/schema.js", "storage/authority-record.js"]) {
  assert.equal(
    withoutLicenseHeader(readFileSync(join(scratch, "js/lib", contract), "utf8")),
    withoutLicenseHeader(readFileSync(join(currentRoot, "lib", contract), "utf8")),
    `${contract} is a data contract and is byte-identical to 0.8.632 apart from the license header`
  );
}
// Stored key constants may only grow. Every 0.8.632 value must still exist
// with the same bytes; new device-local keys are read as "absent means empty".
{
  const [oldConstants, currentConstants] = await Promise.all([
    importOld("js/lib/storage/constants.js"), import("../js/lib/storage/constants.js")
  ]);
  for (const [name, value] of Object.entries(oldConstants)) {
    if (typeof value === "function") continue;
    assert.deepEqual(currentConstants[name], value, `storage constant ${name} is unchanged since 0.8.632`);
  }
}

try {
  const storage = createInterleavableStorage({ deviceId: "upgrade-device" });
  globalThis.chrome = { storage: { local: storage.local, onChanged: storage.onChanged } };
  Object.defineProperty(globalThis, "navigator", {
    value: { locks: createMockLockManager() }, configurable: true
  });

  const [oldSchema, oldLibraryModule, oldRecoveryModule, oldAuthorityModule, oldTypes] = await Promise.all([
    importOld("js/lib/storage/schema.js"),
    importOld("js/lib/storage/library-store.js"),
    importOld("js/lib/storage/recovery-store.js"),
    importOld("js/lib/storage/local-authority.js"),
    importOld("js/lib/types.js")
  ]);
  const libraryAdapter = createMemoryIndexedDbAdapter(oldSchema.LIBRARY_SCHEMA);
  const recoveryAdapter = createMemoryIndexedDbAdapter(oldSchema.RECOVERY_SCHEMA);
  const readBrowserLocal = (keys) => storage.local.get(keys);
  const oldLibrary = oldLibraryModule.createLibraryStore({ adapter: libraryAdapter, deviceId: "upgrade-device" });
  const oldRecovery = oldRecoveryModule.createRecoveryStore({ adapter: recoveryAdapter });
  const oldAuthority = oldAuthorityModule.createStorageAuthority({
    library: oldLibrary, recovery: oldRecovery, readBrowserLocal
  });
  const KEYS = oldTypes.STORE_KEYS;

  // Synthetic 0.8.632 library: nothing here comes from a personal profile.
  const meta = (id, stamp) => ({
    id, deviceId: "upgrade-device", schemaVersion: 1, createdAt: stamp, modifiedAt: stamp
  });
  const seeded = {
    inbox: Object.fromEntries([1, 2, 3].map((n) => [`inbox-${n}`, {
      ...meta(`inbox-${n}`, 10_000 + n), title: `Inbox ${n}`, labels: n === 1 ? ["work"] : [],
      tabs: [{ url: `https://inbox-${n}.example/`, title: `Inbox tab ${n}` }]
    }])),
    archive: Object.fromEntries([1, 2].map((n) => [`archive-${n}`, {
      ...meta(`archive-${n}`, 20_000 + n), title: `Archive ${n}`, labels: ["reading"],
      tabs: [{ url: `https://archive-${n}.example/`, title: `Archive tab ${n}` }]
    }])),
    sessions: {
      ...Object.fromEntries([1, 2].map((n) => [`00000000-0000-4000-8000-00000000a00${n}`, {
        ...meta(`00000000-0000-4000-8000-00000000a00${n}`, 30_000 + n), name: `Named ${n}`,
        auto: false, labels: ["work"],
        windows: [[{ url: `https://named-${n}.example/`, title: `Named tab ${n}` }]]
      }])),
      ...Object.fromEntries([1, 2, 3].map((n) => [`00000000-0000-4000-8000-00000000b00${n}`, {
        ...meta(`00000000-0000-4000-8000-00000000b00${n}`, 40_000 + n), name: `Snapshot ${n}`,
        auto: true, labels: [],
        windows: [[{ url: `https://snapshot-${n}.example/`, title: `Snapshot tab ${n}`,
          favIconUrl: "data:image/png;base64,AQIDBA==" }]]
      }]))
    },
    labelMeta: { work: { color: "blue" }, reading: { color: "green" } },
    settings: { ...oldTypes.DEFAULT_SETTINGS, snapshotKeep: 0, snapshotEveryMinutes: 15 },
    settingsModifiedAt: 50_000,
    suspendedRegistry: {
      101: { originalUrl: "https://suspended-1.example/", title: "Suspended 1", windowId: 1,
        index: 0, pinned: false, recoveryOccurrenceId: "occurrence-1" },
      102: { originalUrl: "https://suspended-2.example/", title: "Suspended 2", windowId: 1,
        index: 1, pinned: true, recoveryOccurrenceId: "occurrence-2" }
    },
    journal: [
      { id: "entry-2", at: 60_002, label: "Saved 1 tab", puts: [], dels: [{ store: "inbox", id: "inbox-2" }],
        reopen: [], moves: [] },
      { id: "entry-1", at: 60_001, label: "Closed 1 tab", puts: [], dels: [],
        reopen: [[{ url: "https://closed.example/", title: "Closed" }]], moves: [] }
    ]
  };
  await oldAuthority.commitMaps({ settings: seeded.settings, settingsModifiedAt: seeded.settingsModifiedAt });
  await oldAuthority.commitMaps({ [KEYS.inbox]: seeded.inbox });
  await oldAuthority.commitMaps({ [KEYS.archive]: seeded.archive });
  await oldAuthority.commitMaps({ [KEYS.sessions]: seeded.sessions });
  await oldAuthority.commitMaps({ labelMeta: seeded.labelMeta });
  await oldAuthority.commitMaps({ suspendedRegistry: seeded.suspendedRegistry, journal: seeded.journal });
  const writtenByOld = await oldAuthority.readMaps([
    KEYS.inbox, KEYS.archive, KEYS.sessions, "labelMeta", "settings", "suspendedRegistry", "journal"
  ]);
  assert.equal(Object.keys(writtenByOld[KEYS.sessions]).length, 5, "0.8.632 wrote five Sessions");

  // Upgrade: the current modules open the same databases without migration.
  const [{ createLibraryStore }, { createRecoveryStore }, { createStorageAuthority }, schema] = await Promise.all([
    import("../js/lib/storage/library-store.js"),
    import("../js/lib/storage/recovery-store.js"),
    import("../js/lib/storage/local-authority.js"),
    import("../js/lib/storage/schema.js")
  ]);
  assert.deepEqual(schema.LIBRARY_SCHEMA, oldSchema.LIBRARY_SCHEMA);
  assert.deepEqual(schema.RECOVERY_SCHEMA, oldSchema.RECOVERY_SCHEMA);
  const library = createLibraryStore({ adapter: libraryAdapter, deviceId: "upgrade-device" });
  const recovery = createRecoveryStore({ adapter: recoveryAdapter });
  const authority = createStorageAuthority({ library, recovery, readBrowserLocal });
  const { setStorageAuthorityForTests } = await import("../js/lib/storage/authority-runtime.js");
  setStorageAuthorityForTests(authority);

  const current = await authority.readMaps([
    KEYS.inbox, KEYS.archive, KEYS.sessions, "labelMeta", "settings", "settingsModifiedAt",
    "suspendedRegistry", "journal"
  ]);
  const ids = (map) => Object.keys(map ?? {}).sort();
  assert.deepEqual(ids(current[KEYS.inbox]), ids(seeded.inbox), "Inbox identities match");
  assert.deepEqual(ids(current[KEYS.archive]), ids(seeded.archive), "Archive identities match");
  assert.deepEqual(ids(current[KEYS.sessions]), ids(seeded.sessions), "named Sessions and Snapshots match");
  assert.deepEqual(current[KEYS.inbox], seeded.inbox, "Inbox records are byte-equivalent");
  assert.deepEqual(current[KEYS.archive], seeded.archive, "Archive records are byte-equivalent");
  for (const [id, session] of Object.entries(seeded.sessions)) {
    assert.deepEqual(current[KEYS.sessions][id], session, `Session ${id} reads back unchanged`);
  }
  assert.deepEqual(current.labelMeta, seeded.labelMeta, "label metadata matches");
  assert.deepEqual(current.settings, seeded.settings, "stored settings are untouched, including snapshotKeep 0");
  assert.equal(current.settingsModifiedAt, seeded.settingsModifiedAt);
  assert.deepEqual(current.suspendedRegistry, seeded.suspendedRegistry, "suspend registry matches");
  assert.deepEqual(current.journal, seeded.journal, "Undo journal matches");
  assert.deepEqual(current, { ...writtenByOld, settingsModifiedAt: seeded.settingsModifiedAt },
    "the current read equals what 0.8.632 read from its own write");

  // Recovery retains the three automatic Snapshots with their favicon assets.
  const snapshots = await recovery.listSnapshots({ limit: 10_000 });
  assert.equal(snapshots.length, 3, "three automatic Snapshots survive the upgrade");
  assert.equal(snapshots.every((s) => s.value.windows[0][0].favIconUrl === "data:image/png;base64,AQIDBA=="), true,
    "Snapshot favicons rehydrate");
  assert.equal((await recovery.exportRecoveryPack()).snapshots.length, 3);

  // Product reads through the current Store see the same data; the legacy
  // snapshotKeep 0 reads as the bounded maximum without a rewrite.
  const { STORE_KEYS } = await import("../js/lib/types.js");
  const { getSettings, listItems, readStoreValue, readFreshStoreMap, mutateStores } =
    await import("../js/lib/store.js");
  assert.equal((await listItems(STORE_KEYS.inbox)).length, 3);
  assert.equal((await listItems(STORE_KEYS.archive)).length, 2);
  assert.equal((await listItems(STORE_KEYS.sessions)).length, 5);
  assert.equal((await getSettings()).snapshotKeep, 1000);
  assert.equal((await readFreshStoreMap("settings")).snapshotKeep, 0, "no settings rewrite on read");
  assert.deepEqual(await readStoreValue("suspendedRegistry"), seeded.suspendedRegistry);

  // The first write after the upgrade succeeds and the old records stay intact.
  await mutateStores([STORE_KEYS.inbox], (maps) => ({
    [STORE_KEYS.inbox]: {
      ...maps[STORE_KEYS.inbox],
      "inbox-4": { ...meta("inbox-4", 70_000), title: "Inbox 4", labels: [],
        tabs: [{ url: "https://inbox-4.example/", title: "Inbox tab 4" }] }
    }
  }));
  const afterWrite = await authority.readMaps([KEYS.inbox]);
  assert.equal(Object.keys(afterWrite[KEYS.inbox]).length, 4);
  for (const [id, item] of Object.entries(seeded.inbox)) assert.deepEqual(afterWrite[KEYS.inbox][id], item);

  console.log("PASS: a 0.8.632 Library and Recovery database reads back unchanged with the current modules");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
