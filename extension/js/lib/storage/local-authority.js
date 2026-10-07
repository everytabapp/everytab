// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Logical local authority over the physical Library and Recovery modules.
 *
 * Product code speaks the existing map-shaped EveryTab storage language at
 * this boundary. IndexedDB entities, compact tombstones, assets, and the
 * separate automatic-Snapshot database remain private implementation details.
 */
import { ARCHIVE_OVERLAY_KEY, STORE_KEYS, effectiveSnapshotKeep } from "../types.js";
import {
  NAMED_SESSION_RECORDS_KEY, SESSION_IDENTITY_INDEX_KEY,
  SESSION_NAVIGATION_REVISION_KEY, buildSessionIdentityIndex,
  buildSessionNavigationRevision
} from "../session-identity-index.js";
import { canonicalJson } from "./canonical.js";
import { makeRecoveryDeletionMarker } from "./recovery-store.js";
import { JOURNAL_KEY, sealCommittedJournalDeletions } from "../journal-state.js";
import {
  STORAGE_LABEL_META_FAMILY, STORAGE_SETTINGS_FAMILY,
  STORAGE_SINGLETON_ID, STORAGE_DURABLE_REVISION_LOCAL_KEY,
  STORAGE_PENDING_LIBRARY_REVISION_LOCAL_KEY, pendingLibraryFamilies
} from "./constants.js";

const SETTINGS_KEY = "settings";
const SETTINGS_MODIFIED_AT_KEY = "settingsModifiedAt";
const LABEL_META_KEY = "labelMeta";
const RECORD_FAMILIES = new Set(Object.values(STORE_KEYS));

/** @typedef {import("./library-store.js").LibraryStore} LibraryStore */
/** @typedef {import("./recovery-store.js").RecoveryStore} RecoveryStore */
/** Public logical storage interface, inferred from its constructor. @typedef {ReturnType<typeof createStorageAuthority>} StorageAuthority */

function hasMethods(value, names) {
  return value && names.every((name) => typeof value[name] === "function");
}

function sameValue(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function compactTombstone(entity) {
  const deletedAt = Number.isFinite(entity.deletedAt)
    ? entity.deletedAt : entity.version?.wallTime ?? 0;
  return {
    id: entity.id,
    deviceId: entity.version?.deviceId ?? "storage-v2",
    createdAt: deletedAt,
    modifiedAt: deletedAt,
    schemaVersion: 1,
    deletedAt,
    deletionRevision: canonicalJson(entity.version ?? {})
  };
}

/**
 * Finalize only this commit's new Undo entries against compact deletion
 * identities. Library clocks are assigned inside its transaction; Recovery
 * uses preplanned markers written with its later deletion. A failed Recovery
 * delete leaves a live Snapshot, which cannot match the sealed marker.
 */
function journalFinalizer(before, sets, operations, recoveryDeletions) {
  if ((!operations.some((operation) => operation.type === "delete") && recoveryDeletions.length === 0) ||
      !Array.isArray(sets[JOURNAL_KEY])) return undefined;
  const priorIds = new Set((before[JOURNAL_KEY] ?? []).map((entry) => entry?.id));
  if (!sets[JOURNAL_KEY].some((entry) => entry?.id && !priorIds.has(entry.id))) return undefined;
  return ({ changes, localSets }) => {
    const deletionMaps = Object.create(null);
    if (recoveryDeletions.length) {
      deletionMaps[STORE_KEYS.sessions] = Object.fromEntries(recoveryDeletions.map((marker) => [marker.id, marker]));
    }
    for (const { entity } of changes) {
      if (entity.lifecycle !== "deleted") continue;
      deletionMaps[entity.family] ??= Object.create(null);
      deletionMaps[entity.family][entity.id] = compactTombstone(entity);
    }
    return {
      ...localSets,
      [JOURNAL_KEY]: sealCommittedJournalDeletions(
        before[JOURNAL_KEY] ?? [], localSets[JOURNAL_KEY], deletionMaps
      )
    };
  };
}

export function mapFromLibraryEntities(entities) {
  return Object.fromEntries((entities ?? []).map((entity) => [
    entity.id,
    entity.lifecycle === "deleted"
      ? compactTombstone(entity)
      : structuredClone(entity.value)
  ]));
}

/** Translate one whole-map result into the smallest entity operation set. */
export function planLibraryFamilyChanges(family, before = {}, after = {}) {
  if (!RECORD_FAMILIES.has(family)) throw new Error(`Unknown portable family ${family}`);
  const operations = [];
  for (const id of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const previous = before?.[id];
    const next = after?.[id];
    if (!next || Number.isFinite(next.deletedAt)) {
      if (previous && !Number.isFinite(previous.deletedAt)) {
        operations.push({ type: "delete", family, id });
      }
      continue;
    }
    if (!previous || Number.isFinite(previous.deletedAt) || !sameValue(previous, next)) {
      operations.push({ type: "put", family, id, value: structuredClone(next) });
    }
  }
  return operations;
}

function automaticSessions(map = {}) {
  return Object.fromEntries(Object.entries(map).filter(([, session]) => session?.auto === true));
}

function namedSessions(map = {}) {
  return Object.fromEntries(Object.entries(map).filter(([, session]) => session?.auto !== true));
}

function planRecoveryChanges(before = {}, after = {}) {
  const captures = [];
  const deletes = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const previous = before[id];
    const next = after[id];
    if (!next || Number.isFinite(next.deletedAt)) {
      if (previous && !Number.isFinite(previous.deletedAt)) deletes.push(id);
      continue;
    }
    if (!previous || Number.isFinite(previous.deletedAt) || !sameValue(previous, next)) {
      captures.push(next);
    }
  }
  return { captures, deletes };
}

