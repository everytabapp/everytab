/**
 * In-app interface language. The resolver installs a packaged catalogue with
 * Chrome-compatible substitution and browser fallback, Intl helpers follow the
 * installed language, Settings normalization preserves stored values, every page
 * entry installs the language before its first render (source guard), and the
 * worker reinstalls the lookup when the setting changes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createChromeI18nMock, englishMessages, getEnglishMessage, readLocaleMessages
} from "./message-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(path.join(root, name), "utf8");
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

/* ---- an English browser with the extension's packaged catalogues ---- */
let fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  const language = /_locales\/([a-z]+)\/messages\.json$/.exec(String(url))?.[1];
  return { ok: Boolean(language), json: async () => readLocaleMessages(language) };
};
function chromeEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) { listeners.splice(listeners.indexOf(listener), 1); },
    emit(...args) { listeners.forEach((listener) => listener(...args)); }
  };
}
globalThis.chrome = {
  i18n: createChromeI18nMock("en"),
  runtime: { getURL: (file) => `chrome-extension://test-id/${file}` },
  storage: { local: { get: async () => ({}) }, onChanged: chromeEvent() }
};

const {
  applyDocumentLocale, applyUiLanguage, browserUiLocale, formatCatalogueMessage, formatDate,
  formatNumber, formatRelativeTime, installedUiLanguage, msg, normalizeUiLanguage,
  pluralCategory, uiLocale
} = await import("../js/lib/i18n.js");

/* ---- default: follow the browser ---- */
assert.equal(installedUiLanguage(), "system");
assert.equal(msg("nav_dashboard"), "Dashboard");
assert.equal(uiLocale(), "en");
assert.equal(browserUiLocale(), "en");

/* ---- a catalogue that cannot be read keeps the browser lookup ---- */
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
assert.equal(await applyUiLanguage("en", { load: async () => { throw new Error("chrome-extension://secret"); } }),
  "system", "a failed catalogue load reports the system language");
console.warn = originalWarn;
assert.equal(installedUiLanguage(), "system");
assert.equal(msg("nav_dashboard"), "Dashboard");
assert.equal(warnings.length, 1, "the failure is reported once");
assert.ok(!warnings[0].includes("secret"), "the warning carries no error text or URL");

/* ---- install French through the packaged catalogue ---- */
assert.equal(await applyUiLanguage("fr"), "fr");
assert.deepEqual(fetchCalls, ["chrome-extension://test-id/_locales/fr/messages.json"],
  "the catalogue is fetched from the packaged _locales folder through chrome.runtime.getURL");
assert.equal(installedUiLanguage(), "fr");
assert.equal(msg("nav_dashboard"), "Tableau de bord", "a plain key resolves from the installed catalogue");

const frenchChrome = createChromeI18nMock("fr");
for (const [key, substitutions] of [
  ["newtab_starred_launcher_many", ["5"]],
  ["notification_snoozed_tomorrow_body", ["Titre"]],
  ["settings_desc_color_scheme", ["36"]]
]) {
  assert.equal(msg(key, substitutions), frenchChrome.getMessage(key, substitutions),
    `${key}: the installed lookup substitutes placeholders exactly like Chrome's French lookup`);
  assert.equal(formatCatalogueMessage(englishMessages[key], substitutions),
    getEnglishMessage(key, substitutions),
    `${key}: the same formatter reproduces the English fixture's Chrome substitution`);
}
assert.equal(msg("newtab_starred_launcher_many", ["5"]), "5 pages favorites");

// Plural pair selected through Intl in the installed language.
assert.equal(pluralCategory(0), "one");
assert.equal(pluralCategory(1), "one");
assert.equal(pluralCategory(2), "other");
const savedRecords = (count) => msg(`restore_saved_record_${pluralCategory(count)}`, [String(count)]);
assert.equal(savedRecords(0), "0 enregistrement", "French selects the singular form for 0");
assert.equal(savedRecords(1), frenchChrome.getMessage("restore_saved_record_one", ["1"]));
assert.equal(savedRecords(3), "3 enregistrements");

