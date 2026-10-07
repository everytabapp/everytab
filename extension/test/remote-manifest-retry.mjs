import assert from "node:assert/strict";
import {
  pullWithFreshManifest, readRemoteVaultState
} from "../js/vault/remote-manifest-retry.js";

const manifest = {
  deviceId: "peer", sourceId: "source", contentHash: "first",
  baseSequence: 0, throughSequence: 2
};
const missing = new Error("missing file");
const failRead = () => readRemoteVaultState(() => { throw missing; });

let reads = 0;
assert.equal(await pullWithFreshManifest({
  manifest, readManifest: () => { reads += 1; }, pull: async () => {}
}), manifest);
assert.equal(reads, 0, "successful pulls never reread the manifest");

await assert.rejects(pullWithFreshManifest({
  manifest, readManifest: async () => manifest, pull: failRead
}), (error) => error === missing, "unchanged heads preserve the original read error");

for (const change of [
  { sourceId: "other" }, { deviceId: "other" },
  { baseSequence: 0, throughSequence: 1 }
]) {
  let attempts = 0;
  await assert.rejects(pullWithFreshManifest({
    manifest, readManifest: async () => ({ ...manifest, contentHash: "next", ...change }),
    pull: () => { attempts += 1; return failRead(); }
  }), /identity changed|moved backwards/);
  assert.equal(attempts, 1);
}
await assert.rejects(pullWithFreshManifest({
  manifest: { ...manifest, baseSequence: 2 },
  readManifest: async () => ({ ...manifest, contentHash: "next", baseSequence: 1 }),
  pull: failRead
}), /moved backwards/, "base regression is rejected even with an unchanged head");

const invalidManifest = new Error("bad seal");
await assert.rejects(pullWithFreshManifest({
  manifest, readManifest: async () => { throw invalidManifest; }, pull: failRead
}), (error) => error === invalidManifest);

let attempts = 0;
reads = 0;
await assert.rejects(pullWithFreshManifest({
  manifest,
  readManifest: async () => ({
    ...manifest, contentHash: String(++reads), throughSequence: 2 + reads
  }),
  pull: (_head, attempt) => {
    assert.equal(attempt, attempts++);
    return failRead();
  }
}), (error) => error === missing);
assert.equal(attempts, 3, "continuously changing heads cannot create an endless retry");
assert.equal(reads, 2);

const next = { ...manifest, contentHash: "next", baseSequence: 2 };
const seen = [];
assert.equal(await pullWithFreshManifest({
  manifest, readManifest: async () => next,
  pull: async (head, attempt) => {
    seen.push([head, attempt]);
    if (attempt === 0) await failRead();
  }
}), next, "the successful head is returned to view publication");
assert.deepEqual(seen, [[manifest, 0], [next, 1]]);

for (const operation of [
  () => { throw new Error("local commit failed"); },
  () => readRemoteVaultState((progress) => progress({ completed: 1 }), () => {
    throw new Error("progress failed");
  }),
  () => readRemoteVaultState(async (progress) => {
    await Promise.resolve();
    progress({ completed: 1 });
  }, () => { throw new Error("async read progress failed"); })
]) {
  reads = 0;
  await assert.rejects(pullWithFreshManifest({
    manifest, readManifest: async () => { reads += 1; return next; }, pull: operation
  }), /failed/);
  assert.equal(reads, 0, "local and progress failures are not stale-file retries");
}

console.log("PASS: remote manifest retry policy");
