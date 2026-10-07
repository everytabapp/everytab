// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Deep custom-scheme domain module.
 *
 * Callers provide merge metadata; this module owns the complete record/share
 * schema, compiler/validation policy, namespaced selection identity, catalogue
 * filtering, and runtime CSS projection. Imported files contain data only and
 * always become a fresh local record.
 */
import { SCHEMES, SCHEME_META, normalizeScheme } from "./schemes.js";
import { SCHEMA_VERSION } from "./types.js";
import {
  COLOR_ROLE_KEYS,
  MAX_DRAFT_BYTES,
  MODES,
  ROLE_CSS_NAMES,
  SCHEME_FORMAT_VERSION,
  SIMPLE_COLOR_KEYS,
  compileSimpleMode,
  createDraftFixture,
  gradientCss,
  isHexColor,
  roleMapToCssProperties,
  validateDraftFixture,
  validateRoleMap
} from "./scheme-tokens.js";

export const CUSTOM_SCHEME_PREFIX = "custom:";
export const CUSTOM_SCHEME_DRAFT_KEY = "customSchemeDraft";
export const CUSTOM_SCHEME_NOTICE_KEY = "customSchemeNotice";
export const CUSTOM_SCHEME_SHARE_VERSION = 1;
export const MAX_CUSTOM_SCHEME_BYTES = MAX_DRAFT_BYTES;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD_KEYS = new Set([
  "id", "deviceId", "createdAt", "modifiedAt", "schemaVersion", "deletedAt",
  "schemeFormatVersion", "validationSeal", "name", "defaultMode", "authoringMode",
  "simple", "light", "dark"
]);
const SHARE_KEYS = Object.freeze(["app", "kind", "formatVersion", "scheme"]);
const SHARE_SCHEME_KEYS = Object.freeze([
  "name", "defaultMode", "authoringMode", "simple", "roles"
]);

const DEFAULT_SIMPLE = Object.freeze({
  light: Object.freeze({
    page: "#f5efe3", surface: "#fffdf6", raisedSurface: "#efe8d8",
    text: "#3d3629", accent: "#bc5f3c", secondaryAccent: "#a44f2f", border: "#e2d8c0"
  }),
  dark: Object.freeze({
    page: "#221e18", surface: "#2b261f", raisedSurface: "#332d24",
    text: "#eee5d0", accent: "#de8b5c", secondaryAccent: "#eba471", border: "#3e372b"
  })
});

const clone = (value) => structuredClone(value);
const error = (code, message, detail = {}) => ({ code, message, ...detail });
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const stable = (value) => Array.isArray(value)
  ? value.map(stable)
  : isObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

function validationPayload(record) {
  return {
    schemeFormatVersion: record.schemeFormatVersion,
    name: record.name,
    defaultMode: record.defaultMode,
    authoringMode: record.authoringMode,
    simple: record.simple,
    light: record.light,
    dark: record.dark
  };
}

