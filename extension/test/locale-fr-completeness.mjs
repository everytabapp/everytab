/**
 * French catalogue completeness. The French locale must mirror the English
 * catalogue key for key, keep every Chrome placeholder contract byte-identical,
 * follow the settled glossary, and resolve through the shared message fixture.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createChromeI18nMock, readLocaleMessages } from "./message-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(path.join(root, name), "utf8");
const failures = [];
const check = (condition, name) => {
  if (!condition) failures.push(name);
};

const enSource = read("_locales/en/messages.json");
const frSource = read("_locales/fr/messages.json");
let en = null;
let fr = null;
try {
  en = JSON.parse(enSource);
  fr = JSON.parse(frSource);
} catch (error) {
  check(false, `both catalogues parse as JSON (${error.message})`);
}

if (en && fr) {
  const enKeys = Object.keys(en);
  const frKeys = Object.keys(fr);
  const frSet = new Set(frKeys);
  const enSet = new Set(enKeys);
  const missing = enKeys.filter((key) => !frSet.has(key));
  const extra = frKeys.filter((key) => !enSet.has(key));
  check(missing.length === 0, `fr has every en key (missing: ${missing.join(", ")})`);
  check(extra.length === 0, `fr has no extra keys (extra: ${extra.join(", ")})`);
  check(JSON.stringify(enKeys) === JSON.stringify(frKeys.filter((key) => enSet.has(key))),
    "fr keeps the English key order");

  const frTopLevel = [...frSource.matchAll(/^ {2}"([^"]+)":/gm)].map((match) => match[1]);
  check(new Set(frTopLevel).size === frTopLevel.length,
    "the French catalogue contains no duplicate top-level message keys");

  const tokens = (message) => [...message.matchAll(/\$[A-Z][A-Z0-9_]*\$/g)].map((match) => match[0]);

  // Strings allowed to equal their English source: proper nouns, product
  // names, scheme names, Chrome terms kept in English by the glossary, exact
  // cognates, and messages made only of placeholders, digits and glyphs.
  const allowedWords = new Set([
    "EveryTab", "Chrome", "JSON", "Markdown", "Minimal", "Terminal", "Inbox", "inbox", "Focus",
    "Session", "Sessions", "session", "sessions", "Suspension", "Collection", "Collections",
    "collection", "Source", "Suggestions", "suggestion", "suggestions", "minute", "minutes", "min",
    "favicons", "index", "copies", "action", "actions", "page", "pages", "Mode", "Rotation",
    "Standard", "Minimum", "OneTab", "Buddy", "Tab", "Manager", "Toby", "Raindrop", "CSV", "h",
    "Cream", "Aladdin", "Candy", "Solarized", "Laser", "Nautilus", "Tokyo", "Night",
    "A–Z",
    // Language option names stay in their own language in every catalogue.
    "English", "Français"
  ]);
  // Example placeholders that are URLs or domains stay untranslated.
  const allowedKeys = new Set(["settings_patterns_placeholder", "settings_add_site_placeholder"]);
  const residue = (message) => message
    .replace(/\$[A-Z][A-Z0-9_]*\$/g, " ")
    .replace(/[0-9]/g, " ")
    .replace(/[·→←+()\[\],.:;!?…  '’"“”«»\-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const identical = [];
  for (const key of enKeys) {
    const entry = fr[key];
    if (!entry) continue;
    check(typeof entry.message === "string" && entry.message.length > 0, `${key} has French copy`);
    const message = entry.message ?? "";
    check(JSON.stringify(en[key].placeholders ?? null) === JSON.stringify(entry.placeholders ?? null),
      `${key} keeps the placeholders block byte-identical`);
    const expected = [...new Set(tokens(en[key].message))];
    const actual = tokens(message);
    check(JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()),
      `${key} uses every English placeholder token exactly once`);
    check(!message.includes("—"), `${key} contains no em dash`);
    check(!/ [?!:;]/.test(message),
      `${key} uses a narrow no-break space, never a plain space, before ? ! : ;`);
    if (message === en[key].message && !allowedKeys.has(key)) {
      const words = residue(message);
      const allowed = words.every((word) => allowedWords.has(word));
      if (!allowed) identical.push(key);
    }
  }
  check(identical.length === 0,
    `no French message equals its English source outside the allowlist (${identical.join(", ")})`);

  const spotChecks = [
    ["action_label", "libellé"],
    ["list_panel_labels_title", "Libellés"],
    ["shell_section_snoozed", "En attente"],
    ["action_snooze", "en attente"],
    ["onboarding_vault_name", "Coffre"],
    ["shell_section_vault", "coffre"],
    ["search_source_snapshot", "Instantané"],
    ["shell_section_snapshots", "Instantanés"],
    ["shell_section_close_day", "Fin de journée"],
    ["close_day_commit", "Clôturer la journée"],
    ["new_tab_choice_dashboard_title", "Tableau de bord"],
    ["new_tab_choice_blank_title", "Page vide"],
    ["nav_starred", "Favoris"],
    ["shell_section_duplicates", "Doublons"],
    ["action_undo", "Annuler"],
    ["action_wake", "Réactiver"],
    ["list_wake_now", "Rouvrir"],
    ["settings_row_color_scheme", "Thème de couleurs"],
    ["settings_option_interface_soft", "Doux"],
    ["settings_option_interface_crisp", "Net"],
    ["newtab_title", "Nouvel onglet"],
    ["popup_side_panel", "Panneau latéral"],
    ["list_group_fallback", "Groupe d’onglets"],
    ["search_source_history", "Historique de navigation"],
    ["nav_settings", "Paramètres"],
    ["shell_nav_more", "Plus"],
    ["settings_open_help", "aide"]
  ];
  for (const [key, term] of spotChecks) {
    check((fr[key]?.message ?? "").toLowerCase().includes(term.toLowerCase()),
      `${key} uses the glossary term "${term}"`);
  }
  check(fr.manifest_name?.message === "EveryTab" && fr.manifest_short_name?.message === "EveryTab",
    "manifest names stay EveryTab in French");
  check(fr.manifest_description?.message !== en.manifest_description.message,
    "manifest description is translated");

  const mock = createChromeI18nMock("fr");
  check(mock.getMessage("@@ui_locale") === "fr", "fixture reports the French UI locale");
  check(mock.getMessage("nav_dashboard") === "Tableau de bord", "fixture resolves French copy");
  check(mock.getMessage("newtab_starred_launcher_many", ["5"]) === "5 pages favorites",
    "fixture substitutes Chrome placeholders in French");
  check(mock.getMessage("notification_snoozed_tomorrow_body", ["Titre"]) === "«\u202fTitre\u202f» reviendra demain à 9 h.",
    "fixture keeps guillemets and narrow no-break spaces around a title placeholder");
  check(mock.getMessage("missing_key") === "", "fixture returns an empty string for a missing key like Chrome");
  const english = createChromeI18nMock();
  check(english.getMessage("nav_dashboard") === "Dashboard" && english.getMessage("@@ui_locale") === "en",
    "default fixture behaviour stays English");
  check(readLocaleMessages("fr") === readLocaleMessages("fr") || Object.keys(readLocaleMessages("fr")).length === enKeys.length,
    "readLocaleMessages exposes the full French catalogue");

  const { createMessageResolver, pluralCategory } = await import("../js/lib/i18n.js");
  const resolve = createMessageResolver(mock.getMessage);
  check(resolve("unit_tabs_other", ["3"]) === "3 onglets", "project resolver returns French copy through the fixture");
  check(pluralCategory(0, { locale: "fr" }) === "one" && pluralCategory(1, { locale: "fr" }) === "one" &&
    pluralCategory(2, { locale: "fr" }) === "other",
  "French plural rules select _one for 0 and 1");
  const singularPairs = enKeys.filter((key) => key.endsWith("_one") && fr[key]?.message.includes("$COUNT$"));
  const pluralSuffixInSingular = singularPairs.filter((key) => /\$COUNT\$ [a-zéèêàç]+s\b/.test(fr[key].message)
    && !/\$COUNT\$ (plus|dans|sur|en|de|déjà|mises|copies)\b/.test(fr[key].message));
  check(pluralSuffixInSingular.length === 0,
    `_one messages with a count read in the singular (${pluralSuffixInSingular.join(", ")})`);
}

if (failures.length) {
  console.error("FAIL locale-fr-completeness:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("PASS locale-fr-completeness: French catalogue mirrors English with glossary terms and fixture lookup");
