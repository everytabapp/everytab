import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(path.join(root, name), "utf8");
let failures = 0;
const check = (condition, name) => {
  if (condition) console.log(`  ok: ${name}`);
  else { console.error(`FAIL: ${name}`); failures += 1; }
};

const dashboard = read("js/ui/dashboard.js");
const dataSurface = read("js/ui/data-surface.js");
const focusStrip = read("js/ui/focus-strip.js");
const dashboardCss = read("css/dashboard.css");
const sidepanelCss = read("css/sidepanel.css");
const tablist = read("js/ui/tablist.js");
const openSurface = read("js/ui/open-surface.js");
const tabFilterControl = read("js/ui/tab-filter-control.js");
const primitives = read("css/primitives.css");
const popupHtml = read("popup.html");
const popup = read("js/ui/popup.js");
const listConfigs = read("js/ui/list-configs.js");
const theme = read("js/ui/theme.js");
const boot = read("js/boot.js");
const newtabCss = read("css/newtab.css");
const newtab = read("js/ui/newtab.js");
const listHelpers = read("js/ui/list-helpers.js");
const icons = read("js/ui/icons.js");
const workflow = read("../.github/workflows/extension-cross-platform.yml");

check(!dashboard.includes("g.style.scrollMarginTop"),
  "Focus jump preserves the complete shared sticky offset");
check(/\.hero-focus\s*\{[^}]*inline-size:\s*142px/s.test(dashboardCss),
  "Focus utility reserves one stable width across Setup, Start, and End");
check(/\.hero-focus\s*\{[^}]*block-size:\s*42px/s.test(dashboardCss) &&
  /\.hero-focus-action, \.hero-focus-settings\s*\{[^}]*block-size:\s*40px[^}]*line-height:\s*1/s.test(dashboardCss),
  "Focus owns one exact vertical geometry in every interface style");
check(tablist.includes('"label-session": "labels"') &&
  !tablist.includes('? "×" : "•"'),
  "every Session action resolves to a registered icon, never a dot fallback");
check(openSurface.includes('localeMessage("list_gather_help")'),
  "Gather explains its cross-window move in plain English");
check(/\.driftrow\s*\{[^}]*margin:\s*0[^}]*border-radius:\s*0/s.test(dashboardCss) &&
  /\[data-compact\] \.driftrow[^}]*margin:\s*0[^}]*border-radius:\s*0/s.test(sidepanelCss),
  "Session update is a square connected header band in wide and compact lists");
check(!theme.includes('location.pathname.endsWith("/popup.html")') &&
  !theme.includes('location.pathname.endsWith("/sidepanel.html")'),
  "Popup and side panel paint the current scheme without consuming a rotation draw");
check(primitives.includes('select:not([multiple])') && primitives.includes("appearance: none"),
  "one shared native-select arrow contract owns alignment");
check(!popupHtml.includes(".search-field { padding-left: 8px; box-shadow: none; }") &&
  !/\.search-results\s*\{[^}]*border-radius:\s*var\(--r-btn\)/s.test(popupHtml),
  "Popup Search keeps the shared full-boundary material and structural radius");
check(/\.search-box:has\(\.search-results:not\(:empty\)\)/.test(primitives),
  "Search highlights the complete field plus results boundary");
check(listConfigs.includes("restoreBeforeCommit: true") &&
  listConfigs.includes("ctx.group.data.name = clean") &&
  listConfigs.includes("title.textContent = clean") &&
  listConfigs.includes('localeMessage("list_session_rename_failed")') &&
  listConfigs.indexOf("title.textContent = clean") < listConfigs.indexOf("await renameSession"),
  "Session rename updates visible state before the Vault-backed commit settles");
check(workflow.includes("ubuntu-latest") && workflow.includes("windows-latest") &&
  workflow.includes("macos-15-intel") &&
  workflow.includes("node tools/test.mjs --lane portable --ci") &&
  workflow.includes("node tools/test.mjs --lane browser --ci"),
  "Windows, macOS, and Linux run portable plus installed Chrome gates in CI");
check(newtabCss.includes(".minimal-horizon") &&
  /\.minimal-horizon #app\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\) auto/s.test(newtabCss) &&
  /\.minimal-clock\s*\{[^}]*container:\s*minimal-clock-space\s*\/\s*size/s.test(newtabCss) &&
  /\.minimal-horizon \.clock\s*\{[^}]*clamp\(176px,\s*min\(35vw,\s*90cqh\),\s*760px\)/s.test(newtabCss) &&
  /\.minimal-horizon \.date\s*\{[^}]*position:\s*static/s.test(newtabCss) &&
  newtab.includes('class: "minimal-clock"') &&
  newtab.includes('class: "minimal-deck"') &&
  newtab.includes("listStarred") && newtab.includes('type: "activate-starred"'),
  "Minimal mode promotes Horizon with the date below its atmospheric clock and a real Starred command deck");
