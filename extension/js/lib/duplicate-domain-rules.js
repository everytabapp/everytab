// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Exact-host exceptions for duplicate URL identity. */
import { getSettings, mutateStores, patchSettings } from "./store.js";
import { normalizeUrl } from "./url-key.js";

/** Retired device-local array retained byte-for-byte as migration recovery data. */
export const DUPLICATE_DOMAIN_RULES_KEY = "duplicateDomainRules";
export const DUPLICATE_DOMAIN_RULES_MIGRATION_KEY = "duplicateDomainRulesPortableMigration";
export const DUPLICATE_RULE_MODES = Object.freeze([
  "standard", "include-fragment", "skip"
]);
const DUPLICATE_RULE_FORMAT = 1;
let migrationChecked = false;
let migrationPending = null;

/** @param {unknown} value @returns {string} */
export function normalizeDuplicateHostname(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * @param {unknown} value
 * @returns {{hostname:string,mode:"include-fragment"|"skip"}[]}
 */
export function normalizeDuplicateDomainRules(value) {
  const byHostname = new Map();
  for (const rule of Array.isArray(value) ? value : []) {
    const hostname = normalizeDuplicateHostname(rule?.hostname);
    const mode = String(rule?.mode ?? "");
    if (!hostname || !DUPLICATE_RULE_MODES.includes(mode)) continue;
    if (mode === "standard") byHostname.delete(hostname);
    else byHostname.set(hostname, { hostname, mode });
  }
  return [...byHostname.values()].sort((left, right) =>
    left.hostname.localeCompare(right.hostname, undefined, { sensitivity: "base" }));
}

/** @param {unknown} value */
export function duplicateDomainRuleMap(value) {
  if (value instanceof Map) return value;
  return new Map(normalizeDuplicateDomainRules(value)
    .map((rule) => [rule.hostname, rule.mode]));
}

/**
 * One-time additive migration from 0.8.624/0.8.625's local array. The source
 * bytes remain stored for recovery, while a local marker prevents them from
 * overriding later portable Settings edits.
 */
export function ensureDuplicateDomainRulesPortable() {
  if (migrationChecked) return Promise.resolve(false);
  if (migrationPending) return migrationPending;
  migrationPending = mutateStores([
    DUPLICATE_DOMAIN_RULES_KEY,
    DUPLICATE_DOMAIN_RULES_MIGRATION_KEY,
    "settings",
    "settingsModifiedAt"
  ], (maps) => {
      if (maps[DUPLICATE_DOMAIN_RULES_MIGRATION_KEY]?.version >= DUPLICATE_RULE_FORMAT) {
        return null;
      }
      const legacy = normalizeDuplicateDomainRules(maps[DUPLICATE_DOMAIN_RULES_KEY]);
      if (!legacy.length) return null;
      const settings = maps.settings ?? {};
      const next = normalizeDuplicateDomainRules([
        ...normalizeDuplicateDomainRules(settings.duplicateDomainRules),
        ...legacy
      ]);
      const now = Math.max(Date.now(), (Number(maps.settingsModifiedAt) || 0) + 1);
      return {
        settings: { ...settings, duplicateDomainRules: next },
        settingsModifiedAt: now,
        [DUPLICATE_DOMAIN_RULES_MIGRATION_KEY]: {
          version: DUPLICATE_RULE_FORMAT,
          migratedAt: now
        }
      };
  }).finally(() => {
    migrationChecked = true;
    migrationPending = null;
  });
  return migrationPending;
}

/**
 * Duplicate-only address identity. General Search, Session, Label and Snooze
 * identity deliberately keep using normalizeUrl without these profile-local
 * exceptions.
 * @param {string} url
 * @param {unknown} rules
 * @returns {string|null}
 */
export function duplicateUrlKey(url, rules = []) {
  try {
    const parsed = new URL(url);
    const mode = duplicateDomainRuleMap(rules).get(parsed.hostname.toLowerCase()) ?? "standard";
    if (mode === "skip") return null;
    const base = normalizeUrl(parsed.href);
    return mode === "include-fragment" ? `${base}${parsed.hash}` : base;
  } catch {
    return normalizeUrl(url);
  }
}

export async function readDuplicateDomainRules() {
  await ensureDuplicateDomainRulesPortable();
  return normalizeDuplicateDomainRules((await getSettings()).duplicateDomainRules);
}

/**
 * Set one exact-host rule. The complete normalized list travels through the
 * existing portable Settings record, including an empty list after Standard.
 * @param {string} hostname
 * @param {"standard"|"include-fragment"|"skip"} mode
 */
export async function setDuplicateDomainRule(hostname, mode) {
  const cleanHostname = normalizeDuplicateHostname(hostname);
  if (!cleanHostname || !DUPLICATE_RULE_MODES.includes(mode)) {
    throw new TypeError("Invalid duplicate domain rule");
  }
  await ensureDuplicateDomainRulesPortable();
  return patchSettings((settings) => {
    const current = normalizeDuplicateDomainRules(settings.duplicateDomainRules);
    const next = normalizeDuplicateDomainRules([
      ...current.filter((rule) => rule.hostname !== cleanHostname),
      { hostname: cleanHostname, mode }
    ]);
    if (JSON.stringify(current) === JSON.stringify(next)) return null;
    return { duplicateDomainRules: next };
  });
}
