/** Two simulated devices share one Vault through delayed propagation.
 * Checks that a same-day Restore-point race cannot prune the other device's
 * young checkpoint, that both Restore lists stay readable, and that a damaged
 * or incomplete daily reference is reported by code instead of failing the
 * list or the sync. Synthetic folders only; no cloud client is exercised.
 */
import assert from "node:assert/strict";
import { createLibraryStore } from "../js/lib/storage/library-store.js";
import { createRecoveryStore } from "../js/lib/storage/recovery-store.js";
import { createStorageAuthority } from "../js/lib/storage/local-authority.js";
import { commitLibraryChange } from "../js/lib/store.js";
import { LIBRARY_SCHEMA, RECOVERY_SCHEMA } from "../js/lib/storage/schema.js";
import { syncVault } from "../js/vault/protocol-sync.js";
import {
  FOREIGN_CHECKPOINT_GRACE_DAYS, FOREIGN_CHECKPOINT_MIN_AGE_MS
} from "../js/vault/checkpoint-sync.js";
import {
  listVaultRestorePoints, listVaultRestorePointsWithReport, previewVaultRestorePoint
} from "../js/vault/restore.js";
import { createMemoryIndexedDbAdapter } from "./memory-indexeddb-adapter.mjs";
import { MemDir, entryAt, names, propagate, propagateAll } from "./vault-memory-fs.mjs";

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

const DAY = 24 * 60 * 60 * 1000;
const D0 = Date.UTC(2026, 3, 1, 12);
const day = (offset) => D0 + offset * DAY;
const utcDay = (time) => new Date(time).toISOString().slice(0, 10);

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
    clock,
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

const checkpointNames = (root) => names(entryAt(root, "checkpoints"));
const backupNames = (root) => names(entryAt(root, "backups"));
const backupsForDay = (root, time) => backupNames(root).filter((name) => name.startsWith(utcDay(time)));
const checkpointOf = (root, backupName) =>
  JSON.parse(entryAt(root, `backups/${backupName}`).content).checkpoint.checkpointId;

let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS: ${name}`); }

/* Day 0: A creates the Vault, B joins through the cloud. */
const a = device("device-a", { value: D0 });
const b = device("device-b", { value: D0 });
const rootA = new MemDir("vault-as-seen-by-a");
await a.save("a-first", "https://a-first.example");
const initial = await a.sync(rootA, day(0));
assert.equal(initial.backedUp, true);
const rootB = new MemDir("vault-as-seen-by-b");
propagateAll(rootA, rootB);
await b.save("b-first", "https://b-first.example");
const joined = await b.sync(rootB, day(0) + 60_000);
assert.equal(joined.checkpointRead, true, "B joins through the bootstrap checkpoint");
assert.equal(joined.backedUp, false, "day 0 already has a Restore point");
propagateAll(rootB, rootA);

await test("same-day backup race keeps the other device's young checkpoint", async () => {
  await a.save("a-day1", "https://a-day1.example");
  const dayOneA = await a.sync(rootA, day(1));
  assert.equal(dayOneA.backedUp, true);
  assert.equal(dayOneA.checkpointWritten, true);
  const [backupA] = backupsForDay(rootA, day(1));
  const checkpointA = checkpointOf(rootA, backupA);

  // The cloud delivers A's checkpoint directory first; A's backup reference
  // and maintenance receipt are still in transit when B opens its Dashboard.
  propagate(rootA, rootB, `checkpoints/${checkpointA}`);
  propagate(rootA, rootB, `devices/${a.deviceId}`);
  await b.save("b-day1", "https://b-day1.example");
  const dayOneB = await b.sync(rootB, day(1) + 5 * 60_000);
  assert.equal(dayOneB.backedUp, true, "B writes its own reference for the day it cannot see");
  assert.equal(dayOneB.checkpointsPruned, 0,
    "B never prunes a checkpoint another device created today");
  assert.ok(checkpointNames(rootB).includes(checkpointA),
    "A's unreferenced young checkpoint survives B's maintenance");
  assert.deepEqual(dayOneB.quarantined, [], "nothing is reported as damaged");

  // Both uploads finish. Each device now sees two references for day 1.
  propagate(rootA, rootB, `backups/${backupA}`);
  propagate(rootA, rootB, "maintenance.json");
  propagate(rootB, rootA, "backups");
  propagate(rootB, rootA, "checkpoints");
  propagate(rootB, rootA, `devices/${b.deviceId}`);
  for (const [label, root] of [["A", rootA], ["B", rootB]]) {
    const listing = await listVaultRestorePointsWithReport(root);
    assert.deepEqual(listing.skipped, [], `${label}'s Restore list reports nothing skipped`);
    assert.equal(listing.points.filter(({ day: pointDay }) => pointDay === utcDay(day(1))).length, 2,
      `${label} lists both devices' day-1 Restore points`);
    assert.equal(listing.points.filter(({ day: pointDay }) => pointDay === utcDay(day(0))).length, 1);
    assert.deepEqual(await listVaultRestorePoints(root), listing.points,
      "the array form keeps returning the usable points");
  }
  const previewOnB = await previewVaultRestorePoint(rootB, { library: b.library, name: backupA });
  assert.equal(previewOnB.point.checkpointId, checkpointA,
    "B can review A's Restore point because its checkpoint was not pruned");
  const settled = await b.sync(rootB, day(1) + 10 * 60_000);
  assert.deepEqual(settled.quarantined, []);
  assert.equal(settled.checkpointsPruned, 0);
});

