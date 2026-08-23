/** Pure portable-state merge planning, stable comparison, and envelope output. */
import { SCHEMA_VERSION, STORE_KEYS } from "./types.js";
import { mergeLabelMeta } from "./merge.js";
import { LABEL_META_KEY } from "./label-meta.js";
import {
  PORTABLE_EXCLUDED_KINDS, PORTABLE_EXPORT_VERSION, SETTINGS_KEY,
  SETTINGS_MODIFIED_AT_KEY, normalizePortableLabelMeta, normalizePortableSettings,
  portableRecordEntries, sourceHash
} from "./portable-state-registry.js";

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function sameValue(a, b) {
  return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
}

export function valueFingerprint(value) {
  return sourceHash(JSON.stringify(stableValue(value)));
}

function recordMerge(local, incoming) {
  const merged = { ...local };
  const changes = {};
  const counts = { incoming: 0, added: 0, updated: 0, keptIncoming: 0, localOnly: 0 };
  for (const [id, record] of Object.entries(incoming)) {
    counts.incoming++;
    const current = local[id];
    if (!current) {
      merged[id] = record;
      changes[id] = { beforePresent: false, before: null, after: record };
      counts.added++;
    } else if (record.modifiedAt > current.modifiedAt) {
      merged[id] = record;
      changes[id] = { beforePresent: true, before: current, after: record };
      counts.updated++;
    } else {
      counts.keptIncoming++;
    }
  }
  counts.localOnly = Object.keys(local).filter((id) => !(id in incoming)).length;
  return { merged, changes, counts };
}

/**
 * Build the logical local snapshot consumed by the pure planner.
 * @param {Record<string, unknown>} raw
 * @param {{archiveBase?: object, archiveOverlay?: object}} [options]
 * @returns {PortableLocalState}
 */
export function localPortableState(raw, {
  archiveBase = raw[STORE_KEYS.archive] ?? {},
  archiveOverlay = raw.archiveOverlay ?? {}
} = {}) {
  const records = {};
  for (const entry of portableRecordEntries()) records[entry.key] = raw[entry.key] ?? {};
  return {
    records,
    archiveBase,
    archiveOverlay,
    settingsRaw: raw[SETTINGS_KEY] ?? {},
    settingsModifiedAt: Number.isFinite(raw[SETTINGS_MODIFIED_AT_KEY])
      ? raw[SETTINGS_MODIFIED_AT_KEY] : 0,
    labelMeta: raw[LABEL_META_KEY] ?? {}
  };
}

function riskToken(parsed, plan) {
  const records = {};
  for (const [key, changes] of Object.entries(plan.recordChanges)) {
    const updates = {};
    for (const [id, change] of Object.entries(changes)) {
      if (!change.beforePresent) continue;
      updates[id] = {
        before: valueFingerprint(change.before),
        after: valueFingerprint(change.after)
      };
    }
    if (Object.keys(updates).length > 0) records[key] = updates;
  }
  const labels = Object.create(null);
  for (const [label, change] of Object.entries(plan.labelChanges)) {
    if (change.beforePresent) labels[label] = { before: change.before, after: change.after };
  }
  const risk = {
    source: parsed.sourceHash,
    records,
    labels,
    settings: plan.changedSettings
      ? { before: valueFingerprint(plan.localOrdinarySettings), after: valueFingerprint(parsed.settings) }
      : null
  };
  return `restore-v1:${sourceHash(JSON.stringify(stableValue(risk)))}`;
}

/**
 * Build a deterministic pure merge plan and exact destructive confirmation token.
 * @param {ParsedPortableState} parsed
 * @param {PortableLocalState} local
 * @param {{restoreSettings?: boolean, now?: number}} [options]
 * @returns {PortableRestorePlan}
 */