// uiLocale and every Intl helper follow the installed language, not the browser.
assert.equal(uiLocale(), "fr");
assert.equal(browserUiLocale(), "en", "the browser's own locale stays available for the System option");
assert.equal(formatDate(Date.UTC(2026, 7, 19, 13, 5), {
  timeZone: "UTC", weekday: "long", day: "numeric", month: "long"
}), "mercredi 19 août", "dates format in French while the browser is English");
assert.equal(formatRelativeTime(-2, "day"), "avant-hier");
assert.equal(formatNumber(1234.5, { maximumFractionDigits: 1 }), "1 234,5");
const documentRoot = {};
applyDocumentLocale(documentRoot);
assert.equal(documentRoot.lang, "fr", "applyDocumentLocale publishes the installed language");
assert.equal(documentRoot.dir, "ltr");

// One fetch per document: installing the same language again is free.
assert.equal(await applyUiLanguage("fr"), "fr");
assert.equal(fetchCalls.length, 1, "the parsed catalogue is cached for the document");

assert.throws(() => msg("missing_key_for_language_test"), /Missing localized message/,
  "msg stays strict about missing keys under an installed catalogue");

/* ---- Chrome substitution rules on synthetic entries ---- */
assert.equal(formatCatalogueMessage(
  { message: "Hello $NAME$ ($$5)", placeholders: { name: { content: "$1" } } }, ["Ada"]
), "Hello Ada ($5)", "named placeholder content and the $$ escape");
assert.equal(formatCatalogueMessage({ message: "$1 and $2" }, ["a"]), "a and ",
  "direct $1 substitution; a missing substitution becomes an empty string");
assert.equal(formatCatalogueMessage(
  { message: "$Name$", placeholders: { NAME: { content: "x$1y" } } }, ["Z"]
), "xZy", "placeholder names match case-insensitively");
assert.equal(formatCatalogueMessage({ message: "$$1" }, ["Z"]), "$1",
  "an escaped dollar is never re-read as a substitution index");
assert.equal(formatCatalogueMessage({ message: "$1" }, ["$2"]), "$2",
  "a substitution containing $2 is not expanded again");
assert.equal(formatCatalogueMessage({ message: "Plain" }, "single"), "Plain",
  "a string substitution is accepted like Chrome's single-argument form");

/* ---- keys missing from a partial catalogue fall back to the browser lookup ---- */
assert.equal(await applyUiLanguage("en", {
  load: async () => ({ nav_dashboard: { message: "Partial board" } })
}), "en");
assert.equal(fetchCalls.length, 1, "an injected loader replaces the fetch");
assert.equal(msg("nav_dashboard"), "Partial board");
assert.equal(msg("nav_settings"), "Settings", "a missing key resolves through chrome.i18n.getMessage");
assert.equal(uiLocale(), "en");
globalThis.chrome.i18n = createChromeI18nMock("fr");
assert.equal(msg("nav_settings"), "Paramètres",
  "the browser fallback follows the browser's own locale, which itself falls back to the default locale");
assert.equal(msg("nav_dashboard"), "Partial board");
globalThis.chrome.i18n = createChromeI18nMock("en");

/* ---- restoring the browser lookup ---- */
assert.equal(await applyUiLanguage("system"), "system");
assert.equal(msg("nav_dashboard"), "Dashboard");
assert.equal(uiLocale(), "en");
applyDocumentLocale(documentRoot);
assert.equal(documentRoot.lang, "en");
assert.equal(await applyUiLanguage("de"), "system", "an unpackaged language reads as system");
assert.equal(await applyUiLanguage(null), "system");
assert.equal(normalizeUiLanguage("fr"), "fr");
assert.equal(normalizeUiLanguage("xx"), "system");
assert.equal(normalizeUiLanguage(undefined), "system");

