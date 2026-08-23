/** Locked portable Export/Restore transactions and the one selective checkpoint. */
import { ARCHIVE_OVERLAY_KEY, STORE_KEYS } from "./types.js";
import {
  archiveBaseFromMutationMaps, mergeArchiveMaps, mutateStores, withStoreLock
} from "./store.js";
import { LABEL_META_KEY } from "./label-meta.js";
import {
  JOURNAL_CAP, JOURNAL_KEY, appendedJournal, makeJournalEntry
} from "./journal.js";
import {
  PORTABLE_EXPORT_MAX_BYTES, SETTINGS_KEY, SETTINGS_MODIFIED_AT_KEY,
  assertPortableRestoreTextSize, parsePortableExport, portableRecordEntries
} from "./portable-state-registry.js";
import {
  exportPortableEnvelope, localPortableState, planPortableRestore, sameValue,
  valueFingerprint
} from "./portable-state-planner.js";

export const RESTORE_CHECKPOINT_KEY = "restoreCheckpoint";

function portableStorageKeys() {
  return [...new Set([
    ...portableRecordEntries().map((entry) => entry.key),
    SETTINGS_KEY, SETTINGS_MODIFIED_AT_KEY, LABEL_META_KEY, ARCHIVE_OVERLAY_KEY,
    JOURNAL_KEY, RESTORE_CHECKPOINT_KEY
  ])];
}

function stateFromMutationMaps(maps) {
  return localPortableState(maps, {
    archiveBase: archiveBaseFromMutationMaps(maps),
    archiveOverlay: maps[ARCHIVE_OVERLAY_KEY] ?? {}
  });
}

function stateFromRawMaps(raw) {
  return localPortableState({
    ...raw,
    [STORE_KEYS.archive]: mergeArchiveMaps(
      raw[STORE_KEYS.archive], raw[ARCHIVE_OVERLAY_KEY]
    )
  }, {
    archiveBase: raw[STORE_KEYS.archive] ?? {},
    archiveOverlay: raw[ARCHIVE_OVERLAY_KEY] ?? {}
  });
}

async function readPortableLocalState({ locked = false } = {}) {
  const read = async () => stateFromRawMaps(await chrome.storage.local.get(portableStorageKeys()));
  return locked ? withStoreLock(read) : read();
}

/**
 * Full portable JSON export, read coherently under the shared store lock.
 * Reads portable storage under the lock and performs no mutation.
 * @returns {Promise<string>}
 */
export async function buildPortableExport() {
  const local = await readPortableLocalState({ locked: true });
  return JSON.stringify(exportPortableEnvelope(local), null, 2);
}

/**
 * Validate and read a selected file without allocating text above the byte ceiling.
 * @param {{size?: number, text: () => Promise<string>}} file
 * @returns {Promise<string>}
 */
export async function readPortableRestoreFile(file) {
  if (!file || typeof file.text !== "function") throw new Error("That backup could not be read");
  if (Number.isFinite(file.size) && file.size > PORTABLE_EXPORT_MAX_BYTES) {
    throw new Error("That backup is too large to Restore safely");
  }
  const text = await file.text();
  assertPortableRestoreTextSize(text);
  return text;
}

/**
 * Validate the whole file and preview its deterministic merge without writing.
 * @param {string} text
 * @param {{restoreSettings?: boolean}} [options]
 * @returns {Promise<import("./types.js").PortableRestoreSummary>}
 */
export async function previewPortableRestore(text, options = {}) {
  const parsed = parsePortableExport(text);
  const local = await readPortableLocalState();
  return planPortableRestore(parsed, local, options).summary;
}

/** @returns {import("./types.js").PortableRestoreSource} */
function sanitizeSource(source, parsed, text) {
  const safe = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  return {
    name: typeof safe.name === "string" ? safe.name.slice(0, 512) : "EveryTab backup",
    size: Number.isFinite(safe.size) && safe.size >= 0
      ? safe.size : assertPortableRestoreTextSize(text),
    lastModified: Number.isFinite(safe.lastModified) && safe.lastModified >= 0
      ? safe.lastModified : 0,
    exportedAt: parsed.exportedAt,
    hash: parsed.sourceHash
  };
}

