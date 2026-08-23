import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(path.join(root, name), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const messages = JSON.parse(read("_locales/en/messages.json"));
const failures = [];
const check = (condition, name) => {
  if (!condition) failures.push(name);
};

const requiredKeys = [
  "manifest_name", "manifest_short_name", "manifest_description", "manifest_action_title",
  "command_search_description", "command_dashboard_description",
  "command_side_panel_description", "command_save_window_description",
  "command_save_tab_description", "command_snooze_tab_description",
  "command_suspend_tab_description", "newtab_title", "newtab_search_placeholder",
  "newtab_search_history_placeholder", "nav_starred", "nav_dashboard", "nav_settings",
  "newtab_starred_launcher_one", "newtab_starred_launcher_many"
];

check(manifest.default_locale === "en", "manifest declares English as the default locale");
check(manifest.name === "__MSG_manifest_name__" &&
  manifest.short_name === "__MSG_manifest_short_name__" &&
  manifest.description === "__MSG_manifest_description__" &&
  manifest.action?.default_title === "__MSG_manifest_action_title__",
"manifest-owned product copy resolves through Chrome messages");
check(Object.values(manifest.commands).every((command) =>
  /^__MSG_[a-z0-9_]+__$/.test(command.description)),
"every Chrome command description resolves through the catalogue");

for (const key of requiredKeys) {
  const entry = messages[key];
  check(Boolean(entry), `English catalogue contains ${key}`);
  check(typeof entry?.message === "string" && entry.message.trim().length > 0,
    `${key} has non-empty English copy`);
  check(typeof entry?.description === "string" && entry.description.trim().length > 0,
    `${key} has translator context`);
}

for (const [key, entry] of Object.entries(messages)) {
  const tokens = [...entry.message.matchAll(/\$([A-Z][A-Z0-9_]*)\$/g)]
    .map((match) => match[1].toLowerCase());
  const declared = Object.keys(entry.placeholders ?? {}).sort();
  check(JSON.stringify([...new Set(tokens)].sort()) === JSON.stringify(declared),
    `${key} declares exactly the placeholders used by its message`);
  for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
    check(/^\$\d+$/.test(placeholder.content) && Boolean(placeholder.example),
      `${key}.${name} has a positional source and translator example`);
  }
}

const {
  createMessageResolver, formatDate, formatList, formatNumber, formatRelativeTime, formatTime,
  pluralCategory, uiLocale
} = await import("../js/lib/i18n.js");
const resolve = createMessageResolver((key, substitutions = []) => {
  const entry = messages[key];
  if (!entry) return "";
  let value = entry.message;
  Object.values(entry.placeholders ?? {}).forEach((placeholder) => {
    const index = Number(placeholder.content.slice(1)) - 1;
    const token = Object.entries(entry.placeholders)
      .find(([, candidate]) => candidate === placeholder)?.[0]?.toUpperCase();
    value = value.replaceAll(`$${token}$`, String(substitutions[index] ?? ""));
  });
  return value;
});
check(resolve("nav_dashboard") === "Dashboard", "message resolver returns catalogue copy");
check(resolve("newtab_starred_launcher_many", ["5"]) === "5 Starred pages",
  "message resolver preserves Chrome placeholder ordering");
let missingThrew = false;
try { resolve("missing_key"); } catch { missingThrew = true; }
check(missingThrew, "message resolver never turns a missing key into blank UI");
check(uiLocale((key) => key === "@@ui_locale" ? "en_GB" : "") === "en-GB" &&
  formatTime(Date.UTC(2026, 7, 19, 13, 5), {
    locale: "en_GB", timeZone: "UTC", hour: "2-digit", minute: "2-digit"
  }) === "13:05",
"Chrome underscore locales are canonicalized before reaching Intl");

check(formatNumber(1234.5, { locale: "en-US", maximumFractionDigits: 1 }) === "1,234.5",
  "number formatting is locale-aware and deterministic under injection");
