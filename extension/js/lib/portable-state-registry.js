// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Pure portable-state registry, whole-file validation, and merge planning. */
import { DEFAULT_SETTINGS, SCHEMA_VERSION, STORE_KEYS, UI_LANGUAGE_VALUES } from "./types.js";
import { LABEL_META_KEY } from "./label-meta.js";
import { SCHEMES } from "./schemes.js";
import {
  assertCustomSchemeRecord, customSchemeIdFromRef, normalizeSchemeSelection
} from "./custom-schemes.js";
import { isOrganizationKind, organizationMembershipId } from "./organization.js";
import { normalizeWelcomePhrases } from "./welcome-phrases.js";
import { unifiedAutomationExclusions } from "./tabs.js";
import { normalizeDuplicateDomainRules } from "./duplicate-domain-rules.js";

export const PORTABLE_EXPORT_VERSION = 2;
export const PORTABLE_EXPORT_MAX_BYTES = 128 * 1024 * 1024;
export const SETTINGS_KEY = "settings";
export const SETTINGS_MODIFIED_AT_KEY = "settingsModifiedAt";

const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_JSON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PORTABLE_SETTING_KEYS = new Set([
  ...Object.keys(DEFAULT_SETTINGS).filter((key) => key !== "perfHud"),
  "autoDumpAfterMinutes"
]);

export const PORTABLE_EXCLUDED_KINDS = Object.freeze([
  "device identity and live browser state",
  "derived caches and performance state",
  "operational receipts and runtime recovery",
  "Focus runtime and attempted navigation",
  "Activity, counters, Vault handles, and UI handoffs"
]);

/** @type {Map<string, PortableStateEntry>} */
const registry = new Map();

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertUuid(id, path) {
  assert(typeof id === "string" && UUID_ID.test(id), `${path} must be a valid record id`);
}

/**
 * Register one portable domain policy. Record identity belongs to the registry
 * because Restore validation and Vault filename generation must agree.
 * @param {PortableStateEntry} entry
 */
export function registerPortableState(entry) {
  if (!entry || typeof entry.key !== "string" || !entry.key || registry.has(entry.key)) {
    throw new Error(`Invalid or duplicate portable-state key: ${entry?.key ?? ""}`);
  }
  if (!["record-map", "settings", "per-key-max"].includes(entry.kind)) {
    throw new Error(`Unsupported portable-state kind for ${entry.key}`);
  }
  if (!entry.vault || typeof entry.vault.kind !== "string") {
    throw new Error(`Portable-state entry ${entry.key} needs Vault routing`);
  }
  const defaults = entry.kind === "record-map"
    ? {
        merge: "record-lww", export: true, checkpoint: true,
        migrateRecord: (record) => record, validateId: assertUuid
      }
    : entry.kind === "settings"
      ? { merge: "explicit-file-wins", export: true, checkpoint: true }
      : { merge: "per-key-max", export: true, checkpoint: true };
  registry.set(entry.key, Object.freeze({
    ...defaults,
    ...entry,
    vault: Object.freeze({ ...entry.vault })
  }));
}

/** @returns {PortableStateEntry[]} a stable snapshot of the policy registry */
export function portableStateEntries() {
  return [...registry.values()];
}

/** Current exported record-map policies in stable registry order. */
export function portableRecordEntries() {
  return portableStateEntries().filter((entry) =>
    entry.kind === "record-map" && entry.export !== false);
}

/** @param {PortableStateEntry} entry @param {string} name */
export function isPortableVaultFile(entry, name) {
  const accept = entry?.vault?.acceptFileName;
  return typeof accept === "function" ? Boolean(accept(name)) : false;
}

/** Return the UUID owned by a canonical Vault filename, or null for conflicts/unknowns. */
export function portableVaultFileId(entry, name) {
  const read = entry?.vault?.idFromFileName;
  if (typeof read !== "function") return null;
  const id = read(name);
  return typeof id === "string" ? id : null;
}

/** @param {PortableStateEntry} entry @param {string} id */
export function portableVaultFileName(entry, id) {
  const build = entry?.vault?.fileNameFor;
  if (typeof build !== "function") throw new Error(`No Vault filename policy for ${entry?.key}`);
  entry.validateId?.(id, `${entry.key}.${id}`);
  const name = build(id);
  assert(typeof name === "string" && name.length > 0 &&
    !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".." &&
    isPortableVaultFile(entry, name), `Unsafe Vault filename for ${entry.key}`);
  return name;
}