function hasOwn(map, key) {
  return Object.hasOwn(map ?? {}, key);
}

function exactValue(map, key) {
  return hasOwn(map, key) ? structuredClone(map[key]) : null;
}

function postDescriptor(value, present = true) {
  if (!present) return { present: false };
  return {
    present: true,
    modifiedAt: Number.isFinite(value?.modifiedAt) ? value.modifiedAt : 0,
    schemaVersion: Number.isInteger(value?.schemaVersion) ? value.schemaVersion : 1,
    ...(Number.isFinite(value?.deletedAt) ? { deletedAt: value.deletedAt } : {}),
    hash: valueFingerprint(value)
  };
}

function sameDescriptor(map, id, expected) {
  const present = hasOwn(map, id);
  if (present !== Boolean(expected?.present)) return false;
  return !present || sameValue(postDescriptor(map[id]), expected);
}

/** @returns {import("./types.js").RestoreCheckpointV2} */
function makeCheckpoint(id, createdAt, source, local, plan) {
  const records = {};
  for (const key of plan.changedRecordKeys) {
    const changes = {};
    if (key === STORE_KEYS.archive) {
      // An affected Archive commit folds its existing small write overlay into
      // the base. Every physically moved overlay id is therefore affected even
      // when the incoming file did not change that logical record.
      const physicalIds = new Set([
        ...Object.keys(plan.recordChanges[key]),
        ...Object.keys(local.archiveOverlay)
      ]);
      for (const recordId of physicalIds) {
        changes[recordId] = {
          beforeBasePresent: hasOwn(local.archiveBase, recordId),
          beforeBase: exactValue(local.archiveBase, recordId),
          beforeOverlayPresent: hasOwn(local.archiveOverlay, recordId),
          beforeOverlay: exactValue(local.archiveOverlay, recordId),
          expectedBase: postDescriptor(
            plan.records[STORE_KEYS.archive][recordId],
            hasOwn(plan.records[STORE_KEYS.archive], recordId)
          ),
          expectedOverlay: postDescriptor(null, false)
        };
      }
    } else {
      for (const [recordId, change] of Object.entries(plan.recordChanges[key])) {
        changes[recordId] = {
          beforePresent: change.beforePresent,
          before: change.beforePresent ? structuredClone(change.before) : null,
          expected: postDescriptor(change.after)
        };
      }
    }
    records[key] = changes;
  }

  const labelMeta = Object.create(null);
  for (const [label, change] of Object.entries(plan.labelChanges)) {
    labelMeta[label] = {
      beforePresent: change.beforePresent,
      before: change.before,
      expected: change.after
    };
  }

  const affected = [
    ...plan.changedRecordKeys,
    ...(plan.changedSettings ? [SETTINGS_KEY] : []),
    ...(plan.changedLabelMeta ? [LABEL_META_KEY] : [])
  ];
  return {
    version: 2,
    id,
    createdAt,
    source,
    affected,
    changes: {
      records,
      ...(plan.changedSettings ? {
        settings: {
          before: structuredClone(local.settingsRaw),
          beforeModifiedAt: local.settingsModifiedAt,
          expected: {
            modifiedAt: plan.settingsModifiedAt,
            hash: valueFingerprint(plan.settings)
          }
        }
      } : {}),
      ...(plan.changedLabelMeta ? { labelMeta } : {})
    }
  };
}

function markRestoreJournal(journal, checkpointId, fields) {
  const next = structuredClone(journal ?? []);
  const entry = next.find((candidate) => candidate.restoreCheckpointId === checkpointId);
  if (!entry) return { changed: false, journal: next };
  let changed = false;
  for (const [key, value] of Object.entries(fields)) {
    if (sameValue(entry[key], value)) continue;
    entry[key] = value;
    changed = true;
  }
  return { changed, journal: next.slice(0, JOURNAL_CAP) };
}

