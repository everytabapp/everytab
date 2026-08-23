/**
 * M5 vault-sync two-device merge suite — run with: node test/vault.mjs
 * Simulates devices A and B (separate chrome.storage mocks) sharing one
 * vault (in-memory File System Access mock). No browser needed.
 */

/* ---------- in-memory FSA mock ---------- */

class MemFile {
  constructor(name) {
    this.name = name;
    this.kind = "file";
    this.content = "";
  }
  async getFile() {
    const c = this.content;
    return { text: async () => c };
  }
  async createWritable() {
    const file = this;
    let buf = "";
    return {
      async write(d) {
        buf += d;
      },
      async close() {
        file.content = buf;
      }
    };
  }
}

class MemDir {
  constructor(name = "root") {
    this.name = name;
    this.kind = "directory";
    this.children = new Map();
  }
  async getDirectoryHandle(name, { create } = {}) {
    let c = this.children.get(name);
    if (!c) {
      if (!create) throw new Error(`NotFound: ${name}`);
      c = new MemDir(name);
      this.children.set(name, c);
    }
    return c;
  }
  async getFileHandle(name, { create } = {}) {
    let c = this.children.get(name);
    if (!c) {
      if (!create) throw new Error(`NotFound: ${name}`);
      c = new MemFile(name);
      this.children.set(name, c);
    }
    return c;
  }
  async removeEntry(name) {
    if (!this.children.delete(name)) throw new Error(`NotFound: ${name}`);
  }
  async *entries() {
    for (const [n, h] of this.children) yield [n, h];
  }
}

/* ---------- two-device chrome.storage mock ---------- */

const memA = { deviceId: "device-A" };
const memB = { deviceId: "device-B" };
let cur = memA;
const storageEvents = new WeakMap();
function eventsFor(mem) {
  if (storageEvents.has(mem)) return storageEvents.get(mem);
  const listeners = new Set();
  const event = {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    dispatch(changes) {
      for (const listener of listeners) listener(structuredClone(changes), "local");
    }
  };
  storageEvents.set(mem, event);
  return event;
}
const useDevice = (m) => {
  cur = m;
  if (globalThis.chrome) chrome.storage.onChanged = eventsFor(m);
};

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === "string") return keys in cur ? { [keys]: cur[keys] } : {};
        const out = {};
        for (const k of keys) if (k in cur) out[k] = cur[k];
        return out;
      },
      set: async (obj) => {
        const changes = {};
        for (const [key, value] of Object.entries(obj)) {
          changes[key] = { oldValue: cur[key], newValue: value };
        }
        Object.assign(cur, obj);
        eventsFor(cur).dispatch(changes);
      }
    },
    onChanged: eventsFor(cur)
  }
};

// E2-0b: store.js takes the "everytab-store" Web Lock for every storage RMW.
// ONE shared mock LockManager across both simulated devices is correct here:
// in real Chrome the lock partition is per-profile/origin, and these tests
// interleave devices sequentially anyway.
const { createMockLockManager } = await import("./e2-mocks.mjs");
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() },
  writable: true,
  configurable: true
});

const { syncWithHandle } = await import("../js/vault/sync.js");
const {
  STORE_KEYS, DEFAULT_SETTINGS, SCHEMA_VERSION, ARCHIVE_OVERLAY_KEY
} = await import("../js/lib/types.js");
const { listItems, getSettings, saveSettings } = await import("../js/lib/store.js");
const { mergeMaps } = await import("../js/lib/merge.js");
const {
  createCustomSchemeRecord, createDefaultCustomSchemeDraft, customSchemeRef
} = await import("../js/lib/custom-schemes.js");
const { organizationMembershipId } = await import("../js/lib/organization.js");

let failures = 0;
function check(cond, name) {
  if (cond) console.log(`  ok: ${name}`);
  else {
    console.error(`FAIL: ${name}`);
    failures++;
  }
}