/**
 * Create the sole map/entity translation seam. Device-local browser state can
 * remain in chrome.storage while portable Library and Recovery data stays in
 * IndexedDB.
 * @param {{library:LibraryStore,recovery:RecoveryStore,
 *   readBrowserLocal?:(keys:string[])=>Promise<Record<string,unknown>>,
 *   snapshotRetention?:number}} options
 */
export function createStorageAuthority({
  library,
  recovery,
  readBrowserLocal = async () => ({}),
  snapshotRetention = 200
}) {
  if (!hasMethods(library, ["readEntity", "readFamily", "commit", "readLocal"]) ||
      !hasMethods(recovery, ["listSnapshots", "captureSnapshot", "deleteSnapshot",
        "readDeletionMarkers", "readReplicationState"]) ||
      typeof readBrowserLocal !== "function") {
    throw new Error("Library and Recovery stores are required");
  }

  /**
   * Read one portable Library record without materializing its whole family.
   * Automatic Snapshots intentionally live only in Recovery, so a named Session
   * action cannot pull retained Snapshot history or unrelated favicon assets.
   */
  async function readItem(family, id) {
    if (!RECORD_FAMILIES.has(family) || typeof id !== "string" || !id) return null;
    const entity = await library.readEntity(family, id, { includeDeleted: true });
    if (!entity) return null;
    return entity.lifecycle === "deleted"
      ? compactTombstone(entity)
      : structuredClone(entity.value);
  }

  /** One bounded projection for navigation, Labels, and Stats. */
  async function readSessionNavigation() {
    const [entities, recoveryState] = await Promise.all([
      library.readFamily(STORE_KEYS.sessions, { includeDeleted: true }),
      recovery.readReplicationState()
    ]);
    const records = namedSessions(mapFromLibraryEntities(entities));
    return {
      namedSessions: Object.values(records)
        .filter((session) => session && !session.deletedAt)
        .sort((left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0)),
      snapshotCount: recoveryState.snapshotCount
    };
  }

  async function readMaps(keys, { includeFavicons = true } = {}) {
    const requested = [...new Set(keys ?? [])];
    const output = {};
    // Both logical Session views can need the same Library rows. Share only
    // this invocation's read; each view still builds its own detached map.
    let sessionEntitiesRead;
    const readSessionEntities = () => sessionEntitiesRead ??= library.readFamily(
      STORE_KEYS.sessions, { includeDeleted: true, includeFavicons }
    );
    const portable = requested.filter((key) => RECORD_FAMILIES.has(key));
    const ordinary = portable.filter((key) => key !== STORE_KEYS.sessions);
    const tasks = ordinary.map(async (family) => {
      output[family] = mapFromLibraryEntities(
        await library.readFamily(family, { includeDeleted: true, includeFavicons })
      );
    });
    if (portable.includes(STORE_KEYS.sessions)) {
      tasks.push((async () => {
        const [entities, snapshots, deletions] = await Promise.all([
          readSessionEntities(),
          recovery.listSnapshots({ limit: 10_000, includeFavicons }),
          recovery.readDeletionMarkers()
        ]);
        output[STORE_KEYS.sessions] = {
          ...Object.fromEntries(deletions.map((marker) => [marker.id, marker])),
          ...mapFromLibraryEntities(entities),
          ...Object.fromEntries(snapshots.map(({ id, value }) => [id, structuredClone(value)]))
        };
      })());
    }
    if (requested.includes(NAMED_SESSION_RECORDS_KEY)) {
      tasks.push((async () => {
        const entities = await readSessionEntities();
        output[NAMED_SESSION_RECORDS_KEY] = namedSessions(
          mapFromLibraryEntities(entities)
        );
      })());
    }

    const wantsSettings = requested.includes(SETTINGS_KEY) ||
      requested.includes(SETTINGS_MODIFIED_AT_KEY);
    if (wantsSettings) {
      tasks.push((async () => {
        const entity = await library.readEntity(
          STORAGE_SETTINGS_FAMILY, STORAGE_SINGLETON_ID
        );
        if (!entity) return;
        output[SETTINGS_KEY] = structuredClone(entity.value.value ?? {});
        output[SETTINGS_MODIFIED_AT_KEY] = Number.isFinite(entity.value.modifiedAt)
          ? entity.value.modifiedAt : 0;
      })());
    }
    if (requested.includes(LABEL_META_KEY)) {
      tasks.push((async () => {
        const entity = await library.readEntity(
          STORAGE_LABEL_META_FAMILY, STORAGE_SINGLETON_ID
        );
        if (entity) output[LABEL_META_KEY] = structuredClone(entity.value.value ?? {});
      })());
    }

    const localKeys = requested.filter((key) =>
      !RECORD_FAMILIES.has(key) && key !== SETTINGS_KEY &&
      key !== SETTINGS_MODIFIED_AT_KEY && key !== LABEL_META_KEY &&
      key !== NAMED_SESSION_RECORDS_KEY && key !== ARCHIVE_OVERLAY_KEY);
    if (requested.includes(ARCHIVE_OVERLAY_KEY)) output[ARCHIVE_OVERLAY_KEY] = {};
    if (localKeys.length > 0) {
      tasks.push((async () => {
        const [stored, fallback] = await Promise.all([
          library.readLocal(localKeys), readBrowserLocal(localKeys)
        ]);
        for (const key of localKeys) {
          if (Object.hasOwn(stored, key)) output[key] = stored[key];
          else if (Object.hasOwn(fallback ?? {}, key)) output[key] = structuredClone(fallback[key]);
        }
      })());
    }
    await Promise.all(tasks);
    return output;
  }

  async function effectiveRecoveryRetention(committedSets) {
    const settings = committedSets
      ? committedSets[SETTINGS_KEY]
      : (await readMaps([SETTINGS_KEY]))[SETTINGS_KEY];
    if (!settings || typeof settings !== "object" || !Object.hasOwn(settings, "snapshotKeep")) {
      return snapshotRetention;
    }
    return effectiveSnapshotKeep(settings.snapshotKeep);
  }

  async function commitMaps(sets) {
    const keys = Object.keys(sets ?? {});
    if (keys.length === 0) throw new Error("At least one logical storage value is required");
    if (keys.includes(STORE_KEYS.sessions) && keys.includes(NAMED_SESSION_RECORDS_KEY) &&
        !sameValue(namedSessions(sets[STORE_KEYS.sessions]), sets[NAMED_SESSION_RECORDS_KEY])) {
      throw new Error("Session map and named Session projection disagree");
    }
    const reads = keys.includes(ARCHIVE_OVERLAY_KEY) && !keys.includes(STORE_KEYS.archive)
      ? [...keys, STORE_KEYS.archive] : keys;
    const before = await readMaps(reads);
    const operations = [];
    const logicalChanges = {};
    let recoveryPlan = { captures: [], deletes: [] };

    for (const family of keys.filter((key) => RECORD_FAMILIES.has(key))) {
      if (family === STORE_KEYS.sessions) {
        operations.push(...planLibraryFamilyChanges(
          family, namedSessions(before[family]), namedSessions(sets[family])
        ));
        recoveryPlan = planRecoveryChanges(
          automaticSessions(before[family]), automaticSessions(sets[family])
        );
      } else {
        operations.push(...planLibraryFamilyChanges(family, before[family], sets[family]));
      }
    }
    if (keys.includes(NAMED_SESSION_RECORDS_KEY) && !keys.includes(STORE_KEYS.sessions)) {
      operations.push(...planLibraryFamilyChanges(
        STORE_KEYS.sessions,
        before[NAMED_SESSION_RECORDS_KEY],
        sets[NAMED_SESSION_RECORDS_KEY]
      ));
    }
    // Live navigation needs only identity, name, and counts. Never persist or
    // broadcast complete Session maps here: they can contain thousands of tab
    // references and hydrated favicon assets.
    const sessionKeyChanged = keys.includes(STORE_KEYS.sessions) ||
      keys.includes(NAMED_SESSION_RECORDS_KEY);
    if (sessionKeyChanged) {
      const source = keys.includes(STORE_KEYS.sessions)
        ? sets[STORE_KEYS.sessions] ?? {}
        : sets[NAMED_SESSION_RECORDS_KEY] ?? {};
      logicalChanges[SESSION_NAVIGATION_REVISION_KEY] = {
        newValue: buildSessionNavigationRevision(source, {
          includeSnapshotCount: keys.includes(STORE_KEYS.sessions)
        })
      };
    }
    if (keys.includes(ARCHIVE_OVERLAY_KEY) && !keys.includes(STORE_KEYS.archive)) {
      const overlay = sets[ARCHIVE_OVERLAY_KEY] ?? {};
      const current = Object.fromEntries(Object.keys(overlay).flatMap((id) =>
        Object.hasOwn(before[STORE_KEYS.archive] ?? {}, id)
          ? [[id, before[STORE_KEYS.archive][id]]] : []));
      operations.push(...planLibraryFamilyChanges(
        STORE_KEYS.archive, current, overlay
      ));
    }

    if (keys.includes(SETTINGS_KEY) || keys.includes(SETTINGS_MODIFIED_AT_KEY)) {
      const value = {
        value: structuredClone(sets[SETTINGS_KEY] ?? before[SETTINGS_KEY] ?? {}),
        modifiedAt: Number.isFinite(sets[SETTINGS_MODIFIED_AT_KEY])
          ? sets[SETTINGS_MODIFIED_AT_KEY]
          : before[SETTINGS_MODIFIED_AT_KEY] ?? 0
      };
      if (!sameValue(value, {
        value: before[SETTINGS_KEY] ?? {},
        modifiedAt: before[SETTINGS_MODIFIED_AT_KEY] ?? 0
      })) {
        operations.push({
          type: "put",
          family: STORAGE_SETTINGS_FAMILY,
          id: STORAGE_SINGLETON_ID,
          value
        });
        logicalChanges[SETTINGS_KEY] = {
          oldValue: structuredClone(before[SETTINGS_KEY] ?? {}),
          newValue: structuredClone(value.value)
        };
        logicalChanges[SETTINGS_MODIFIED_AT_KEY] = {
          oldValue: before[SETTINGS_MODIFIED_AT_KEY] ?? 0,
          newValue: value.modifiedAt
        };
      }
    }
    if (keys.includes(LABEL_META_KEY) &&
        !sameValue(before[LABEL_META_KEY] ?? {}, sets[LABEL_META_KEY] ?? {})) {
      operations.push({
        type: "put",
        family: STORAGE_LABEL_META_FAMILY,
        id: STORAGE_SINGLETON_ID,
        value: { value: structuredClone(sets[LABEL_META_KEY] ?? {}) }
      });
    }

    const localSets = {};
    for (const key of keys.filter((key) =>
      !RECORD_FAMILIES.has(key) && key !== SETTINGS_KEY &&
      key !== SETTINGS_MODIFIED_AT_KEY && key !== LABEL_META_KEY &&
      key !== NAMED_SESSION_RECORDS_KEY && key !== ARCHIVE_OVERLAY_KEY)) {
      if (!sameValue(before[key], sets[key])) localSets[key] = structuredClone(sets[key]);
    }

    const changed = operations.length > 0 || recoveryPlan.captures.length > 0 ||
      recoveryPlan.deletes.length > 0 || Object.keys(localSets).length > 0;
    const revision = changed ? {
      id: crypto.randomUUID(),
      changedKeys: [...new Set([...keys, ...Object.keys(logicalChanges)])],
      ...(Object.keys(logicalChanges).length > 0
        ? { logicalChanges: structuredClone(logicalChanges) } : {}),
      committedAt: Date.now()
    } : null;
    if (revision) localSets[STORAGE_DURABLE_REVISION_LOCAL_KEY] = revision;

    // Automatic Snapshots are device-local recovery data. They commit first;
    // if the companion Library transaction later fails, a later capture can
    // at worst replace the same id, never lose the retained arrangement.
    // Recovery retention follows the visible Settings value, so the database
    // never prunes below what Settings promises. The authority record keeps
    // the default for profiles that never stored the setting.
    const retention = recoveryPlan.captures.length > 0
      ? await effectiveRecoveryRetention(keys.includes(SETTINGS_KEY) ? sets : null)
      : snapshotRetention;
    for (const snapshot of recoveryPlan.captures) {
      await recovery.captureSnapshot(snapshot, {
        id: snapshot.id,
        capturedAt: Math.max(0, Math.floor(snapshot.modifiedAt ?? snapshot.createdAt ?? Date.now())),
        retention
      });
    }
    const recoveryDeletions = recoveryPlan.deletes.map(makeRecoveryDeletionMarker);
    if (operations.length > 0 || Object.keys(localSets).length > 0) {
      await library.commit({
        operations, localSets,
        finalizeLocalSets: journalFinalizer(before, sets, operations, recoveryDeletions)
      });
    }
    // Deletion is intentionally last. A failure may retain one older recovery
    // snapshot, but can never remove the only durable copy before the rest of
    // the logical commit succeeds.
    for (const marker of recoveryDeletions) await recovery.deleteSnapshot(marker.id, { marker });
    return {
      changed,
      keys,
      entityOperations: operations.length,
      recoveryCaptures: recoveryPlan.captures.length,
      recoveryDeletes: recoveryPlan.deletes.length,
      localKeys: Object.keys(localSets).filter((key) =>
        key !== STORAGE_DURABLE_REVISION_LOCAL_KEY),
      logicalChanges,
      revision
    };
  }

  async function readPendingRevision() {
    return (await library.readLocal([STORAGE_DURABLE_REVISION_LOCAL_KEY]))
      [STORAGE_DURABLE_REVISION_LOCAL_KEY] ?? null;
  }

  /**
   * Publish the exact logical families changed by a Library mutation outside
   * the map adapter, such as a remote Vault merge or exact Restore. Session
   * navigation and its device-local membership index are rebuilt from the
   * authoritative post-mutation state before the revision becomes visible.
   * Call under the Store lock. Empty input repairs durable intent left by an
   * earlier interrupted merge; index/revision publication retires that intent
   * in the same transaction, so a failed rebuild remains retryable.
   */
  async function commitLibraryRevision(families = []) {
    const pending = pendingLibraryFamilies((await library.readLocal([
      STORAGE_PENDING_LIBRARY_REVISION_LOCAL_KEY
    ]))[STORAGE_PENDING_LIBRARY_REVISION_LOCAL_KEY]);
    const changedKeys = [...new Set([...pending, ...families.filter((family) =>
      typeof family === "string" && family)])];
    if (changedKeys.length === 0) return null;
    const logicalChanges = {};
    const localSets = {};
    if (changedKeys.includes(STORAGE_SETTINGS_FAMILY)) {
      changedKeys.push(SETTINGS_MODIFIED_AT_KEY);
    }
    if (changedKeys.includes(STORE_KEYS.sessions)) {
      const [entities, snapshots] = await Promise.all([
        library.readFamily(STORE_KEYS.sessions, { includeDeleted: true }),
        recovery.listSnapshots({ limit: 10_000 })
      ]);
      const named = mapFromLibraryEntities(entities);
      localSets[SESSION_IDENTITY_INDEX_KEY] = buildSessionIdentityIndex(named);
      changedKeys.push(SESSION_IDENTITY_INDEX_KEY, NAMED_SESSION_RECORDS_KEY,
        SESSION_NAVIGATION_REVISION_KEY);
      logicalChanges[SESSION_NAVIGATION_REVISION_KEY] = {
        newValue: buildSessionNavigationRevision({
          ...named,
          ...Object.fromEntries(snapshots.map(({ id, value }) => [id, value]))
        }, { includeSnapshotCount: true })
      };
    }
    const revision = {
      id: crypto.randomUUID(),
      changedKeys: [...new Set(changedKeys)],
      ...(Object.keys(logicalChanges).length > 0 ? { logicalChanges } : {}),
      committedAt: Date.now()
    };
    localSets[STORAGE_DURABLE_REVISION_LOCAL_KEY] = revision;
    await library.commit({ localSets,
      localDeletes: pending.length > 0 ? [STORAGE_PENDING_LIBRARY_REVISION_LOCAL_KEY] : [] });
    return revision;
  }

  return {
    readItem,
    readSessionNavigation,
    readMaps,
    commitMaps,
    readPendingRevision,
    commitLibraryRevision,
    // Compatibility for the focused pre-release authority tests and any open
    // development page from before exact Restore joined this shared seam.
    commitRemoteRevision: commitLibraryRevision
  };
}