function journalWithNewRestore(maps, journalEntry) {
  let journal = structuredClone(maps[JOURNAL_KEY] ?? []);
  const previous = maps[RESTORE_CHECKPOINT_KEY];
  if (previous && !previous.undoneAt) {
    journal = markRestoreJournal(journal, previous.id, {
      restoreUndoStatus: "unavailable",
      restoreCheckpointAvailable: false
    }).journal;
  }
  return appendedJournal(journal, journalEntry);
}

/**
 * Revalidate, replan under the lock, and commit once. Destructive fresh plans
 * require the exact token returned by their latest preview/replan.
 * @param {string} text
 * @param {import("./types.js").PortableRestoreOptions} [options]
 * @returns {Promise<import("./types.js").PortableRestoreResult>}
 * @sideeffect Atomically writes only planned portable families, one selective
 * checkpoint, and one Activity entry under the shared store lock.
 */
export async function restorePortableState(text, options = {}) {
  const parsed = parsePortableExport(text);
  const checkpointId = crypto.randomUUID();
  const source = sanitizeSource(options.source, parsed, text);
  let journalEntry = null;
  let committedPlan = null;
  let confirmationRequired = false;

  const committed = await mutateStores(portableStorageKeys(), (maps) => {
    const now = Date.now();
    const local = stateFromMutationMaps(maps);
    const plan = planPortableRestore(parsed, local, {
      restoreSettings: options.restoreSettings,
      now
    });
    committedPlan = plan;
    if (!plan.summary.changed) return null;
    if (plan.summary.requiresConfirmation &&
        options.confirmationToken !== plan.summary.confirmationToken) {
      confirmationRequired = true;
      return null;
    }

    journalEntry = makeJournalEntry(
      "Restored an EveryTab backup",
      { restoreCheckpointId: checkpointId },
      { category: "restore" }
    );
    const checkpoint = makeCheckpoint(checkpointId, now, source, local, plan);
    const sets = {
      [RESTORE_CHECKPOINT_KEY]: checkpoint,
      [JOURNAL_KEY]: journalWithNewRestore(maps, journalEntry)
    };
    for (const key of plan.changedRecordKeys) {
      if (key === STORE_KEYS.archive) {
        sets[STORE_KEYS.archive] = plan.records[STORE_KEYS.archive];
      } else {
        sets[key] = plan.records[key];
      }
    }
    if (plan.changedSettings) {
      sets[SETTINGS_KEY] = plan.settings;
      sets[SETTINGS_MODIFIED_AT_KEY] = plan.settingsModifiedAt;
    }
    if (plan.changedLabelMeta) sets[LABEL_META_KEY] = plan.labelMeta;
    return sets;
  });

  return {
    status: committed ? "restored" : confirmationRequired ? "confirmation-required" : "no-op",
    checkpointId: committed ? checkpointId : null,
    journalEntry: committed ? journalEntry : null,
    summary: committedPlan.summary
  };
}

function checkpointStaleKeys(checkpoint, local) {
  const stale = [];
  for (const [key, changes] of Object.entries(checkpoint.changes?.records ?? {})) {
    let changed = false;
    for (const [id, change] of Object.entries(changes)) {
      if (key === STORE_KEYS.archive) {
        if (!sameDescriptor(local.archiveBase, id, change.expectedBase) ||
            !sameDescriptor(local.archiveOverlay, id, change.expectedOverlay)) changed = true;
      } else if (!sameDescriptor(local.records[key] ?? {}, id, change.expected)) {
        changed = true;
      }
      if (changed) break;
    }
    if (changed) stale.push(key);
  }

  const settings = checkpoint.changes?.settings;
  if (settings && (local.settingsModifiedAt !== settings.expected.modifiedAt ||
      valueFingerprint(local.settingsRaw) !== settings.expected.hash)) stale.push(SETTINGS_KEY);

  let labelStale = false;
  for (const [label, change] of Object.entries(checkpoint.changes?.labelMeta ?? {})) {
    if (!hasOwn(local.labelMeta, label) || local.labelMeta[label] !== change.expected) {
      labelStale = true;
      break;
    }
  }
  if (labelStale) stale.push(LABEL_META_KEY);
  return stale;
}