/* ---------- fixtures: explicit ids + timestamps (LWW must be deterministic) ---------- */

const T0 = Date.parse("2026-07-01T10:00:00Z");
const DAY = 86_400_000;
const ID = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

function rec(id, deviceId, ts, extra) {
  return {
    id,
    deviceId,
    createdAt: ts,
    modifiedAt: ts,
    schemaVersion: SCHEMA_VERSION,
    labels: [],
    ...extra
  };
}
const put = (mem, key, r) => ((mem[key] ??= {})[r.id] = r);

const vault = new MemDir();
const dirFiles = (dir) => [...vault.children.get(dir).children.keys()];
const readVaultJson = (dir, name) =>
  JSON.parse(vault.children.get(dir).children.get(name).content);

/* ---------- pure merge unit checks ---------- */

{
  const local = { x: { id: "x", modifiedAt: 5 }, y: { id: "y", modifiedAt: 5 } };
  const remote = { y: { id: "y", modifiedAt: 9 }, z: { id: "z", modifiedAt: 1 } };
  const { merged, pulled, pushed } = mergeMaps(local, remote);
  check(merged.y.modifiedAt === 9 && pulled.includes("y"), "mergeMaps: newer remote wins → pulled");
  check(merged.x && pushed.includes("x"), "mergeMaps: local-only → pushed");
  check(merged.z && pulled.includes("z"), "mergeMaps: remote-only → pulled");
  const tie = mergeMaps({ x: { id: "x", modifiedAt: 5 } }, { x: { id: "x", modifiedAt: 5 } });
  check(tie.pulled.length === 0 && tie.pushed.length === 0, "mergeMaps: tie → no writes");
  const future = mergeMaps({}, { f: { id: "f", modifiedAt: 1, schemaVersion: 99 } });
  check(!future.merged.f && future.pulled.length === 0, "mergeMaps: future schema never merged");
}

/* ---------- device A seeds and pushes ---------- */

useDevice(memA);
put(memA, STORE_KEYS.inbox, rec(ID(1), "device-A", T0, {
  kind: "tab", tabs: [{ url: "https://inbox-a.com", title: "Inbox A" }], source: "dump"
}));
put(memA, STORE_KEYS.sessions, rec(ID(2), "device-A", T0, {
  name: "Project X", auto: false,
  windows: [[{ url: "https://proj.com/1", title: "Proj 1" }, { url: "https://proj.com/2", title: "Proj 2" }]]
}));
put(memA, STORE_KEYS.collections, rec(ID(3), "device-A", T0, {
  name: "Research", tabs: [{ url: "https://paper.com", title: "The Paper" }]
}));
put(memA, STORE_KEYS.snoozes, rec(ID(4), "device-A", T0, {
  url: "https://later.com", title: "Later", dueAt: T0 + 7 * DAY
}));
put(memA, STORE_KEYS.smartviews, rec(ID(5), "device-A", T0, {
  name: "Videos", field: "url", pattern: "youtube", scope: "all"
}));
put(memA, STORE_KEYS.archive, rec(ID(6), "device-A", T0, {
  kind: "tab", tabs: [{ url: "https://old-a.com", title: "Old A" }], source: "dump", archivedAt: T0
}));
put(memA, STORE_KEYS.starred, rec(ID(7), "device-A", T0, {
  url: "https://launch.example", title: "Launch", position: 0
}));
const customDraft = createDefaultCustomSchemeDraft("Vault Harbor");
const customRecord = createCustomSchemeRecord(customDraft.value, {
  id: ID(9), deviceId: "device-A", createdAt: T0, modifiedAt: T0,
  schemaVersion: SCHEMA_VERSION
}).value;
put(memA, STORE_KEYS.customSchemes, customRecord);
const sessionGroup = rec(ID(8), "device-A", T0, {
  organizationKind: "session", name: "Clients"
});
put(memA, STORE_KEYS.organizationGroups, sessionGroup);
const membershipId = organizationMembershipId("session", ID(2), sessionGroup.id);
put(memA, STORE_KEYS.organizationMemberships, rec(membershipId, "device-A", T0, {
  organizationKind: "session", memberKey: ID(2), groupId: sessionGroup.id
}));
const customRef = customSchemeRef(customRecord.id);
await saveSettings({
  ...DEFAULT_SETTINGS, autoArchiveDays: 10,
  uiScheme: customRef, schemeFavorites: [customRef],
  uiQuickTheme: false, uiEmphasis: "muted", dedupIgnoreQuery: true,
  snoozeWakeQuiet: true, popupDupHint: false
});
memA.settingsModifiedAt = T0; // deterministic