/* ---- Settings contract: default, read normalization, portable seam ---- */
const { DEFAULT_SETTINGS, UI_LANGUAGE_VALUES } = await import("../js/lib/types.js");
assert.equal(DEFAULT_SETTINGS.uiLanguage, "system");
assert.deepEqual([...UI_LANGUAGE_VALUES], ["system", "en", "fr"]);
const { settingsFromStored, normalizeAppearanceSettings } = await import("../js/lib/store.js");
const stored = { uiLanguage: "de" };
assert.equal(settingsFromStored(stored).uiLanguage, "system", "an unknown stored value reads as system");
assert.equal(stored.uiLanguage, "de", "the stored value is not rewritten on read");
assert.equal(settingsFromStored({ uiLanguage: "fr" }).uiLanguage, "fr");
assert.equal(settingsFromStored({ uiLanguage: "en" }).uiLanguage, "en");
assert.equal(settingsFromStored({}).uiLanguage, "system");
assert.equal(normalizeAppearanceSettings({ ...DEFAULT_SETTINGS, uiLanguage: 7 }).uiLanguage, "system");
const { normalizePortableSettings } = await import("../js/lib/portable-state-registry.js");
assert.equal(normalizePortableSettings({ uiLanguage: "fr", uiInterfaceStyle: "crisp" }).uiLanguage, "fr",
  "the language travels through Vault sync and backups like the other appearance keys");
assert.equal(normalizePortableSettings({ uiLanguage: "de" }).uiLanguage, "system");
assert.equal(normalizePortableSettings({}).uiLanguage, "system");

/* ---- Settings copy: the Language row and its options ---- */
const { settingsLanguageOptions, settingsLanguageOwnName, settingsRowCopy } =
  await import("../js/ui/settings-copy.js");
assert.deepEqual(settingsLanguageOptions("en-US"), [
  ["system", "System (English)"], ["en", "English"], ["fr", "Français"]
], "the System option names the browser language in its own language; stored values stay codes");
assert.deepEqual(settingsLanguageOptions("fr")[0], ["system", "System (Français)"]);
assert.equal(settingsLanguageOwnName("en-GB"), "English");
assert.equal(settingsLanguageOwnName("zz"), "zz", "an unknown language falls back to its code");
assert.equal(settingsRowCopy("language").title, "Language");
assert.equal(settingsRowCopy("language").description, "Takes effect when a page is next opened");
await applyUiLanguage("fr");
assert.deepEqual(settingsLanguageOptions("en-US"), [
  ["system", "Système (English)"], ["en", "English"], ["fr", "Français"]
], "under the French catalogue the option names of the languages stay in their own language");
assert.equal(settingsRowCopy("language").title, "Langue");
assert.equal(settingsRowCopy("language").description, "Prend effet à la prochaine ouverture d’une page");
await applyUiLanguage("system");
const frenchCatalogue = readLocaleMessages("fr");
assert.deepEqual(frenchCatalogue.settings_option_language_system.placeholders,
  englishMessages.settings_option_language_system.placeholders);
assert.equal(frenchCatalogue.settings_option_language_en.message, "English");
assert.equal(englishMessages.settings_option_language_fr.message, "Français");

/* ---- source guard: every page entry installs the language before its first render ---- */
const settingsForm = stripComments(read("js/ui/settings-form.js"));
assert.ok(settingsForm.includes('group("appearance",\n      localizedRow("language", select("uiLanguage", settingsLanguageOptions())),'),
  "Language is the first row of the Appearance group and reuses the shared select control");

const INSTALL = "await applyUiLanguage(";
const firstRenderMarkers = ["applyDocumentLocale();", "initTheme();", "document.title", "localeMessage(", "msg("];
const entryGuards = {
  "js/ui/newtab-entry.js": ['await import("./dashboard.js")', 'await import("./newtab.js")', 'msg("newtab_title")'],
  "js/ui/dashboard.js": firstRenderMarkers,
  "js/ui/popup.js": firstRenderMarkers,
  "js/ui/sidepanel.js": firstRenderMarkers,
  "js/ui/options.js": [...firstRenderMarkers, "mountSettingsForm("],
  "js/ui/suspend-page.js": firstRenderMarkers,
  "js/ui/focus-page.js": firstRenderMarkers,
  "js/ui/scheme-editor.js": ["applyDocumentLocale();", "initTheme();", "mount();", "wireControls();"]
};
for (const [file, markers] of Object.entries(entryGuards)) {
  const source = stripComments(read(file));
  const importsEnd = source.lastIndexOf("\nimport ");
  const body = source.slice(source.indexOf("\n", importsEnd + 1));
  const installAt = body.indexOf(INSTALL);
  assert.ok(installAt >= 0, `${file} installs the chosen interface language`);
  assert.ok(body.slice(0, installAt).includes("getSettings()") || body.slice(installAt, installAt + 80).includes("getSettings()"),
    `${file} installs the language from its Settings read`);
  for (const marker of markers) {
    const markerAt = body.indexOf(marker);
    if (markerAt < 0) continue;
    assert.ok(installAt < markerAt, `${file}: language is installed before ${JSON.stringify(marker)}`);
  }
}
const pageScripts = {
  "newtab.html": "js/ui/newtab-entry.js", "dashboard.html": "js/ui/dashboard.js",
  "popup.html": "js/ui/popup.js", "sidepanel.html": "js/ui/sidepanel.js",
  "options.html": "js/ui/options.js", "suspend.html": "js/ui/suspend-page.js",
  "focus.html": "js/ui/focus-page.js", "scheme-editor.html": "js/ui/scheme-editor.js"
};
for (const [page, script] of Object.entries(pageScripts)) {
  assert.ok(read(page).includes(`${script}"`), `${page} is driven by ${script}`);
}

