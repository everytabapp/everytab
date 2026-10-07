// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Bounded automatic-Snapshot recovery module, separate from the Library. */
import {
  assetDigestsIn, externalizeEmbeddedFavicons, hydrateEmbeddedFavicons,
  readAssetsByDigest
} from "./assets.js";
import { contentHash } from "./canonical.js";
import { createIndexedDbAdapter } from "./indexeddb-adapter.js";
import { RECOVERY_SCHEMA, RECOVERY_STORES } from "./schema.js";
import { requireSupportedValue } from "./record-format.js";

export const MAX_RECOVERY_SNAPSHOTS = 10_000;
const META_RETENTION = "retention";
const META_NEWEST = "newestSnapshot";
const META_ORDER = "snapshotOrder";
const META_SEQUENCE = "snapshotSequence";
const META_DELETIONS = "snapshotDeletions";
// Only deletion identities are retained, never deleted tab lists or assets.
export const MAX_RECOVERY_DELETION_MARKERS = 200;

/** Public Recovery interface, inferred from its single constructor. @typedef {ReturnType<typeof createRecoveryStore>} RecoveryStore */
/** Adapter interface at the Recovery persistence seam. @typedef {ReturnType<typeof createIndexedDbAdapter>} RecoveryStorageAdapter */

export function makeRecoveryDeletionMarker(id) {
  const at = Math.max(1, Date.now());
  return {
    id, auto: true, deviceId: "recovery", schemaVersion: 1,
    createdAt: at, modifiedAt: at, deletedAt: at,
    deletionRevision: globalThis.crypto.randomUUID()
  };
}

async function deletionMarkers(transaction) {
  const stored = await transaction.get(RECOVERY_STORES.meta, META_DELETIONS);
  const entries = Array.isArray(stored?.value) ? stored.value : [];
  entries.forEach(requireSupportedValue);
  const seen = new Set();
  return entries.filter((marker) => {
    if (typeof marker?.id !== "string" || !marker.id || seen.has(marker.id) ||
        marker.auto !== true || !Number.isFinite(marker.deletedAt) || marker.deletedAt <= 0 ||
        typeof marker.deletionRevision !== "string" || !marker.deletionRevision) return false;
    seen.add(marker.id);
    return true;
  }).slice(0, MAX_RECOVERY_DELETION_MARKERS);
}

export function normalizeRecoveryRetention(value) {
  if (value === 0) return MAX_RECOVERY_SNAPSHOTS;
  if (!Number.isFinite(value)) return 200;
  return Math.min(MAX_RECOVERY_SNAPSHOTS, Math.max(1, Math.floor(value)));
}

async function assetsForSnapshots(transaction, snapshots) {
  return readAssetsByDigest(
    transaction,
    RECOVERY_STORES.assets,
    snapshots.flatMap((snapshot) => snapshot.assetDigests ?? [])
  );
}

function publicSnapshot(snapshot, assets, options) {
  requireSupportedValue(snapshot.value);
  return {
    id: snapshot.id,
    capturedAt: snapshot.capturedAt,
    contentHash: snapshot.contentHash,
    value: hydrateEmbeddedFavicons(snapshot.value, assets, options)
  };
}

function publicAsset(asset) {
  const { refCount: _refCount, ...portable } = asset;
  return portable;
}

function addAssetDelta(deltas, digests, amount) {
  for (const digest of digests ?? []) deltas.set(digest, (deltas.get(digest) ?? 0) + amount);
}

async function updateAssetReferences(transaction, newAssets, deltas) {
  const supplied = new Map(newAssets.map((asset) => [asset.digest, asset]));
  for (const [digest, delta] of deltas) {
    if (delta === 0) continue;
    const existing = await transaction.get(RECOVERY_STORES.assets, digest);
    const currentCount = existing?.refCount;
    if (existing && (!Number.isSafeInteger(currentCount) || currentCount < 1)) {
      throw new Error(`Recovery asset ${digest} has an invalid reference count`);
    }
    const nextCount = (currentCount ?? 0) + delta;
    if (nextCount < 0) throw new Error(`Recovery asset ${digest} reference count became negative`);
    if (nextCount === 0) {
      await transaction.delete(RECOVERY_STORES.assets, digest);
      continue;
    }
    const source = existing ?? supplied.get(digest);
    if (!source) throw new Error(`Recovery Snapshot is missing asset ${digest}`);
    await transaction.put(RECOVERY_STORES.assets, { ...source, refCount: nextCount });
  }
}

