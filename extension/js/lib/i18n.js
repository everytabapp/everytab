// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Chrome-native localization boundary. Runtime UI receives strings from the
 * packaged locale Chrome selected, or from a packaged catalogue the user chose
 * in Settings; tests inject an equivalent lookup function.
 */
import { UI_LANGUAGE_VALUES } from "./types.js";
import { reportFailure } from "./failure-diagnostic.js";

/** @typedef {(key: string, substitutions?: string|string[]) => string} MessageLookup */

function normalizedSubstitutions(substitutions) {
  if (substitutions == null) return [];
  if (Array.isArray(substitutions)) return substitutions.map(String);
  return [String(substitutions)];
}

/**
 * Build a strict message resolver. Missing keys are programming errors: a blank
 * label is never a safe localization fallback.
 * @param {MessageLookup} lookup
 */
export function createMessageResolver(lookup) {
  if (typeof lookup !== "function") throw new TypeError("Message lookup must be a function");
  return (key, substitutions = []) => {
    if (typeof key !== "string" || !key) throw new TypeError("Message key must be non-empty");
    const value = lookup(key, normalizedSubstitutions(substitutions));
    if (typeof value !== "string" || !value) throw new Error(`Missing localized message: ${key}`);
    return value;
  };
}

/** Chrome's own lookup: the browser UI locale, then the manifest default locale. */
const chromeLookup = (key, substitutions) => {
  const lookup = globalThis.chrome?.i18n?.getMessage;
  return typeof lookup === "function" ? lookup.call(globalThis.chrome.i18n, key, substitutions) : "";
};

/**
 * The lookup every runtime caller resolves through. It is the browser lookup
 * until a document installs a chosen packaged catalogue (see applyUiLanguage),
 * so `msg` stays a stable export while the language behind it can change.
 * @type {MessageLookup}
 */
let activeLookup = chromeLookup;
const resolveActive = (key, substitutions) => activeLookup(key, substitutions);

export const msg = createMessageResolver(resolveActive);

/** Chrome exposes locale tags with underscores; Intl requires BCP 47 hyphens. */
export function canonicalLocale(locale) {
  const candidate = String(locale || "en").replaceAll("_", "-");
  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? "en";
  } catch {
    return "en";
  }
}

/* ---------- user-chosen packaged catalogue ---------- */

/** Stored Settings value that means "follow the browser". */
const SYSTEM_LANGUAGE = "system";

/** @param {unknown} value @returns {"system"|"en"|"fr"} */
export function normalizeUiLanguage(value) {
  return UI_LANGUAGE_VALUES.includes(value) ? value : SYSTEM_LANGUAGE;
}

/**
 * Format one catalogue entry the way Chrome's getMessage does: `$NAME$` tokens
 * become their placeholder `content` (case-insensitive names), then `$1`..`$9`
 * take the matching substitution (missing ones become empty strings) and `$$`
 * is a literal dollar sign. Both passes run in that order, so a substitution
 * containing "$2" is never re-expanded.
 * @param {{message: string, placeholders?: Record<string, {content: string}>}} entry
 * @param {string|string[]} [substitutions]
 */
export function formatCatalogueMessage(entry, substitutions = []) {
  const values = normalizedSubstitutions(substitutions);
  const placeholders = entry.placeholders ?? {};
  const byName = new Map(Object.keys(placeholders)
    .map((name) => [name.toLowerCase(), placeholders[name]]));
  const withContent = String(entry.message).replace(/\$([A-Za-z0-9_@]+)\$/g, (token, name) => {
    const placeholder = byName.get(name.toLowerCase());
    return placeholder ? String(placeholder.content ?? "") : token;
  });
  return withContent.replace(/\$(\$|[1-9])/g, (_, mark) =>
    mark === "$" ? "$" : (values[Number(mark) - 1] ?? ""));
}

/**
 * Lookup over one packaged catalogue. Keys the catalogue lacks fall back to the
 * browser lookup, which itself falls back to the manifest default locale, so a
 * partial catalogue can never blank a label.
 * @param {"en"|"fr"} language
 * @param {Record<string, {message: string, placeholders?: object}>} catalogue
 * @returns {MessageLookup}
 */
function createCatalogueLookup(language, catalogue) {
  return (key, substitutions) => {
    if (key === "@@ui_locale") return language;
    // Every packaged catalogue is left-to-right; Chrome derives this from the
    // UI locale, so the chosen language owns it too.
    if (key === "@@bidi_dir") return "ltr";
    const entry = catalogue[key];
    if (!entry || typeof entry.message !== "string") return chromeLookup(key, substitutions);
    return formatCatalogueMessage(entry, substitutions);
  };
}

const defaultCatalogueLoad = async (language) => {
  const response = await fetch(chrome.runtime.getURL(`_locales/${language}/messages.json`));
  if (!response.ok) throw new Error(`Catalogue request failed (${response.status})`);
  return response.json();
};

/** Parsed catalogues by language. One fetch per document (or worker life). */
const catalogues = new Map();
let installedLanguage = SYSTEM_LANGUAGE;
let installSequence = 0;