function restoreExact(map, id, present, value) {
  if (present) map[id] = structuredClone(value);
  else delete map[id];
}

/**
 * Undo the matching singleton checkpoint, terminalizing stale/unavailable entries.
 * @param {string} checkpointId
 * @returns {Promise<import("./types.js").PortableRestoreUndoResult>}
 * @sideeffect Atomically restores exact affected pre-state when fresh; a stale
 * or unavailable attempt updates only the matching Activity entry.
 */
export async function undoPortableRestore(checkpointId) {
  let result = { status: "unavailable", checkpointId, staleKeys: [], checkpointAvailable: false };
  await mutateStores(portableStorageKeys(), (maps) => {
    const checkpoint = maps[RESTORE_CHECKPOINT_KEY];
    if (!checkpoint || checkpoint.undoneAt || checkpoint.id !== checkpointId) {
      const terminal = markRestoreJournal(maps[JOURNAL_KEY], checkpointId, {
        restoreUndoStatus: "unavailable",
        restoreCheckpointAvailable: false
      });
      if (!terminal.changed) return null;
      return { [JOURNAL_KEY]: terminal.journal };
    }

    const local = stateFromMutationMaps(maps);
    const staleKeys = checkpointStaleKeys(checkpoint, local);
    if (staleKeys.length > 0) {
      const terminal = markRestoreJournal(maps[JOURNAL_KEY], checkpoint.id, {
        restoreUndoStatus: "stale",
        restoreCheckpointAvailable: true,
        restoreUndoStaleKeys: staleKeys
      });
      result = {
        status: "stale", checkpointId: checkpoint.id, staleKeys,
        checkpointAvailable: true
      };
      return terminal.changed ? { [JOURNAL_KEY]: terminal.journal } : null;
    }

    const sets = {};
    for (const [key, changes] of Object.entries(checkpoint.changes?.records ?? {})) {
      if (key === STORE_KEYS.archive) {
        const base = { ...local.archiveBase };
        const overlay = { ...local.archiveOverlay };
        for (const [id, change] of Object.entries(changes)) {
          restoreExact(base, id, change.beforeBasePresent, change.beforeBase);
          restoreExact(overlay, id, change.beforeOverlayPresent, change.beforeOverlay);
        }
        sets[STORE_KEYS.archive] = base;
        sets[ARCHIVE_OVERLAY_KEY] = overlay;
      } else {
        const map = { ...(local.records[key] ?? {}) };
        for (const [id, change] of Object.entries(changes)) {
          restoreExact(map, id, change.beforePresent, change.before);
        }
        sets[key] = map;
      }
    }

    const settings = checkpoint.changes?.settings;
    if (settings) {
      sets[SETTINGS_KEY] = settings.before;
      sets[SETTINGS_MODIFIED_AT_KEY] = settings.beforeModifiedAt;
    }
    const labelChanges = checkpoint.changes?.labelMeta ?? {};
    if (Object.keys(labelChanges).length > 0) {
      const labelMeta = { ...local.labelMeta };
      for (const [label, change] of Object.entries(labelChanges)) {
        restoreExact(labelMeta, label, change.beforePresent, change.before);
      }
      sets[LABEL_META_KEY] = labelMeta;
    }

    const journal = structuredClone(maps[JOURNAL_KEY] ?? []);
    const entry = journal.find((candidate) => candidate.restoreCheckpointId === checkpoint.id);
    if (entry) {
      entry.undone = true;
      delete entry.restoreUndoStatus;
      delete entry.restoreCheckpointAvailable;
      delete entry.restoreUndoStaleKeys;
    }
    sets[JOURNAL_KEY] = journal.slice(0, JOURNAL_CAP);
    sets[RESTORE_CHECKPOINT_KEY] = { ...checkpoint, undoneAt: Date.now() };
    result = {
      status: "undone", checkpointId: checkpoint.id, staleKeys: [],
      checkpointAvailable: false
    };
    return sets;
  });
  return result;
}