check(formatDate(Date.UTC(2026, 7, 19, 13, 5), {
  locale: "en-GB", timeZone: "UTC", weekday: "long", month: "long", day: "numeric"
}) === "Wednesday 19 August",
"date formatting is locale-aware and deterministic under injection");
check(formatTime(Date.UTC(2026, 7, 19, 13, 5), {
  locale: "en-GB", timeZone: "UTC", hour: "2-digit", minute: "2-digit"
}) === "13:05",
"time formatting is locale-aware and deterministic under injection");
check(formatRelativeTime(-2, "day", { locale: "en" }) === "2 days ago" &&
  pluralCategory(1, { locale: "en" }) === "one" &&
  pluralCategory(2, { locale: "en" }) === "other",
"relative time and plural selection use Intl rather than English concatenation");
check(formatList(["“Work”", "“Research”"], { locale: "en" }) === "“Work” and “Research”",
  "list formatting is locale-aware rather than comma-concatenated English");

const { pseudoExpand } = await import("../tools/pseudo-locale.mjs");
const source = "Search $COUNT$ tabs with in: and label:";
const pseudo = pseudoExpand(source, { expansion: 0.35 });
check(pseudo.startsWith("［") && pseudo.endsWith("］") &&
  pseudo.includes("$COUNT$") && pseudo.includes("in:") && pseudo.includes("label:") &&
  pseudo.length >= Math.ceil(source.length * 1.35),
"development pseudo-copy expands by at least 35% while preserving placeholders and filter syntax");
check(!read("js/ui/newtab.js").includes('"Search open and saved tabs…"') &&
  read("js/ui/newtab.js").includes('msg("newtab_search_placeholder")'),
"Horizon is the first runtime surface to consume the catalogue rather than duplicate English");