export function planPortableRestore(parsed, local, { restoreSettings = true, now = Date.now() } = {}) {
  const records = {};
  const recordChanges = {};
  const recordCounts = { incoming: 0, added: 0, updated: 0, keptIncoming: 0, localOnly: 0 };
  const changedRecordKeys = [];
  for (const entry of portableRecordEntries()) {
    const result = recordMerge(local.records[entry.key] ?? {}, parsed.records[entry.key] ?? {});
    records[entry.key] = result.merged;
    recordChanges[entry.key] = result.changes;
    for (const key of Object.keys(recordCounts)) recordCounts[key] += result.counts[key];
    if (Object.keys(result.changes).length > 0) changedRecordKeys.push(entry.key);
  }

  const mergedLabelMeta = mergeLabelMeta(local.labelMeta, parsed.labelMeta);
  const labelChanges = Object.create(null);
  let labelExistingAdvanced = 0;
  for (const [label, timestamp] of Object.entries(mergedLabelMeta)) {
    if (timestamp === local.labelMeta?.[label]) continue;
    const beforePresent = Object.hasOwn(local.labelMeta ?? {}, label);
    labelChanges[label] = {
      beforePresent, before: beforePresent ? local.labelMeta[label] : null, after: timestamp
    };
    if (beforePresent) labelExistingAdvanced++;
  }

  const localOrdinarySettings = normalizePortableSettings(local.settingsRaw);
  const settingsEnabled = Boolean(restoreSettings && parsed.hasSettings);
  const settingsChanged = settingsEnabled && !sameValue(localOrdinarySettings, parsed.settings);
  const settings = settingsChanged ? { ...local.settingsRaw, ...parsed.settings } : local.settingsRaw;
  const settingsModifiedAt = settingsChanged ? now : local.settingsModifiedAt;
  const changed = changedRecordKeys.length > 0 || Object.keys(labelChanges).length > 0 || settingsChanged;
  const requiresConfirmation = recordCounts.updated > 0 || labelExistingAdvanced > 0 || settingsChanged;
  const plan = {
    records,
    recordChanges,
    labelMeta: mergedLabelMeta,
    labelChanges,
    settings,
    settingsModifiedAt,
    localOrdinarySettings,
    changedRecordKeys,
    changedLabelMeta: Object.keys(labelChanges).length > 0,
    changedSettings: settingsChanged
  };
  plan.summary = {
    exportVersion: parsed.exportVersion,
    legacy: parsed.legacy,
    exportedAt: parsed.exportedAt,
    sourceHash: parsed.sourceHash,
    records: recordCounts,
    labelMeta: {
      incoming: Object.keys(parsed.labelMeta).length,
      advanced: Object.keys(labelChanges).length,
      existingAdvanced: labelExistingAdvanced
    },
    settings: {
      available: parsed.hasSettings,
      enabled: settingsEnabled,
      changed: settingsChanged,
      count: parsed.settingsCount
    },
    changed,
    requiresConfirmation,
    confirmationToken: requiresConfirmation ? riskToken(parsed, plan) : null
  };
  return plan;
}

/** Produce the complete portable v2 envelope without mutating local state. */
export function exportPortableEnvelope(local, exportedAt = new Date().toISOString(), extra = {}) {
  const data = {};
  for (const entry of portableRecordEntries()) data[entry.key] = local.records[entry.key] ?? {};
  return {
    app: "tabvault",
    exportVersion: PORTABLE_EXPORT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    excludedKinds: [...PORTABLE_EXCLUDED_KINDS],
    settings: normalizePortableSettings(local.settingsRaw),
    settingsModifiedAt: local.settingsModifiedAt,
    labelMeta: normalizePortableLabelMeta(local.labelMeta),
    data,
    ...extra
  };
}

/** @typedef {import("./types.js").ParsedPortableState} ParsedPortableState */
/** @typedef {import("./types.js").PortableLocalState} PortableLocalState */
/** @typedef {import("./types.js").PortableRestorePlan} PortableRestorePlan */
