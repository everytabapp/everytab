// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Authoritative Library storage module.
 *
 * Its interface owns record transactions, logical versions, compact deletion,
 * favicon assets, and the durable sync outbox. Physical IndexedDB details do
 * not cross this seam.
 */
import {
  assetDigestsIn, externalizeEmbeddedFavicons, hydrateEmbeddedFavicons,
  readAssetsByDigest
} from "./assets.js";
import { canonicalJson, contentHash } from "./canonical.js";
import { createIndexedDbAdapter } from "./indexeddb-adapter.js";
import { LIBRARY_SCHEMA, LIBRARY_STORES } from "./schema.js";
import { compareVersions, greatestVersion, nextVersion, normalizeVersion } from "./version.js";
import {
  requireSupportedEntity, requireSupportedFamily, requireSupportedValue
} from "./record-format.js";
import {
  recordOutboxChanges, acknowledgeOutboxHistory, readCompactedSequence
} from "./outbox-history.js";
import { collectLibraryAssets } from "./asset-retention.js";
import {
  STORAGE_PENDING_LIBRARY_REVISION_LOCAL_KEY, pendingLibraryFamilies
} from "./constants.js";

const META_CLOCK = "clock";
const META_SEQUENCE = "sequence";
const META_SOURCE_ID = "replication-source-id";
const META_RESTORE_EPOCH = "restore-epoch";
const RESTORE_SAFETY_LOCAL_KEY = "vault-restore-safety";
const DEFAULT_BATCH_OPERATIONS = 128;
const DEFAULT_BATCH_BYTES = 512 * 1024;

/** @typedef {{wallTime:number,logicalCounter:number,deviceId:string}} LibraryVersion */
/**
 * @typedef {{family:string,id:string,lifecycle:("live"|"deleted"),version:LibraryVersion,
 *   deletedAt?:number}}
 *   CommittedLibraryEntity
 */
/** @typedef {{sequence:number,entity:CommittedLibraryEntity}} CommittedLibraryChange */
/**
 * @callback FinalizeLibraryLocalSets
 * @param {{changes:CommittedLibraryChange[],localSets:Record<string,unknown>}} input
 * @returns {Record<string,unknown>} replacement values for exactly the supplied local keys
 */
/**
 * @typedef {{type:"delete",family:string,id:string}|
 *   {type:"put",family:string,id:string,value:Record<string,unknown>}} LibraryOperation
 */
/**
 * @typedef {{operations?:LibraryOperation[],localSets?:Record<string,unknown>,
 *   localDeletes?:string[],finalizeLocalSets?:FinalizeLibraryLocalSets}} LibraryCommitOptions
 */
/** Public Library interface, inferred from its single constructor. @typedef {ReturnType<typeof createLibraryStore>} LibraryStore */
/** Adapter interface at the Library persistence seam. @typedef {ReturnType<typeof createIndexedDbAdapter>} LibraryStorageAdapter */

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function validateIdentity(family, id) {
  requiredText(family, "A record family");
  requireSupportedFamily(family);
  requiredText(id, "A record id");
  if (family.includes("\0") || id.includes("\0")) throw new Error("Record identity is invalid");
}

function entityContent(entity) {
  return entity.lifecycle === "deleted"
    ? { family: entity.family, id: entity.id, lifecycle: "deleted" }
    : { family: entity.family, id: entity.id, lifecycle: "live", value: entity.value };
}

async function prepareOperation(operation, cryptoProvider) {
  if (!operation || typeof operation !== "object") throw new Error("A storage operation is required");
  const family = requiredText(operation.family, "A record family");
  const id = requiredText(operation.id, "A record id");
  validateIdentity(family, id);
  if (operation.type === "delete") {
    const entity = { family, id, lifecycle: "deleted", assetDigests: [] };
    return { entity, assets: [], contentHash: await contentHash(entityContent(entity), cryptoProvider) };
  }
  if (operation.type !== "put") throw new Error(`Unknown storage operation ${operation.type}`);
  if (!operation.value || typeof operation.value !== "object" || Array.isArray(operation.value)) {
    throw new Error("A live record value is required");
  }
  if (operation.value.id !== undefined && operation.value.id !== id) {
    throw new Error("Record value id must match its storage id");
  }
  requireSupportedValue(operation.value);
  const externalized = await externalizeEmbeddedFavicons(operation.value, cryptoProvider);
  const entity = {
    family,
    id,
    lifecycle: "live",
    value: externalized.value,
    assetDigests: [...assetDigestsIn(externalized.value)].sort()
  };
  return {
    entity,
    assets: externalized.assets,
    contentHash: await contentHash(entityContent(entity), cryptoProvider)
  };
}

async function assetsForEntities(transaction, entities) {
  return readAssetsByDigest(
    transaction,
    LIBRARY_STORES.assets,
    entities.flatMap((entity) => entity.assetDigests ?? [])
  );
}

function hydrateEntity(entity, assets, options) {
  if (!entity) return null;
  requireSupportedEntity(entity);
  const output = structuredClone(entity);
  if (output.lifecycle === "live") {
    output.value = hydrateEmbeddedFavicons(output.value, assets, options);
  }
  return output;
}

function byteLength(value) {
  return new TextEncoder().encode(canonicalJson(value)).length;
}