async function snapshotOrder(transaction) {
  const meta = await transaction.get(RECOVERY_STORES.meta, META_ORDER);
  if (Array.isArray(meta?.value)) return structuredClone(meta.value);
  const snapshots = await transaction.getAll(RECOVERY_STORES.snapshots);
  return snapshots.map(({ id, sequence = 0 }) => ({ id, sequence }))
    .sort((left, right) => right.sequence - left.sequence || right.id.localeCompare(left.id));
}

async function verifiedRecoveryPack(pack, cryptoProvider) {
  if (!pack || pack.app !== "everytab" || pack.kind !== "recovery-pack" ||
      pack.formatVersion !== 1 || !Array.isArray(pack.snapshots) ||
      !Array.isArray(pack.assets) || pack.snapshots.length > MAX_RECOVERY_SNAPSHOTS) {
    throw new Error("Recovery pack is invalid");
  }
  const { contentHash: suppliedHash, ...body } = pack;
  if (typeof suppliedHash !== "string" ||
      suppliedHash !== await contentHash(body, cryptoProvider)) {
    throw new Error("Recovery pack content hash does not match");
  }
  if (pack.sequence !== undefined &&
      (!Number.isSafeInteger(pack.sequence) || pack.sequence < 0)) {
    throw new Error("Recovery pack sequence is invalid");
  }

  const assets = new Map();
  for (const candidate of pack.assets) {
    if (!candidate || typeof candidate.digest !== "string" ||
        typeof candidate.dataUrl !== "string" || assets.has(candidate.digest)) {
      throw new Error("Recovery pack asset is invalid");
    }
    const probe = await externalizeEmbeddedFavicons(
      { favIconUrl: candidate.dataUrl }, cryptoProvider
    );
    if (probe.assets[0]?.digest !== candidate.digest) {
      throw new Error("Recovery pack asset digest does not match");
    }
    assets.set(candidate.digest, structuredClone(candidate));
  }

  const identities = new Set();
  const sequences = new Set();
  const referenced = new Map();
  const snapshots = [];
  for (const candidate of pack.snapshots) {
    const snapshot = structuredClone(candidate);
    if (typeof snapshot?.id !== "string" || !snapshot.id || identities.has(snapshot.id) ||
        !Number.isSafeInteger(snapshot.capturedAt) || snapshot.capturedAt < 0 ||
        !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 1 ||
        sequences.has(snapshot.sequence) || !snapshot.value ||
        typeof snapshot.value !== "object" || Array.isArray(snapshot.value)) {
      throw new Error("Recovery pack Snapshot is invalid");
    }
    requireSupportedValue(snapshot.value);
    identities.add(snapshot.id);
    sequences.add(snapshot.sequence);
    const digests = [...assetDigestsIn(snapshot.value)].sort();
    if (JSON.stringify(digests) !== JSON.stringify([...(snapshot.assetDigests ?? [])].sort())) {
      throw new Error("Recovery pack Snapshot asset references are invalid");
    }
    for (const digest of digests) {
      if (!assets.has(digest)) throw new Error("Recovery pack is missing an asset");
      referenced.set(digest, (referenced.get(digest) ?? 0) + 1);
    }
    if (snapshot.contentHash !== await contentHash({
      id: snapshot.id,
      capturedAt: snapshot.capturedAt,
      value: snapshot.value
    }, cryptoProvider)) {
      throw new Error("Recovery pack Snapshot content hash does not match");
    }
    snapshots.push(snapshot);
  }
  if ([...assets.keys()].some((digest) => !referenced.has(digest))) {
    throw new Error("Recovery pack contains an unreferenced asset");
  }
  snapshots.sort((left, right) =>
    right.sequence - left.sequence || right.id.localeCompare(left.id));
  const newestSequence = snapshots.reduce(
    (maximum, snapshot) => Math.max(maximum, snapshot.sequence), 0
  );
  if (pack.sequence !== undefined && pack.sequence < newestSequence) {
    throw new Error("Recovery pack sequence precedes its Snapshots");
  }
  return { snapshots, assets, referenced };
}

/**
 * @param {{adapter:RecoveryStorageAdapter,now?:()=>number,createId?:()=>string,
 *   cryptoProvider?:Crypto}} options
 */