function loadCatalogue(language, load) {
  let pending = catalogues.get(language);
  if (!pending) {
    pending = Promise.resolve().then(() => load(language)).then((parsed) => {
      if (!parsed || typeof parsed !== "object") throw new TypeError("Catalogue is not an object");
      return parsed;
    });
    pending.catch(() => catalogues.delete(language));
    catalogues.set(language, pending);
  }
  return pending;
}

/**
 * Install the user's chosen interface language for this document or worker.
 * "system" (or any unknown value) restores the browser lookup; "en"/"fr" load
 * that packaged catalogue once and route `msg`, `uiLocale`, `applyDocumentLocale`
 * and every Intl helper through it. A catalogue that cannot be read leaves the
 * browser lookup in place rather than blanking the page. Callers await this
 * before their first render; the last call to settle wins when calls overlap.
 * @param {unknown} language
 * @param {{load?: (language: string) => Promise<object>}} [options] test injection
 * @returns {Promise<"system"|"en"|"fr">} the language now installed
 */
export async function applyUiLanguage(language, { load = defaultCatalogueLoad } = {}) {
  const sequence = ++installSequence;
  const next = normalizeUiLanguage(language);
  if (next === SYSTEM_LANGUAGE) {
    activeLookup = chromeLookup;
    installedLanguage = SYSTEM_LANGUAGE;
    return installedLanguage;
  }
  let catalogue;
  try {
    catalogue = await loadCatalogue(next, load);
  } catch (error) {
    reportFailure("interface language install", error);
    if (sequence === installSequence) {
      activeLookup = chromeLookup;
      installedLanguage = SYSTEM_LANGUAGE;
    }
    return installedLanguage;
  }
  if (sequence !== installSequence) return installedLanguage;
  activeLookup = createCatalogueLookup(next, catalogue);
  installedLanguage = next;
  return installedLanguage;
}

/** The language installed by applyUiLanguage, "system" when following the browser. */
export function installedUiLanguage() {
  return installedLanguage;
}

/**
 * Chrome's UI locale cannot change for a loaded document, so the browser
 * lookup is resolved once. A missing `chrome.i18n` (an early call before a test
 * installs its mock) yields a placeholder that is not retained.
 */
let defaultUiLocale = null;

/** The browser's own UI locale, independent of the installed language. */
export function browserUiLocale() {
  if (defaultUiLocale) return defaultUiLocale;
  const raw = chromeLookup("@@ui_locale", []);
  const locale = canonicalLocale(raw);
  if (raw) defaultUiLocale = locale;
  return locale;
}

/**
 * Resolve the active UI locale without storing it in product data. By default
 * this follows the installed language; an injected lookup answers for itself.
 */
export function uiLocale(lookup = activeLookup) {
  if (lookup !== chromeLookup) return canonicalLocale(lookup("@@ui_locale", []));
  return browserUiLocale();
}

/** Apply the active language and direction to an extension document. */
export function applyDocumentLocale(root = globalThis.document?.documentElement, lookup = activeLookup) {
  if (!root) return;
  root.lang = uiLocale(lookup);
  const direction = lookup("@@bidi_dir", []);
  root.dir = direction === "rtl" ? "rtl" : "ltr";
}

function localeOptions(options = {}) {
  const { locale = uiLocale(), ...intlOptions } = options;
  return { locale: canonicalLocale(locale), intlOptions };
}

/**
 * Intl formatters are stateless, so one instance per constructor, locale and
 * options serves every call. Constructing one per formatted number or date
 * was the dominant cost of a large list render.
 * @type {Map<string, object>}
 */
const formatters = new Map();

function formatter(Constructor, locale, intlOptions) {
  const key = `${Constructor.name}\u0000${locale}\u0000${JSON.stringify(intlOptions)}`;
  let instance = formatters.get(key);
  if (!instance) {
    instance = new Constructor(locale, intlOptions);
    formatters.set(key, instance);
  }
  return instance;
}

export function formatNumber(value, options = {}) {
  const { locale, intlOptions } = localeOptions(options);
  return formatter(Intl.NumberFormat, locale, intlOptions).format(value);
}

export function formatDate(value, options = {}) {
  const { locale, intlOptions } = localeOptions(options);
  return formatter(Intl.DateTimeFormat, locale, intlOptions).format(value);
}

export function formatTime(value, options = {}) {
  const { locale, intlOptions } = localeOptions(options);
  return formatter(Intl.DateTimeFormat, locale, intlOptions).format(value);
}

/** Locale-aware time parts for layouts that style the day period separately. */
export function formatTimeParts(value, options = {}) {
  const { locale, intlOptions } = localeOptions(options);
  return formatter(Intl.DateTimeFormat, locale, intlOptions).formatToParts(value);
}

export function formatRelativeTime(value, unit, options = {}) {
  const { locale, intlOptions } = localeOptions(options);
  return formatter(Intl.RelativeTimeFormat, locale, { numeric: "auto", ...intlOptions })
    .format(value, unit);
}

export function formatList(values, options = {}) {
  const { locale, intlOptions } = localeOptions(options);
  return formatter(Intl.ListFormat, locale, intlOptions).format(
    Array.isArray(values) ? values.map(String) : []
  );
}

export function pluralCategory(value, options = {}) {
  const { locale, intlOptions } = localeOptions(options);
  return formatter(Intl.PluralRules, locale, intlOptions).select(value);
}
