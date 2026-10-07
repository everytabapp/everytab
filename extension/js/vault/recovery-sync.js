// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Device-scoped, bounded Recovery replication for the Vault. */
import {
  VAULT_FORMAT_VERSION,
  DIGEST,
  entries,
  optionalFileHandle,
  parseJson,
  readNamedFile,
  requiredCount,
  seal,
  verifySeal,
  writeJson
} from "./protocol-io.js";

const MANIFEST_FILE = "manifest.json";
const RECOVERY_DIR = "recovery";
const RECOVERY_PACKS_DIR = "packs";
const MAX_RECOVERY_PACKS = 16;
const MAX_PUBLISHED_ASSETS = 10_000;

function recoveryPackFileName(fromSequence, throughSequence, digest) {
  const match = DIGEST.exec(digest);
  if (!match) throw new Error("Vault Recovery pack digest is invalid");
  return `${String(fromSequence).padStart(12, "0")}-${String(throughSequence)
    .padStart(12, "0")}-${match[1]}.json.gz`;
}

async function gzipText(text) {
  if (typeof CompressionStream !== "function") {
    throw new Error("Chrome compression support is required for Vault Recovery");
  }
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(bytes, label) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("Chrome decompression support is required for Vault Recovery");
  }
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  } catch {
    throw new Error(`${label} is not valid gzip data`);
  }
}