const r1 = await syncWithHandle(vault, T0);
check(r1.pushed === 11 && r1.pulled === 0, `A first sync pushes 11 (got ${r1.pushed}/${r1.pulled})`);
check(r1.backedUp === true, "A first sync writes a backup");
check(
  ["inbox", "sessions", "collections", "snoozes", "smartviews", "starred",
    "customSchemes", "organizationGroups", "organizationMemberships", "archive", "backups"].every((d) =>
    vault.children.get(d)?.kind === "directory"
  ),
  "vault layout: all subfolders created"
);
check(readVaultJson("collections", `${ID(3)}.json`).name === "Research", "per-item file holds the record");
check(readVaultJson("customSchemes", `${customRecord.id}.json`).name === "Vault Harbor",
  "custom scheme is one mergeable Vault record in its own folder");
check(readVaultJson("archive", "2026-07-01.json")[ID(6)] !== undefined, "archive record in its daily file");
check(dirFiles("backups").includes("tabvault-2026-07-01.json"), "backup file named by day");
const firstBackup = readVaultJson("backups", "tabvault-2026-07-01.json");
check(
  firstBackup.app === "tabvault" && firstBackup.exportVersion === 2 &&
    firstBackup.settingsModifiedAt === T0 && firstBackup.labelMeta &&
    firstBackup.data.customSchemes?.[customRecord.id]?.name === "Vault Harbor" &&
    firstBackup.settings.uiScheme === customRef &&
    !("journal" in firstBackup) && !("counters" in firstBackup),
  "N44: rolling Vault backup uses the complete portable v2 envelope and excludes operational state"
);
const settingsFile = JSON.parse(vault.children.get("settings.json").content);
check(settingsFile.settings.autoArchiveDays === 10 && settingsFile.modifiedAt === T0 &&
  settingsFile.settings.uiQuickTheme === false && settingsFile.settings.uiEmphasis === "muted" &&
  settingsFile.settings.dedupIgnoreQuery === true && settingsFile.settings.snoozeWakeQuiet === true &&
  settingsFile.settings.popupDupHint === false,
"settings.json pushes retired recognized values byte-for-byte with its LWW timestamp");
const indexMd = vault.children.get("index.md").content;
check(
  indexMd.includes("### Research (1 tabs)") && indexMd.includes("[The Paper](https://paper.com)"),
  "index.md lists the collection with links"
);
check(indexMd.includes("Project X") && indexMd.includes("2 tabs"), "index.md lists the named session");
check(
  indexMd.includes("## Session groups (1)") && indexMd.includes("### Clients (1)") &&
    (!indexMd.includes("### Ungrouped") ||
      indexMd.indexOf("### Clients (1)") < indexMd.indexOf("### Ungrouped")),
  "index.md lists organization groups and keeps projected Ungrouped last"
);

const r2 = await syncWithHandle(vault, T0);
check(r2.pushed === 0 && r2.pulled === 0 && r2.backedUp === false, "second sync is a no-op (idempotent)");

/* ---------- device B pulls everything ---------- */