function sameStrings(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function localClockMeta(value) {
  return normalizeVersion(value?.value);
}

function localSequenceMeta(value) {
  return Number.isSafeInteger(value?.value) && value.value >= 0 ? value.value : 0;
}

function restoreEpochMeta(value) {
  return Number.isSafeInteger(value?.value) && value.value >= 0 ? value.value : 0;
}

function identityOf(entity) {
  return `${entity.family}\0${entity.id}`;
}

function sortedEntities(entities) {
  return [...entities].sort((left, right) =>
    left.family.localeCompare(right.family) || left.id.localeCompare(right.id));
}

async function logicalStateHash(entities, cryptoProvider) {
  return contentHash(sortedEntities(entities).map(entityContent), cryptoProvider);
}

/**
 * Complete portable-state identity without repeating record payloads or assets.
 * Entity content hashes cover the value/lifecycle; versions also catch a remote
 * change that restores the same value. Outbox sequence alone tracks local writes.
 */
function restoreStateIdentity(entities) {
  return sortedEntities(entities).map(({ family, id, contentHash: hash, version }) =>
    ({ family, id, contentHash: hash, version }));
}

/** Data/cursor advancement and its later index/notification repair cannot separate. */
async function recordPendingLibraryRevision(transaction, families) {
  if (families.length === 0) return;
  const prior = await transaction.get(LIBRARY_STORES.local, STORAGE_PENDING_LIBRARY_REVISION_LOCAL_KEY);
  await transaction.put(LIBRARY_STORES.local, {
    key: STORAGE_PENDING_LIBRARY_REVISION_LOCAL_KEY,
    value: [...new Set([...pendingLibraryFamilies(prior?.value), ...families])].sort()
  });
}

function liveCounts(entities) {
  const families = {};
  for (const entity of entities) {
    if (entity.lifecycle !== "live") continue;
    families[entity.family] = (families[entity.family] ?? 0) + 1;
  }
  return families;
}

function firstSavedReference(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.url === "string") return value;
  if (Array.isArray(value.tabs)) {
    const reference = value.tabs.find((tab) => tab && typeof tab === "object");
    if (reference) return reference;
  }
  if (Array.isArray(value.windows)) {
    for (const window of value.windows) {
      const tabs = Array.isArray(window) ? window : window?.tabs;
      const reference = Array.isArray(tabs)
        ? tabs.find((tab) => tab && typeof tab === "object")
        : null;
      if (reference) return reference;
    }
  }
  return null;
}

function restoreChangeIdentity(entity, kind) {
  const value = entity?.lifecycle === "live" ? entity.value : null;
  const reference = firstSavedReference(value);
  const title = [value?.name, value?.title, value?.label, reference?.title,
    reference?.url, entity?.id].find((candidate) =>
    typeof candidate === "string" && candidate.trim()) ?? "";
  const url = [value?.url, reference?.url].find((candidate) =>
    typeof candidate === "string" && candidate.trim()) ?? "";
  return {
    kind,
    family: entity.family,
    id: entity.id,
    title,
    url
  };
}

function restoreDifference(current, target) {
  const currentById = new Map(current.map((entity) => [identityOf(entity), entity]));
  const targetById = new Map(target.map((entity) => [identityOf(entity), entity]));
  const summary = { added: 0, updated: 0, removed: 0, watermarks: 0, unchanged: 0 };
  const changes = [];
  for (const identity of new Set([...currentById.keys(), ...targetById.keys()])) {
    const before = currentById.get(identity);
    const after = targetById.get(identity);
    const beforeLive = before?.lifecycle === "live";
    const afterLive = after?.lifecycle === "live";
    if (!beforeLive && afterLive) {
      summary.added += 1;
      changes.push(restoreChangeIdentity(after, "added"));
    } else if (beforeLive && !afterLive) {
      summary.removed += 1;
      changes.push(restoreChangeIdentity(before, "removed"));
    } else if (!before && after?.lifecycle === "deleted") {
      summary.watermarks += 1;
      changes.push(restoreChangeIdentity(after, "watermark"));
    }
    else if (beforeLive && afterLive && before.contentHash !== after.contentHash) {
      summary.updated += 1;
      changes.push(restoreChangeIdentity(after, "updated"));
    } else {
      summary.unchanged += 1;
    }
  }
  return {
    ...summary,
    changes,
    changed: summary.added + summary.updated + summary.removed + summary.watermarks > 0
  };
}

async function verifyRemoteBatch(batch, cryptoProvider) {
  const deviceId = requiredText(batch?.deviceId, "Remote device id");
  const sourceId = batch?.sourceId === undefined || batch.sourceId === null
    ? null
    : requiredText(batch.sourceId, "Remote replication source id");
  if (!Array.isArray(batch?.changes)) throw new Error("Remote changes must be an array");
  const assets = Array.isArray(batch.assets) ? batch.assets : [];
  const verifiedAssets = new Map();
  for (const asset of assets) {
    if (!asset || typeof asset.digest !== "string" || typeof asset.dataUrl !== "string") {
      throw new Error("Remote asset is invalid");
    }
    const probe = await externalizeEmbeddedFavicons({ favIconUrl: asset.dataUrl }, cryptoProvider);
    if (probe.assets[0]?.digest !== asset.digest) throw new Error("Remote asset digest does not match");
    verifiedAssets.set(asset.digest, asset);
  }
  const changes = [];
  for (const candidate of batch.changes) {
    const sequence = candidate?.sequence;
    const entity = candidate?.entity;
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !entity) {
      throw new Error("Remote change sequence is invalid");
    }
    validateIdentity(entity.family, entity.id);
    requireSupportedEntity(entity);
    if (!["live", "deleted"].includes(entity.lifecycle)) throw new Error("Remote lifecycle is invalid");
    const version = normalizeVersion(entity.version);
    if (!version.deviceId || version.deviceId !== deviceId ||
        !Number.isSafeInteger(entity.version?.wallTime) || entity.version.wallTime < 0 ||
        !Number.isSafeInteger(entity.version?.logicalCounter) ||
        entity.version.logicalCounter < 0) {
      throw new Error("Remote record version is invalid");
    }
    if (entity.lifecycle === "deleted" && (entity.value !== undefined || entity.assetDigests?.length)) {
      throw new Error("Remote deletion is not compact");
    }
    if (entity.lifecycle === "live" && (!entity.value || typeof entity.value !== "object" ||
        !sameStrings(entity.assetDigests ?? [], assetDigestsIn(entity.value)))) {
      throw new Error("Remote record asset references are invalid");
    }
    const expectedHash = await contentHash(entityContent(entity), cryptoProvider);
    if (entity.contentHash !== expectedHash) throw new Error("Remote record content hash does not match");
    changes.push({ sequence, entity: structuredClone(entity) });
  }
  changes.sort((left, right) => left.sequence - right.sequence);
  for (let index = 1; index < changes.length; index++) {
    if (changes[index].sequence !== changes[index - 1].sequence + 1) {
      throw new Error("Remote change sequence contains a gap");
    }
  }
  return { deviceId, sourceId, changes, assets: [...verifiedAssets.values()] };
}