/**
 * Classify a candidate Vault record while retaining a validated UUID for
 * opaque future-schema records. Sync uses that identity to leave an existing
 * canonical/conflict file hands-off rather than mistaking it for absence.
 * @param {PortableStateEntry} entry
 * @param {unknown} record
 * @returns {PortableRecordInspection}
 */
export function inspectPortableRecord(entry, record) {
  let id = null;
  try {
    entry.validateId?.(record?.id, `${entry?.key ?? "record"}.${record?.id ?? "?"}`);
    id = record.id;
    if (Number.isInteger(record?.schemaVersion) && record.schemaVersion > SCHEMA_VERSION) {
      return { status: "future-schema", id };
    }
    assertMeta(record, record?.id, `${entry?.key ?? "record"}.${record?.id ?? "?"}`);
    entry.validateRecord?.(record, `${entry.key}.${record.id}`);
    return { status: "current", id };
  } catch {
    return { status: "invalid", id };
  }
}

/** Registry-backed Vault record validation without exposing thrown parse errors. */
export function isValidPortableRecord(entry, record) {
  return inspectPortableRecord(entry, record).status === "current";
}

/** Validate one map/filename identity without assuming any record fields. */
export function isPortableRecordId(entry, id) {
  try {
    entry.validateId?.(id, `${entry?.key ?? "record"}.${id ?? "?"}`);
    return true;
  } catch {
    return false;
  }
}

function assertFinite(value, path, { min = 0, integer = false } = {}) {
  assert(Number.isFinite(value) && value >= min && (!integer || Number.isInteger(value)),
    `${path} must be a finite${integer ? " integer" : ""} number`);
}

function assertStringArray(value, path) {
  assert(Array.isArray(value) && value.every((item) => typeof item === "string"),
    `${path} must be a list of strings`);
}

function assertTabRef(ref, path) {
  assert(isPlainObject(ref), `${path} must be an object`);
  assert(typeof ref.url === "string", `${path}.url must be a string`);
  assert(typeof ref.title === "string", `${path}.title must be a string`);
  if (ref.favIconUrl !== undefined) {
    assert(typeof ref.favIconUrl === "string", `${path}.favIconUrl must be a string`);
  }
  if (ref.pinned !== undefined) assert(typeof ref.pinned === "boolean", `${path}.pinned must be true or false`);
  if (ref.labels !== undefined) assertStringArray(ref.labels, `${path}.labels`);
  if (ref.groupIndex !== undefined) assertFinite(ref.groupIndex, `${path}.groupIndex`, { integer: true });
}

function assertTabRefs(value, path) {
  assert(Array.isArray(value), `${path} must be a list`);
  value.forEach((ref, index) => assertTabRef(ref, `${path}[${index}]`));
}

function assertMeta(record, id, path) {
  assert(isPlainObject(record), `${path} must be an object`);
  assert(typeof record.id === "string" && record.id.length > 0, `${path}.id must be a string`);
  assert(record.id === id, `${path}.id must match its map key`);
  assert(typeof record.deviceId === "string" && record.deviceId.length > 0,
    `${path}.deviceId must be a string`);
  assertFinite(record.createdAt, `${path}.createdAt`);
  assertFinite(record.modifiedAt, `${path}.modifiedAt`);
  const version = record.schemaVersion ?? 1;
  assertFinite(version, `${path}.schemaVersion`, { min: 1, integer: true });
  assert(version <= SCHEMA_VERSION,
    `${path} needs a newer EveryTab version (record schema ${version})`);
  if (record.deletedAt !== undefined) assertFinite(record.deletedAt, `${path}.deletedAt`);
}

function assertInbox(record, path) {
  assert(["tab", "window"].includes(record.kind), `${path}.kind is not supported`);
  assertTabRefs(record.tabs, `${path}.tabs`);
  assert(typeof record.source === "string", `${path}.source must be a string`);
  if (record.labels !== undefined) assertStringArray(record.labels, `${path}.labels`);
  if (record.windowTitle !== undefined) {
    assert(typeof record.windowTitle === "string", `${path}.windowTitle must be a string`);
  }
  if (record.archivedAt !== undefined) assertFinite(record.archivedAt, `${path}.archivedAt`);
}