useDevice(memB);
// E3-3: prime every vault-synced key with the empty device-B snapshots. The
// whole-map pulls below must invalidate each entry through storage.onChanged.
await Promise.all([
  ...Object.values(STORE_KEYS).map((key) => listItems(key)),
  getSettings()
]);
const r3 = await syncWithHandle(vault, T0 + 1000);
check(r3.pulled === 11 && r3.pushed === 0, `B pulls all 11 (got ${r3.pulled}/${r3.pushed})`);
const pulledItemIds = await Promise.all(
  Object.values(STORE_KEYS).map(async (key) => (await listItems(key))[0]?.id)
);
check(
  pulledItemIds.every(Boolean) && (await getSettings()).autoArchiveDays === 10,
  "E3-3: vault whole-map pull invalidates every store + settings key it touched"
);
check((await listItems(STORE_KEYS.collections))[0]?.name === "Research", "B sees A's collection");
check((await listItems(STORE_KEYS.customSchemes))[0]?.name === "Vault Harbor" &&
  (await getSettings()).uiScheme === customRef,
"B receives the active custom scheme record before using its namespaced setting");
check(memB.settings?.autoArchiveDays === 10 && memB.settings.uiQuickTheme === false &&
  memB.settings.uiEmphasis === "muted" && memB.settings.dedupIgnoreQuery === true &&
  memB.settings.snoozeWakeQuiet === true && memB.settings.popupDupHint === false,
"B pulls A's ordinary and retired recognized settings byte-for-byte");
check((await listItems(STORE_KEYS.archive))[0]?.id === ID(6), "B pulls the archive item");

/* ---------- edit + create on B, tombstone on A, propagate both ways ---------- */

memB[STORE_KEYS.collections][ID(3)] = {
  ...memB[STORE_KEYS.collections][ID(3)], name: "Research v2", modifiedAt: T0 + 2000
};
put(memB, STORE_KEYS.inbox, rec(ID(8), "device-B", T0 + 2000, {
  kind: "tab", tabs: [{ url: "https://inbox-b.com", title: "Inbox B" }], source: "manual"
}));
await syncWithHandle(vault, T0 + 3000);

useDevice(memA);
memA[STORE_KEYS.snoozes][ID(4)] = {
  ...memA[STORE_KEYS.snoozes][ID(4)], deletedAt: T0 + 4000, modifiedAt: T0 + 4000
};
const r4 = await syncWithHandle(vault, T0 + 5000);
check(r4.pulled === 2 && r4.pushed === 1, `A pulls B's 2 changes, pushes tombstone (got ${r4.pulled}/${r4.pushed})`);
check(memA[STORE_KEYS.collections][ID(3)].name === "Research v2", "A sees B's edit (LWW)");
check((await listItems(STORE_KEYS.inbox)).some((i) => i.id === ID(8)), "A sees B's new item (union)");

useDevice(memB);
await syncWithHandle(vault, T0 + 6000);
check(!(await listItems(STORE_KEYS.snoozes)).some((s) => s.id === ID(4)), "A's deletion propagates to B");
check(readVaultJson("snoozes", `${ID(4)}.json`).deletedAt === T0 + 4000, "vault file holds the tombstone, never hard-deleted");

/* ---------- conflicting edits: newest wins on both after both sync ---------- */

useDevice(memA);
memA[STORE_KEYS.collections][ID(3)] = { ...memA[STORE_KEYS.collections][ID(3)], name: "A-name", modifiedAt: T0 + 7000 };
useDevice(memB);
memB[STORE_KEYS.collections][ID(3)] = { ...memB[STORE_KEYS.collections][ID(3)], name: "B-name", modifiedAt: T0 + 8000 };

useDevice(memA);
await syncWithHandle(vault, T0 + 9000); // A pushes A-name
useDevice(memB);
await syncWithHandle(vault, T0 + 9000); // B's copy newer → B pushes B-name
useDevice(memA);
await syncWithHandle(vault, T0 + 9000); // A pulls B-name
check(
  memA[STORE_KEYS.collections][ID(3)].name === "B-name" &&
    memB[STORE_KEYS.collections][ID(3)].name === "B-name",
  "conflicting edits converge to the newest (LWW) on both devices"
);

