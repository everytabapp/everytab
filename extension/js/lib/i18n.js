/**
 * Chrome-native localization boundary. Runtime UI receives strings from the
 * packaged default locale; tests inject an equivalent lookup function.
 */

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

const chromeLookup = (key, substitutions) => {
  const lookup = globalThis.chrome?.i18n?.getMessage;
  return typeof lookup === "function" ? lookup.call(globalThis.chrome.i18n, key, substitutions) : "";
};

export const msg = createMessageResolver(chromeLookup);

/** Chrome exposes locale tags with underscores; Intl requires BCP 47 hyphens. */
export function canonicalLocale(locale) {
  const candidate = String(locale || "en").replaceAll("_", "-");
  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? "en";
  } catch {
    return "en";
  }
}

/** Resolve Chrome's active UI locale without storing it in product data. */
export function uiLocale(lookup = chromeLookup) {
  return canonicalLocale(lookup("@@ui_locale", []));
}

/** Apply the active language and direction to an extension document. */
export function applyDocumentLocale(root = globalThis.document?.documentElement, lookup = chromeLookup) {
  if (!root) return;
  root.lang = uiLocale(lookup);
  const direction = lookup("@@bidi_dir", []);
  root.dir = direction === "rtl" ? "rtl" : "ltr";
}

function localeOptions(options = {}) {
  const { locale = uiLocale(), ...intlOptions } = options;
  return { locale: canonicalLocale(locale), intlOptions };
}

export function formatNumber(value, options = {}) {
  const { locale, intlOptions } = localeOptions(options);
  return new Intl.NumberFormat(locale, intlOptions).format(value);
}

export function formatDate(value, options = {}) {
  const { locale, intlOptions } = localeOptions(options);
  return new Intl.DateTimeFormat(locale, intlOptions).format(value);
}

export function formatTime(value, options = {}) {
  const { locale, intlOptions } = localeOptions(options);
  return new Intl.DateTimeFormat(locale, intlOptions).format(value);
}

export function formatRelativeTime(value, unit, options = {}) {
  const { locale, intlOptions } = localeOptions(options);
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto", ...intlOptions }).format(value, unit);
}

export function formatList(values, options = {}) {
  const { locale, intlOptions } = localeOptions(options);
  return new Intl.ListFormat(locale, intlOptions).format(
    Array.isArray(values) ? values.map(String) : []
  );
}

export function pluralCategory(value, options = {}) {
  const { locale, intlOptions } = localeOptions(options);
  return new Intl.PluralRules(locale, intlOptions).select(value);
}
