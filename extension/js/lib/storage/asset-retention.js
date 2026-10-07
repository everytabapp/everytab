// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Conservative local asset collection; callers supply one atomic Library transaction. */
import { LIBRARY_STORES } from "./schema.js";
import { requireSupportedEntity } from "./record-format.js";

const RECEIPT_KEY = "library-asset-retention";
const SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = 7 * SCAN_INTERVAL_MS;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function requireKnownAssetReferences(entity) {
  if (!entity || !["live", "deleted"].includes(entity.lifecycle) ||
      (entity.assetDigests !== undefined && (!Array.isArray(entity.assetDigests) ||
        entity.assetDigests.some((digest) => typeof digest !== "string" || !DIGEST.test(digest))))) {
    throw new Error("The saved record has unsupported asset references");
  }
  requireSupportedEntity(entity);
}

function referenceDigests(roots) {
  const references = new Set();
  const seen = new WeakSet();
  const pending = [...roots];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string" && DIGEST.test(value)) references.add(value);
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    // Include opaque local descriptors and embedded Restore checkpoints, not
    // just today's public favicon marker or entity assetDigests field.
    if (value instanceof Map) {
      for (const [key, child] of value) pending.push(key, child);
    } else if (value instanceof Set) {
      for (const child of value) pending.push(child);
    } else {
      for (const [key, child] of Object.entries(value)) pending.push(key, child);
    }
  }
  return references;
}

function checkedReceipt(row) {
  if (!row) return null;
  const receipt = row.value;
  if (receipt?.formatVersion !== 1 || !Number.isSafeInteger(receipt.lastScanAt) ||
      receipt.lastScanAt < 0 || !Array.isArray(receipt.candidates)) {
    throw new Error("The Library asset-retention receipt is invalid");
  }
  const digests = new Set();
  for (const candidate of receipt.candidates) {
    if (!DIGEST.test(candidate?.digest ?? "") || digests.has(candidate.digest) ||
        !Number.isSafeInteger(candidate.unreferencedAt) || candidate.unreferencedAt < 0 ||
        candidate.unreferencedAt > receipt.lastScanAt) {
      throw new Error("The Library asset-retention candidates are invalid");
    }
    digests.add(candidate.digest);
  }
  return receipt;
}

/**
 * Remove only assets absent from two completed scans at least seven days apart.
 * Entities, outbox, local values, assets and meta must share this readwrite transaction.
 * A skipped scan does not claim a measured retained count.
 */
export async function collectLibraryAssets(transaction, { now }) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Asset scan time is invalid");
  const previous = checkedReceipt(await transaction.get(LIBRARY_STORES.meta, RECEIPT_KEY));
  if (previous && now - previous.lastScanAt < SCAN_INTERVAL_MS) {
    return { skipped: true, removed: 0, retained: null };
  }
  const [entities, outbox, local] = await Promise.all([
    transaction.getAll(LIBRARY_STORES.entities),
    transaction.getAll(LIBRARY_STORES.outbox),
    transaction.getAll(LIBRARY_STORES.local)
  ]);
  const saveReceipt = (candidates) => transaction.put(LIBRARY_STORES.meta, {
    key: RECEIPT_KEY, value: { formatVersion: 1, lastScanAt: now, candidates }
  });
  let references;
  try {
    entities.forEach(requireKnownAssetReferences);
    outbox.forEach(({ entity }) => requireKnownAssetReferences(entity));
    references = referenceDigests([...entities, ...outbox, ...local]);
  } catch {
    // A future record format may refer to assets in a way we cannot interpret.
    // Break the consecutive-scan proof and leave all assets untouched.
    await saveReceipt([]);
    return { skipped: true, removed: 0, retained: null };
  }
  const assets = await transaction.getAll(LIBRARY_STORES.assets);
  if (assets.some((asset) => !DIGEST.test(asset.digest ?? ""))) {
    await saveReceipt([]);
    return { skipped: true, removed: 0, retained: null };
  }
  const priorCandidates = new Map((previous?.candidates ?? [])
    .map(({ digest, unreferencedAt }) => [digest, unreferencedAt]));
  const candidates = [];
  let removed = 0;
  for (const asset of assets) {
    if (references.has(asset.digest)) continue;
    const firstSeen = priorCandidates.get(asset.digest);
    if (firstSeen !== undefined && now - firstSeen >= GRACE_MS) {
      await transaction.delete(LIBRARY_STORES.assets, asset.digest);
      removed += 1;
    } else {
      candidates.push({ digest: asset.digest, unreferencedAt: firstSeen ?? now });
    }
  }
  await saveReceipt(candidates);
  return { skipped: false, removed, retained: assets.length - removed };
}