/* ---------- archive: same-day items append into one daily file ---------- */

useDevice(memA);
put(memA, STORE_KEYS.archive, rec(ID(8), "device-A", T0 + 9500, {
  kind: "tab", tabs: [{ url: "https://old-b.com", title: "Old B" }], source: "dump", archivedAt: T0 + 3600_000
}));
await syncWithHandle(vault, T0 + 10_000);
const day1 = readVaultJson("archive", "2026-07-01.json");
check(day1[ID(6)] && day1[ID(8)], "same-day archive items share one daily file");
check(dirFiles("archive").filter((n) => n.endsWith(".json")).length === 1, "no extra archive files");

/* ---------- conflict-copy detection + auto-merge ---------- */

const conflictName = `${ID(3)} (Someone's conflicted copy 2026-07-02).json`;
const conflicted = { ...readVaultJson("collections", `${ID(3)}.json`), name: "Dropbox rescue", modifiedAt: T0 + 20_000 };
vault.children.get("collections").children.set(conflictName, Object.assign(new MemFile(conflictName), {
  content: JSON.stringify(conflicted)
}));
const r5 = await syncWithHandle(vault, T0 + 21_000);
check(r5.conflictCopies === 1, "conflict copy detected");
check(!dirFiles("collections").includes(conflictName), "conflict copy file removed");
check(readVaultJson("collections", `${ID(3)}.json`).name === "Dropbox rescue", "conflict copy content merged into canonical file");
check(memA[STORE_KEYS.collections][ID(3)].name === "Dropbox rescue", "conflict copy content merged into local store");

/* ---------- unknown files are never touched ---------- */

vault.children.get("collections").children.set("notes.json", Object.assign(new MemFile("notes.json"), {
  content: JSON.stringify({ my: "personal notes" })
}));
vault.children.set("README.txt", Object.assign(new MemFile("README.txt"), { content: "hands off" }));
await syncWithHandle(vault, T0 + 22_000);
check(dirFiles("collections").includes("notes.json"), "non-EveryTab json left alone");
check(vault.children.get("README.txt").content === "hands off", "non-json files left alone");

/* ---------- settings LWW the other way ---------- */

useDevice(memB);
await saveSettings({ ...memB.settings, autoArchiveDays: 21 });
memB.settingsModifiedAt = T0 + 23_000;
await syncWithHandle(vault, T0 + 24_000);
useDevice(memA);
await syncWithHandle(vault, T0 + 25_000);
check(memA.settings.autoArchiveDays === 21, "settings LWW: B's newer settings reach A");

/* ---------- F8-1: Focus settings ride the vault; operational Focus keys do not ---------- */

useDevice(memA);
await saveSettings({
  ...memA.settings,
  focusSiteRules: [{ domain: "news.example.com", displayDomain: "news.example.com", scope: "always" }],
  focusExceptionStyle: "pause",
  focusDayEndMinutes: 1200
});
memA.settingsModifiedAt = T0 + 40_000; // deterministic LWW
// Operational Focus state is a SEPARATE local key, never part of `settings`.
memA.focusState = { id: "run-1", startedAt: T0, endsAt: null, label: "Window", target: {}, minimized: [] };
memA.focusSaveReceipts = { "attempt-1": { id: "attempt-1", complete: true } };
await syncWithHandle(vault, T0 + 41_000);
const focusSettingsFile = JSON.parse(vault.children.get("settings.json").content);
check(focusSettingsFile.settings.focusSiteRules?.[0]?.domain === "news.example.com",
  "F8-1: Focus site rules pushed to settings.json");
check(!("focusState" in focusSettingsFile.settings),
  "F8-1: operational focusState is never serialized into settings.json");
