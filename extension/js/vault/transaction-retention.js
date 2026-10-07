// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Owner-only retirement of transaction files superseded by a verified replication base. */
import { canonicalJson, contentHash } from "../lib/storage/canonical.js";
import { assetDigestsIn } from "../lib/storage/assets.js";
import { verifyLibraryCheckpoint } from "../lib/storage/library-store.js";
import { requireSupportedEntity } from "../lib/storage/record-format.js";
import { compareVersions } from "../lib/storage/version.js";
import { entries, parseJson, readFileHandle, readNamedFile, verifySeal } from "./protocol-io.js";

const DAY = 24 * 60 * 60 * 1000;
const GRACE = 7 * DAY;
const CHUNK_NAME = /^(\d{12,16})-(\d{12,16})-([a-f0-9]{64})\.json$/;
const identity = ({ family, id }) => JSON.stringify([family, id]);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const sameDigests = (left, right) => Array.isArray(left) &&
  left.every((digest) => /^sha256:[a-f0-9]{64}$/.test(digest)) &&
  canonicalJson([...left].sort()) === canonicalJson([...new Set(right)].sort());

function checkedReceipt(value, manifest) {
  if (value === undefined) return null;
  if (value?.formatVersion !== 1 || value.vaultId !== manifest.vaultId ||
      value.deviceId !== manifest.deviceId || value.sourceId !== manifest.sourceId ||
      !count(value.lastScanAt) || !count(value.baseSequence) ||
      !Array.isArray(value.candidates)) {
    throw new Error("Vault transaction-retention receipt is invalid");
  }
  const names = new Set();
  for (const item of value.candidates) {
    const match = CHUNK_NAME.exec(item?.name ?? "");
    if (!match || names.has(item.name) || item.contentHash !== `sha256:${match[3]}` ||
        !count(item.unreferencedAt) || item.unreferencedAt > value.lastScanAt) {
      throw new Error("Vault transaction-retention candidate is invalid");
    }
    names.add(item.name);
  }
  return value;
}

async function coveredChunk(name, text, manifest, entities, cryptoProvider) {
  const match = CHUNK_NAME.exec(name);
  if (!match) return null;
  const from = Number(match[1]);
  const through = Number(match[2]);
  if (!count(from) || from < 1 || !count(through) || through < from ||
      through > manifest.baseSequence ||
      match[1] !== String(from).padStart(12, "0") ||
      match[2] !== String(through).padStart(12, "0")) return null;
  const chunk = await verifySeal(parseJson(text, name), "Retired transaction", cryptoProvider);
  if (chunk.app !== "everytab" || chunk.kind !== "vault-v2-transaction" ||
      chunk.formatVersion !== 1 || chunk.vaultId !== manifest.vaultId ||
      chunk.deviceId !== manifest.deviceId || chunk.sourceId !== manifest.sourceId ||
      chunk.fromSequence !== from || chunk.throughSequence !== through ||
      chunk.contentHash !== `sha256:${match[3]}` || !Array.isArray(chunk.changes) ||
      chunk.changes.length !== through - from + 1 || !Array.isArray(chunk.assetManifest)) return null;
  for (const [index, change] of chunk.changes.entries()) {
    const entity = change?.entity;
    if (change?.sequence !== from + index || !entity || typeof entity.id !== "string" ||
        !entity.id || !["live", "deleted"].includes(entity.lifecycle) ||
        entity.version?.deviceId !== manifest.deviceId || !count(entity.version?.wallTime) ||
        !count(entity.version?.logicalCounter)) return null;
    requireSupportedEntity(entity);
    if (entity.id.includes("\0") || canonicalJson(entity.versionKey) !== canonicalJson([
      entity.version.wallTime, entity.version.logicalCounter, entity.version.deviceId
    ])) return null;
    if (entity.lifecycle === "deleted") {
      if (entity.value !== undefined || entity.assetDigests?.length || !count(entity.deletedAt)) return null;
    } else if (!entity.value || typeof entity.value !== "object" || Array.isArray(entity.value) ||
        !sameDigests(entity.assetDigests, assetDigestsIn(entity.value))) return null;
    const body = entity.lifecycle === "deleted"
      ? { family: entity.family, id: entity.id, lifecycle: "deleted" }
      : { family: entity.family, id: entity.id, lifecycle: "live", value: entity.value };
    if (entity.contentHash !== await contentHash(body, cryptoProvider)) return null;
    const replacement = entities.get(identity(entity));
    if (!replacement) return null;
    const order = compareVersions(replacement.version, entity.version);
    if (order < 0 || (order === 0 && replacement.contentHash !== entity.contentHash)) return null;
  }
  if (!sameDigests(chunk.assetManifest.map((asset) => asset?.digest),
    chunk.changes.flatMap(({ entity }) => entity.assetDigests ?? [])) ||
      chunk.assetManifest.some((asset) => !count(asset.byteLength) ||
        typeof asset.mimeType !== "string")) return null;
  return chunk;
}