/* ---- worker: install at start and reinstall through the Settings-change owner ---- */
const background = stripComments(read("js/background.js"));
assert.ok(background.includes("void installUiLanguage();"), "the worker installs the language at startup");
assert.ok(background.includes("uiLanguageChanged: installUiLanguage"),
  "the worker reinstalls through the Settings-change owner");
assert.ok(background.includes("getFreshSettings()\n  .then((settings) => applyUiLanguage(settings.uiLanguage))"),
  "the worker reads fresh Settings for the install");

const { installSettingsChangeOwner } = await import("../js/background/settings-change-owner.js");
let workerSettings = { uiLanguage: "system" };
const readFreshSettings = async () => settingsFromStored(workerSettings);
const effectCalls = [];
let lastInstall = Promise.resolve();
installSettingsChangeOwner({
  recordStorageChange() {},
  ensureSnapshotAlarm: async () => {},
  ensureArchiveAlarm() {},
  ensureSchemeRotationAlarm() {},
  refreshBadge() {},
  scheduleAutoSaveCapSweep() {},
  sweepInboxExpiry: async () => {},
  focusRulesChanged() {},
  uiLanguageChanged() {
    effectCalls.push("ui-language");
    lastInstall = readFreshSettings().then((settings) => applyUiLanguage(settings.uiLanguage));
    return lastInstall;
  }
});
assert.equal(msg("action_undo"), "Undo");
const previous = workerSettings;
workerSettings = { ...workerSettings, uiLanguage: "fr" };
globalThis.chrome.storage.onChanged.emit({ settings: { oldValue: previous, newValue: workerSettings } }, "local");
await lastInstall;
assert.deepEqual(effectCalls, ["ui-language"]);
assert.equal(installedUiLanguage(), "fr");
assert.equal(msg("action_undo"), "Annuler", "notification copy follows the new language");

globalThis.chrome.storage.onChanged.emit({
  settings: { oldValue: workerSettings, newValue: { ...workerSettings, uiScheme: "cream" } }
}, "local");
assert.deepEqual(effectCalls, ["ui-language"], "an unrelated Settings change does not reinstall");

const beforePulse = workerSettings;
workerSettings = { ...workerSettings, uiLanguage: "system" };
globalThis.chrome.storage.onChanged.emit({
  storageV2Revision: { newValue: { changedKeys: ["settings"], logicalChanges: { settings: {} } } }
}, "local");
await lastInstall;
assert.deepEqual(effectCalls, ["ui-language", "ui-language"], "a value-free pulse re-reads Settings");
assert.equal(installedUiLanguage(), "system");
assert.equal(msg("action_undo"), "Undo");
assert.notEqual(beforePulse.uiLanguage, workerSettings.uiLanguage);

globalThis.chrome.storage.onChanged.emit({ settings: { oldValue: {}, newValue: { uiLanguage: "fr" } } }, "sync");
assert.deepEqual(effectCalls, ["ui-language", "ui-language"], "non-local changes never reinstall");

console.log("PASS ui-language-setting: catalogue install, Chrome substitution parity, browser fallback, Intl, Settings normalization, entry source guard, worker reinstall");