check(!("focusSaveReceipts" in focusSettingsFile.settings),
  "F8-R2r2: operational Focus save receipts are never serialized into settings.json");
useDevice(memB);
await syncWithHandle(vault, T0 + 42_000);
check(
  memB.settings.focusExceptionStyle === "pause" &&
    memB.settings.focusSiteRules?.[0]?.scope === "always" &&
    memB.settings.focusDayEndMinutes === 1200,
  "F8-1: device B pulls A's Focus settings via LWW"
);
check(memB.focusState === undefined, "F8-1: device B never receives operational focusState");
check(memB.focusSaveReceipts === undefined,
  "F8-R2r2: device B never receives operational Focus save receipts");

/* ---------- future-schema records are quarantined ---------- */

useDevice(memA);
const futureId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
vault.children.get("collections").children.set(`${futureId}.json`, Object.assign(new MemFile(`${futureId}.json`), {
  content: JSON.stringify({ id: futureId, modifiedAt: T0 + 99_000, schemaVersion: 99, name: "From the future" })
}));
await syncWithHandle(vault, T0 + 26_000);
check(!memA[STORE_KEYS.collections]?.[futureId], "future-schema record not pulled");
check(
  JSON.parse(vault.children.get("collections").children.get(`${futureId}.json`).content).name === "From the future",
  "future-schema file left untouched"
);

/* A filtered future record still occupies its identity. A same-UUID local v1
 * record must not make the opaque canonical file look absent and pushable. */
const localAtFutureId = rec(futureId, "device-A", T0 + 98_000, {
  name: "Local understood copy", tabs: [], labels: []
});
put(memA, STORE_KEYS.collections, localAtFutureId);
const futureCanonical = vault.children.get("collections").children.get(`${futureId}.json`);
const futureCanonicalText = futureCanonical.content;
const futureCanonicalResult = await syncWithHandle(vault, T0 + 99_500);
check(
  futureCanonical.content === futureCanonicalText &&
    memA[STORE_KEYS.collections][futureId].name === "Local understood copy" &&
    futureCanonicalResult.pushed === 0,
  "N44 Vault leaves a future canonical record opaque and never reports the same local UUID pushable"
);

const futureConflictId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const futureConflictName = `${futureConflictId} (conflicted copy).json`;
const futureConflictText = JSON.stringify({
  id: futureConflictId, modifiedAt: T0 + 100_000, schemaVersion: 99,
  name: "Opaque future conflict"
});
vault.children.get("collections").children.set(futureConflictName,
  Object.assign(new MemFile(futureConflictName), { content: futureConflictText }));
put(memA, STORE_KEYS.collections, rec(futureConflictId, "device-A", T0 + 99_000, {
  name: "Local conflict UUID", tabs: [], labels: []
}));
const futureConflictResult = await syncWithHandle(vault, T0 + 100_500);
check(
  dirFiles("collections").includes(futureConflictName) &&
    !dirFiles("collections").includes(`${futureConflictId}.json`) &&
    vault.children.get("collections").children.get(futureConflictName).content === futureConflictText &&
    futureConflictResult.pushed === 0 && futureConflictResult.conflictCopies === 0,
  "N44 Vault preserves a future conflict copy and does not synthesize or delete its canonical UUID"
);

const unknownCanonicalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const unknownCanonicalName = `${unknownCanonicalId}.json`;
const unknownCanonicalText = "{\n  \"mine\": \"opaque\"\n}";
vault.children.get("collections").children.set(unknownCanonicalName,
  Object.assign(new MemFile(unknownCanonicalName), { content: unknownCanonicalText }));
put(memA, STORE_KEYS.collections, rec(unknownCanonicalId, "device-A", T0 + 101_000, {
  name: "Local unknown UUID", tabs: [], labels: []
}));
const unknownCanonicalResult = await syncWithHandle(vault, T0 + 101_500);
check(
  vault.children.get("collections").children.get(unknownCanonicalName).content === unknownCanonicalText &&
    unknownCanonicalResult.pushed === 0,
  "N44 an unknown canonical JSON file remains byte-for-byte hands-off"
);