/**
 * Called under the Vault sync lock after publication. Only the supplied owner
 * directory is scanned. readManifest and readCheckpoint verify protocol identity;
 * the checkpoint's contents/assets are independently validated before any removal.
 * Failed/interrupted scans discard absence proof. File deletions are not atomic:
 * completed removals remain safe, but remaining files must earn a fresh grace period.
 */
export async function retireVaultTransactions({
  library, manifest, deviceDirectory, now, cryptoProvider, readManifest, readCheckpoint,
  report, onProgress = () => {}
}) {
  if (!count(now)) throw new Error("Vault transaction-retention time is invalid");
  const key = `vault-transaction-retention:${manifest.vaultId}`;
  const prior = checkedReceipt((await library.readLocal([key]))[key], manifest);
  if (!manifest.baseCheckpoint && !prior) return;
  const save = (candidates) => library.commit({ localSets: { [key]: {
    formatVersion: 1, vaultId: manifest.vaultId, deviceId: manifest.deviceId,
    sourceId: manifest.sourceId, baseSequence: Math.max(manifest.baseSequence, prior?.baseSequence ?? 0),
    lastScanAt: now, candidates
  } } });
  if (!manifest.baseCheckpoint || (prior && manifest.baseSequence < prior.baseSequence)) {
    await save([]);
    throw new Error("Vault transaction-retention base moved backwards");
  }
  if (prior && now - prior.lastScanAt < DAY) return;
  // Persist failure-safe proof before file I/O. A crash cannot promote yesterday's
  // candidates after an incomplete or unsupported reference scan.
  await save([]);
  const checkpoint = await readCheckpoint();
  const verified = await verifyLibraryCheckpoint(checkpoint, cryptoProvider, onProgress);
  const entities = new Map(verified.entities.map((entity) => [identity(entity), entity]));
  const directory = await deviceDirectory.getDirectoryHandle("transactions");
  const referenced = new Set(manifest.chunks.map(({ name }) => name));
  const priorCandidates = new Map((prior?.candidates ?? []).map((item) => [item.name, item]));
  const candidates = [];
  const removable = [];
  const files = (await entries(directory)).filter(({ name, handle }) =>
    handle.kind === "file" && !referenced.has(name) && CHUNK_NAME.test(name));
  for (const [index, { name, handle }] of files.entries()) {
    onProgress({ stage: "reading", target: "library", completed: index, total: files.length });
    const text = await readFileHandle(handle, name);
    let chunk;
    try { chunk = await coveredChunk(name, text, manifest, entities, cryptoProvider); }
    catch { continue; } // Unknown or damaged files are retained, never repaired by cleanup.
    if (!chunk) continue;
    const earlier = priorCandidates.get(name);
    const unreferencedAt = earlier?.contentHash === chunk.contentHash
      ? earlier.unreferencedAt : now;
    const candidate = { name, contentHash: chunk.contentHash, unreferencedAt };
    if (now - unreferencedAt >= GRACE) removable.push({ ...candidate, text });
    else candidates.push(candidate);
  }
  onProgress({ stage: "reading", target: "library", completed: files.length, total: files.length });
  for (const [index, item] of removable.entries()) {
    const current = await readManifest();
    if (current.contentHash !== manifest.contentHash) return;
    // Reacquire by name so replacing a file handle cannot evade the final check.
    const currentText = await readNamedFile(directory, item.name, { optional: true });
    if (currentText === null) continue;
    if (currentText !== item.text) return;
    await directory.removeEntry(item.name);
    report.chunksPruned += 1;
    onProgress({ stage: "pruning", target: "library", completed: index + 1, total: removable.length });
  }
  if ((await readManifest()).contentHash !== manifest.contentHash) return;
  await save(candidates);
}
