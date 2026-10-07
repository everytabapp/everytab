import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(path.join(root, name), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const messagesSource = read("_locales/en/messages.json");
const messages = JSON.parse(messagesSource);
const failures = [];
const check = (condition, name) => {
  if (!condition) failures.push(name);
};

const topLevelMessageKeys = [...messagesSource.matchAll(/^ {2}"([^"]+)":/gm)]
  .map((match) => match[1]);
check(new Set(topLevelMessageKeys).size === topLevelMessageKeys.length,
  "the English catalogue contains no duplicate top-level message keys");

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
  formatTimeParts, pluralCategory, uiLocale
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
check(formatTimeParts(new Date("2026-09-12T21:41:00Z"), {
  locale: "en-US", timeZone: "UTC", hour: "2-digit", minute: "2-digit"
}).some((part) => part.type === "dayPeriod" && part.value === "PM"),
"time parts preserve the locale day period for responsive presentation");
check(formatRelativeTime(-2, "day", { locale: "en" }) === "2 days ago" &&
  pluralCategory(1, { locale: "en" }) === "one" &&
  pluralCategory(2, { locale: "en" }) === "other",
"relative time and plural selection use Intl rather than English concatenation");
check(formatList(["“Work”", "“Research”"], { locale: "en" }) === "“Work” and “Research”",
  "list formatting is locale-aware rather than comma-concatenated English");

const { pseudoExpand } = await import("../../tools/pseudo-locale.mjs");
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
// Maintained developer diagnostics are part of the shipped copy catalogue
// contract even though they now live outside extension/js.
collectJs(path.join(root, "../tools/diagnostics"));
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
    for (const match of source.matchAll(/["']((?:activity|attention)_[a-z0-9_]+)["']/g)) {
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
const deadKeys = Object.keys(messages).filter((key) => !referenced.has(key));
check(deadKeys.length === 0,
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
    "Session · 3 windows · 18 tabs" &&
  searchResultMeta({ type: "session-entity", windowCount: 3, tabCount: 18 }, {
    context: "omnibox"
  }) === "3 windows · 18 tabs" &&
  searchResultMeta({ type: "label-group-entity", memberCount: 5 }) ===
    "Label group · 5 labels",
"Search outcomes identify named Sessions while keeping compact omnibox metadata");
check(searchCount("result", 1) === "1 result" &&
  searchCount("result", 6) === "6 results" &&
  searchCount("recent", 6, { announcement: true }) === "6 recent tabs.",
"Search counts use catalogue-backed singular, plural, and live-announcement copy");

const {
  HELP_GROUPS, HELP_TOPICS, ONBOARDING_PAGES, SECTION_TO_PAGE,
  helpTopicId, onboardingStatic, onboardingStepId
} = await import("../js/lib/onboarding-copy.js");
check(ONBOARDING_PAGES.map((page) => page.id).join(",") === "local,find,save,newtab,scheme,data" &&
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
  "js/lib/onboarding-copy.js", "js/ui/onboarding.js", "js/ui/onboarding-choices.js", "js/ui/new-tab-choices.js"
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
  read("js/ui/newtab-entry.js").includes('msg("newtab_title")') &&
  read("js/ui/suspend-page.js").includes("applyDocumentLocale();") &&
  !/Suspended by EveryTab|>Wake up<|>Suspended tab</.test(read("suspend.html")),
"Dashboard, side panel, popup, New Tab, and Suspend publish localized document identity");
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
  settingsApplySchemeAria, settingsFavoriteAria, settingsFavoritesSummary, settingsGroupTitle, settingsInvalidSite,
  settingsOptions, settingsRowCopy, settingsSchemeGroupLabel, settingsStatic
} = await import("../js/ui/settings-copy.js");
check(settingsGroupTitle("appearance") === "Appearance" &&
  settingsRowCopy("colorScheme", [36]).description ===
    "36 built-in palettes plus yours, synced through your vault" &&
  settingsOptions("rotation").map(([value]) => value).join(",") === "off,open,hourly,daily",
"Settings resolves stable group, row, and option ids through one presentation module");
check(settingsDurationLabel(45) === "45 min" && settingsDurationLabel(360, "auto") === "6 hours" &&
  settingsFavoritesSummary(0, 36) === "Color schemes" &&
  settingsSchemeGroupLabel("dark", "vivid") === "Dark default · Vivid",
"Settings duration, favorites, and scheme-category grammar is localized without changing stored values");
check(settingsInvalidSite("wildcard") === "Remove the star. A rule already covers subdomains." &&
  settingsExceptionDescription("pause") === "Wait 15 seconds before the timed access choices appear." &&
  settingsFavoriteAria(true, "Ink") === "Remove Ink from rotation favorites" &&
  settingsApplySchemeAria(false, "Ink") === "Use Ink color scheme",
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

const {
  importFormatLabel, importFormatOptions, importJournalDescription
} = await import("../js/lib/import-copy.js");
check(importFormatLabel("everytab-markdown") === "EveryTab Markdown" &&
  importFormatLabel("unknown-format") === "another tab export" &&
  importFormatOptions().map(({ id }) => id).join(",") ===
    "everytab-markdown,onetab,session-buddy,tab-session-manager,toby,raindrop-csv,bookmarks-html" &&
  importJournalDescription(1, "onetab") === "Imported 1 tab from OneTab" &&
  importJournalDescription(4, "session-buddy") === "Imported 4 tabs from Session Buddy",
"import presentation localizes format names and Journal grammar without changing format ids");

const {
  dataRecentlyClosedAction, dataRecentlyClosedResult, dataSnapshotAction,
  dataSnapshotResult, dataStatic
} = await import("../js/ui/data-copy.js");
check(dataStatic.downloadBackup() === "Download backup" &&
  dataStatic.checkRecentlyClosed() === "Check recently closed" &&
  dataRecentlyClosedAction(1) === "Recover 1 tab" &&
  dataRecentlyClosedAction(3) === "Recover 3 tabs" &&
  dataSnapshotAction(1) === "Recover 1 missing tab" &&
  dataSnapshotAction(3) === "Recover 3 missing tabs",
"Data actions resolve static and plural copy through one presentation module");
check(dataRecentlyClosedResult({ restored: 2, failed: 1, unavailable: 3 }) ===
    "2 recovered, 1 failed, and 3 no longer available" &&
  dataSnapshotResult({ restored: 2, windows: 1, failed: 0, unavailable: 1 }) ===
    "2 recovered in 1 new window and 1 already open or no longer available",
"Data recovery outcomes use localized list and count grammar");
check(dataSnapshotResult({ uncertain: 2 }) ===
    "2 tab openings could not be confirmed. Check open tabs before retrying" &&
  dataSnapshotResult({ restored: 2, windows: 1, degraded: 1 }).includes(
    "1 window opened, but some saved settings could not be applied"),
"Snapshot recovery exposes unconfirmed opens and incomplete setup without erasing confirmed counts");
const dataSource = read("js/ui/data-surface.js")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");
check(dataSource.includes('from "./data-copy.js"') &&
  !dataSource.includes('"Download backup"') &&
  !dataSource.includes('"Checking local automatic snapshots..."') &&
  !dataSource.includes('"Import shared tabs or another tab tool"') &&
  !read("js/lib/import-formats.js").includes("FORMAT_LABELS"),
"Data and import parsing no longer duplicate catalogue-owned English presentation");
const dataCopyTargets = [
  "js/lib/import-copy.js", "js/lib/import-formats.js", "js/lib/import-commit.js",
  "js/ui/data-copy.js", "js/ui/data-surface.js"
];
const strippedDataSources = dataCopyTargets.map((file) => read(file)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, ""));
const dataKeys = Object.keys(messages).filter((key) =>
  key.startsWith("data_") || key.startsWith("import_format_") ||
  key.startsWith("import_journal_") || key === "import_default_session");
check(dataKeys.every((key) => {
  const entry = messages[key];
  if (entry.placeholders || entry.message.length < 5) return true;
  return strippedDataSources.every((source) => !source.includes(`"${entry.message}"`) &&
    !source.includes(`'${entry.message}'`) && !source.includes(`>${entry.message}<`));
}), "the extracted Data and import slice does not duplicate catalogue-owned English copy");

const {
  vaultLastSyncText, vaultPillState, vaultProgressText, vaultRestorePointLabel,
  vaultRestoreDeltaRows, vaultRestoreProgressText, vaultRestoreStatic,
  vaultRestoreSummary, vaultStatic, vaultSyncAction, vaultSyncFailureReason, vaultFailureBanner,
  vaultStatusBadge
} = await import("../js/ui/vault-copy.js");
check(vaultPillState({ state: "connected" }, null, true).text === "syncing…" &&
  vaultPillState({ state: "needs-permission" }, null, false).text === "vault: reconnect" &&
  vaultSyncAction({ restarting: false, busy: false, stalled: false }) === "Sync now" &&
  vaultSyncAction({ restarting: false, busy: false, stalled: true }) === "Restart sync",
"Vault pills and actions resolve through one presentation module");
check(vaultProgressText({ stage: "scanning", target: "assets", completed: 245 }) ===
    "Scanning favicons… 200+ files found" &&
  vaultProgressText({ stage: "reading", target: "sessions", completed: 18, total: 40 }) ===
    "Syncing Sessions… 18 of 40" &&
  vaultProgressText({}, true) === "Syncing in another EveryTab tab…",
"Vault progress localizes target names and bounded numerical progress");
check(vaultProgressText({ stage: "starting" }, false, 2_400) ===
    "Starting Vault sync… (2 seconds elapsed)" &&
  vaultProgressText({ stage: "reading", target: "sessions", completed: 18, total: 40 },
    false, 1_200) === "Syncing Sessions… 18 of 40 (1 second elapsed)",
"Vault progress visibly advances even when a phase has no countable work");
check(vaultLastSyncText({
  ok: true, lastSyncAt: Date.now(), pulled: 2, pushed: 3, conflictCopies: 1, backedUp: true
}).startsWith("Last sync just now: pulled 2, pushed 3, merged 1 conflict copy, backup written") &&
  vaultStatic.description().startsWith("Plain JSON in a folder you own."),
"Vault outcomes and product explanation resolve through the catalogue");
const privateReceipt = { ok: false, lastSyncAt: Date.now(),
  error: "private fixture payload", errorClass: "name:TypeError" };
check(vaultFailureBanner(vaultSyncFailureReason(privateReceipt)) === vaultStatic.defaultFailureBanner() &&
  vaultLastSyncText(privateReceipt).includes(vaultStatic.unknownError()) &&
  !vaultLastSyncText(privateReceipt).includes(privateReceipt.error) &&
  !vaultLastSyncText(privateReceipt).includes(privateReceipt.errorClass),
"classified Vault receipts use localized failure copy without diagnostic tokens or stored payloads");
check(vaultStatusBadge({ state: "error", message: "Vault sync failed", errorClass: "name:TypeError" }).text ===
  `error: ${vaultStatic.unknownError()}` &&
  vaultStatusBadge({ state: "error", message: "Historical reason" }).text === "error: Historical reason",
"classified Vault status badges use localized copy while legacy statuses keep their reason");
check(vaultSyncFailureReason({ ...privateReceipt, failureCode: "timeout" }) ===
  "Vault sync stopped because the folder did not respond." &&
  vaultLastSyncText({ ...privateReceipt, failureCode: "timeout" }).includes("Restart sync") &&
  vaultSyncFailureReason({ ok: false, error: "Historical reason" }) === "Historical reason",
"classified timeout receipts retain restart guidance while historical receipts keep their text");
check(vaultRestoreStatic.heading() === "Restore from Vault" &&
  vaultRestoreStatic.reviewPoint() === "Review Restore point" &&
  vaultRestorePointLabel("2026-09-06") === "Sep 6, 2026",
"Vault Restore headings, actions, and dates resolve through the presentation module");
check(vaultRestoreSummary({
  added: 2, updated: 1, removed: 0,
  targetFamilies: { inbox: 2, sessions: 1 }
}) === "2 in Inbox and 1 in Sessions. 2 added and 1 replaced.",
"Vault Restore summaries use localized lists, counts, and target names");
check(vaultRestoreProgressText({ completed: 37, total: 120 }) ===
  "Checking Restore point… 37 of 120 records" &&
  vaultRestoreProgressText({ completed: 38, total: 120 }) ===
  "Checking Restore point… 38 of 120 records",
"Vault Restore verification exposes changing completed and total record progress");
const restoreDeltaRows = vaultRestoreDeltaRows({
  limit: 3,
  changes: [
    { kind: "added", family: "inbox", title: "One", host: "one.example" },
    { kind: "updated", family: "sessions", title: "Two", host: "two.example" },
    { kind: "removed", family: "archive", title: "Three", host: "three.example" },
    { kind: "added", family: "inbox", title: "Four", host: "four.example" },
    { kind: "removed", family: "labels", title: "Five", host: "five.example" }
  ]
});
check(restoreDeltaRows.rows.length === 3 &&
  restoreDeltaRows.rows[0] === "Added to Inbox: One · one.example" &&
  restoreDeltaRows.rows[1] === "Replaced in Sessions: Two · two.example" &&
  restoreDeltaRows.rows[2] === "Removed from Archive: Three · three.example" &&
  restoreDeltaRows.remainingText === "2 more changes",
"Vault Restore review identifies a bounded delta and reports omitted changes");
const vaultSource = read("js/ui/vault-surface.js")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");
check(vaultSource.includes('from "./vault-copy.js"') &&
  vaultSource.includes("onProgress: reportRestoreProgress") &&
  vaultSource.includes("vaultRestoreDeltaRows") &&
  /function reportRestoreProgress\(next\) \{[\s\S]*?restoreMessageNode\.textContent = restoreMessage;\n  \}/.test(vaultSource) &&
  !vaultSource.includes('"Syncing in another EveryTab tab…"') &&
  !vaultSource.includes('"Plain JSON in a folder you own.') &&
  !vaultSource.includes('"Sync now"') &&
  !vaultSource.includes('"Restore from Vault"') &&
  !vaultSource.includes('"Checking the complete Restore point…"'),
"Vault status and progress no longer duplicate catalogue-owned English presentation");
const strippedVaultSources = ["js/ui/vault-copy.js", "js/ui/vault-surface.js"].map((file) =>
  read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""));
const vaultKeys = Object.keys(messages).filter((key) => key.startsWith("vault_"));
const stableVaultGrammar = new Set(["Vault"]);
check(vaultKeys.every((key) => {
  const entry = messages[key];
  if (entry.placeholders || entry.message.length < 5 || stableVaultGrammar.has(entry.message)) {
    return true;
  }
  return strippedVaultSources.every((source) => !source.includes(`"${entry.message}"`) &&
    !source.includes(`'${entry.message}'`) && !source.includes(`>${entry.message}<`));
}), "the extracted Vault status slice does not duplicate catalogue-owned English copy");

const {
  themeRotationDiagnosticEvidence, themeRotationDiagnosticStatic,
  themeRotationDiagnosticSummary, themeRotationDiagnosticWatching
} = await import("../../tools/diagnostics/theme-rotation-diagnostics-copy.js");
check(themeRotationDiagnosticStatic.title() === "Troubleshoot theme rotation" &&
  themeRotationDiagnosticStatic.run() === "Run one New Tab check" &&
  themeRotationDiagnosticWatching(4) ===
    "Watching for the rotation and any later settings writer… 4 seconds remaining",
"theme-rotation diagnostic controls and progress resolve through one presentation module");
check(themeRotationDiagnosticSummary("rotation-reverted", { revertSource: "vault" }) ===
    "The rotation committed a new scheme, then Vault restored a different selection." &&
  themeRotationDiagnosticEvidence("post-commit-vault-change") ===
    "A Vault update followed the rotation",
"theme-rotation verdicts and evidence resolve stable ids through catalogue copy");
const rotationDiagnosticSource = read("../tools/diagnostics/theme-rotation-diagnostics.js")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");
check(rotationDiagnosticSource.includes('from "./theme-rotation-diagnostics-copy.js"') &&
  !rotationDiagnosticSource.includes('"Troubleshoot theme rotation"') &&
  !rotationDiagnosticSource.includes('"Run one New Tab check"') &&
  !read("../tools/diagnostics/scheme-rotation-diagnostics.js").includes(
    '"The rotation committed a new scheme and the current state still matches it."'),
"theme-rotation diagnostics do not retain a second raw-English presentation path");
const strippedRotationDiagnosticSources = [
  "../tools/diagnostics/theme-rotation-diagnostics-copy.js", "../tools/diagnostics/theme-rotation-diagnostics.js",
  "../tools/diagnostics/scheme-rotation-diagnostics.js"
].map((file) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""));
const rotationDiagnosticKeys = Object.keys(messages).filter((key) =>
  key.startsWith("theme_rotation_diagnostic_"));
check(rotationDiagnosticKeys.every((key) => {
  const entry = messages[key];
  if (entry.placeholders || entry.message.length < 5) return true;
  return strippedRotationDiagnosticSources.every((source) =>
    !source.includes(`"${entry.message}"`) && !source.includes(`'${entry.message}'`) &&
    !source.includes(`>${entry.message}<`));
}), "the extracted theme-rotation diagnostic slice does not duplicate catalogue copy");


/*
 * Extraction guard for the Dashboard chrome, Activity, Duplicates, Needs you,
 * Starred, toast, shared inputs, Stats, Snapshots, and Snooze-wake slice.
 *
 * Two complementary checks. (1) Negative: no catalogue message owned by this
 * slice may reappear as a quoted literal in its modules, so a reverted
 * extraction fails. (2) Positive heuristic: every quoted or template literal
 * in those modules is scanned for English copy shapes, so NEW hardcoded copy
 * fails even before a catalogue entry exists. A literal counts as copy when it
 *   - starts with a capitalized word followed by more text or sentence
 *     punctuation ("Clear history", "Loading…", "Couldn't end Focus."), or
 *   - is a lowercase sentence ending in punctuation, or
 *   - is a spaced lowercase phrase containing an English function word
 *     ("you did this", "tabs open now", "changed later").
 * Literals that are the first argument of msg/localeMessage, a failure
 * diagnostic label, a console or performance mark, or an Error message are
 * skipped, as are CSS selectors and template strings carrying code.
 * Known blind spots: a single capitalized word ("Keep", "Rescan", "Off"), a
 * lowercase phrase with no function word ("kept copy", "vault syncs"), a
 * template that begins with a placeholder (`${n} shown`), copy assembled from
 * fragments, and text that reaches the DOM through innerHTML or a data file.
 * Persisted Journal labels (`makeJournalEntry("Woke 3 snoozed tabs")`) and the
 * Close-the-day planner's coverage labels look like copy but are stored
 * operational data the surfaces never render (Activity uses activityEntryLabel,
 * the review derives copy from coverage.kind), so library modules are only in
 * the negative check.
 * Those still need a reviewer; the heuristic lowers the floor, it is not proof.
 */
const extractedCopyTargets = [
  "js/ui/activity-surface.js", "js/ui/dashboard.js", "js/ui/duplicates-surface.js",
  "js/ui/command-box.js", "js/ui/sidepanel.js", "js/ui/toast.js", "js/ui/starred-button.js",
  "js/ui/labelinput.js", "js/ui/combobox.js", "js/ui/loading.js", "js/ui/snapshots-surface.js",
  "js/ui/stats-surface.js", "js/ui/theme.js", "js/lib/snooze-delivery.js", "js/lib/close-day-planner.js"
];
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const strippedExtractedSources = extractedCopyTargets.map((file) => stripComments(read(file)));
const extractedKeyPrefixes = [
  "activity_", "attention_", "starred_", "duplicate_", "stats_", "undo_", "toast_",
  "focus_action_", "focus_settings", "focus_end_failed", "focus_start_", "new_tab_notice_",
  "history_access_", "shell_loading_", "shell_skip_", "vault_pill_", "snapshot_",
  "notification_snooze_", "list_repeat_", "list_combobox_", "list_labels_", "list_remove_label_chip",
  "list_add_labels", "theme_missing_", "session_tab_groups_", "settings_scheme_catalogue_", "close_day_locked_"
];
const extractedKeys = Object.keys(messages).filter((key) =>
  extractedKeyPrefixes.some((prefix) => key.startsWith(prefix)));
// Stored Undo status enums are compared in code; their chip copy is identical.
const stableExtractedGrammar = new Set(["undone", "incomplete", "unavailable", "stale"]);
const duplicatedExtractedCopy = extractedKeys.filter((key) => {
  const entry = messages[key];
  if (entry.placeholders || entry.message.length < 5 || stableExtractedGrammar.has(entry.message)) return false;
  return strippedExtractedSources.some((source) => source.includes(`"${entry.message}"`) ||
    source.includes(`'${entry.message}'`) || source.includes(`\`${entry.message}\``) ||
    source.includes(`>${entry.message}<`));
});
check(duplicatedExtractedCopy.length === 0,
  `the extracted Dashboard/Activity/Duplicates/Needs you/Starred slice does not duplicate catalogue-owned English copy${
    duplicatedExtractedCopy.length ? ` (${duplicatedExtractedCopy.join(", ")})` : ""}`);

const ENGLISH_FUNCTION_WORDS =
  /(?:^|\s)(?:the|a|an|to|of|in|on|for|this|that|these|you|your|is|are|was|did|will|can|no|not|here|now|ago|later|shown|selected|every|only|all time)(?=\s|$|[.,!?…])/;
export function copyLikeLiterals(source) {
  const stripped = stripComments(source);
  const hits = [];
  for (const match of stripped.matchAll(/(["'\`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    // Template placeholders become a neutral token so `Undo ${label}` reads as copy
    // while code-bearing templates still fail the character filter below.
    const text = match[2].replace(/\$\{[^}]*\}/g, "X");
    const before = stripped.slice(Math.max(0, match.index - 48), match.index);
    if (/(?:\bmsg|\blocaleMessage|\breportFailure|\bconsole\.\w+|\bError|\bmark|\bperformance\.\w+|\bmeasure)\(\s*$/.test(before)) continue;
    if (/^[.#[]/.test(text) || /[{}();=<>]/.test(text)) continue;
    if (/^[A-Z][a-z’']+(?:\s+\S|[.!?…]$)/.test(text) ||
        /^(?:[a-z]+\s+)+[a-z]+[.!?…]$/.test(text) ||
        (/\s/.test(text) && /^[a-z]/.test(text) && ENGLISH_FUNCTION_WORDS.test(text))) {
      hits.push(match[2]);
    }
  }
  return hits;
}
// Library planners persist descriptive fields (Journal labels, Close-the-day
// coverage labels) that the surfaces never render; only UI modules get the scan.
const heuristicCopyTargets = extractedCopyTargets.filter((file) => file.startsWith("js/ui/"));
check(!/"(?:Incognito tabs|Audible tabs|EveryTab and extension pages)/.test(read("js/lib/close-day-planner.js")) &&
  read("js/ui/close-day-surface.js").includes("closeDayLockedReason(row.lockedReason)"),
"Close-the-day locked rows carry language-free planner codes that the review surface turns into catalogue copy");
const residualCopy = heuristicCopyTargets.flatMap((file) =>
  copyLikeLiterals(read(file)).map((text) => `${file}: ${JSON.stringify(text)}`));
check(residualCopy.length === 0,
  `the extracted slice carries no remaining English copy literals${
    residualCopy.length ? ` (${residualCopy.join("; ")})` : ""}`);
check(copyLikeLiterals('el("span", {}, "Actions you can undo will appear here.")').length === 1 &&
  copyLikeLiterals('el("span", {}, "you did this")').length === 1 &&
  copyLikeLiterals('showNotice("Couldn\'t end Focus.")').length === 1 &&
  copyLikeLiterals("el(\"b\", {}, `Undo ${label}`)").length === 1 &&
  copyLikeLiterals('el("div", { class: "banner hidden" }, localeMessage("undo_stale"))').length === 0 &&
  copyLikeLiterals('reportFailure("Side Panel refresh", error); throw new Error("Protection change rejected");').length === 0 &&
  copyLikeLiterals('if (key === "ArrowDown") root.querySelector(".tacts button:not([disabled])");').length === 0,
"the copy-literal heuristic flags sentences, attributions, templates, and failure notices while ignoring catalogue calls, diagnostics, classes, keys, and selectors");

if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  if (deadKeys.length) console.error(`DEAD KEYS: ${deadKeys.join(", ")}`);
  process.exit(1);
}
console.log(`PASS ${failures.length ? 0 : Object.keys(messages).length + 41}: English catalogue, Focus/system/Search/list/shell/popup/Settings extraction, Intl, and pseudo-expansion`);