check(tablist.includes('class: "pinned-state"') && tablist.includes('msg("list_pinned_tab")') &&
  tablist.includes('msg("list_pinned_tab") }, msg("list_pinned")') &&
  !tablist.includes('icon("pin", 12), "Pinned"'),
  "pinned tabs name the browser state without an ambiguous metadata glyph");
check(popup.includes("buildSharedSnoozePanel") && popup.includes("buildSortChoices(doSort)") &&
  listHelpers.includes("export function buildSortChoices"),
  "Popup reuses the shared Snooze and Sort menu builders");
check(dashboard.includes('class: "navlabel" }, shellStatic.now()') &&
  dashboard.includes('class: "navlabel" }, shellStatic.saved()') &&
  dashboard.includes('class: "navlabel" }, shellStatic.more()'),
  "sidebar navigation uses the simpler Now, Saved, and More hierarchy");
check(!dataSurface.includes("buildOneTabExport") &&
  dataSurface.includes("dataStatic.backupHeading()") &&
  dataSurface.includes("dataStatic.restoreHeading()") &&
  dataSurface.includes("data-interoperability"),
  "Data uses Settings-style Backup/Restore groups and retires OneTab export");
check(/\.nav-collapse\s*\{[^}]*margin-left:\s*auto[^}]*width:\s*30px[^}]*background:\s*transparent/s.test(dashboardCss) &&
  dashboard.includes('icon(sidebarCollapsed ? "navexpand" : "navcollapse"') &&
  icons.includes('width="6" height="17" rx="1.6" fill="currentColor" stroke="none" opacity=".18"') &&
  icons.includes('<path d="m16 9-3 3 3 3"/>') &&
  icons.includes('<path d="m13 9 3 3-3 3"/>'),
  "sidebar collapse uses the selected fixed-footprint filled-column glyph in both directions");
check(/\.gear\s*\{[^}]*width:\s*30px[^}]*height:\s*30px/s.test(dashboardCss),
  "Settings and Color scheme share one aligned sidebar utility slot");
check(primitives.includes(".focus-strip-layout") &&
  primitives.includes("@property --focus-layout-h") &&
  primitives.includes("block-size: var(--focus-layout-h)") &&
  !primitives.includes("focus-strip-content-enter") &&
  !primitives.includes("focus-strip-surface-enter") &&
  !primitives.includes("focus-strip-content-exit") &&
  !primitives.includes("focus-strip-surface-exit") &&
  !primitives.includes("focus-strip-edge-cue") &&
  dashboardCss.includes(".hero-focus-action::before") &&
  dashboardCss.includes("transform var(--motion-continuity)") &&
  focusStrip.includes('style.setProperty("--focus-layout-h"') &&
  dashboard.includes("aria-busy") &&
  !dashboard.includes("focusPrimary.disabled"),
  "Focus uses a fixed-size icon/sweep control plus copy that is present from the start of one rail-free layout reveal");
check(focusStrip.includes('classList.add("focus-layout-transition")') &&
  focusStrip.includes("const beforeTop = follower?.getBoundingClientRect().top") &&
  focusStrip.includes("const targetHeight = open ? layoutInner.getBoundingClientRect().height : 0") &&
  focusStrip.includes("layoutInner.animate([") &&
  focusStrip.includes('style.setProperty("--focus-layout-h"') &&
  /html\.focus-layout-transition\s*\{[^}]*overflow-anchor:\s*none/s.test(primitives) &&
  !dashboard.includes("animateFocusLayout(") &&
  !dashboardCss.includes("--focus-sticky-shift"),
  "Focus publishes settled sticky geometry once and reveals its complete material with a following-surface FLIP");
check(focusStrip.includes("transitionLayout(false, () =>") &&
  !focusStrip.includes("await transitionLayout(") &&
  focusStrip.includes("strip.inert = true") &&
  focusStrip.includes("if (finishLayout !== finish) return") &&
  focusStrip.includes('strip.classList.add("focus-exit")') &&
  !primitives.includes("focus-strip-content-exit") &&
  !primitives.includes("focus-strip-surface-exit") &&
  !primitives.includes("focus-strip-edge-exit") &&
  !primitives.includes("focus-strip-dematerialize") &&
  !dashboard.includes("animateFocusLayout(") &&
  !dashboard.includes("dailyStage.animate") &&
  !dashboard.includes("upper?.animate"),
  "Focus exit retains inert copy until settlement, allows interruption and leaves Search ancestors untransformed");
