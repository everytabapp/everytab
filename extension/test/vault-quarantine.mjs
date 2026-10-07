/** Quarantine semantics for non-authoritative Vault files.
 * Another device's damaged manifest, a sync-service conflict copy, and iCloud
 * eviction placeholders are skipped and counted; the sync continues and the
 * receipt carries only allowlisted codes and file kinds. Authoritative files
 * (format.json, this device's manifest, referenced checkpoints and chunks)
 * keep failing closed, and newer-format data fails with the update-required
 * code. Synthetic folders only.
 */
import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { commitLibraryChange } from "../js/lib/store.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { classifyFailure } from "../js/lib/failure-diagnostic.js";
import { inspectVaultRoot, syncVault } from "../js/vault/protocol-sync.js";
import { classifyForeignEntry, seal } from "../js/vault/protocol-io.js";
import {
  VAULT_FAILURE_CODES, VaultSyncError, classifyVaultProtocolError, readQuarantine,
  recordQuarantine, vaultFailureCode, vaultFailureFileKind
} from "../js/vault/failure-codes.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import {
  MemDir, MemFile, cloneEntry, entryAt, propagateAll, readJson
} from "./vault-memory-fs.mjs";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { locks: { async request(name, options, work) { return work({ name }); } } }
});
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener() {}, removeListener() {} }
  }
};

const T0 = Date.UTC(2026, 4, 1, 12);