await test("an unreferenced foreign checkpoint is pruned only after the retention window plus the grace margin", async () => {
  assert.equal(FOREIGN_CHECKPOINT_GRACE_DAYS, 2);
  assert.equal(FOREIGN_CHECKPOINT_MIN_AGE_MS, 9 * DAY);
  const [, backupB] = backupsForDay(rootA, day(1)).sort((left, right) =>
    JSON.parse(entryAt(rootA, `backups/${left}`).content).createdAt -
    JSON.parse(entryAt(rootA, `backups/${right}`).content).createdAt);
  const checkpointB = checkpointOf(rootA, backupB);
  assert.equal(JSON.parse(entryAt(rootA, `checkpoints/${checkpointB}/library.json`).content)
    .sourceDeviceId, b.deviceId);
  const ownDayOne = checkpointOf(rootA, backupsForDay(rootA, day(1))[0] === backupB
    ? backupsForDay(rootA, day(1))[1] : backupsForDay(rootA, day(1))[0]);

  // A alone syncs daily from day 2. Day 1 leaves the retained seven days on day 8.
  for (let offset = 2; offset <= 8; offset += 1) {
    await a.save(`a-day${offset}`, `https://a-day${offset}.example`);
    await a.sync(rootA, day(offset));
  }
  assert.ok(!backupNames(rootA).some((name) => name.startsWith(utcDay(day(1)))),
    "day-1 references left the seven retained days");
  assert.ok(!checkpointNames(rootA).includes(ownDayOne),
    "A's own unreferenced checkpoint is removed at once");
  assert.ok(checkpointNames(rootA).includes(checkpointB),
    "B's unreferenced checkpoint (7 days old) is kept inside the grace margin");
  await a.sync(rootA, day(9) - 1);
  assert.ok(checkpointNames(rootA).includes(checkpointB),
    "still kept just under 9 days of age");
  const pruned = await a.sync(rootA, day(10) + 10 * 60_000);
  assert.ok(!checkpointNames(rootA).includes(checkpointB),
    "removed once it is older than retention plus grace");
  assert.ok(pruned.checkpointsPruned >= 1);
});

await test("a damaged daily reference is reported by code and skipped, never deleted", async () => {
  const [victim] = backupNames(rootA).filter((name) => !name.startsWith(utcDay(day(10))));
  const file = entryAt(rootA, `backups/${victim}`);
  const original = file.content;
  file.content = original.slice(0, Math.floor(original.length / 2));
  const listing = await listVaultRestorePointsWithReport(rootA);
  assert.deepEqual(listing.skipped, [{ code: "vault-damaged-backup", kind: "backup", count: 1 }]);
  assert.ok(!listing.points.some(({ name }) => name === victim));
  assert.ok(listing.points.length >= 6, "the remaining points stay usable");

  const report = await a.sync(rootA, day(11));
  assert.equal(report.backedUp, true, "sync continues and writes the new day's Restore point");
  assert.deepEqual(report.quarantined, [{ code: "vault-damaged-backup", kind: "backup", count: 1 }]);
  assert.equal(entryAt(rootA, `backups/${victim}`), file, "the damaged file is left in place");
  assert.equal(file.content.length, Math.floor(original.length / 2));
  assert.ok(!JSON.stringify(report).includes(victim), "the receipt carries no file name");
  file.content = original;
});

await test("a reference whose checkpoint is missing is reported, not fatal, and today still gets a point", async () => {
  // B has been away. A's day-12 reference reaches B before its checkpoint.
  await a.save("a-day12", "https://a-day12.example");
  await a.sync(rootA, day(12));
  const [backupA12] = backupsForDay(rootA, day(12));
  propagate(rootA, rootB, `backups/${backupA12}`);
  const before = await listVaultRestorePointsWithReport(rootB);
  assert.deepEqual(before.skipped, [{ code: "vault-damaged-backup", kind: "checkpoint", count: 1 }]);
  assert.ok(!before.points.some(({ name }) => name === backupA12));

  const report = await b.sync(rootB, day(12) + 60_000);
  assert.equal(report.backedUp, true, "B writes a complete reference for today");
  assert.ok(report.quarantined.some(({ code, kind }) =>
    code === "vault-damaged-backup" && kind === "checkpoint"));
  assert.ok(entryAt(rootB, `backups/${backupA12}`), "the incomplete reference is left for the cloud to complete");
  propagate(rootA, rootB, `checkpoints/${checkpointOf(rootA, backupA12)}`);
  const after = await listVaultRestorePointsWithReport(rootB);
  assert.ok(after.points.some(({ name }) => name === backupA12),
    "once the checkpoint arrives the point is listed with no further action");
  assert.ok(!after.skipped.some(({ kind }) => kind === "checkpoint"));
});

console.log(`${passed} Vault Restore-point race cases passed`);