async function readFileBytes(handle, label) {
  if (!handle || handle.kind !== "file") throw new Error(`${label} is missing`);
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

async function writeBytes(directory, name, bytes) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function writeImmutableCompressedJson(directory, name, value) {
  const existing = await optionalFileHandle(directory, name);
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  if (existing) {
    const current = await gunzipText(await readFileBytes(existing, name), name);
    if (current !== expected) {
      throw new Error(`Immutable Vault file ${name} has conflicting content`);
    }
    return false;
  }
  await writeBytes(directory, name, await gzipText(expected));
  return true;
}

async function verifyRecoveryManifest(manifest, identity, cryptoProvider) {
  const { vaultId, deviceId, sourceId } = identity;
  await verifySeal(manifest, `Recovery manifest for ${deviceId}`, cryptoProvider);
  if (manifest.app !== "everytab" || manifest.kind !== "vault-v2-recovery-manifest" ||
      manifest.formatVersion !== VAULT_FORMAT_VERSION || manifest.vaultId !== vaultId ||
      manifest.deviceId !== deviceId || manifest.sourceId !== sourceId ||
      !Array.isArray(manifest.packs) || manifest.packs.length > MAX_RECOVERY_PACKS ||
      !Array.isArray(manifest.snapshots) || manifest.snapshots.length > 10_000 ||
      typeof manifest.cleanupPending !== "boolean") {
    throw new Error(`Recovery manifest for ${deviceId} is invalid`);
  }
  const sequence = requiredCount(manifest.sequence, `Recovery sequence for ${deviceId}`);
  const publishedAssetDigests = manifest.publishedAssetDigests ?? [];
  if (!Array.isArray(publishedAssetDigests)) {
    throw new Error(`Recovery asset receipt for ${deviceId} is invalid`);
  }
  let previousDigest = "";
  for (const digest of publishedAssetDigests) {
    if (!DIGEST.test(digest) || digest <= previousDigest) {
      throw new Error(`Recovery asset receipt for ${deviceId} is invalid`);
    }
    previousDigest = digest;
  }
  const packNames = verifyPackDescriptors(manifest.packs, deviceId);
  verifySnapshotIndex(manifest.snapshots, { sequence, packNames, deviceId });
  if ((manifest.snapshots.length === 0) !== (manifest.packs.length === 0)) {
    throw new Error(`Recovery pack references for ${deviceId} are invalid`);
  }
  return { ...manifest, publishedAssetDigests };
}

function verifyPackDescriptors(packs, deviceId) {
  const names = new Set();
  let previousSequence = Number.POSITIVE_INFINITY;
  for (const descriptor of packs) {
    const sequence = requiredCount(descriptor?.sequence, "Recovery pack sequence");
    const from = requiredCount(
      descriptor?.fromSnapshotSequence, "Recovery pack first Snapshot sequence"
    );
    const through = requiredCount(
      descriptor?.throughSnapshotSequence, "Recovery pack last Snapshot sequence"
    );
    requiredCount(descriptor?.snapshotCount, "Recovery pack Snapshot count");
    if (sequence >= previousSequence || through > sequence || from > through ||
        !DIGEST.test(descriptor?.contentHash ?? "") ||
        !DIGEST.test(descriptor?.recoveryContentHash ?? "") ||
        descriptor.name !== recoveryPackFileName(from, sequence, descriptor.contentHash) ||
        names.has(descriptor.name)) {
      throw new Error(`Recovery packs for ${deviceId} are invalid`);
    }
    names.add(descriptor.name);
    previousSequence = sequence;
  }
  return names;
}

function verifySnapshotIndex(snapshots, { sequence, packNames, deviceId }) {
  const ids = new Set();
  const referencedPacks = new Set();
  for (const snapshot of snapshots) {
    const snapshotSequence = requiredCount(snapshot?.sequence, "Recovery Snapshot sequence");
    if (typeof snapshot?.id !== "string" || !snapshot.id || ids.has(snapshot.id) ||
        snapshotSequence > sequence || !DIGEST.test(snapshot?.contentHash ?? "") ||
        typeof snapshot?.packName !== "string" || !packNames.has(snapshot.packName)) {
      throw new Error(`Recovery Snapshot index for ${deviceId} is invalid`);
    }
    ids.add(snapshot.id);
    referencedPacks.add(snapshot.packName);
  }
  if (referencedPacks.size !== packNames.size) {
    throw new Error(`Recovery pack references for ${deviceId} are invalid`);
  }
}

async function readRecoveryManifest(directory, identity, cryptoProvider) {
  const text = await readNamedFile(directory, MANIFEST_FILE, { optional: true });
  if (text === null) return null;
  return verifyRecoveryManifest(
    parseJson(text, `Recovery manifest for ${identity.deviceId}`),
    identity,
    cryptoProvider
  );
}

function normalizeRecoveryState(state) {
  const sequence = requiredCount(state.sequence, "Local Recovery sequence");
  const snapshotCount = requiredCount(state.snapshotCount, "Local Recovery Snapshot count");
  if (!Array.isArray(state.snapshots) || state.snapshots.length !== snapshotCount ||
      state.snapshots.length > 10_000) {
    throw new Error("Local Recovery Snapshot index is invalid");
  }
  const ids = new Set();
  const snapshots = state.snapshots.map((snapshot) => {
    if (typeof snapshot?.id !== "string" || !snapshot.id || ids.has(snapshot.id)) {
      throw new Error("Local Recovery Snapshot identity is invalid");
    }
    const snapshotSequence = requiredCount(snapshot.sequence, "Local Recovery Snapshot sequence");
    if (snapshotSequence > sequence) {
      throw new Error("Local Recovery Snapshot sequence is ahead of its store");
    }
    ids.add(snapshot.id);
    return { id: snapshot.id, sequence: snapshotSequence };
  });
  return { ...state, sequence, snapshotCount, snapshots };
}

function planPublication(state, manifest) {
  const previousById = new Map((manifest?.snapshots ?? []).map((snapshot) => [
    snapshot.id,
    snapshot
  ]));
  const unchanged = state.snapshots.filter((snapshot) =>
    previousById.get(snapshot.id)?.sequence === snapshot.sequence
  );
  const changed = state.snapshots.filter((snapshot) =>
    previousById.get(snapshot.id)?.sequence !== snapshot.sequence
  );
  const unchangedPackNames = new Set(
    unchanged.map(({ id }) => previousById.get(id).packName)
  );
  const retainedPacks = (manifest?.packs ?? []).filter(({ name }) =>
    unchangedPackNames.has(name)
  );
  const compact = changed.length > 0 && retainedPacks.length + 1 > MAX_RECOVERY_PACKS;
  return {
    previousById,
    retainedPacks: compact ? [] : retainedPacks,
    compact,
    exporting: compact ? state.snapshots : changed,
    publishedAssetDigests: manifest?.publishedAssetDigests ?? []
  };
}

async function writeRecoveryPack({
  assetWriter, packsDirectory, recovery, state, identity, plan,
  now, cryptoProvider, report, onProgress
}) {
  if (plan.exporting.length === 0) {
    return { descriptor: null, packedById: new Map(), assetDigests: [] };
  }
  onProgress({ stage: "reading", target: "recovery", completed: 0,
    total: plan.exporting.length });
  const pack = await recovery.exportRecoveryPack({
    limit: state.retention,
    ids: plan.exporting.map(({ id }) => id)
  });
  const packSequence = requiredCount(pack.sequence, "Exported Recovery sequence");
  if (packSequence !== state.sequence) {
    throw new Error("Recovery changed while its Vault pack was being prepared");
  }
  const snapshotSequences = pack.snapshots.map(({ sequence }) =>
    requiredCount(sequence, "Recovery Snapshot sequence")
  );
  const fromSnapshotSequence = Math.min(...snapshotSequences);
  const throughSnapshotSequence = Math.max(...snapshotSequences);
  if (throughSnapshotSequence > packSequence) {
    throw new Error("Recovery pack contains a future Snapshot sequence");
  }
  assetWriter.remember(plan.publishedAssetDigests);
  await assetWriter.write(pack.assets, report, onProgress);
  const envelope = await seal({
    app: "everytab",
    kind: "vault-v2-recovery-pack",
    formatVersion: VAULT_FORMAT_VERSION,
    ...identity,
    sequence: packSequence,
    createdAt: now,
    recoveryCreatedAt: pack.createdAt,
    recoveryContentHash: pack.contentHash,
    snapshots: pack.snapshots,
    assetManifest: pack.assets.map(({ dataUrl: _dataUrl, ...asset }) => asset)
  }, cryptoProvider);
  const name = recoveryPackFileName(fromSnapshotSequence, packSequence, envelope.contentHash);
  await writeImmutableCompressedJson(packsDirectory, name, envelope);
  report.recoveryPackWritten = true;
  report.recoverySnapshotsWritten = pack.snapshots.length;
  report.recoveryCompacted = plan.compact;
  onProgress({ stage: "reading", target: "recovery", completed: pack.snapshots.length,
    total: pack.snapshots.length });
  return {
    descriptor: {
      name,
      sequence: packSequence,
      fromSnapshotSequence,
      throughSnapshotSequence,
      snapshotCount: pack.snapshots.length,
      contentHash: envelope.contentHash,
      recoveryContentHash: pack.contentHash
    },
    packedById: new Map(pack.snapshots.map((snapshot) => [snapshot.id, {
      id: snapshot.id,
      sequence: snapshot.sequence,
      contentHash: snapshot.contentHash,
      packName: name
    }])),
    assetDigests: pack.assets.map(({ digest }) => digest)
  };
}

async function writeRecoveryManifest({
  deviceDirectory, state, identity, plan, packResult, now, cryptoProvider
}) {
  const snapshots = state.snapshots.map(({ id }) => {
    const indexed = packResult.packedById.get(id) ?? plan.previousById.get(id);
    if (!indexed) throw new Error("Recovery Snapshot was not included in its Vault pack");
    return indexed;
  });
  const packs = packResult.descriptor
    ? [packResult.descriptor, ...plan.retainedPacks]
    : plan.retainedPacks;
  const publishedAssetDigests = [...new Set([
    ...plan.publishedAssetDigests,
    ...packResult.assetDigests
  ])].slice(-MAX_PUBLISHED_ASSETS).sort();
  const manifest = await seal({
    app: "everytab",
    kind: "vault-v2-recovery-manifest",
    formatVersion: VAULT_FORMAT_VERSION,
    ...identity,
    sequence: state.sequence,
    snapshots,
    packs,
    publishedAssetDigests,
    cleanupPending: true,
    updatedAt: now
  }, cryptoProvider);
  await writeJson(deviceDirectory, MANIFEST_FILE, manifest);
  return manifest;
}

async function finishRecoveryCleanup({
  deviceDirectory, packsDirectory, manifest, now, cryptoProvider, report
}) {
  if (!manifest.cleanupPending) return manifest;
  const keepNames = new Set(manifest.packs.map(({ name }) => name));
  for (const { name, handle } of await entries(packsDirectory)) {
    if (handle.kind !== "file" || keepNames.has(name)) continue;
    await packsDirectory.removeEntry(name);
    report.recoveryPacksPruned += 1;
  }
  const cleaned = { ...manifest, cleanupPending: false, updatedAt: now };
  delete cleaned.contentHash;
  const sealed = await seal(cleaned, cryptoProvider);
  await writeJson(deviceDirectory, MANIFEST_FILE, sealed);
  return sealed;
}

/** Publish only this device's retained Recovery history. Remote packs are never imported. */
export async function publishRecovery({
  root, recovery, format, replication, now, cryptoProvider, report, onProgress, assetWriter
}) {
  const state = normalizeRecoveryState(await recovery.readReplicationState());
  const recoveryDirectory = await root.getDirectoryHandle(RECOVERY_DIR, { create: true });
  const deviceDirectory = await recoveryDirectory.getDirectoryHandle(
    replication.deviceId,
    { create: true }
  );
  const packsDirectory = await deviceDirectory.getDirectoryHandle(
    RECOVERY_PACKS_DIR,
    { create: true }
  );
  const identity = {
    vaultId: format.vaultId,
    deviceId: replication.deviceId,
    sourceId: replication.sourceId
  };
  let manifest = await readRecoveryManifest(deviceDirectory, identity, cryptoProvider);
  if (manifest && manifest.sequence > state.sequence) {
    throw new Error("The Vault Recovery manifest is ahead of this local Recovery store");
  }
  if (!manifest || manifest.sequence < state.sequence) {
    const plan = planPublication(state, manifest);
    const packResult = await writeRecoveryPack({
      assetWriter, packsDirectory, recovery, state, identity, plan,
      now, cryptoProvider, report, onProgress
    });
    manifest = await writeRecoveryManifest({
      deviceDirectory, state, identity, plan, packResult, now, cryptoProvider
    });
  } else if (manifest.publishedAssetDigests.length > MAX_PUBLISHED_ASSETS) {
    // Earlier writers accumulated this optimization cache without a bound.
    // Validate its original seal first, then trim only hints, never asset files.
    // Forgotten digests fall back to the writer's normal file-content check.
    const body = { ...manifest,
      publishedAssetDigests: manifest.publishedAssetDigests.slice(-MAX_PUBLISHED_ASSETS) };
    delete body.contentHash;
    manifest = await seal(body, cryptoProvider);
    await writeJson(deviceDirectory, MANIFEST_FILE, manifest);
  }
  return finishRecoveryCleanup({
    deviceDirectory, packsDirectory, manifest, now, cryptoProvider, report
  });
}