function assertSession(record, path) {
  assert(typeof record.name === "string", `${path}.name must be a string`);
  assert(typeof record.auto === "boolean", `${path}.auto must be true or false`);
  assert(Array.isArray(record.windows), `${path}.windows must be a list`);
  record.windows.forEach((refs, index) => assertTabRefs(refs, `${path}.windows[${index}]`));
  if (record.labels !== undefined) assertStringArray(record.labels, `${path}.labels`);
  if (record.groups !== undefined) {
    assert(Array.isArray(record.groups), `${path}.groups must be a list`);
    record.groups.forEach((groups, windowIndex) => {
      assert(Array.isArray(groups), `${path}.groups[${windowIndex}] must be a list`);
      groups.forEach((group, groupIndex) => {
        const gp = `${path}.groups[${windowIndex}][${groupIndex}]`;
        assert(isPlainObject(group), `${gp} must be an object`);
        if (group.title !== undefined) assert(typeof group.title === "string", `${gp}.title must be a string`);
        if (group.color !== undefined) assert(typeof group.color === "string", `${gp}.color must be a string`);
        if (group.collapsed !== undefined) {
          assert(typeof group.collapsed === "boolean", `${gp}.collapsed must be true or false`);
        }
      });
    });
  }
}

function assertCollection(record, path) {
  assert(typeof record.name === "string", `${path}.name must be a string`);
  assertTabRefs(record.tabs, `${path}.tabs`);
  if (record.labels !== undefined) assertStringArray(record.labels, `${path}.labels`);
}

function assertSnooze(record, path) {
  assert(typeof record.url === "string", `${path}.url must be a string`);
  assert(typeof record.title === "string", `${path}.title must be a string`);
  assertFinite(record.dueAt, `${path}.dueAt`);
  if (record.tabs !== undefined) assertTabRefs(record.tabs, `${path}.tabs`);
  if (record.recurrence !== undefined) {
    assert(typeof record.recurrence === "string", `${path}.recurrence must be a string`);
  }
  if (record.sessionId !== undefined) {
    assert(typeof record.sessionId === "string", `${path}.sessionId must be a string`);
  }
}

function assertSmartView(record, path) {
  assert(typeof record.name === "string", `${path}.name must be a string`);
  assert(["domain", "url", "title"].includes(record.field), `${path}.field is not supported`);
  assert(typeof record.pattern === "string", `${path}.pattern must be a string`);
  assert(["open", "saved", "all"].includes(record.scope), `${path}.scope is not supported`);
  if (record.builtin !== undefined) assert(typeof record.builtin === "boolean", `${path}.builtin must be true or false`);
}

function assertStarred(record, path) {
  assert(typeof record.url === "string", `${path}.url must be a string`);
  assert(typeof record.title === "string", `${path}.title must be a string`);
  if (record.favIconUrl !== undefined) {
    assert(typeof record.favIconUrl === "string", `${path}.favIconUrl must be a string`);
  }
  assertFinite(record.position, `${path}.position`);
}

function assertOrganizationGroup(record, path) {
  assert(isOrganizationKind(record.organizationKind), `${path}.organizationKind is not supported`);
  assert(typeof record.name === "string" && record.name.trim() === record.name && record.name.length > 0,
    `${path}.name must be a non-empty trimmed string`);
  assert(record.name.toLowerCase() !== "ungrouped", `${path}.name is reserved`);
}

function assertOrganizationMembership(record, path) {
  assert(isOrganizationKind(record.organizationKind), `${path}.organizationKind is not supported`);
  assert(typeof record.memberKey === "string" && record.memberKey.trim().length > 0,
    `${path}.memberKey must be a non-empty string`);
  if (record.organizationKind === "session") {
    assertUuid(record.memberKey, `${path}.memberKey`);
  }
  assertUuid(record.groupId, `${path}.groupId`);
  assert(record.id === organizationMembershipId(
    record.organizationKind, record.memberKey, record.groupId
  ), `${path}.id must match its organization membership tuple`);
}

function validateRecordMap(entry, map) {
  assert(isPlainObject(map), `${entry.key} must be a record map`);
  const result = {};
  for (const [id, record] of Object.entries(map)) {
    const path = `${entry.key}.${id}`;
    entry.validateId?.(id, path);
    assertMeta(record, id, path);
    entry.validateRecord?.(record, path);
    result[id] = entry.migrateRecord(record);
  }
  return result;
}