const productionJs = [];
const collectJs = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collectJs(absolute);
    else if (entry.name.endsWith(".js")) productionJs.push(absolute);
  }
};
collectJs(path.join(root, "js"));
const referenced = new Set();
for (const file of productionJs) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/(?:\bmsg|\blocaleMessage)\(\s*["']([a-z0-9_]+)["']/g)) {
    referenced.add(match[1]);
  }
  // Ternaries and shared copy maps select catalogue keys before calling the
  // resolver. Count only string literals that are actual catalogue entries,
  // so the strict dead-key check still rejects unused English copy.
  for (const match of source.matchAll(/["']([a-z0-9_]+)["']/g)) {
    if (messages[match[1]]) referenced.add(match[1]);
  }
  if (file.endsWith("settings-copy.js") || file.endsWith("history-access-copy.js")) {
    for (const match of source.matchAll(/["']((?:settings|history_access)_[a-z0-9_]+)["']/g)) {
      if (messages[match[1]]) referenced.add(match[1]);
    }
  }
  if (file.endsWith("activity-copy.js")) {
    for (const match of source.matchAll(/["'](activity_[a-z0-9_]+)["']/g)) {
      const key = match[1];
      if (messages[key]) referenced.add(key);
      if (messages[`${key}_one`]) referenced.add(`${key}_one`);
      if (messages[`${key}_other`]) referenced.add(`${key}_other`);
    }
  }
}
for (const match of JSON.stringify(manifest).matchAll(/__MSG_([a-z0-9_]+)__/g)) {
  referenced.add(match[1]);
}
check([...referenced].every((key) => messages[key]),
  "every literal runtime message reference exists in the English catalogue");
check(Object.keys(messages).every((key) => referenced.has(key)),
  "the English catalogue contains no dead keys");

for (const [key, entry] of Object.entries(messages)) {
  const expanded = pseudoExpand(entry.message, { expansion: 0.35 });
  const tokens = [...entry.message.matchAll(/\$[A-Z][A-Z0-9_]*\$/g)].map((match) => match[0]);
  check(tokens.every((token) => expanded.includes(token)),
    `${key} pseudo-copy preserves every Chrome placeholder`);
}

const focusCopyTargets = [
  "js/lib/focus-copy.js", "js/lib/focus-guard.js", "js/ui/focus-access.js",
  "js/ui/focus-strip.js", "js/ui/focus-page.js", "js/ui/focus-page-actions.js",
  "js/background.js", "focus.html"
];
const strippedFocusSources = focusCopyTargets.map((file) => read(file)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, ""));
const focusKeys = Object.keys(messages).filter((key) =>
  key.startsWith("focus_") || key.startsWith("context_") ||
  key.startsWith("notification_") || key === "action_cancel" ||
  key === "action_stop" || key === "action_undo");
check(focusKeys.every((key) => {
  const entry = messages[key];
  if (entry.placeholders || entry.message.length < 5) return true;
  return strippedFocusSources.every((source) => !source.includes(`"${entry.message}"`) &&
    !source.includes(`'${entry.message}'`) && !source.includes(`>${entry.message}<`));
}), "the extracted Focus and system slice does not duplicate catalogue-owned English copy");

const searchCopyTargets = [
  "js/lib/search-copy.js", "js/lib/search-popup.js", "js/lib/omnibox.js",
  "js/ui/searchbox.js", "js/ui/shortcuts.js"
];
const strippedSearchSources = searchCopyTargets.map((file) => read(file)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, ""));
const searchKeys = Object.keys(messages).filter((key) =>
  key.startsWith("search_") || key.startsWith("shortcuts_") ||
  key.startsWith("command_") || key === "action_close" || key === "action_try_again");
const stableSearchGrammar = new Set(["session", "snoozed"]);
check(searchKeys.every((key) => {
  const entry = messages[key];
  if (entry.placeholders || entry.message.length < 5 || stableSearchGrammar.has(entry.message)) return true;
  return strippedSearchSources.every((source) => !source.includes(`"${entry.message}"`) &&
    !source.includes(`'${entry.message}'`) && !source.includes(`>${entry.message}<`));
}), "the extracted Search and shortcut slice does not duplicate catalogue-owned English copy");

const listCopyTargets = [
  "js/lib/relative-time.js", "js/ui/list-copy.js", "js/ui/tablist.js",
  "js/ui/list-helpers.js", "js/ui/list-configs.js", "js/ui/indexbar.js",
  "js/ui/open-surface.js", "js/ui/inbox-surface.js", "js/ui/labels-surface.js",
  "js/ui/sessions-surface.js", "js/ui/organization-controls.js"
];
const strippedListSources = listCopyTargets.map((file) => read(file)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, ""));
const listActionKeys = new Set([
  "action_archive", "action_close", "action_copy", "action_delete", "action_inbox",
  "action_label", "action_remove", "action_rename", "action_session", "action_snooze",
  "action_suspend", "action_wake"
]);
const listKeys = Object.keys(messages).filter((key) =>
  key.startsWith("list_") || key.startsWith("organization_") || key.startsWith("unit_") ||
  key.startsWith("age_") || listActionKeys.has(key));
const stableListGrammar = new Set(["Inbox", "Groups", "All", "Ungrouped", "Manage", "Delete"]);
const nextListSlice = new Set(["list_copy_selected_title"]);
check(listKeys.every((key) => {
  const entry = messages[key];
  if (entry.placeholders || entry.message.length < 5 || /^[a-z]+$/.test(entry.message) ||
      stableListGrammar.has(entry.message) || nextListSlice.has(key)) return true;
  return strippedListSources.every((source) => !source.includes(`"${entry.message}"`) &&
    !source.includes(`'${entry.message}'`) && !source.includes(`>${entry.message}<`));
}), "the extracted shared-list slice does not duplicate catalogue-owned English copy");

globalThis.chrome = { i18n: { getMessage: (key, substitutions) => {
  if (key === "@@ui_locale") return "en";
  if (key === "@@bidi_dir") return "ltr";
  return resolve(key, substitutions);
} } };
const { searchCount, searchResultAction, searchResultMeta } =
  await import("../js/lib/search-copy.js");
check(searchResultAction("session-entity") === "Restore" &&
  searchResultMeta({ type: "session-entity", windowCount: 3, tabCount: 18 }) ===
    "3 windows · 18 tabs" &&
  searchResultMeta({ type: "label-group-entity", memberCount: 5 }) ===
    "Label group · 5 labels",
"Search outcomes and entity metadata resolve through one shared presentation module");
check(searchCount("result", 1) === "1 result" &&
  searchCount("result", 6) === "6 results" &&
  searchCount("recent", 6, { announcement: true }) === "6 recent tabs.",
"Search counts use catalogue-backed singular, plural, and live-announcement copy");

const {
  HELP_GROUPS, HELP_TOPICS, ONBOARDING_PAGES, SECTION_TO_PAGE,
  helpTopicId, onboardingStatic, onboardingStepId
} = await import("../js/lib/onboarding-copy.js");
check(ONBOARDING_PAGES.map((page) => page.id).join(",") === "local,newtab,save,find,scheme,data" &&
  HELP_TOPICS.length === 14 && HELP_GROUPS.flatMap((group) => group.topicIds).length === 14,
"localized first run has six outcomes and permanent Help has its own complete library");
check(Object.values(SECTION_TO_PAGE).every((id) => HELP_TOPICS.some((topic) => topic.id === id)) &&
  onboardingStepId("machinery") === "save" && helpTopicId("snapshots") === "sessions",
"Learn more and legacy incomplete-tour ids resolve through stable language-free topic ids");
check(onboardingStatic.progress(3, 6) === "3 of 6" &&
  onboardingStatic.pageAria(2, 6, "Choose your new tab") ===
    "Step 2 of 6: Choose your new tab",
"first-run progress and accessible labels use localized numbers and placeholders");
const onboardingSources = [
  "js/lib/onboarding-copy.js", "js/ui/onboarding.js", "js/ui/automation-threshold-controls.js"
].map((file) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""));
const onboardingKeys = Object.keys(messages).filter((key) =>
  key.startsWith("onboarding_") || key.startsWith("help_"));
check(onboardingKeys.every((key) => {
  const entry = messages[key];
  if (entry.placeholders || entry.message.length < 5) return true;
  return onboardingSources.every((sourceText) =>
    !sourceText.includes(`"${entry.message}"`) && !sourceText.includes(`'${entry.message}'`));
}), "first run and Help do not duplicate catalogue-owned English copy");

const { compactRelativeAge } = await import("../js/lib/relative-time.js");
const {
  listLabelMeta, listPanelCopy, listRecurrenceOptionLabel, listSelectionSummary,
  listShortActionLabel, listSnoozePresetLabel, listSortLabel, listUnit
} = await import("../js/ui/list-copy.js");
check(compactRelativeAge(10_000_000 - 10 * 60_000, 10_000_000) === "10m ago" &&
  compactRelativeAge(10_000_000 - 2 * 60 * 60_000, 10_000_000) === "2h ago",
"shared list age copy uses the same localized compact-time boundary as Search");
check(listSelectionSummary(0, 0) === "0 selected" &&
  listSelectionSummary(1, 1) === "1 tab selected" &&
  listSelectionSummary(5, 2) === "5 tabs selected (across 2 items)",
"shared list selection copy resolves zero, singular, and cross-card states through the catalogue");
check(listUnit("window", 2) === "2 windows" && listUnit("place", 1) === "1 place" &&
  listLabelMeta(3, 2) === "3 tabs · 2 places",
"shared list count and metadata copy uses localized units rather than concatenated English");
check(listShortActionLabel("archive", "fallback") === "Archive" &&
  listPanelCopy("organization-label").title === "Label groups" &&
  listSnoozePresetLabel("next-week") === "next week" &&
  listRecurrenceOptionLabel("weekly") === "Weekly" && listSortLabel("domain") === "Domain",
"shared row actions, panels, Snooze presets, and recurrence labels resolve through one presentation module");

const shellCopyTargets = ["js/ui/dashboard.js", "js/ui/sidepanel.js"];
const shellSources = shellCopyTargets.map((file) => read(file)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, ""));
check(shellSources.every((source) => source.includes('from "./shell-copy.js"')) &&
  !shellSources[0].includes("SECTION_INTROS") && !shellSources[0].includes("SECTION_TITLES"),
"Dashboard and side-panel chrome share one localized section and navigation presentation module");
check([...shellCopyTargets, "js/ui/popup.js"].every((file) =>
  read(file).includes("applyDocumentLocale();")) &&
  read("js/ui/newtab-entry.js").includes('msg("newtab_title")'),
"Dashboard, side panel, popup, and the New Tab entry publish localized document identity");
const popupSource = read("js/ui/popup.js")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");
const popupKeys = Object.keys(messages).filter((key) => key.startsWith("popup_"));
check(popupKeys.every((key) => {
  const entry = messages[key];
  if (entry.placeholders || entry.message.length < 5) return true;
  return !popupSource.includes(`"${entry.message}"`) && !popupSource.includes(`'${entry.message}'`);
}), "the toolbar popup no longer duplicates catalogue-owned English copy");

const {
  shellMoreSelected, shellNavName, shellSectionCountTitle, shellSectionIntro,
  shellSectionTitle, shellSidebarToggleLabel, shellStatic
} = await import("../js/ui/shell-copy.js");
check(shellSectionTitle("open") === "Open tabs" &&
  shellSectionIntro("archive") === "Long-term storage. Searchable forever, deleted never." &&
  shellSectionCountTitle("snoozed", 3) === "Snoozed (3)" &&
  shellNavName("Inbox", 24) === "Inbox, 24" &&
  shellSidebarToggleLabel(true) === "Expand navigation" &&
  shellMoreSelected("snoozed") === "More sections, Snoozed selected",
"shell copy resolves stable section ids, counts, and control states through the catalogue");
check(shellStatic.brand() === "EveryTab",
"the product shell uses the compact brand rather than Chrome's Store listing name");

const {
  customSchemeSettingsCopy, settingsDurationLabel, settingsExceptionDescription,
  settingsFavoriteAria, settingsFavoritesSummary, settingsGroupTitle, settingsInvalidSite,
  settingsOptions, settingsRowCopy, settingsSchemeGroupLabel, settingsStatic
} = await import("../js/ui/settings-copy.js");
check(settingsGroupTitle("appearance") === "Appearance" &&
  settingsRowCopy("colorScheme", [36]).description ===
    "36 built-in palettes plus yours, synced through your vault" &&
  settingsOptions("rotation").map(([value]) => value).join(",") === "off,open,hourly,daily",
"Settings resolves stable group, row, and option ids through one presentation module");
check(settingsDurationLabel(45) === "45 min" && settingsDurationLabel(360, "auto") === "6 hours" &&
  settingsFavoritesSummary(0, 36) === "All 36 schemes" &&
  settingsSchemeGroupLabel("dark", "vivid") === "Dark default · Vivid",
"Settings duration, favorites, and scheme-category grammar is localized without changing stored values");
check(settingsInvalidSite("wildcard") === "Remove the star. A rule already covers subdomains." &&
  settingsExceptionDescription("pause") === "Wait 15 seconds before the timed access choices appear." &&
  settingsFavoriteAria(true, "Ink") === "Remove Ink from rotation favorites",
"Settings validation, dynamic descriptions, and accessible actions resolve through the catalogue");
check(settingsStatic.siteDuplicate("example.com") === "example.com is already on your list." &&
  settingsStatic.openHelp() === "Open Help" &&
  customSchemeSettingsCopy.unsaved("Evening") === "Evening has unsaved changes.",
"Settings preserves user-provided domains and scheme names through localized placeholders");

const settingsSources = ["js/ui/settings-form.js", "js/ui/custom-schemes-settings.js", "js/ui/options.js"]
  .map((file) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""));
