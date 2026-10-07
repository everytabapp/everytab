import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const messagesUrl = new URL("../_locales/en/messages.json", import.meta.url);
export const englishMessages = JSON.parse(readFileSync(fileURLToPath(messagesUrl), "utf8"));

/** Chrome-compatible English message lookup for Node-only extension fixtures. */
export function getEnglishMessage(key, substitutions = []) {
  return getLocaleMessage(englishMessages, "en", key, substitutions);
}

/**
 * Read one packaged locale catalogue. English is the default locale and stays
 * the only catalogue loaded unless a test asks for another one.
 */
export function readLocaleMessages(locale = "en") {
  if (locale === "en") return englishMessages;
  const url = new URL(`../_locales/${locale}/messages.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

function getLocaleMessage(messages, locale, key, substitutions) {
  if (key === "@@ui_locale") return locale;
  if (key === "@@bidi_dir") return "ltr";
  const entry = messages[key];
  if (!entry) return "";
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  let value = entry.message;
  for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
    const index = Number(String(placeholder.content).slice(1)) - 1;
    value = value.replaceAll(`$${name.toUpperCase()}$`, String(values[index] ?? ""));
  }
  return value;
}

/**
 * Chrome-compatible lookup for one packaged locale. Without an argument this
 * is the English lookup every existing fixture relies on.
 */
export function createChromeI18nMock(locale = "en") {
  if (locale === "en") return { getMessage: getEnglishMessage };
  const messages = readLocaleMessages(locale);
  return {
    getMessage: (key, substitutions = []) => getLocaleMessage(messages, locale, key, substitutions)
  };
}