const itemVault = (directory) => ({
  kind: "items",
  path: directory,
  acceptFileName: (name) => UUID_JSON.test(name),
  fileNameFor: (id) => `${id}.json`,
  idFromFileName: (name) => UUID_JSON.test(name) ? name.slice(0, -5) : null
});

registerPortableState({ key: STORE_KEYS.inbox, kind: "record-map", validateRecord: assertInbox,
  vault: itemVault(STORE_KEYS.inbox) });
registerPortableState({ key: STORE_KEYS.archive, kind: "record-map", validateRecord: assertInbox,
  vault: { kind: "archive", path: STORE_KEYS.archive } });
registerPortableState({ key: STORE_KEYS.sessions, kind: "record-map", validateRecord: assertSession,
  vault: itemVault(STORE_KEYS.sessions) });
registerPortableState({ key: STORE_KEYS.collections, kind: "record-map", validateRecord: assertCollection,
  vault: itemVault(STORE_KEYS.collections) });
registerPortableState({ key: STORE_KEYS.snoozes, kind: "record-map", validateRecord: assertSnooze,
  vault: itemVault(STORE_KEYS.snoozes) });
registerPortableState({ key: STORE_KEYS.smartviews, kind: "record-map", validateRecord: assertSmartView,
  vault: itemVault(STORE_KEYS.smartviews) });
registerPortableState({ key: STORE_KEYS.starred, kind: "record-map", validateRecord: assertStarred,
  vault: itemVault(STORE_KEYS.starred) });
registerPortableState({
  key: STORE_KEYS.customSchemes,
  kind: "record-map",
  validateRecord: assertCustomSchemeRecord,
  vault: itemVault(STORE_KEYS.customSchemes)
});
registerPortableState({
  key: STORE_KEYS.organizationGroups,
  kind: "record-map",
  validateRecord: assertOrganizationGroup,
  vault: itemVault(STORE_KEYS.organizationGroups)
});
registerPortableState({
  key: STORE_KEYS.organizationMemberships,
  kind: "record-map",
  validateRecord: assertOrganizationMembership,
  vault: itemVault(STORE_KEYS.organizationMemberships)
});
registerPortableState({ key: SETTINGS_KEY, kind: "settings",
  vault: { kind: "settings", path: "settings.json", timestampKey: SETTINGS_MODIFIED_AT_KEY } });
registerPortableState({ key: LABEL_META_KEY, kind: "per-key-max",
  vault: { kind: "per-key-max", path: "labelMeta.json" } });

const BOOLEAN_SETTINGS = new Set([
  "autoArchiveEnabled", "dedupAutoClose", "suspendEnabled", "suspendLazyReload",
  "snoozeWakeQuiet", "dedupIgnoreQuery", "uiGradient", "uiQuickTheme",
  "uiSectionIntros", "uiSidebarCollapsed", "popupDupHint",
  "focusMinimizeOtherWindows", "preserveTabGroups", "oneNewTabPerWindow",
  "newTabWelcomeEnabled"
]);
const NUMBER_SETTINGS = {
  autoArchiveDays: [1, 36500], autoSaveMaxTabs: [0, 100000],
  inboxExpiryDays: [0, 36500], suspendMinTabs: [0, 100000],
  suspendMaxTabs: [0, 100000], suspendAfterMinutes: [1, 525600],
  snapshotEveryMinutes: [1, 525600], snapshotKeep: [0, 100000],
  focusDefaultDurationMinutes: [1, 1440], focusMorningEndMinutes: [0, 1439],
  focusDayEndMinutes: [0, 1439]
};
const ENUM_SETTINGS = {
  newTabMode: ["dashboard", "terminal", "minimal", "blank"], newTabFocus: ["omnibox", "search"],
  newTabWelcomeTone: ["clock", "accent"],
  uiMode: ["system", "scheme", "light", "dark"], schemeRotate: ["off", "open", "hourly", "daily"],
  uiEmphasis: ["bold", "muted"], uiCheckboxShape: ["round", "square"],
  uiCornerStyle: ["crisp", "soft"], uiInterfaceStyle: ["soft", "crisp", "terminal"],
  uiLanguage: [...UI_LANGUAGE_VALUES],
  uiRowInfo: ["clean", "useful", "detailed"],
  uiUtilityLayout: ["shelf", "rail", "compact"],
  uiWindowGrouping: ["space", "divider", "accent-cap"],
  uiAccentCapStrength: ["fine", "bold"], uiActionLabels: ["named", "icons"],
  uiLabelSort: ["recent", "az", "count"], uiSessionSort: ["recent", "az", "count"],
  focusDefaultEndMode: ["duration", "morning-end", "day-end", "manual"],
  focusExceptionStyle: ["immediate", "pause"],
  focusTemporaryEndAction: ["next-navigation", "save-close"]
};