export function createRecoveryStore({
  adapter,
  now = () => Date.now(),
  createId = () => globalThis.crypto.randomUUID(),
  cryptoProvider = globalThis.crypto
}) {
  if (typeof adapter?.transaction !== "function") {
    throw new Error("A Recovery storage adapter is required");
  }

  async function captureSnapshot(value, {
    retention = 200,
    id = value?.id,
    capturedAt: suppliedCapturedAt
  } = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("A recovery Snapshot is required");
    }
    requireSupportedValue(value);
    const snapshotId = typeof id === "string" && id ? id : createId();
    const capturedAt = suppliedCapturedAt ?? now();
    if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) {
      throw new Error("Recovery capture time is invalid");
    }
    const limit = normalizeRecoveryRetention(retention);
    const externalized = await externalizeEmbeddedFavicons(value, cryptoProvider);
    const snapshot = {
      id: snapshotId,
      capturedAt,
      value: externalized.value,
      assetDigests: [...assetDigestsIn(externalized.value)].sort()
    };
    snapshot.contentHash = await contentHash({
      id: snapshot.id,
      capturedAt: snapshot.capturedAt,
      value: snapshot.value
    }, cryptoProvider);

    return adapter.transaction(
      [RECOVERY_STORES.snapshots, RECOVERY_STORES.assets, RECOVERY_STORES.meta],
      "readwrite",
      async (transaction) => {
        const previous = await transaction.get(RECOVERY_STORES.snapshots, snapshotId);
        requireSupportedValue(previous?.value);
        const sequenceMeta = await transaction.get(RECOVERY_STORES.meta, META_SEQUENCE);
        const sequence = Number.isSafeInteger(sequenceMeta?.value) && sequenceMeta.value >= 0
          ? sequenceMeta.value + 1 : 1;
        snapshot.sequence = sequence;
        const order = (await snapshotOrder(transaction)).filter(({ id }) => id !== snapshotId);
        order.unshift({ id: snapshotId, sequence });
        order.sort((left, right) => right.sequence - left.sequence || right.id.localeCompare(left.id));
        const retained = order.slice(0, limit);
        const removed = order.slice(limit);
        const removedSnapshots = (await Promise.all(
          removed.map(({ id }) => transaction.get(RECOVERY_STORES.snapshots, id))
        )).filter(Boolean);
        removedSnapshots.forEach((candidate) => requireSupportedValue(candidate.value));
        const deltas = new Map();
        addAssetDelta(deltas, previous?.assetDigests, -1);
        removedSnapshots.forEach((candidate) => addAssetDelta(deltas, candidate.assetDigests, -1));
        addAssetDelta(deltas, snapshot.assetDigests, 1);
        await updateAssetReferences(transaction, externalized.assets, deltas);
        await transaction.put(RECOVERY_STORES.snapshots, snapshot);
        const deletions = await deletionMarkers(transaction);
        if (deletions.some((marker) => marker.id === snapshotId)) {
          await transaction.put(RECOVERY_STORES.meta, {
            key: META_DELETIONS, value: deletions.filter((marker) => marker.id !== snapshotId)
          });
        }
        for (const candidate of removed) {
          await transaction.delete(RECOVERY_STORES.snapshots, candidate.id);
        }
        await transaction.put(RECOVERY_STORES.meta, { key: META_RETENTION, value: limit });
        await transaction.put(RECOVERY_STORES.meta, { key: META_ORDER, value: retained });
        await transaction.put(RECOVERY_STORES.meta, { key: META_SEQUENCE, value: sequence });
        await transaction.put(RECOVERY_STORES.meta, {
          key: META_NEWEST,
          value: retained[0]?.id ?? null
        });
        return { id: snapshotId, retained: retained.length, pruned: removed.map(({ id }) => id) };
      }
    );
  }

  async function readSnapshot(id) {
    if (typeof id !== "string" || !id) throw new Error("A Snapshot id is required");
    return adapter.transaction(
      [RECOVERY_STORES.snapshots, RECOVERY_STORES.assets], "readonly", async (transaction) => {
        const snapshot = await transaction.get(RECOVERY_STORES.snapshots, id);
        if (!snapshot) return null;
        return publicSnapshot(snapshot, await assetsForSnapshots(transaction, [snapshot]));
      }
    );
  }

  async function listSnapshots({ limit = 50, includeFavicons = true } = {}) {
    if (!Number.isFinite(limit)) throw new Error("Recovery Snapshot limit is invalid");
    const count = Math.max(0, Math.min(MAX_RECOVERY_SNAPSHOTS, Math.floor(limit)));
    return adapter.transaction(
      includeFavicons ? [RECOVERY_STORES.snapshots, RECOVERY_STORES.assets] : [RECOVERY_STORES.snapshots],
      "readonly", async (transaction) => {
        const snapshots = (await transaction.getAll(RECOVERY_STORES.snapshots))
          .sort((left, right) => right.sequence - left.sequence || right.id.localeCompare(left.id))
          .slice(0, count);
        const assets = includeFavicons ? await assetsForSnapshots(transaction, snapshots) : null;
        return snapshots.map((snapshot) => publicSnapshot(snapshot, assets, { includeFavicons }));
      }
    );
  }

  async function deleteSnapshot(id, { marker = makeRecoveryDeletionMarker(id) } = {}) {
    if (typeof id !== "string" || !id) throw new Error("A Snapshot id is required");
    requireSupportedValue(marker);
    if (marker?.id !== id || marker.auto !== true || !Number.isFinite(marker.deletedAt) || marker.deletedAt <= 0 ||
        typeof marker.deletionRevision !== "string" || !marker.deletionRevision) {
      throw new Error("A Snapshot deletion identity is required");
    }
    return adapter.transaction(
      [RECOVERY_STORES.snapshots, RECOVERY_STORES.assets, RECOVERY_STORES.meta],
      "readwrite",
      async (transaction) => {
        const snapshot = await transaction.get(RECOVERY_STORES.snapshots, id);
        if (!snapshot) return false;
        requireSupportedValue(snapshot.value);
        const sequenceMeta = await transaction.get(RECOVERY_STORES.meta, META_SEQUENCE);
        const sequence = Number.isSafeInteger(sequenceMeta?.value) && sequenceMeta.value >= 0
          ? sequenceMeta.value + 1 : 1;
        const deltas = new Map();
        addAssetDelta(deltas, snapshot.assetDigests, -1);
        await updateAssetReferences(transaction, [], deltas);
        await transaction.delete(RECOVERY_STORES.snapshots, id);
        const deletions = await deletionMarkers(transaction);
        await transaction.put(RECOVERY_STORES.meta, {
          key: META_DELETIONS,
          value: [structuredClone(marker), ...deletions.filter((entry) => entry.id !== id)]
            .slice(0, MAX_RECOVERY_DELETION_MARKERS)
        });
        const order = (await snapshotOrder(transaction)).filter((candidate) => candidate.id !== id);
        await transaction.put(RECOVERY_STORES.meta, { key: META_ORDER, value: order });
        await transaction.put(RECOVERY_STORES.meta, {
          key: META_NEWEST,
          value: order[0]?.id ?? null
        });
        await transaction.put(RECOVERY_STORES.meta, { key: META_SEQUENCE, value: sequence });
        return true;
      }
    );
  }

  /** Local-only, bounded identities for Journal freshness; never exported. */
  async function readDeletionMarkers() {
    return adapter.transaction([RECOVERY_STORES.meta], "readonly", async (transaction) => {
      return structuredClone(await deletionMarkers(transaction));
    });
  }

  /** Small state projection used to skip Recovery export on an unchanged sync. */
  async function readReplicationState() {
    return adapter.transaction([RECOVERY_STORES.meta], "readonly", async (transaction) => {
      const [sequenceMeta, retentionMeta, newestMeta, orderMeta] = await Promise.all([
        transaction.get(RECOVERY_STORES.meta, META_SEQUENCE),
        transaction.get(RECOVERY_STORES.meta, META_RETENTION),
        transaction.get(RECOVERY_STORES.meta, META_NEWEST),
        transaction.get(RECOVERY_STORES.meta, META_ORDER)
      ]);
      const sequence = Number.isSafeInteger(sequenceMeta?.value) && sequenceMeta.value >= 0
        ? sequenceMeta.value : 0;
      const retention = Number.isSafeInteger(retentionMeta?.value) && retentionMeta.value > 0
        ? retentionMeta.value : 200;
      const order = Array.isArray(orderMeta?.value) ? orderMeta.value : [];
      return {
        sequence,
        retention,
        newestSnapshotId: typeof newestMeta?.value === "string" ? newestMeta.value : null,
        snapshotCount: order.length,
        snapshots: order.map(({ id, sequence: snapshotSequence }) => ({
          id,
          sequence: snapshotSequence
        }))
      };
    });
  }

  async function exportRecoveryPack({ limit = MAX_RECOVERY_SNAPSHOTS, ids = null } = {}) {
    const requestedIds = ids === null ? null : [...ids];
    if (requestedIds && (requestedIds.length > MAX_RECOVERY_SNAPSHOTS ||
        new Set(requestedIds).size !== requestedIds.length ||
        requestedIds.some((id) => typeof id !== "string" || !id))) {
      throw new Error("Recovery pack Snapshot selection is invalid");
    }
    const pack = await adapter.transaction(
      [RECOVERY_STORES.snapshots, RECOVERY_STORES.assets, RECOVERY_STORES.meta],
      "readonly",
      async (transaction) => {
        const maximum = normalizeRecoveryRetention(limit);
        if (requestedIds && requestedIds.length > maximum) {
          throw new Error("Recovery pack Snapshot selection exceeds its limit");
        }
        const available = (await transaction.getAll(RECOVERY_STORES.snapshots))
          .sort((left, right) => right.sequence - left.sequence || right.id.localeCompare(left.id));
        const byId = new Map(available.map((snapshot) => [snapshot.id, snapshot]));
        const snapshots = requestedIds
          ? requestedIds.map((id) => byId.get(id))
          : available.slice(0, maximum);
        if (snapshots.some((snapshot) => !snapshot)) {
          throw new Error("Recovery changed while its Vault pack was being prepared");
        }
        snapshots.sort((left, right) =>
          right.sequence - left.sequence || right.id.localeCompare(left.id));
        const assets = [...(await assetsForSnapshots(transaction, snapshots)).values()]
          .map(publicAsset);
        const sequenceMeta = await transaction.get(RECOVERY_STORES.meta, META_SEQUENCE);
        const sequence = Number.isSafeInteger(sequenceMeta?.value) && sequenceMeta.value >= 0
          ? sequenceMeta.value : 0;
        return {
          app: "everytab",
          kind: "recovery-pack",
          formatVersion: 1,
          createdAt: now(),
          sequence,
          snapshots,
          assets
        };
      }
    );
    return { ...pack, contentHash: await contentHash(pack, cryptoProvider) };
  }

  /** Seed one verified pack into an empty Recovery store for exact rehearsal. */
  async function seedRecoveryPack(pack, { retention = pack?.snapshots?.length || 1 } = {}) {
    const verified = await verifiedRecoveryPack(pack, cryptoProvider);
    const limit = normalizeRecoveryRetention(retention);
    if (verified.snapshots.length > limit) {
      throw new Error("Recovery pack exceeds the requested retention");
    }
    return adapter.transaction(
      Object.values(RECOVERY_STORES), "readwrite", async (transaction) => {
        for (const store of Object.values(RECOVERY_STORES)) {
          if ((await transaction.getAll(store)).length > 0) {
            throw new Error("Recovery pack destination is not empty");
          }
        }
        for (const [digest, asset] of verified.assets) {
          await transaction.put(RECOVERY_STORES.assets, {
            ...asset,
            refCount: verified.referenced.get(digest)
          });
        }
        for (const snapshot of verified.snapshots) {
          await transaction.put(RECOVERY_STORES.snapshots, snapshot);
        }
        const order = verified.snapshots.map(({ id, sequence }) => ({ id, sequence }));
        const newest = order[0]?.id ?? null;
        const sequence = Number.isSafeInteger(pack.sequence)
          ? pack.sequence
          : order.reduce((maximum, item) => Math.max(maximum, item.sequence), 0);
        await transaction.put(RECOVERY_STORES.meta, { key: META_RETENTION, value: limit });
        await transaction.put(RECOVERY_STORES.meta, { key: META_ORDER, value: order });
        await transaction.put(RECOVERY_STORES.meta, { key: META_SEQUENCE, value: sequence });
        await transaction.put(RECOVERY_STORES.meta, { key: META_NEWEST, value: newest });
        return { snapshots: order.length, assets: verified.assets.size };
      }
    );
  }

  return {
    captureSnapshot,
    readSnapshot,
    listSnapshots,
    deleteSnapshot,
    readDeletionMarkers,
    readReplicationState,
    exportRecoveryPack,
    seedRecoveryPack,
    close: () => adapter.close?.()
  };
}

export function openRecoveryStore({ databaseName, now, createId, cryptoProvider } = {}) {
  const adapter = createIndexedDbAdapter(RECOVERY_SCHEMA, { databaseName });
  return createRecoveryStore({ adapter, now, createId, cryptoProvider });
}
