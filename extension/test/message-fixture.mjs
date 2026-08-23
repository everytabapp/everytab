import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const messagesUrl = new URL("../_locales/en/messages.json", import.meta.url);
export const englishMessages = JSON.parse(readFileSync(fileURLToPath(messagesUrl), "utf8"));

/** Chrome-compatible English message lookup for Node-only extension fixtures. */
export function getEnglishMessage(key, substitutions = []) {
  if (key === "@@ui_locale") return "en";
  if (key === "@@bidi_dir") return "ltr";
  const entry = englishMessages[key];
  if (!entry) return "";
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  let value = entry.message;
  for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
    const index = Number(String(placeholder.content).slice(1)) - 1;
    value = value.replaceAll(`$${name.toUpperCase()}$`, String(values[index] ?? ""));
  }
  return value;
}

export function createChromeI18nMock() {
  return { getMessage: getEnglishMessage };
}