/** Fast deterministic integrity seal; strict validation remains the authority that issues it. */
function validationSealFor(record) {
  const text = JSON.stringify(stable(validationPayload(record)));
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `v1-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

function exactKeys(value, allowed, where) {
  if (!isObject(value)) return [error("shape.object", `${where} must be an object.`)];
  const accepted = new Set(allowed);
  const errors = Object.keys(value)
    .filter((key) => !accepted.has(key))
    .map((key) => error("shape.unknown-key", `${where} contains an unsupported “${key}” field.`));
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      errors.push(error("shape.missing-key", `${where} is missing “${key}”.`));
    }
  }
  return errors;
}

function compiledRoles(simple, errors) {
  const roles = {};
  for (const mode of MODES) {
    const result = compileSimpleMode(simple?.[mode], { mode });
    errors.push(...result.errors);
    if (result.roles) roles[mode] = result.roles;
  }
  return roles;
}

/** A syntactically valid custom selection reference. */
export function customSchemeRef(id) {
  return typeof id === "string" && UUID_RE.test(id)
    ? `${CUSTOM_SCHEME_PREFIX}${id.toLowerCase()}`
    : null;
}

export function customSchemeIdFromRef(value) {
  if (typeof value !== "string" || !value.startsWith(CUSTOM_SCHEME_PREFIX)) return null;
  const id = value.slice(CUSTOM_SCHEME_PREFIX.length);
  return UUID_RE.test(id) ? id.toLowerCase() : null;
}

/** Preserve valid custom references while retaining the permanent Everforest alias. */
export function normalizeSchemeSelection(value) {
  const customId = customSchemeIdFromRef(value);
  if (customId) return customSchemeRef(customId);
  return normalizeScheme(value);
}

/** Build the safe Cream-based initial editor draft. */
export function createDefaultCustomSchemeDraft(name = "My color scheme") {
  const simple = clone(DEFAULT_SIMPLE);
  const roles = Object.fromEntries(MODES.map((mode) => [
    mode,
    compileSimpleMode(simple[mode], { mode }).roles
  ]));
  return createDraftFixture({
    name,
    defaultMode: "light",
    authoringMode: "simple",
    simple,
    roles
  });
}

/** Validate and normalize the complete mergeable record payload. */
export function validateCustomSchemeRecord(candidate) {
  const errors = [];
  if (!isObject(candidate)) {
    return { ok: false, value: null, errors: [error("shape.record", "Custom scheme must be an object.")] };
  }
  for (const key of Object.keys(candidate)) {
    if (!RECORD_KEYS.has(key)) {
      errors.push(error("shape.unknown-key", `Custom scheme contains an unsupported “${key}” field.`));
    }
  }
  if (candidate.schemeFormatVersion !== SCHEME_FORMAT_VERSION) {
    errors.push(error(
      "value.scheme-format",
      `Scheme format ${candidate.schemeFormatVersion} is not supported; expected ${SCHEME_FORMAT_VERSION}.`
    ));
  }
  const fixture = validateDraftFixture({
    app: "everytab",
    kind: "color-scheme-draft",
    formatVersion: 1,
    name: candidate.name,
    defaultMode: candidate.defaultMode,
    authoringMode: candidate.authoringMode,
    simple: candidate.simple,
    roles: { light: candidate.light, dark: candidate.dark }
  });
  errors.push(...fixture.errors);
  if (fixture.ok && fixture.value.authoringMode === "simple") {
    const expected = compiledRoles(fixture.value.simple, errors);
    if (!same(expected, fixture.value.roles)) {
      errors.push(error(
        "value.simple-role-mismatch",
        "Saved Simple roles do not match the seven source colours. Recompile the scheme before saving."
      ));
    }
  }
  if (fixture.ok) {
    const expectedSeal = validationSealFor({
      ...candidate,
      schemeFormatVersion: SCHEME_FORMAT_VERSION,
      name: fixture.value.name,
      defaultMode: fixture.value.defaultMode,
      authoringMode: fixture.value.authoringMode,
      simple: fixture.value.simple,
      light: fixture.value.roles.light,
      dark: fixture.value.roles.dark
    });
    if (candidate.validationSeal !== expectedSeal) {
      errors.push(error(
        "value.validation-seal",
        "Custom scheme validation seal is missing or does not match its colour data."
      ));
    }
  }
  if (!fixture.ok || errors.length) return { ok: false, value: null, errors };
  return {
    ok: true,
    value: {
      ...candidate,
      schemeFormatVersion: SCHEME_FORMAT_VERSION,
      validationSeal: candidate.validationSeal,
      name: fixture.value.name,
      defaultMode: fixture.value.defaultMode,
      authoringMode: fixture.value.authoringMode,
      simple: fixture.value.simple,
      light: fixture.value.roles.light,
      dark: fixture.value.roles.dark
    },
    errors: []
  };
}

/** Registry adapter: throws one stable validation error at the portable/Vault seam. */
export function assertCustomSchemeRecord(candidate, path = "custom scheme") {
  const result = validateCustomSchemeRecord(candidate);
  if (!result.ok) throw new Error(`${path}: ${result.errors[0]?.message ?? "invalid custom scheme"}`);
  return result.value;
}

/** Promote a validated editor draft into one mergeable record. */
export function createCustomSchemeRecord(draft, meta) {
  const fixture = validateDraftFixture(draft);
  if (!fixture.ok) return { ok: false, value: null, errors: fixture.errors };
  const errors = [];
  const roles = fixture.value.authoringMode === "simple"
    ? compiledRoles(fixture.value.simple, errors)
    : clone(fixture.value.roles);
  for (const mode of MODES) {
    const validation = validateRoleMap(roles[mode], { id: "custom", mode });
    errors.push(...validation.errors);
  }
  if (errors.length) return { ok: false, value: null, errors };
  const candidate = {
    ...clone(meta),
    schemeFormatVersion: SCHEME_FORMAT_VERSION,
    name: fixture.value.name,
    defaultMode: fixture.value.defaultMode,
    authoringMode: fixture.value.authoringMode,
    simple: fixture.value.simple,
    light: roles.light,
    dark: roles.dark
  };
  candidate.validationSeal = validationSealFor(candidate);
  const result = validateCustomSchemeRecord(candidate);
  return result;
}

export function customSchemeDraftFromRecord(record) {
  const checked = validateCustomSchemeRecord(record);
  if (!checked.ok) return checked;
  return createDraftFixture({
    name: checked.value.name,
    defaultMode: checked.value.defaultMode,
    authoringMode: checked.value.authoringMode,
    simple: checked.value.simple,
    roles: { light: checked.value.light, dark: checked.value.dark }
  });
}

export function duplicateCustomSchemeRecord(record, meta) {
  const draft = customSchemeDraftFromRecord(record);
  if (!draft.ok) return draft;
  draft.value.name = `${draft.value.name} copy`.slice(0, 64).trim();
  return createCustomSchemeRecord(draft.value, meta);
}

function recordsFrom(value) {
  if (Array.isArray(value)) return value;
  return isObject(value) ? Object.values(value) : [];
}

function runtimeRoleMapSafe(roles) {
  return roles && typeof roles === "object" && !Array.isArray(roles) &&
    COLOR_ROLE_KEYS.every((key) => isHexColor(roles[key])) &&
    Array.isArray(roles.gradientStops) && roles.gradientStops.length >= 2 &&
    roles.gradientStops.length <= 3 && roles.gradientStops.every(isHexColor) &&
    Number.isFinite(roles.gradientAngle) && Array.isArray(roles.gradientStopPositions) &&
    roles.gradientStopPositions.length === roles.gradientStops.length &&
    Boolean(gradientCss(
      roles.gradientStops, roles.gradientAngle, roles.gradientStopPositions
    ));
}

/**
 * Cheap read-path guard for records already certified by create/import/Restore/Vault.
 * The seal rejects accidental/manual mutation without rerunning the production
 * pairing ledger for every menu paint.
 */
export function isRuntimeCustomSchemeRecord(record) {
  if (!isObject(record) || Object.keys(record).some((key) => !RECORD_KEYS.has(key)) ||
      !UUID_RE.test(record.id ?? "") || record.schemeFormatVersion !== SCHEME_FORMAT_VERSION ||
      typeof record.name !== "string" || !record.name.trim() || record.name.length > 64 ||
      !MODES.includes(record.defaultMode) || !["simple", "advanced"].includes(record.authoringMode) ||
      !Number.isFinite(record.createdAt) || !Number.isFinite(record.modifiedAt) ||
      record.schemaVersion !== SCHEMA_VERSION ||
      typeof record.validationSeal !== "string") return false;
  const simpleSafe = MODES.every((mode) => isObject(record.simple?.[mode]) &&
    SIMPLE_COLOR_KEYS.every((key) => isHexColor(record.simple[mode][key])));
  return simpleSafe && MODES.every((mode) => runtimeRoleMapSafe(record[mode])) &&
    record.validationSeal === validationSealFor(record);
}

/** Live, valid records only; malformed/future/tombstoned values never reach UI or rotation. */
export function customSchemeCatalogue(value) {
  return recordsFrom(value)
    .filter((record) => !record?.deletedAt)
    .filter(isRuntimeCustomSchemeRecord)
    .map((record) => ({
      id: customSchemeRef(record.id),
      record,
      label: record.name,
      accent: record[record.defaultMode].accent,
      defaultMode: record.defaultMode
    }))
    .sort((a, b) => (b.record.modifiedAt ?? 0) - (a.record.modifiedAt ?? 0) ||
      a.label.localeCompare(b.label));
}

export function availableSchemeIds(value) {
  return [...SCHEMES, ...customSchemeCatalogue(value).map(({ id }) => id)];
}

/** Resolve a stored selection without letting malformed custom data reach paint. */
export function resolveSchemeSelection(selection, customRecords) {
  const normalized = normalizeSchemeSelection(selection);
  const customId = customSchemeIdFromRef(normalized);
  if (customId) {
    const entry = customSchemeCatalogue(customRecords).find(({ record }) => record.id === customId);
    if (entry) return { kind: "custom", selection: entry.id, ...entry };
    return {
      kind: "built-in",
      selection: "cream",
      id: "cream",
      label: SCHEME_META.cream.label,
      accent: SCHEME_META.cream.accent,
      defaultMode: SCHEME_META.cream.defaultMode,
      missingCustomRef: normalized
    };
  }
  const id = normalizeScheme(normalized);
  return {
    kind: "built-in", selection: id, id,
    label: SCHEME_META[id].label,
    accent: SCHEME_META[id].accent,
    defaultMode: SCHEME_META[id].defaultMode
  };
}

export function resolveCustomSchemeMode(uiMode, resolved, prefersDark = false) {
  if (uiMode === "light" || uiMode === "dark") return uiMode;
  if (uiMode === "scheme") return resolved.defaultMode;
  return prefersDark ? "dark" : "light";
}

export function customSchemeCssProperties(record, mode) {
  const checked = validateCustomSchemeRecord(record);
  if (!checked.ok || !MODES.includes(mode)) return { ok: false, value: {}, errors: checked.errors };
  return roleMapToCssProperties(checked.value[mode], { mode });
}

/** Runtime projection after the fast seal/shape gate; creation boundaries already ran strict AA. */
export function runtimeCustomSchemeCssProperties(record, mode) {
  if (!isRuntimeCustomSchemeRecord(record) || !MODES.includes(mode)) {
    return { ok: false, value: {}, errors: [error("value.runtime-record", "Custom scheme is unavailable.")] };
  }
  const roles = record[mode];
  const value = Object.fromEntries(COLOR_ROLE_KEYS.map((key) =>
    [ROLE_CSS_NAMES[key], roles[key]]));
  value["--bg-grad"] = gradientCss(
    roles.gradientStops, roles.gradientAngle, roles.gradientStopPositions
  );
  return { ok: true, value, errors: [] };
}

export const CUSTOM_SCHEME_CSS_PROPERTIES = Object.freeze([
  ...COLOR_ROLE_KEYS.map((key) => ROLE_CSS_NAMES[key]),
  "--bg-grad"
]);

function sharePayload(record) {
  return {
    name: record.name,
    defaultMode: record.defaultMode,
    authoringMode: record.authoringMode,
    simple: clone(record.simple),
    roles: { light: clone(record.light), dark: clone(record.dark) }
  };
}

export function serializeCustomSchemeShare(record) {
  const checked = validateCustomSchemeRecord(record);
  if (!checked.ok) return { ok: false, text: "", errors: checked.errors };
  const envelope = {
    app: "everytab",
    kind: "color-scheme",
    formatVersion: CUSTOM_SCHEME_SHARE_VERSION,
    scheme: sharePayload(checked.value)
  };
  return { ok: true, text: `${JSON.stringify(envelope, null, 2)}\n`, errors: [] };
}

export function parseCustomSchemeShare(text, meta) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_CUSTOM_SCHEME_BYTES) {
    return { ok: false, value: null, errors: [error(
      "value.file-size", `Scheme file exceeds the ${MAX_CUSTOM_SCHEME_BYTES / 1024} KiB limit.`
    )] };
  }
  let candidate;
  try { candidate = JSON.parse(text); }
  catch { return { ok: false, value: null, errors: [error("value.json", "Scheme file is not valid JSON.")] }; }
  const errors = exactKeys(candidate, SHARE_KEYS, "Scheme file");
  if (candidate?.app !== "everytab") errors.push(error("value.app", "Scheme app must be “everytab”."));
  if (candidate?.kind !== "color-scheme") {
    errors.push(error("value.kind", "This file is not an EveryTab color scheme."));
  }
  if (candidate?.formatVersion !== CUSTOM_SCHEME_SHARE_VERSION) {
    errors.push(error(
      "value.format-version",
      `Scheme format ${candidate?.formatVersion} is not supported; expected ${CUSTOM_SCHEME_SHARE_VERSION}.`
    ));
  }
  errors.push(...exactKeys(candidate?.scheme, SHARE_SCHEME_KEYS, "Shared scheme"));
  if (errors.length) return { ok: false, value: null, errors };
  const fixture = createDraftFixture({
    ...candidate.scheme,
    roles: candidate.scheme.roles
  });
  if (!fixture.ok) return { ok: false, value: null, errors: fixture.errors };
  return createCustomSchemeRecord(fixture.value, meta);
}

export function customSchemeFileName(record) {
  const checked = validateCustomSchemeRecord(record);
  const base = checked.ok ? checked.value.name : "everytab-color-scheme";
  const safe = base.normalize("NFKD").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")
    .slice(0, 48).toLowerCase();
  return `${safe || "everytab-color-scheme"}.everytab-scheme.json`;
}