const futureArchiveId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const futureArchiveDay = "2026-07-04.json";
const futureArchiveText = JSON.stringify({
  [futureArchiveId]: {
    id: futureArchiveId, modifiedAt: T0 + 102_000, schemaVersion: 99,
    archivedAt: T0 + 3 * DAY, opaque: "future archive"
  }
}, null, 2);
vault.children.get(STORE_KEYS.archive).children.set(futureArchiveDay,
  Object.assign(new MemFile(futureArchiveDay), { content: futureArchiveText }));
put(memA, STORE_KEYS.archive, rec(futureArchiveId, "device-A", T0 + 101_000, {
  kind: "tab", tabs: [{ url: "https://local-archive.example", title: "Local archive" }],
  source: "manual", labels: [], archivedAt: T0 + 3 * DAY
}));
const futureArchiveResult = await syncWithHandle(vault, T0 + 102_500);
check(
  vault.children.get(STORE_KEYS.archive).children.get(futureArchiveDay).content === futureArchiveText &&
    memA[STORE_KEYS.archive][futureArchiveId].tabs[0].url === "https://local-archive.example" &&
    futureArchiveResult.pushed === 0,
  "N44 Archive leaves a future-schema day file opaque and never pushes its same local UUID"
);

const futureArchiveConflictId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const futureArchiveConflictName = "2026-07-05 (conflicted copy).json";
const futureArchiveConflictText = JSON.stringify({
  [futureArchiveConflictId]: {
    id: futureArchiveConflictId, modifiedAt: T0 + 103_000, schemaVersion: 99,
    archivedAt: T0 + 4 * DAY, opaque: "future archive conflict"
  }
});
vault.children.get(STORE_KEYS.archive).children.set(futureArchiveConflictName,
  Object.assign(new MemFile(futureArchiveConflictName), { content: futureArchiveConflictText }));
put(memA, STORE_KEYS.archive, rec(futureArchiveConflictId, "device-A", T0 + 102_000, {
  kind: "tab", tabs: [{ url: "https://local-archive-conflict.example", title: "Local" }],
  source: "manual", labels: [], archivedAt: T0 + 4 * DAY
}));
const futureArchiveConflictResult = await syncWithHandle(vault, T0 + 103_500);
check(
  vault.children.get(STORE_KEYS.archive).children.get(futureArchiveConflictName).content ===
    futureArchiveConflictText &&
    !dirFiles(STORE_KEYS.archive).includes("2026-07-05.json") &&
    futureArchiveConflictResult.pushed === 0 && futureArchiveConflictResult.conflictCopies === 0,
  "N44 Archive preserves an opaque future conflict day without canonical rewrite or deletion"
);

const unknownArchiveId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const unknownArchiveDay = "2026-07-06.json";
const unknownArchiveText = "{ this is not EveryTab JSON }";
vault.children.get(STORE_KEYS.archive).children.set(unknownArchiveDay,
  Object.assign(new MemFile(unknownArchiveDay), { content: unknownArchiveText }));
put(memA, STORE_KEYS.archive, rec(unknownArchiveId, "device-A", T0 + 104_000, {
  kind: "tab", tabs: [{ url: "https://unknown-archive.example", title: "Unknown day" }],
  source: "manual", labels: [], archivedAt: T0 + 5 * DAY
}));
const unknownArchiveResult = await syncWithHandle(vault, T0 + 104_500);
check(
  vault.children.get(STORE_KEYS.archive).children.get(unknownArchiveDay).content ===
    unknownArchiveText && unknownArchiveResult.pushed === 0,
  "N44 Archive leaves an unknown canonical day file byte-for-byte hands-off"
);