check(settingsSources[0].includes('from "./settings-copy.js"') &&
  settingsSources[1].includes('from "./settings-copy.js"') &&
  settingsSources[2].includes("applyDocumentLocale();") &&
  read("js/ui/dashboard.js").includes('from "./settings-copy.js"') &&
  read("js/ui/dashboard.js").includes("settingsSchemeGroupLabel(group.defaultMode, group.tone)") &&
  settingsSources[0].includes('group("appearance"') &&
  !settingsSources[0].includes('title.toLowerCase().replace('),
"Settings uses one localized presentation seam, stable group ids, and localized document identity");
check(!settingsSources[0].includes('"Filter settings…"') &&
  !settingsSources[0].includes('"No settings match that."') &&
  !settingsSources[1].includes('"No custom schemes yet.') &&
  !read("js/ui/history-access.js").includes('"Allow browser History"'),
"Settings, custom schemes, and the History disclosure do not duplicate catalogue-owned English copy");

const {
  popupCloseDuplicates, popupDueToday, popupFocusSummary, popupGuardedSites,
  popupLabeledWith, popupSavedSession, popupStatusSummary, popupStatic
} = await import("../js/ui/popup-copy.js");
check(popupStatic.thisTab() === "This tab" && popupStatic.saveWindowInbox() === "Save window to Inbox" &&
  popupStatusSummary(52, 4) === "52 tabs · 4 windows" && popupDueToday(1) === "1 due today" &&
  popupCloseDuplicates(5) === "Close 5 duplicate tabs" &&
  popupSavedSession("Research") === "Saved: Research." &&
  popupLabeledWith(["Work", "Research"]) === "Labeled with “Work” and “Research”." &&
  popupFocusSummary("32m left", popupGuardedSites(4)) === "32m left · 4 sites guarded",
"popup headings, count grammar, outcomes, labels, and Focus summary resolve through one presentation module");

if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log(`PASS ${failures.length ? 0 : Object.keys(messages).length + 38}: English catalogue, Focus/system/Search/list/shell/popup/Settings extraction, Intl, and pseudo-expansion`);