function cleanStrings(value, allowed = null) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const clean = item.trim();
    if (!clean || (allowed && !allowed.has(clean)) || result.includes(clean)) continue;
    result.push(clean);
  }
  return result;
}

/**
 * Normalize only recognized ordinary settings crossing the portable seam.
 * @param {unknown} value
 * @returns {import("./types.js").Settings}
 */
export function normalizePortableSettings(value) {
  const source = isPlainObject(value) ? value : {};
  const settings = structuredClone(DEFAULT_SETTINGS);
  delete settings.perfHud;

  for (const key of BOOLEAN_SETTINGS) {
    if (typeof source[key] === "boolean") settings[key] = source[key];
  }
  for (const [key, [min, max]] of Object.entries(NUMBER_SETTINGS)) {
    const number = source[key];
    if (Number.isFinite(number)) settings[key] = Math.max(min, Math.min(max, Math.round(number)));
  }
  for (const [key, allowed] of Object.entries(ENUM_SETTINGS)) {
    if (allowed.includes(source[key])) settings[key] = source[key];
  }

  const automationExclusions = unifiedAutomationExclusions({
    archiveWhitelist: cleanStrings(source.archiveWhitelist),
    suspendWhitelist: cleanStrings(source.suspendWhitelist)
  });
  settings.archiveWhitelist = automationExclusions;
  settings.suspendWhitelist = automationExclusions;
  settings.newTabWelcomePhrases = normalizeWelcomePhrases(source.newTabWelcomePhrases);
  settings.schemeFavorites = cleanStrings(source.schemeFavorites).map(normalizeSchemeSelection)
    .filter((id, index, values) =>
      (SCHEMES.includes(id) || customSchemeIdFromRef(id)) && values.indexOf(id) === index);
  settings.uiScheme = normalizeSchemeSelection(source.uiScheme ?? settings.uiScheme);
  settings.focusSiteRules = Array.isArray(source.focusSiteRules)
    ? source.focusSiteRules.filter((rule) => isPlainObject(rule) &&
        typeof rule.domain === "string" && typeof rule.displayDomain === "string" &&
        ["focus", "always"].includes(rule.scope))
      .map((rule) => ({ domain: rule.domain, displayDomain: rule.displayDomain, scope: rule.scope }))
    : [];
  settings.duplicateDomainRules = normalizeDuplicateDomainRules(
    source.duplicateDomainRules
  );

  const legacyDays = Number(settings.autoArchiveDays) || DEFAULT_SETTINGS.autoArchiveDays;
  settings.autoDumpAfterMinutes = Number.isFinite(source.autoDumpAfterMinutes)
    ? Math.max(1, Math.min(52560000, Math.round(source.autoDumpAfterMinutes)))
    : Math.max(1, legacyDays) * 1440;
  return settings;
}

/**
 * Validate label recency into a prototype-safe user-text dictionary.
 * @param {unknown} value
 * @returns {import("./types.js").PortableLabelMeta}
 */
export function normalizePortableLabelMeta(value) {
  assert(isPlainObject(value), "labelMeta must be an object");
  const result = Object.create(null);
  for (const [label, timestamp] of Object.entries(value)) {
    assert(label.length > 0, "labelMeta keys must not be empty");
    assertFinite(timestamp, `labelMeta.${label}`);
    result[label] = timestamp;
  }
  return result;
}

function assertNoPollution(value, path = "backup") {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    assert(!POLLUTION_KEYS.has(key), `${path} contains a reserved key`);
    assertNoPollution(value[key], `${path}.${key}`);
  }
}

function assertPortableStructure(parsed) {
  for (const key of Object.keys(parsed)) {
    assert(!POLLUTION_KEYS.has(key), "backup contains a reserved key");
    // labelMeta is a user-text register. Its values are validated as finite
    // numbers before they are copied into a null-prototype dictionary.
    if (key !== "labelMeta") assertNoPollution(parsed[key], `backup.${key}`);
  }
}