const futureSettingsText = JSON.stringify({
  schemaVersion: 99, modifiedAt: T0 + 200_000,
  settings: { uiScheme: "future-scheme", opaque: true }
}, null, 2);
vault.children.set("settings.json",
  Object.assign(new MemFile("settings.json"), { content: futureSettingsText }));
const futureSettingsResult = await syncWithHandle(vault, T0 + 104_000);
check(
  vault.children.get("settings.json").content === futureSettingsText &&
    memA.settings.uiScheme !== "future-scheme" && futureSettingsResult.pushed === 0,
  "N44 Vault leaves future-schema settings.json opaque instead of treating it as absent and pushable"
);

/* ---------- rolling backups: one per day, prune to 7 ---------- */

const backups = vault.children.get("backups");
for (let i = 1; i <= 9; i++) {
  const n = `tabvault-2026-06-${String(i).padStart(2, "0")}.json`;
  backups.children.set(n, Object.assign(new MemFile(n), { content: "{}" }));
}
const r6 = await syncWithHandle(vault, T0 + DAY); // next day → new backup
check(r6.backedUp === true, "new day → new backup");
const backupNames = dirFiles("backups").sort();
check(backupNames.length === 7, `backups pruned to 7 (got ${backupNames.length})`);
check(
  backupNames.includes("tabvault-2026-07-01.json") && backupNames.includes("tabvault-2026-07-02.json"),
  "newest backups survive pruning"
);

/* ---------- E3: Archive overlay is one logical map to Vault ---------- */

useDevice(memA);
const overlayArchive = rec(ID(9), "device-A", T0 + 2 * DAY, {
  kind: "tab",
  tabs: [{ url: "https://overlay-vault.example", title: "Overlay vault" }],
  source: "manual",
  archivedAt: T0 + 2 * DAY,
  labels: ["overlay"]
});
put(memA, ARCHIVE_OVERLAY_KEY, overlayArchive);
await syncWithHandle(vault, T0 + 2 * DAY);
const overlayDay = readVaultJson(STORE_KEYS.archive, "2026-07-03.json");
check(
  overlayDay[overlayArchive.id]?.tabs[0].url === "https://overlay-vault.example",
  "E3 Archive overlay: Vault pushes overlay records through the logical Archive map"
);

useDevice(memB);
await syncWithHandle(vault, T0 + 2 * DAY + 500);
check(
  (await listItems(STORE_KEYS.archive)).some((item) => item.id === overlayArchive.id) &&
    Object.keys(memB[ARCHIVE_OVERLAY_KEY] ?? {}).length === 0,
  "E3 Archive overlay: Vault pull persists the merged base and clears the overlay atomically"
);

/* ---------- F21: label-recency register syncs whole-map, per-key max ---------- */

const readRootJson = (name) => JSON.parse(vault.children.get(name).content);

useDevice(memA);
memA.labelMeta = { work: 100, home: 300 };
await syncWithHandle(vault, T0 + 2 * DAY);
const lmFile = readRootJson("labelMeta.json");
check(lmFile.work === 100 && lmFile.home === 300,
  "F21: device A pushes labelMeta.json (whole-map file, not per-record)");

useDevice(memB);
memB.labelMeta = { work: 500, travel: 200 };
await syncWithHandle(vault, T0 + 2 * DAY + 1000);
check(
  memB.labelMeta.work === 500 && memB.labelMeta.home === 300 && memB.labelMeta.travel === 200,
  "F21: device B merges labelMeta by per-key max (keeps its newer work, gains A's home)"
);

useDevice(memA);
await syncWithHandle(vault, T0 + 2 * DAY + 2000);
check(
  memA.labelMeta.work === 500 && memA.labelMeta.home === 300 && memA.labelMeta.travel === 200,
  "F21: both devices converge to the per-key max (A inherits B's travel + newer work)"
);

if (failures > 0) {
  console.error(`\n${failures} vault test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll vault sync tests passed");
process.exit(0);