/**
 * Latest checkpoint metadata for the Data route. Reads storage only.
 * @returns {Promise<import("./types.js").PortableRestoreCheckpointSummary|null>}
 */
export async function readPortableRestoreCheckpoint() {
  const result = await chrome.storage.local.get([RESTORE_CHECKPOINT_KEY, JOURNAL_KEY]);
  const checkpoint = result[RESTORE_CHECKPOINT_KEY];
  if (!checkpoint || checkpoint.undoneAt) return null;
  const entry = (result[JOURNAL_KEY] ?? []).find((candidate) =>
    candidate.restoreCheckpointId === checkpoint.id);
  return {
    id: checkpoint.id,
    createdAt: checkpoint.createdAt,
    source: checkpoint.source,
    affected: [...(checkpoint.affected ?? [])],
    undoStatus: entry?.restoreUndoStatus ?? "available",
    checkpointAvailable: true
  };
}

function beforeArchiveRecord(change) {
  const base = change.beforeBasePresent ? { value: change.beforeBase } : {};
  const overlay = change.beforeOverlayPresent ? { value: change.beforeOverlay } : {};
  const merged = mergeArchiveMaps(base, overlay);
  return hasOwn(merged, "value") ? { present: true, value: merged.value } : { present: false };
}

/**
 * Build an importable recovery backup. A selective checkpoint cannot recreate
 * unrelated state as it existed earlier, so the envelope says exactly what it
 * contains: earlier affected state plus current unaffected portable state.
 * @param {string} checkpointId
 * @returns {Promise<string|null>}
 * @sideeffect Reads a coherent snapshot under the shared lock; writes nothing.
 */
export async function buildRestoreCheckpointExport(checkpointId) {
  return withStoreLock(async () => {
    const raw = await chrome.storage.local.get(portableStorageKeys());
    const checkpoint = raw[RESTORE_CHECKPOINT_KEY];
    if (!checkpoint || checkpoint.id !== checkpointId) return null;
    const current = stateFromRawMaps(raw);
    const records = structuredClone(current.records);

    for (const [key, changes] of Object.entries(checkpoint.changes?.records ?? {})) {
      for (const [id, change] of Object.entries(changes)) {
        if (key === STORE_KEYS.archive) {
          const before = beforeArchiveRecord(change);
          restoreExact(records[key], id, before.present, before.value);
        } else {
          restoreExact(records[key], id, change.beforePresent, change.before);
        }
      }
    }

    const settingsChange = checkpoint.changes?.settings;
    const settingsRaw = settingsChange ? settingsChange.before : current.settingsRaw;
    const settingsModifiedAt = settingsChange
      ? settingsChange.beforeModifiedAt : current.settingsModifiedAt;
    const labelMeta = { ...current.labelMeta };
    for (const [label, change] of Object.entries(checkpoint.changes?.labelMeta ?? {})) {
      restoreExact(labelMeta, label, change.beforePresent, change.before);
    }

    const envelope = exportPortableEnvelope({
      records, settingsRaw, settingsModifiedAt, labelMeta
    }, new Date().toISOString(), {
      recovery: {
        kind: "affected-pre-restore",
        checkpointId: checkpoint.id,
        restoreAt: new Date(checkpoint.createdAt).toISOString(),
        scope: "Affected saved data is from before Restore. Unaffected saved data is current at download time."
      }
    });
    return JSON.stringify(envelope, null, 2);
  });
}