/** Validate a portable checkpoint without changing local data; shared by Restore and Vault retention. */
export async function verifyLibraryCheckpoint(checkpoint, cryptoProvider, onProgress = () => {}) {
  if (!checkpoint || checkpoint.app !== "everytab" ||
      checkpoint.kind !== "library-checkpoint" || checkpoint.formatVersion !== 1 ||
      !Array.isArray(checkpoint.entities) || !Array.isArray(checkpoint.assets)) {
    throw new Error("Library checkpoint is invalid");
  }
  const { contentHash: suppliedHash, ...body } = checkpoint;
  onProgress({ stage: "checking", target: "checkpoint", completed: 0, total: 1 });
  if (typeof suppliedHash !== "string" ||
      suppliedHash !== await contentHash(body, cryptoProvider)) {
    throw new Error("Library checkpoint content hash does not match");
  }
  onProgress({ stage: "checking", target: "checkpoint", completed: 1, total: 1 });

  const assets = new Map();
  onProgress({ stage: "checking", target: "assets", completed: 0,
    total: checkpoint.assets.length });
  for (const candidate of checkpoint.assets) {
    if (!candidate || typeof candidate.digest !== "string" ||
        typeof candidate.dataUrl !== "string" || assets.has(candidate.digest)) {
      throw new Error("Library checkpoint asset is invalid");
    }
    const probe = await externalizeEmbeddedFavicons(
      { favIconUrl: candidate.dataUrl }, cryptoProvider
    );
    if (probe.assets[0]?.digest !== candidate.digest) {
      throw new Error("Library checkpoint asset digest does not match");
    }
    assets.set(candidate.digest, structuredClone(candidate));
    onProgress({ stage: "checking", target: "assets", completed: assets.size,
      total: checkpoint.assets.length });
  }

  const identities = new Set();
  const referenced = new Set();
  let clock = normalizeVersion(null);
  const entities = [];
  onProgress({ stage: "checking", target: "records", completed: 0,
    total: checkpoint.entities.length });
  for (const candidate of checkpoint.entities) {
    const entity = structuredClone(candidate);
    validateIdentity(entity?.family, entity?.id);
    requireSupportedEntity(entity);
    const identity = `${entity.family}\0${entity.id}`;
    if (identities.has(identity)) throw new Error("Library checkpoint contains a duplicate identity");
    identities.add(identity);
    if (!["live", "deleted"].includes(entity.lifecycle)) {
      throw new Error("Library checkpoint lifecycle is invalid");
    }
    const version = normalizeVersion(entity.version);
    if (!version.deviceId || !Number.isSafeInteger(entity.version?.wallTime) ||
        entity.version.wallTime < 0 ||
        !Number.isSafeInteger(entity.version?.logicalCounter) ||
        entity.version.logicalCounter < 0) {
      throw new Error("Library checkpoint version is invalid");
    }
    if (canonicalJson(entity.versionKey) !== canonicalJson([
      version.wallTime, version.logicalCounter, version.deviceId
    ])) {
      throw new Error("Library checkpoint version key is invalid");
    }
    if (entity.lifecycle === "deleted") {
      if (entity.value !== undefined || entity.assetDigests?.length ||
          !Number.isSafeInteger(entity.deletedAt) || entity.deletedAt < 0) {
        throw new Error("Library checkpoint deletion is invalid");
      }
    } else if (!entity.value || typeof entity.value !== "object" ||
        Array.isArray(entity.value) ||
        !sameStrings(entity.assetDigests ?? [], assetDigestsIn(entity.value))) {
      throw new Error("Library checkpoint record is invalid");
    }
    for (const digest of entity.assetDigests ?? []) {
      if (!assets.has(digest)) throw new Error("Library checkpoint is missing an asset");
      referenced.add(digest);
    }
    if (entity.contentHash !== await contentHash(entityContent(entity), cryptoProvider)) {
      throw new Error("Library checkpoint record content hash does not match");
    }
    clock = greatestVersion(clock, version);
    entities.push(entity);
    onProgress({ stage: "checking", target: "records", completed: entities.length,
      total: checkpoint.entities.length });
  }
  if ([...assets.keys()].some((digest) => !referenced.has(digest))) {
    throw new Error("Library checkpoint contains an unreferenced asset");
  }
  return { entities, assets: [...assets.values()], clock };
}

/**
 * Test adapters cross the same interface through this constructor.
 * @param {{adapter:LibraryStorageAdapter,deviceId:string,now?:()=>number,
 *   cryptoProvider?:Crypto,createId?:()=>string,onCommit?:(event:unknown)=>void}} options
 */