check(tablist.includes("headerBulkGroupId") && tablist.includes("header-bulk-actions") &&
  tablist.includes("updateHeaderLaneAvailability") &&
  /\.tablist \.header-bulk-actions\s*\{/.test(read("css/tablist-d4.css")) &&
  /\.tablist\.has-multiple-selection \.item-head > \.gacts:not\(\.header-bulk-actions\)\s*\{/.test(read("css/tablist-d4.css")),
  "one-card actions stay local while cross-card selection keeps stable header geometry and uses the dock");
check(popup.includes("findDuplicateGroupsFromTabs(allTabs") &&
  popup.includes("publish one useful popup state after the independent reads settle"),
  "Popup derives duplicates from its first tab snapshot and publishes one useful state");
check(!boot.includes("canUsePrepared = location.pathname.endsWith(\"/popup.html\")") &&
  theme.includes("const canRotateOnOpen = isNewTabOverride"),
  "only New Tab consumes On-open rotation; utility surfaces never flash a new draw");
check(theme.includes('readFreshStoreMaps([') &&
  theme.includes('"settingsModifiedAt"') &&
  theme.includes("cacheSnapshotIsOlder(cache, readThemeCache())"),
  "theme pre-paint cache uses one atomic snapshot and rejects older cross-context writes");
check(/\.tablist\[data-compact\] \.tacts button,[\s\S]*\.tablist\[data-compact\] \.gacts button \{[\s\S]*width:\s*var\(--control-h-compact\)/.test(read("css/tablist-d4.css")),
  "compact Suspend and Wake actions keep one profile-independent square slot");
check(openSurface.includes('placeholder: localeMessage("list_filter_tabs_placeholder")') &&
  tabFilterControl.includes('class: "open-filter-control"') &&
  openSurface.includes('empty: query ? localeMessage("list_open_filter_empty")') &&
  openSurface.includes("groups = filterOpenGroups(allGroups, query)"),
  "Open owns one lightweight title-or-URL scanner with truthful empty copy");
check(popupHtml.includes("html, body { width: 400px; height: 600px; max-height: 600px; overflow: hidden; }") &&
  popupHtml.includes("body.popup-fit-compact .group { padding-block: 9px; }") &&
  popupHtml.includes("body:not(.popup-ready) #app > :not(.search-box) { visibility: hidden; }") &&
  /\.linkrow \{[^}]*position: sticky;[^}]*bottom: 0/s.test(popupHtml) &&
  popup.includes('document.body.classList.add("popup-ready")') &&
  popup.includes("function fitPopupHeight()"),
  "Popup sizes to Chrome's available height, compacts ordinary whitespace before scrolling, and keeps its destinations visible");
check(!dashboard.includes('makeSec("smartviews")') &&
  read("js/lib/portable-state-registry.js").includes("key: STORE_KEYS.smartviews"),
  "Smart Views are retired from use without deleting portable pre-release records");
check(dashboard.includes("SCHEME_GROUPS.map") &&
  read("js/ui/settings-form.js").includes("...SCHEME_GROUPS.map") &&
  read("js/lib/schemes.js").includes('id: "light-soft"') &&
  read("js/lib/schemes.js").includes('id: "dark-vivid"'),
  "both scheme selectors share one Light/Dark default × Soft/Vivid matrix");

const { filterOpenGroups } = await import("../js/ui/open-surface.js");
const openFixture = [{ id: "w1", refs: [
  { title: "Project plan", url: "https://docs.example/plan", labels: ["work", "urgent"] },
  { title: "Mail", url: "https://mail.example/inbox", labels: ["work"] }
], live: [{ tabId: 1 }, { tabId: 2 }] }];
const filteredOpen = filterOpenGroups(openFixture, "MAIL.EXAMPLE");
check(filteredOpen.length === 1 && filteredOpen[0].refs[0].title === "Mail" &&
  filteredOpen[0].live[0].tabId === 2 && openFixture[0].refs.length === 2,
  "Open filtering is case-insensitive, index-aligned, and non-mutating");
const noLocalGrammar = filterOpenGroups(openFixture, "label:work");
check(noLocalGrammar.length === 0,
  "Open remains a lightweight title-or-URL scanner; label facets belong to Search and Labels");

const { createChromeI18nMock } = await import("./message-fixture.mjs");
globalThis.chrome = { ...(globalThis.chrome ?? {}), i18n: createChromeI18nMock() };
const { attentionItems } = await import("../js/ui/command-box.js");
const now = Date.UTC(2026, 7, 18, 12);
const expiry = attentionItems({
  inboxExpiryDays: 30,
  inboxItems: [{ id: "near", createdAt: now - 29.5 * 86400_000, modifiedAt: now }]
}, now)[0];
check(expiry?.id === "inbox-expiry" && expiry.label.includes("12h"),
  "Needs you warns from saved age even after later Inbox edits");

if (failures) process.exit(1);
console.log("\nAll pre-localization polish contracts passed");