export function sourceHash(text) {
  const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const primes = [0x01000193, 0x27d4eb2d, 0x165667b1, 0x9e3779b1];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    for (let lane = 0; lane < hashes.length; lane++) {
      hashes[lane] = Math.imul(hashes[lane] ^ code, primes[lane]);
    }
  }
  return `hash128:${hashes.map((hash) =>
    (hash >>> 0).toString(16).padStart(8, "0")).join("")}`;
}

/** Validate a string against a UTF-8 byte ceiling without allocating an encoded copy. */
export function assertPortableRestoreTextSize(text, { maxBytes = PORTABLE_EXPORT_MAX_BYTES } = {}) {
  assert(typeof text === "string", "That file is not valid JSON");
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
        text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    assert(bytes <= maxBytes, "That backup is too large to Restore safely");
  }
  return bytes;
}

/**
 * Validate and normalize the complete untrusted envelope before any store read/write.
 * @param {string} text
 * @returns {import("./types.js").ParsedPortableState}
 */
export function parsePortableExport(text) {
  assertPortableRestoreTextSize(text);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("That file is not valid JSON"); }
  assertPortableStructure(parsed);
  assert(isPlainObject(parsed) && parsed.app === "tabvault",
    "That file is not an EveryTab JSON backup");

  const version = parsed.exportVersion ?? 1;
  assert(Number.isInteger(version) && version >= 1 && version <= PORTABLE_EXPORT_VERSION,
    `This backup needs a newer EveryTab version (export ${version})`);
  const recordSchema = parsed.schemaVersion ?? 1;
  assert(Number.isInteger(recordSchema) && recordSchema >= 1 && recordSchema <= SCHEMA_VERSION,
    `This backup needs a newer EveryTab version (schema ${recordSchema})`);
  assert(isPlainObject(parsed.data), "Backup data must be an object");

  const recordEntries = portableRecordEntries();
  const knownDataKeys = new Set(recordEntries.map((entry) => entry.key));
  for (const key of Object.keys(parsed.data)) {
    assert(knownDataKeys.has(key), `This backup contains an unsupported saved-data section: ${key}`);
  }

  const records = {};
  for (const entry of recordEntries) {
    records[entry.key] = validateRecordMap(entry, parsed.data[entry.key] ?? {});
  }

  if (version >= 2) {
    assert(isPlainObject(parsed.settings), "Backup settings must be an object");
    assertFinite(parsed.settingsModifiedAt, "settingsModifiedAt");
    assert(isPlainObject(parsed.labelMeta), "Backup labelMeta must be an object");
  } else if (parsed.settings !== undefined) {
    assert(isPlainObject(parsed.settings), "Backup settings must be an object");
  }

  return {
    exportVersion: version,
    legacy: version < PORTABLE_EXPORT_VERSION,
    exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : null,
    records,
    hasSettings: parsed.settings !== undefined,
    settings: normalizePortableSettings(parsed.settings),
    settingsCount: isPlainObject(parsed.settings)
      ? Object.keys(parsed.settings).filter((key) => PORTABLE_SETTING_KEYS.has(key)).length
      : 0,
    settingsModifiedAt: Number.isFinite(parsed.settingsModifiedAt) ? parsed.settingsModifiedAt : 0,
    labelMeta: parsed.labelMeta === undefined
      ? Object.create(null) : normalizePortableLabelMeta(parsed.labelMeta),
    sourceHash: sourceHash(text)
  };
}

/**
 * @typedef {Object} PortableStateEntry
 * @property {string} key
 * @property {"record-map"|"settings"|"per-key-max"} kind
 * @property {"record-lww"|"explicit-file-wins"|"per-key-max"} [merge]
 * @property {boolean} [export]
 * @property {boolean} [checkpoint]
 * @property {(id: string, path: string) => void} [validateId]
 * @property {(record: object, path: string) => void} [validateRecord]
 * @property {(record: object) => object} [migrateRecord]
 * @property {{kind: string, path: string, timestampKey?: string,
 *   acceptFileName?: (name: string) => boolean, fileNameFor?: (id: string) => string,
 *   idFromFileName?: (name: string) => string|null}} vault
 */

/**
 * @typedef {Object} PortableRecordInspection
 * @property {"current"|"future-schema"|"invalid"} status
 * @property {string|null} id validated UUID when the candidate carries one
 */