export function createLibraryStore({
  adapter,
  deviceId,
  now = () => Date.now(),
  cryptoProvider = globalThis.crypto,
  createId = () => cryptoProvider.randomUUID(),
  onCommit = () => {}
}) {
  if (typeof adapter?.transaction !== "function") {
    throw new Error("A Library storage adapter is required");
  }
  requiredText(deviceId, "A device id");
  const listeners = new Set();
  if (typeof onCommit === "function") listeners.add(onCommit);

  function notify(event) {
    for (const listener of listeners) {
      try { listener(event); } catch { /* notifications cannot roll back durable data */ }
    }
  }

  async function readEntity(family, id, { includeDeleted = false } = {}) {
    validateIdentity(family, id);
    return adapter.transaction(
      [LIBRARY_STORES.entities, LIBRARY_STORES.assets], "readonly", async (transaction) => {
        const entity = await transaction.get(LIBRARY_STORES.entities, [family, id]);
        if (!entity || (!includeDeleted && entity.lifecycle === "deleted")) return null;
        return hydrateEntity(entity, await assetsForEntities(transaction, [entity]));
      }
    );
  }

  async function readFamily(family, { includeDeleted = false, includeFavicons = true } = {}) {
    requiredText(family, "A record family");
    requireSupportedFamily(family);
    return adapter.transaction(
      includeFavicons ? [LIBRARY_STORES.entities, LIBRARY_STORES.assets] : [LIBRARY_STORES.entities],
      "readonly", async (transaction) => {
        const entities = includeDeleted
          ? await transaction.getAllByIndex(LIBRARY_STORES.entities, "byFamily", family)
          : await transaction.getAllByIndex(
            LIBRARY_STORES.entities, "byFamilyLifecycle", [family, "live"]
          );
        const assets = includeFavicons ? await assetsForEntities(transaction, entities) : null;
        return entities.map((entity) => hydrateEntity(entity, assets, { includeFavicons }));
      }
    );
  }

  async function readPortableState({ families = null, includeDeleted = true } = {}) {
    return adapter.transaction(
      [LIBRARY_STORES.entities, LIBRARY_STORES.assets], "readonly", async (transaction) => {
        const allowed = families ? new Set(families.map((family) => requiredText(family, "A family"))) : null;
        const entities = (await transaction.getAll(LIBRARY_STORES.entities)).filter((entity) =>
          (!allowed || allowed.has(entity.family)) && (includeDeleted || entity.lifecycle === "live")
        );
        const assets = await assetsForEntities(transaction, entities);
        const records = {};
        for (const entity of entities) {
          (records[entity.family] ??= {})[entity.id] = hydrateEntity(entity, assets);
        }
        return records;
      }
    );
  }

  /**
   * Read device-local values that are transactionally adjacent to the Library
   * but never enter checkpoints, replication, or human-readable views.
   */
  async function readLocal(keys) {
    if (!Array.isArray(keys)) throw new Error("Local storage keys must be an array");
    const unique = [...new Set(keys.map((key) => requiredText(key, "A local storage key")))];
    if (unique.length === 0) return {};
    return adapter.transaction([LIBRARY_STORES.local], "readonly", async (transaction) => {
      const output = {};
      for (const key of unique) {
        const row = await transaction.get(LIBRARY_STORES.local, key);
        if (row) output[key] = structuredClone(row.value);
      }
      return output;
    });
  }

  /**
   * One local commit boundary for synced entities and device-local companion
   * state. A tab-closing action can therefore persist its records and Undo
   * journal together without leaking the journal into a Vault checkpoint.
   * `finalizeLocalSets` may synchronously replace values of the supplied local
   * keys using the final entity versions. It must not perform external effects
   * or add/remove keys. A throw aborts the entire transaction.
   * @param {LibraryCommitOptions} [options]
   */
  async function commit({ operations = [], localSets = {}, localDeletes = [], finalizeLocalSets } = {}) {
    if (!Array.isArray(operations) || !Array.isArray(localDeletes) ||
        !localSets || typeof localSets !== "object" || Array.isArray(localSets)) {
      throw new Error("A valid Library commit is required");
    }
    if (finalizeLocalSets !== undefined && typeof finalizeLocalSets !== "function") {
      throw new Error("The local-state finalizer must be a function");
    }
    const localEntries = Object.entries(localSets).map(([key, value]) => {
      requiredText(key, "A local storage key");
      if (value === undefined) throw new Error(`Local storage value ${key} is undefined`);
      return [key, structuredClone(value)];
    });
    const deleteKeys = [...new Set(localDeletes.map((key) =>
      requiredText(key, "A local storage key")))];
    const changedLocalKeys = [...new Set([
      ...localEntries.map(([key]) => key), ...deleteKeys
    ])];
    if (operations.length === 0 && changedLocalKeys.length === 0) {
      throw new Error("At least one storage operation is required");
    }
    const prepared = await Promise.all(
      operations.map((operation) => prepareOperation(operation, cryptoProvider))
    );
    const stores = [LIBRARY_STORES.local];
    if (prepared.length > 0) {
      stores.push(
        LIBRARY_STORES.entities, LIBRARY_STORES.assets, LIBRARY_STORES.outbox,
        LIBRARY_STORES.meta
      );
    }
    const result = await adapter.transaction(
      stores,
      "readwrite",
      async (transaction) => {
        let clock = prepared.length > 0
          ? localClockMeta(await transaction.get(LIBRARY_STORES.meta, META_CLOCK))
          : normalizeVersion(null);
        let sequence = prepared.length > 0
          ? localSequenceMeta(await transaction.get(LIBRARY_STORES.meta, META_SEQUENCE))
          : 0;
        const changes = [];
        for (const operation of prepared) {
          const previous = await transaction.get(
            LIBRARY_STORES.entities, [operation.entity.family, operation.entity.id]
          );
          requireSupportedEntity(previous);
          clock = greatestVersion(clock, previous?.version);
          clock = nextVersion(clock, null, deviceId, now());
          sequence += 1;
          for (const asset of operation.assets) {
            await transaction.put(LIBRARY_STORES.assets, asset);
          }
          const entity = {
            ...operation.entity,
            version: clock,
            versionKey: [clock.wallTime, clock.logicalCounter, clock.deviceId],
            contentHash: operation.contentHash,
            ...(operation.entity.lifecycle === "deleted" ? { deletedAt: clock.wallTime } : {})
          };
          await transaction.put(LIBRARY_STORES.entities, entity);
          changes.push({ sequence, entity: structuredClone(entity) });
        }
        if (prepared.length > 0) {
          await recordOutboxChanges(transaction, { deviceId, changes });
          await transaction.put(LIBRARY_STORES.meta, { key: META_CLOCK, value: clock });
          await transaction.put(LIBRARY_STORES.meta, { key: META_SEQUENCE, value: sequence });
        }
        let finalEntries = localEntries;
        if (finalizeLocalSets) {
          const finalized = finalizeLocalSets({
            changes: structuredClone(changes),
            localSets: Object.fromEntries(localEntries)
          });
          if (!finalized || typeof finalized !== "object" || Array.isArray(finalized) ||
              typeof finalized.then === "function" ||
              !sameStrings(Object.keys(finalized), localEntries.map(([key]) => key))) {
            throw new Error("The local-state finalizer must synchronously preserve its keys");
          }
          finalEntries = localEntries.map(([key]) => {
            if (finalized[key] === undefined) throw new Error(`Local storage value ${key} is undefined`);
            return [key, structuredClone(finalized[key])];
          });
        }
        for (const [key, value] of finalEntries) {
          await transaction.put(LIBRARY_STORES.local, { key, value });
        }
        for (const key of deleteKeys) await transaction.delete(LIBRARY_STORES.local, key);
        return {
          deviceId,
          fromSequence: changes[0]?.sequence ?? sequence,
          throughSequence: sequence,
          changes,
          localKeys: changedLocalKeys
        };
      }
    );
    notify(result);
    return result;
  }

  async function transact(operations) {
    return commit({ operations });
  }

  async function readSyncBatch({
    afterSequence = 0,
    throughSequence = Number.MAX_SAFE_INTEGER,
    maxOperations = DEFAULT_BATCH_OPERATIONS,
    maxBytes = DEFAULT_BATCH_BYTES
  } = {}) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("Sync cursor is invalid");
    }
    if (!Number.isSafeInteger(throughSequence) || throughSequence < afterSequence) {
      throw new Error("Sync upper cursor is invalid");
    }
    if (!Number.isSafeInteger(maxOperations) || maxOperations < 1) {
      throw new Error("Sync operation limit is invalid");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Sync byte limit is invalid");
    }
    return adapter.transaction(
      [LIBRARY_STORES.outbox, LIBRARY_STORES.assets, LIBRARY_STORES.meta],
      "readonly", async (transaction) => {
        const pending = await transaction.getAllByKeyRange(
          LIBRARY_STORES.outbox,
          {
            lower: [deviceId, afterSequence],
            upper: [deviceId, throughSequence],
            lowerOpen: true
          },
          maxOperations
        );
        const selected = [];
        let bytes = 0;
        for (const entry of pending) {
          const size = byteLength(entry);
          if (selected.length > 0 &&
              (selected.length >= maxOperations || bytes + size > maxBytes)) break;
          selected.push(entry);
          bytes += size;
        }
        const assets = [...(await readAssetsByDigest(
          transaction,
          LIBRARY_STORES.assets,
          selected.flatMap((entry) => entry.entity.assetDigests ?? [])
        )).values()];
        return {
          deviceId,
          compactedThroughSequence: await readCompactedSequence(transaction),
          fromSequence: selected[0]?.sequence ?? afterSequence,
          throughSequence: selected.at(-1)?.sequence ?? afterSequence,
          changes: selected.map(({ sequence, entity }) => ({ sequence, entity })),
          assets,
          byteLength: bytes
        };
      }
    );
  }

  async function acknowledgeSync(throughSequence) {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) {
      throw new Error("Sync acknowledgement is invalid");
    }
    return adapter.transaction(
      [LIBRARY_STORES.outbox, LIBRARY_STORES.meta], "readwrite",
      (transaction) => acknowledgeOutboxHistory(transaction, { deviceId, throughSequence })
    );
  }

  /**
   * Small durable identity and cursor projection for the Vault module. The
   * source id binds one device manifest to this exact Library database, so a
   * newly staged database cannot accidentally continue an older sequence.
   */
  async function readReplicationState() {
    return adapter.transaction(
      [LIBRARY_STORES.meta, LIBRARY_STORES.replicas], "readwrite", async (transaction) => {
        let source = await transaction.get(LIBRARY_STORES.meta, META_SOURCE_ID);
        if (!source) {
          const value = requiredText(createId(), "A replication source id");
          source = { key: META_SOURCE_ID, value };
          await transaction.put(LIBRARY_STORES.meta, source);
        }
        const sequence = localSequenceMeta(
          await transaction.get(LIBRARY_STORES.meta, META_SEQUENCE)
        );
        const replicas = (await transaction.getAll(LIBRARY_STORES.replicas)).map((replica) => ({
          deviceId: replica.deviceId,
          sourceId: typeof replica.sourceId === "string" ? replica.sourceId : null,
          sequence: Number.isSafeInteger(replica.sequence) ? replica.sequence : 0
        }));
        return { deviceId, sourceId: source.value, sequence, replicas };
      }
    );
  }

  async function applyRemoteBatch(batch) {
    const verified = await verifyRemoteBatch(batch, cryptoProvider);
    const result = await adapter.transaction(
      [
        LIBRARY_STORES.entities, LIBRARY_STORES.assets, LIBRARY_STORES.replicas,
        LIBRARY_STORES.meta, LIBRARY_STORES.local
      ],
      "readwrite",
      async (transaction) => {
        const replica = await transaction.get(LIBRARY_STORES.replicas, verified.deviceId);
        if (replica?.sourceId && verified.sourceId && replica.sourceId !== verified.sourceId) {
          throw new Error("Remote device replication source changed");
        }
        const cursor = Number.isSafeInteger(replica?.sequence) ? replica.sequence : 0;
        const pending = verified.changes.filter((change) => change.sequence > cursor);
        if (pending.length === 0) {
          return {
            applied: 0, ignored: verified.changes.length, sequence: cursor,
            changedFamilies: []
          };
        }
        if (pending[0].sequence !== cursor + 1) throw new Error("Remote batch does not continue its cursor");
        for (const asset of verified.assets) await transaction.put(LIBRARY_STORES.assets, asset);
        let clock = localClockMeta(await transaction.get(LIBRARY_STORES.meta, META_CLOCK));
        let applied = 0;
        const changedFamilies = new Set();
        for (const { entity } of pending) {
          for (const digest of entity.assetDigests ?? []) {
            if (!await transaction.get(LIBRARY_STORES.assets, digest)) {
              throw new Error(`Remote batch is missing asset ${digest}`);
            }
          }
          const current = await transaction.get(
            LIBRARY_STORES.entities, [entity.family, entity.id]
          );
          requireSupportedEntity(current);
          if (!current || compareVersions(entity.version, current.version) > 0) {
            await transaction.put(LIBRARY_STORES.entities, entity);
            applied += 1;
            changedFamilies.add(entity.family);
          }
          clock = greatestVersion(clock, entity.version);
        }
        const sequence = pending.at(-1).sequence;
        await transaction.put(LIBRARY_STORES.replicas, {
          deviceId: verified.deviceId,
          sourceId: verified.sourceId ?? replica?.sourceId ?? null,
          sequence,
          updatedAt: now()
        });
        await transaction.put(LIBRARY_STORES.meta, { key: META_CLOCK, value: clock });
        await recordPendingLibraryRevision(transaction, [...changedFamilies]);
        return {
          applied, ignored: verified.changes.length - applied, sequence,
          changedFamilies: [...changedFamilies]
        };
      }
    );
    if (result.applied > 0) {
      notify({ remoteDeviceId: verified.deviceId, ...result });
    }
    return result;
  }

  /**
   * Merge one verified remote checkpoint and advance only that remote
   * replica's cursor. Unlike the empty-database Restore primitive below, this
   * is safe for a populated Library: every entity still passes through the
   * same whole-record version resolver used by ordinary transaction chunks.
   */
  async function applyRemoteCheckpoint({
    deviceId: remoteDeviceId,
    sourceId,
    throughSequence,
    checkpoint
  } = {}) {
    requiredText(remoteDeviceId, "Remote checkpoint device id");
    requiredText(sourceId, "Remote checkpoint source id");
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) {
      throw new Error("Remote checkpoint sequence is invalid");
    }
    const verified = await verifyLibraryCheckpoint(checkpoint, cryptoProvider);
    const result = await adapter.transaction(
      [
        LIBRARY_STORES.entities, LIBRARY_STORES.assets, LIBRARY_STORES.replicas,
        LIBRARY_STORES.meta, LIBRARY_STORES.local
      ],
      "readwrite",
      async (transaction) => {
        const replica = await transaction.get(LIBRARY_STORES.replicas, remoteDeviceId);
        if (replica?.sourceId && replica.sourceId !== sourceId) {
          throw new Error("Remote device replication source changed");
        }
        const cursor = Number.isSafeInteger(replica?.sequence) ? replica.sequence : 0;
        if (replica && cursor >= throughSequence) {
          return {
            applied: 0, ignored: verified.entities.length, sequence: cursor,
            changedFamilies: []
          };
        }
        for (const asset of verified.assets) {
          await transaction.put(LIBRARY_STORES.assets, asset);
        }
        let clock = localClockMeta(await transaction.get(LIBRARY_STORES.meta, META_CLOCK));
        let applied = 0;
        const changedFamilies = new Set();
        for (const entity of verified.entities) {
          const current = await transaction.get(
            LIBRARY_STORES.entities, [entity.family, entity.id]
          );
          requireSupportedEntity(current);
          if (!current || compareVersions(entity.version, current.version) > 0) {
            await transaction.put(LIBRARY_STORES.entities, entity);
            applied += 1;
            changedFamilies.add(entity.family);
          }
          clock = greatestVersion(clock, entity.version);
        }
        await transaction.put(LIBRARY_STORES.replicas, {
          deviceId: remoteDeviceId,
          sourceId,
          sequence: throughSequence,
          updatedAt: now()
        });
        await transaction.put(LIBRARY_STORES.meta, { key: META_CLOCK, value: clock });
        await recordPendingLibraryRevision(transaction, [...changedFamilies]);
        return {
          applied,
          ignored: verified.entities.length - applied,
          sequence: throughSequence,
          changedFamilies: [...changedFamilies]
        };
      }
    );
    if (result.applied > 0) {
      notify({ remoteDeviceId, checkpoint: true, ...result });
    }
    return result;
  }

  /** Daily maintenance; roots and deletions share one transaction, never the UI save path. */
  async function collectUnusedAssets() {
    return adapter.transaction([
      LIBRARY_STORES.entities, LIBRARY_STORES.outbox, LIBRARY_STORES.local,
      LIBRARY_STORES.assets, LIBRARY_STORES.meta
    ], "readwrite", (transaction) => collectLibraryAssets(transaction, { now: now() }));
  }

  async function createExactCheckpoint() {
    return adapter.transaction(
      [LIBRARY_STORES.entities, LIBRARY_STORES.assets, LIBRARY_STORES.meta],
      "readonly",
      async (transaction) => {
        const entities = await transaction.getAll(LIBRARY_STORES.entities);
        const assets = [...(await readAssetsByDigest(
          transaction,
          LIBRARY_STORES.assets,
          entities.flatMap((entity) => entity.assetDigests ?? [])
        )).values()];
        const checkpoint = {
          app: "everytab",
          kind: "library-checkpoint",
          formatVersion: 1,
          createdAt: now(),
          entities,
          assets
        };
        return { ...checkpoint, contentHash: await contentHash(checkpoint, cryptoProvider) };
      }
    );
  }

  /** Supply verified local favicon payloads so Restore reads only missing Vault assets. */
  async function readRestoreAssets(digests) {
    return adapter.transaction(
      [LIBRARY_STORES.assets],
      "readonly",
      async (transaction) => [...(await readAssetsByDigest(
        transaction,
        LIBRARY_STORES.assets,
        digests
      )).values()].map((asset) => structuredClone(asset))
    );
  }

  async function readRestoreState() {
    return adapter.transaction(
      [LIBRARY_STORES.entities, LIBRARY_STORES.assets, LIBRARY_STORES.meta,
        LIBRARY_STORES.local],
      "readonly",
      async (transaction) => {
        const entities = await transaction.getAll(LIBRARY_STORES.entities);
        entities.forEach(requireSupportedEntity);
        const assets = [...(await readAssetsByDigest(
          transaction,
          LIBRARY_STORES.assets,
          entities.flatMap((entity) => entity.assetDigests ?? [])
        )).values()];
        return {
          entities,
          assets,
          sequence: localSequenceMeta(
            await transaction.get(LIBRARY_STORES.meta, META_SEQUENCE)
          ),
          restoreEpoch: restoreEpochMeta(
            await transaction.get(LIBRARY_STORES.meta, META_RESTORE_EPOCH)
          ),
          pending: (await transaction.get(
            LIBRARY_STORES.local, RESTORE_SAFETY_LOCAL_KEY
          ))?.value ?? null
        };
      }
    );
  }

  async function checkpointFromState(state) {
    const checkpoint = {
      app: "everytab",
      kind: "library-checkpoint",
      formatVersion: 1,
      createdAt: now(),
      entities: state.entities,
      assets: state.assets
    };
    return { ...checkpoint, contentHash: await contentHash(checkpoint, cryptoProvider) };
  }

  /** Read-only exact-Restore comparison. Recovery and device-local state are absent by design. */
  async function previewExactRestore(checkpoint, { onProgress = () => {} } = {}) {
    const [verified, current] = await Promise.all([
      verifyLibraryCheckpoint(checkpoint, cryptoProvider, onProgress),
      readRestoreState()
    ]);
    onProgress({ stage: "comparing", target: "records",
      completed: verified.entities.length, total: verified.entities.length });
    const difference = restoreDifference(current.entities, verified.entities);
    return {
      ...difference,
      currentSequence: current.sequence,
      restoreEpoch: current.restoreEpoch,
      currentStateHash: await contentHash(restoreStateIdentity(current.entities), cryptoProvider),
      checkpointContentHash: checkpoint.contentHash,
      pendingRestore: Boolean(current.pending),
      currentFamilies: liveCounts(current.entities),
      targetFamilies: liveCounts(verified.entities)
    };
  }

  async function replacementStateEntities(verified, currentEntities) {
    const targetIdentities = new Set(verified.entities.map(identityOf));
    const replacements = verified.entities.map((entity) => structuredClone(entity));
    for (const current of currentEntities) {
      if (targetIdentities.has(identityOf(current))) continue;
      const entity = {
        family: current.family,
        id: current.id,
        lifecycle: "deleted",
        assetDigests: []
      };
      replacements.push({
        ...entity,
        contentHash: await contentHash(entityContent(entity), cryptoProvider)
      });
    }
    return sortedEntities(replacements);
  }

  function changedReplacementEntities(replacementState, currentEntities) {
    const currentById = new Map(currentEntities.map((entity) => [identityOf(entity), entity]));
    return replacementState.filter((replacement) => {
      const current = currentById.get(identityOf(replacement));
      return !current || current.lifecycle !== replacement.lifecycle ||
        current.contentHash !== replacement.contentHash;
    });
  }

  async function applyExactReplacement({
    verified,
    current,
    expectedSequence,
    expectedRestoreEpoch,
    safety = null,
    expectedPendingId = null
  }) {
    const replacementState = await replacementStateEntities(verified, current.entities);
    const replacements = changedReplacementEntities(replacementState, current.entities);
    const appliedStateHash = await logicalStateHash(replacementState, cryptoProvider);
    const nextEpoch = current.restoreEpoch + 1;
    const appliedAt = now();
    const result = await adapter.transaction(
      [LIBRARY_STORES.entities, LIBRARY_STORES.assets, LIBRARY_STORES.outbox,
        LIBRARY_STORES.meta, LIBRARY_STORES.local],
      "readwrite",
      async (transaction) => {
        const sequenceBefore = localSequenceMeta(
          await transaction.get(LIBRARY_STORES.meta, META_SEQUENCE)
        );
        const epochBefore = restoreEpochMeta(
          await transaction.get(LIBRARY_STORES.meta, META_RESTORE_EPOCH)
        );
        const pendingRow = await transaction.get(
          LIBRARY_STORES.local, RESTORE_SAFETY_LOCAL_KEY
        );
        if (sequenceBefore !== expectedSequence || epochBefore !== expectedRestoreEpoch) {
          throw new Error("Saved data changed after this Restore was reviewed");
        }
        // Hashing and file verification happen before this transaction. Compare
        // the complete sampled identities synchronously here so a remote merge
        // in the final read-to-write gap cannot escape the freshness guard.
        const entitiesBefore = await transaction.getAll(LIBRARY_STORES.entities);
        if (canonicalJson(restoreStateIdentity(entitiesBefore)) !==
            canonicalJson(restoreStateIdentity(current.entities))) {
          throw new Error("Saved data changed after this Restore was reviewed");
        }
        if (expectedPendingId === null ? Boolean(pendingRow) :
            pendingRow?.value?.id !== expectedPendingId) {
          throw new Error(expectedPendingId === null
            ? "Confirm or undo the previous Vault Restore first"
            : "The Vault Restore safety point changed");
        }

        for (const asset of verified.assets) {
          await transaction.put(LIBRARY_STORES.assets, asset);
        }
        let clock = localClockMeta(await transaction.get(LIBRARY_STORES.meta, META_CLOCK));
        let sequence = sequenceBefore;
        const changes = [];
        for (const replacement of replacements) {
          const previous = await transaction.get(
            LIBRARY_STORES.entities, [replacement.family, replacement.id]
          );
          requireSupportedEntity(previous);
          clock = greatestVersion(clock, previous?.version);
          clock = nextVersion(clock, null, deviceId, appliedAt);
          sequence += 1;
          const entity = {
            family: replacement.family,
            id: replacement.id,
            lifecycle: replacement.lifecycle,
            ...(replacement.lifecycle === "live"
              ? {
                value: structuredClone(replacement.value),
                assetDigests: [...(replacement.assetDigests ?? [])]
              }
              : { assetDigests: [], deletedAt: clock.wallTime }),
            version: clock,
            versionKey: [clock.wallTime, clock.logicalCounter, clock.deviceId],
            contentHash: replacement.contentHash
          };
          await transaction.put(LIBRARY_STORES.entities, entity);
          changes.push({ sequence, entity: structuredClone(entity) });
        }
        await recordOutboxChanges(transaction, { deviceId, changes });
        await transaction.put(LIBRARY_STORES.meta, { key: META_CLOCK, value: clock });
        await transaction.put(LIBRARY_STORES.meta, { key: META_SEQUENCE, value: sequence });
        await transaction.put(LIBRARY_STORES.meta, {
          key: META_RESTORE_EPOCH,
          value: nextEpoch
        });
        if (safety) {
          await transaction.put(LIBRARY_STORES.local, {
            key: RESTORE_SAFETY_LOCAL_KEY,
            value: {
              ...safety,
              restoreEpoch: nextEpoch,
              appliedThroughSequence: sequence,
              appliedStateHash
            }
          });
        } else {
          await transaction.delete(LIBRARY_STORES.local, RESTORE_SAFETY_LOCAL_KEY);
        }
        await recordPendingLibraryRevision(transaction,
          [...new Set(changes.map(({ entity }) => entity.family))]);
        return {
          deviceId,
          fromSequence: changes[0]?.sequence ?? sequence,
          throughSequence: sequence,
          changes,
          restoreEpoch: nextEpoch
        };
      }
    );
    notify({ exactRestore: true, ...result });
    return result;
  }

  /**
   * Replace the complete portable Library as one transaction. The current
   * Library is retained locally until the user keeps or undoes the result.
   * All three expected values come from previewExactRestore; a preview made
   * before the state fingerprint was introduced must be reviewed again.
   */
  async function replaceFromCheckpoint(checkpoint, {
    expectedSequence,
    expectedRestoreEpoch,
    expectedStateHash,
    restoreId = createId(),
    source = null
  } = {}) {
    requiredText(restoreId, "A Restore identity");
    const verified = await verifyLibraryCheckpoint(checkpoint, cryptoProvider);
    const current = await readRestoreState();
    if (current.pending) throw new Error("Confirm or undo the previous Vault Restore first");
    if (typeof expectedStateHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedStateHash)) {
      throw new Error("Review this Restore point again before replacing saved data");
    }
    if (current.sequence !== expectedSequence || current.restoreEpoch !== expectedRestoreEpoch ||
        await contentHash(restoreStateIdentity(current.entities), cryptoProvider) !== expectedStateHash) {
      throw new Error("Saved data changed after this Restore was reviewed");
    }
    const difference = restoreDifference(current.entities, verified.entities);
    if (!difference.changed) return { status: "no-op", summary: difference };
    const safetyCheckpoint = await checkpointFromState(current);
    const applied = await applyExactReplacement({
      verified,
      current,
      expectedSequence,
      expectedRestoreEpoch,
      safety: {
        app: "everytab",
        kind: "vault-restore-safety",
        formatVersion: 1,
        id: restoreId,
        createdAt: now(),
        targetCheckpointContentHash: checkpoint.contentHash,
        source: source ? structuredClone(source) : null,
        checkpoint: safetyCheckpoint
      }
    });
    return { status: "restored", restoreId, summary: difference, ...applied };
  }

  async function readPendingRestore() {
    const current = await readRestoreState();
    if (!current.pending) return null;
    const { checkpoint: _checkpoint, ...publicState } = current.pending;
    return structuredClone(publicState);
  }

  async function confirmExactRestore(restoreId) {
    requiredText(restoreId, "A Restore identity");
    return adapter.transaction([LIBRARY_STORES.local], "readwrite", async (transaction) => {
      const row = await transaction.get(LIBRARY_STORES.local, RESTORE_SAFETY_LOCAL_KEY);
      if (!row) return false;
      if (row.value?.id !== restoreId) throw new Error("The Vault Restore safety point changed");
      await transaction.delete(LIBRARY_STORES.local, RESTORE_SAFETY_LOCAL_KEY);
      return true;
    });
  }

  async function undoExactRestore(restoreId) {
    requiredText(restoreId, "A Restore identity");
    const current = await readRestoreState();
    const pending = current.pending;
    if (!pending || pending.id !== restoreId) {
      throw new Error("The Vault Restore safety point is no longer available");
    }
    if (current.sequence !== pending.appliedThroughSequence ||
        current.restoreEpoch !== pending.restoreEpoch ||
        await logicalStateHash(current.entities, cryptoProvider) !== pending.appliedStateHash) {
      throw new Error("Saved data changed after the Vault Restore, so Undo was not applied");
    }
    const verified = await verifyLibraryCheckpoint(pending.checkpoint, cryptoProvider);
    const difference = restoreDifference(current.entities, verified.entities);
    const applied = await applyExactReplacement({
      verified,
      current,
      expectedSequence: current.sequence,
      expectedRestoreEpoch: current.restoreEpoch,
      expectedPendingId: restoreId
    });
    return { status: "undone", restoreId, summary: difference, ...applied };
  }

  /**
   * Seed a verified checkpoint into a genuinely empty Library. This narrow
   * primitive is for conversion rehearsal and disaster recovery; it never
   * overlays or replaces a populated database.
   */
  async function seedExactCheckpoint(checkpoint) {
    const verified = await verifyLibraryCheckpoint(checkpoint, cryptoProvider);
    return adapter.transaction(
      Object.values(LIBRARY_STORES), "readwrite", async (transaction) => {
        for (const store of Object.values(LIBRARY_STORES)) {
          if ((await transaction.getAll(store)).length > 0) {
            throw new Error("Library checkpoint destination is not empty");
          }
        }
        for (const asset of verified.assets) {
          await transaction.put(LIBRARY_STORES.assets, asset);
        }
        for (const entity of verified.entities) {
          await transaction.put(LIBRARY_STORES.entities, entity);
        }
        await transaction.put(LIBRARY_STORES.meta, { key: META_CLOCK, value: verified.clock });
        await transaction.put(LIBRARY_STORES.meta, { key: META_SEQUENCE, value: 0 });
        return { entities: verified.entities.length, assets: verified.assets.length };
      }
    );
  }

  return {
    collectUnusedAssets,
    readEntity,
    readFamily,
    readPortableState,
    readLocal,
    commit,
    transact,
    readSyncBatch,
    acknowledgeSync,
    readReplicationState,
    applyRemoteBatch,
    applyRemoteCheckpoint,
    createExactCheckpoint,
    readRestoreAssets,
    seedExactCheckpoint,
    previewExactRestore,
    replaceFromCheckpoint,
    readPendingRestore,
    confirmExactRestore,
    undoExactRestore,
    subscribe(listener) {
      if (typeof listener !== "function") throw new Error("A storage listener is required");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => adapter.close?.()
  };
}

export function openLibraryStore({
  databaseName, deviceId, now, cryptoProvider, createId, onCommit
} = {}) {
  const adapter = createIndexedDbAdapter(LIBRARY_SCHEMA, { databaseName });
  return createLibraryStore({ adapter, deviceId, now, cryptoProvider, createId, onCommit });
}