function device(deviceId, clock) {
  const library = createLibraryStore({
    adapter: createMemoryIndexedDbAdapter(LIBRARY_SCHEMA),
    deviceId,
    createId: () => `${deviceId}-source`,
    now: () => clock.value
  });
  const recovery = createRecoveryStore({
    adapter: createMemoryIndexedDbAdapter(RECOVERY_SCHEMA),
    now: () => clock.value
  });
  const authority = createStorageAuthority({ library, recovery });
  let ids = 0;
  return {
    deviceId,
    library,
    sync: (root, now) => {
      clock.value = now;
      return syncVault(root, {
        library, recovery, now,
        createId: () => `${deviceId}-id-${++ids}`,
        commitRemoteApply: (apply) => commitLibraryChange(apply, { authority })
      });
    },
    async save(id, url) {
      await library.transact([{
        type: "put", family: "inbox", id,
        value: { id, kind: "tab", tabs: [{ url, title: id }], labels: [] }
      }]);
    }
  };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS: ${name}`); }

/* A creates the Vault; B and C join and each publish one record. */
const clock = { value: T0 };
const a = device("device-a", clock);
const b = device("device-b", clock);
const c = device("device-c", clock);
const root = new MemDir("vault-as-seen-by-a");
await a.save("a-first", "https://a-first.example");
await a.sync(root, T0);
const rootB = cloneEntry(root);
await b.save("b-first", "https://b-first.example");
await b.sync(rootB, T0 + 1_000);
const rootC = cloneEntry(root);
await c.save("c-first", "https://c-first.example");
await c.sync(rootC, T0 + 2_000);
propagateAll(rootB, root);
propagateAll(rootC, root);
const healthy = await a.sync(root, T0 + 3_000);
assert.equal(healthy.pulled, 2);
assert.deepEqual(healthy.quarantined, []);
const manifestB = entryAt(root, `devices/${b.deviceId}/manifest.json`);
const manifestBText = manifestB.content;

await test("foreign entry names are classified without reading them", () => {
  assert.equal(classifyForeignEntry(".format.json.icloud"), "placeholder");
  assert.equal(classifyForeignEntry(".manifest.json.icloud"), "placeholder");
  assert.equal(classifyForeignEntry("device-b (conflicted copy 2026-10-01).json"), "conflict-copy");
  assert.equal(classifyForeignEntry("device-b (1)"), "conflict-copy");
  assert.equal(classifyForeignEntry("manifest 2.json"), "conflict-copy");
  assert.equal(classifyForeignEntry(".sync-conflict-20261001-120000-ABCDEF.json"), "conflict-copy");
  assert.equal(classifyForeignEntry("manifest.json"), null);
  assert.equal(classifyForeignEntry(".DS_Store"), null);
});

await test("a damaged foreign manifest skips that device only; other devices still sync", async () => {
  manifestB.content = manifestBText.slice(0, 40);
  await c.save("c-second", "https://c-second.example");
  await c.sync(rootC, T0 + 4_000);
  propagateAll(rootC, root);
  const report = await a.sync(root, T0 + 5_000);
  assert.deepEqual(report.quarantined,
    [{ code: VAULT_FAILURE_CODES.foreignManifestUnreadable, kind: "manifest", count: 1 }]);
  assert.equal(report.pulled, 1, "C's new record still arrives");
  assert.ok(await a.library.readEntity("inbox", "c-second"));
  assert.equal(manifestB.content, manifestBText.slice(0, 40), "the damaged file is never deleted or rewritten");
  assert.ok(!JSON.stringify(report).includes(b.deviceId), "the receipt names no device identity");

  manifestB.content = manifestBText;
  const healed = await a.sync(root, T0 + 6_000);
  assert.deepEqual(healed.quarantined, [], "a readable manifest ends the quarantine with no action");
});

await test("a sync-service conflict copy inside devices/ is counted and left in place", async () => {
  const devices = entryAt(root, "devices");
  const copyName = `${b.deviceId} (conflicted copy 2026-05-01)`;
  const copy = cloneEntry(entryAt(root, `devices/${b.deviceId}`));
  copy.name = copyName;
  devices.children.set(copyName, copy);
  const report = await a.sync(root, T0 + 7_000);
  assert.deepEqual(report.quarantined,
    [{ code: VAULT_FAILURE_CODES.conflictCopy, kind: "directory", count: 1 }]);
  assert.equal(devices.children.get(copyName), copy, "the copy is not removed or read as a device");
  devices.children.delete(copyName);
});

await test("an evicted foreign manifest is reported as a placeholder and that device is skipped", async () => {
  const deviceB = entryAt(root, `devices/${b.deviceId}`);
  deviceB.children.delete("manifest.json");
  deviceB.children.set(".manifest.json.icloud", new MemFile(".manifest.json.icloud", "placeholder"));
  const report = await a.sync(root, T0 + 8_000);
  assert.deepEqual(report.quarantined,
    [{ code: VAULT_FAILURE_CODES.placeholderFile, kind: "manifest", count: 1 }]);
  deviceB.children.delete(".manifest.json.icloud");
  deviceB.children.set("manifest.json", manifestB);
  assert.deepEqual((await a.sync(root, T0 + 9_000)).quarantined, []);
});

await test("an evicted format.json is a placeholder Vault, never an unrecognized folder", async () => {
  const evicted = new MemDir("evicted-vault");
  evicted.children.set(".format.json.icloud", new MemFile(".format.json.icloud", ""));
  evicted.children.set("devices", cloneEntry(entryAt(root, "devices")));
  const inspection = await inspectVaultRoot(evicted);
  assert.equal(inspection.state, "placeholder");
  assert.equal(inspection.failureCode, VAULT_FAILURE_CODES.placeholderFile);
  assert.equal(inspection.fileKind, "format");
  assert.doesNotMatch(inspection.message, /new empty folder/i);
  await assert.rejects(a.sync(evicted, T0 + 10_000), (error) => {
    assert.equal(vaultFailureCode(error), VAULT_FAILURE_CODES.placeholderFile);
    assert.equal(vaultFailureFileKind(error), "format");
    assert.equal(classifyFailure(error), "code:vault-placeholder-file");
    return true;
  });
  const onlyPlaceholders = new MemDir("all-evicted");
  onlyPlaceholders.children.set(".library.json.icloud", new MemFile(".library.json.icloud", ""));
  assert.equal((await inspectVaultRoot(onlyPlaceholders)).state, "placeholder");
  const unrelated = new MemDir("unrelated");
  unrelated.children.set("notes.txt", new MemFile("notes.txt", "x"));
  assert.equal((await inspectVaultRoot(unrelated)).state, "unrecognized");
});

await test("an evicted referenced transaction chunk fails closed with the placeholder code", async () => {
  const transactions = entryAt(rootC, `devices/${c.deviceId}/transactions`);
  const [chunkName] = [...transactions.children.keys()];
  const chunk = transactions.children.get(chunkName);
  transactions.children.delete(chunkName);
  transactions.children.set(`.${chunkName}.icloud`, new MemFile(`.${chunkName}.icloud`, ""));
  const late = device("device-late", clock);
  await assert.rejects(late.sync(rootC, T0 + 11_000), (error) => {
    assert.equal(vaultFailureCode(error), VAULT_FAILURE_CODES.placeholderFile);
    assert.equal(vaultFailureFileKind(error), "transaction");
    return true;
  });
  transactions.children.delete(`.${chunkName}.icloud`);
  transactions.children.set(chunkName, chunk);
});

await test("newer-format data fails closed with the update-required code", async () => {
  const newerFormat = cloneEntry(root);
  const format = readJson(newerFormat, "format.json");
  delete format.contentHash;
  newerFormat.children.get("format.json").content =
    JSON.stringify(await seal({ ...format, formatVersion: 2 }));
  const inspection = await inspectVaultRoot(newerFormat);
  assert.equal(inspection.state, "invalid");
  assert.equal(inspection.failureCode, VAULT_FAILURE_CODES.updateRequired);
  await assert.rejects(a.sync(newerFormat, T0 + 12_000), (error) => {
    assert.equal(vaultFailureCode(error), VAULT_FAILURE_CODES.updateRequired);
    assert.equal(classifyFailure(error), "code:vault-update-required");
    return true;
  });

  const newerManifest = cloneEntry(root);
  const manifest = readJson(entryAt(newerManifest, `devices/${b.deviceId}`), "manifest.json");
  delete manifest.contentHash;
  entryAt(newerManifest, `devices/${b.deviceId}/manifest.json`).content =
    JSON.stringify(await seal({ ...manifest, formatVersion: 2 }));
  await assert.rejects(a.sync(newerManifest, T0 + 13_000), (error) => {
    assert.equal(vaultFailureCode(error), VAULT_FAILURE_CODES.updateRequired);
    assert.equal(vaultFailureFileKind(error), "manifest");
    return true;
  }, "a newer manifest is not quarantined as merely unreadable");

  // A valid, sealed chunk carrying a record family this build does not know.
  const futureRoot = cloneEntry(root);
  const deviceDirectory = entryAt(futureRoot, `devices/${c.deviceId}`);
  const current = readJson(deviceDirectory, "manifest.json");
  const transactions = deviceDirectory.children.get("transactions");
  const sample = JSON.parse([...transactions.children.values()].at(-1).content);
  const change = structuredClone(sample.changes[0]);
  change.sequence = current.throughSequence + 1;
  change.entity.family = "futureFamily";
  change.entity.id = "future-record";
  const { contentHash: _chunkHash, ...chunkBody } = sample;
  const chunk = await seal({
    ...chunkBody, fromSequence: change.sequence, throughSequence: change.sequence,
    changes: [change], assetManifest: []
  });
  const name = `${String(change.sequence).padStart(12, "0")}-${String(change.sequence)
    .padStart(12, "0")}-${chunk.contentHash.slice("sha256:".length)}.json`;
  transactions.children.set(name, new MemFile(name, JSON.stringify(chunk)));
  const { contentHash: _manifestHash, ...manifestBody } = current;
  deviceDirectory.children.get("manifest.json").content = JSON.stringify(await seal({
    ...manifestBody,
    throughSequence: change.sequence,
    chunks: [...current.chunks, {
      name, fromSequence: change.sequence, throughSequence: change.sequence,
      contentHash: chunk.contentHash
    }]
  }));
  await assert.rejects(a.sync(futureRoot, T0 + 14_000), (error) => {
    assert.equal(vaultFailureCode(error), VAULT_FAILURE_CODES.updateRequired);
    assert.match(error.message, /Update EveryTab/);
    return true;
  }, "an unsupported family inside a verified chunk reports update-required");
  assert.equal(await a.library.readEntity("inbox", "future-record"), null);
});

await test("authoritative files still fail closed without a quarantine", async () => {
  const ownDamaged = cloneEntry(root);
  const own = entryAt(ownDamaged, `devices/${a.deviceId}/manifest.json`);
  own.content = own.content.slice(0, 40);
  await assert.rejects(a.sync(ownDamaged, T0 + 15_000), (error) => {
    assert.equal(vaultFailureCode(error), null);
    return true;
  }, "this device's own manifest is authoritative");

  const bootstrapDamaged = cloneEntry(root);
  const bootstrapId = readJson(bootstrapDamaged, "format.json").bootstrap.checkpointId;
  const checkpoint = entryAt(bootstrapDamaged, `checkpoints/${bootstrapId}/library.json`);
  checkpoint.content = checkpoint.content.slice(0, 40);
  const joiner = device("device-joiner", clock);
  await assert.rejects(joiner.sync(bootstrapDamaged, T0 + 16_000),
    "a joining device never accepts a damaged bootstrap checkpoint");
});

await test("failure codes and quarantine entries are allowlisted and content free", () => {
  const error = new VaultSyncError("x", { code: "vault-made-up", kind: "weird" });
  assert.equal(error.code, null);
  assert.equal(error.fileKind, "file");
  assert.equal(vaultFailureCode({ code: "vault-damaged-backup" }), "vault-damaged-backup");
  assert.equal(vaultFailureCode({ code: "name:Error" }), null);
  assert.equal(vaultFailureCode({ get code() { throw new Error("hostile"); } }), null);
  const classified = classifyVaultProtocolError(
    new Error("Unsupported saved-data version. Update EveryTab before using this data.")
  );
  assert.equal(classified.code, VAULT_FAILURE_CODES.updateRequired);
  const plain = new Error("something else");
  assert.equal(classifyVaultProtocolError(plain), plain);
  const report = {};
  recordQuarantine(report, VAULT_FAILURE_CODES.damagedBackup, "backup");
  recordQuarantine(report, VAULT_FAILURE_CODES.damagedBackup, "backup");
  recordQuarantine(report, VAULT_FAILURE_CODES.conflictCopy, "directory");
  assert.deepEqual(report.quarantined, [
    { code: VAULT_FAILURE_CODES.conflictCopy, kind: "directory", count: 1 },
    { code: VAULT_FAILURE_CODES.damagedBackup, kind: "backup", count: 2 }
  ]);
  assert.throws(() => recordQuarantine({}, "vault-made-up", "backup"));
  assert.deepEqual(readQuarantine([
    { code: VAULT_FAILURE_CODES.damagedBackup, kind: "backup", count: 1 },
    { code: "vault-made-up", kind: "backup", count: 1 },
    { code: VAULT_FAILURE_CODES.damagedBackup, kind: "backup", count: 0 },
    "junk"
  ]), [{ code: VAULT_FAILURE_CODES.damagedBackup, kind: "backup", count: 1 }]);
});

console.log(`${passed} Vault quarantine cases passed`);
