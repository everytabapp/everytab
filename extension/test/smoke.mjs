/**
 * M1 logic smoke tests — run with: node test/smoke.mjs (from extension/)
 * Mocks the chrome APIs the lib modules use; no browser needed.
 */
import { installSmokeChrome } from "./smoke-chrome.mjs";
import { createSmokeChecks } from "./smoke-checks.mjs";
import { runSmokeCopyPolicy } from "./smoke-copy-policy.mjs";
import { runSmokeThemeRotation } from "./smoke-theme-rotation.mjs";
import { runSmokeSearchPopup } from "./smoke-search-popup.mjs";
import { runSmokeSearchContracts } from "./smoke-search-contracts.mjs";
import { runSmokeFocus } from "./smoke-focus.mjs";
import { runSmokeDashboardContracts } from "./smoke-dashboard-contracts.mjs";
import { runSmokeListWorkflows } from "./smoke-list-workflows.mjs";
import { runSmokePresentationContracts } from "./smoke-presentation-contracts.mjs";
import { runSmokeSavedDataWorkflows } from "./smoke-saved-data-workflows.mjs";
import { runSmokeStorageConcurrency } from "./smoke-storage-concurrency.mjs";

const mem = {};
const sessionMem = {};
let createdWindows = [];
let removedTabIds = [];
let removedWindowIds = [];
let mockWindows = [];
let mockCurrentWindowId = null;

let alarms = {};
let createdTabs = [];
let updatedTabs = []; // N4c: in-place repairs are updates, not creations
let discardedTabs = [];
let notifications = [];
let badgeTexts = [];
let tabsMoveCalls = []; // F13: records chrome.tabs.move({ids, props}) calls
// F18: tab-groups + permissions mock state.
let mockTabGroups = {};        // groupId → {id, title?, color?, collapsed?}
let nextGroupId = 1;
let tabsGroupCalls = [];        // {tabIds, windowId, groupId} per chrome.tabs.group
let tabGroupsUpdateCalls = [];  // {groupId, props} per chrome.tabGroups.update
let grantedPermissions = new Set();  // optional permissions granted at runtime
let permissionRequestGrants = true;  // what chrome.permissions.request resolves to
let failGroupOps = false;       // when true, chrome.tabs.group throws (recreate-failure path)

const smokeBrowserEffects = {
  clearTabs() { createdTabs = []; },
  clearWindows() { createdWindows = []; },
  get tabs() { return createdTabs; },
  get windows() { return createdWindows; },
  get alarms() { return alarms; }
};

installSmokeChrome({
  storage: () => ({ local: mem, session: sessionMem }),
  windows: () => ({
    live: mockWindows,
    created: createdWindows,
    removedIds: removedWindowIds,
    currentId: mockCurrentWindowId
  }),
  tabs: () => ({
    removedIds: removedTabIds,
    createdUrls: createdTabs,
    updated: updatedTabs,
    discardedIds: discardedTabs,
    moves: tabsMoveCalls
  }),
  effects: () => ({ alarms, notifications, badgeTexts }),
  groups: () => ({
    records: mockTabGroups,
    groupCalls: tabsGroupCalls,
    updateCalls: tabGroupsUpdateCalls,
    fail: failGroupOps
  }),
  nextGroupId: () => nextGroupId++,
  permissions: () => ({ granted: grantedPermissions, requestGrants: permissionRequestGrants })
});

// E2-0b: store.js takes the "everytab-store" Web Lock for every storage RMW,
// so the Node harness installs a LockManager BEFORE any module import.
const { createMockLockManager } = await import("./e2-mocks.mjs");
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() },
  writable: true,
  configurable: true
});

const { installBrowserMapStorageAuthority } = await import(
  "./storage-authority-fixture.mjs"
);
installBrowserMapStorageAuthority();

const {
  takeSnapshot, saveAllWindowsAsSession, saveWindowAsSession, restoreWindowRefs,
  restoreSession, restoreSessionWindow, restoreSessionById
} =
  await import("../js/lib/sessions.js");
const {
  mapGroupIndexes, groupPlanFromRefs, fetchGroupTemplates, fetchLiveGroupDetails, recreateWindowGroups,
  hasTabGroupsPermission, ensureTabGroupsPermission, setGroupRestoreNotifier, GROUP_COLOR_HEX
} = await import("../js/lib/tab-groups.js");
const { buildJsonExport, importJson, buildOneTabExport, parseOneTabImport } = await import(
  "../js/lib/export.js"
);
const { unwrapSuspendedUrl, canonicalRef, canonicalUrlOf, isOwnSuspendPage, isSaveableTab, organizeTabOf } =
  await import("../js/lib/tabs.js");
const {
  registrableDomain, hostnameOf, domainKeyOf, sortOrderFor, gatherPlanFor, gatherOptionsFor,
  sortWindowById, gatherDomainToNewWindow, SORT_MODES, SORT_LABELS
} = await import("../js/lib/organize.js");
const { listActions: listOrganizeActions, undoAction: undoOrganizeAction, clearJournal: clearOrganizeJournal } =
  await import("../js/lib/journal.js");
const { listItems, upsertItem, newMeta, getSettings, getFreshSettings } = await import("../js/lib/store.js");
const { STORE_KEYS, ARCHIVE_OVERLAY_KEY } = await import("../js/lib/types.js");
const { removeTabFromInboxItem, dumpTab, dumpTabs } = await import("../js/lib/actions.js");
const { deleteSavedItem } = await import("../js/lib/saved-item-actions.js");
const { windowFingerprint, sameWindowFingerprint, closeWindowSafely } =
  await import("../js/lib/close-window.js");

const { check, finish } = createSmokeChecks();

/* --- P11-03: guarded whole-window close --- */
{
  const fingerprint = windowFingerprint([
    { id: 8, pinned: true }, { id: 3, pinned: false }, { id: 5, pinned: true }
  ]);
  check(JSON.stringify(fingerprint) === JSON.stringify({
    tabCount: 3, tabIds: [3, 5, 8], pinnedTabIds: [5, 8]
  }), "P11-03: window fingerprints are stable and include exact pin state");
  check(sameWindowFingerprint(fingerprint, { ...fingerprint }) &&
        !sameWindowFingerprint(fingerprint, { ...fingerprint, pinnedTabIds: [5] }),
    "P11-03: the stale guard rejects a pin-state change at the same tab count");

  mem.journal = [];
  removedWindowIds = [];
  mockWindows = [{ id: 40, type: "normal", tabs: [
    { id: 1, url: "https://one.test" }, { id: 2, url: "https://two.test" }
  ] }];
  const invalid = await closeWindowSafely(40, { tabCount: 2, tabIds: [1], pinnedTabIds: [] });
  check(invalid.reason === "invalid" && removedWindowIds.length === 0 && mem.journal.length === 0,
    "P11-03: malformed close requests cannot remove or journal a window");

  const stale = await closeWindowSafely(40, { tabCount: 2, tabIds: [1, 3], pinnedTabIds: [] });
  check(stale.reason === "changed" && stale.tabCount === 2 && removedWindowIds.length === 0,
    "P11-03: a same-count tab replacement stops the close and returns the live total");
  mockWindows[0].tabs[1].pinned = true;
  const repinned = await closeWindowSafely(40, { tabCount: 2, tabIds: [1, 2], pinnedTabIds: [] });
  check(repinned.reason === "changed" && repinned.pinnedTabIds[0] === 2 && removedWindowIds.length === 0,
    "P11-03: newly pinned tabs require a fresh confirmation");

  mockWindows = [{ id: 41, type: "normal", incognito: true,
    tabs: [{ id: 4, url: "https://secret.test" }] }];
  const incognito = await closeWindowSafely(41, { tabCount: 1, tabIds: [4], pinnedTabIds: [] });
  check(incognito.reason === "forbidden" && removedWindowIds.length === 0 && mem.journal.length === 0,
    "P11-03: the worker refuses incognito windows at the message boundary");

  const suspended = chrome.runtime.getURL("suspend.html") + "?originalUrl=" +
    encodeURIComponent("https://sleeping.test/page") + "&title=" + encodeURIComponent("Sleeping");
  mockWindows = [{ id: 42, type: "normal", tabs: [
    { id: 11, url: "https://awake.test", title: "Awake", pinned: true },
    { id: 12, url: "chrome://settings", title: "Settings" },
    { id: 13, url: suspended, title: "Suspended" }
  ] }];
  const expected = windowFingerprint(mockWindows[0].tabs);
  const closed = await closeWindowSafely(42, expected);
  const recovery = mem.journal?.[0];
  check(closed.ok && closed.recoverableCount === 2 && closed.recoverySaved === true &&
        removedWindowIds.includes(42) && mockWindows.length === 0,
    "P11-03: a matching request removes the exact whole window");
  check(recovery?.reopen?.[0]?.length === 2 &&
        recovery.reopen[0].some((ref) => ref.url === "https://awake.test") &&
        recovery.reopen[0].some((ref) => ref.url === "https://sleeping.test/page") &&
        !recovery.reopen[0].some((ref) => ref.url.startsWith("chrome://")) &&
        /best-effort recovery/.test(recovery.label),
    "P11-03: recovery journals canonical web pages only and names its limitation");

  const gone = await closeWindowSafely(999, { tabCount: 1, tabIds: [9], pinnedTabIds: [] });
  check(gone.reason === "gone", "P11-03: an already-closed window reports gone safely");

  const { readFileSync: readCloseWindow } = await import("node:fs");
  const src = (path) => readCloseWindow(new URL(path, import.meta.url), "utf8");
  const config = src("../js/ui/list-configs.js");
  const helper = src("../js/ui/list-helpers.js");
  const surface = src("../js/ui/open-surface.js");
  const tablist = src("../js/ui/tablist.js");
  const css = src("../css/tablist-d4.css");
  check(config.includes('id: "close-window"') &&
        config.includes("expectedPinnedTabIds") && config.includes("beforeRemoveCard?.()") &&
        surface.includes("chrome.windows.getCurrent()") && surface.includes("browserWindowCount"),
    "P11-03: both shared Open hosts send the reviewed identity and know current/last-window context");
  check(helper.includes('localeMessage("list_close_window_current")') &&
        helper.includes('localeMessage("list_close_window_last")') &&
        helper.includes('localeMessage("list_close_window_pinned_one")') &&
        helper.includes('localeMessage("list_close_window_pinned_other"') &&
        helper.includes('localeMessage("list_close_tabs"'),
    "P11-03: the inline second step names tab count, pins, the current UI, and the last Chrome window");
  check(tablist.includes("pendingCardFocus") && tablist.includes("beforeRemoveCard: markCardFocus") &&
        css.includes(".window-close-confirm.armed") &&
        css.includes(":has(.window-close-confirm.armed) > .gacts > :not(.window-close-confirm)"),
    "P11-03: confirmation owns the temporary header and restores focus to the next card header");
  mem.journal = [];
  mockWindows = [];
  removedWindowIds = [];
}

await runSmokeThemeRotation({ check, local: mem, alarms });

await runSmokeSearchPopup({ check, session: sessionMem });

/* ===================== F13 — open-tab organization ===================== */
{
  // --- pure: hostname + registrable domain ---
  check(hostnameOf("https://Gist.GitHub.com/a/b?x=1") === "gist.github.com",
    "F13: hostnameOf lowercases the host and drops path/query");
  check(hostnameOf("chrome://settings") === "" && hostnameOf("not a url") === "",
    "F13: hostnameOf returns '' for non-HTTP(S)/unparseable input");
  check(registrableDomain("gist.github.com") === "github.com" &&
        registrableDomain("www.github.com") === "github.com" &&
        registrableDomain("github.com") === "github.com",
    "F13: registrableDomain reduces subdomains and www to eTLD+1");
  check(registrableDomain("www.bbc.co.uk") === "bbc.co.uk" &&
        registrableDomain("news.bbc.co.uk") === "bbc.co.uk",
    "F13: registrableDomain keeps the second-level ccTLD suffix (co.uk)");
  check(registrableDomain("localhost") === "localhost" &&
        registrableDomain("10.0.0.1") === "10.0.0.1" &&
        registrableDomain("") === "",
    "F13: registrableDomain leaves single labels, IPv4, and empty untouched");
  check(domainKeyOf({ url: "https://docs.google.com/x" }) === "google.com" &&
        domainKeyOf({ url: "chrome://newtab" }) === "",
    "F13: domainKeyOf keys a tab by its registrable domain ('' for chrome://)");

  // --- pure: sortOrderFor (pinned excluded, stable) ---
  const winTabs = [
    { id: 1, url: "https://a.com/", title: "Zebra", pinned: true, index: 0 },
    { id: 2, url: "https://zed.com/", title: "apple", pinned: false, index: 1, lastAccessed: 100 },
    { id: 3, url: "https://alpha.com/", title: "Mango", pinned: false, index: 2, lastAccessed: 300, active: true },
    { id: 4, url: "https://alpha.com/2", title: "Banana", pinned: false, index: 3, lastAccessed: 200 }
  ];
  check(JSON.stringify(sortOrderFor(winTabs, "domain")) === JSON.stringify([4, 3, 2]),
    "F13: domain sort groups by registrable domain then title A-Z, pinned excluded");
  check(JSON.stringify(sortOrderFor(winTabs, "title")) === JSON.stringify([2, 4, 3]),
    "F13: title sort is A-Z case-insensitive, pinned excluded");
  check(JSON.stringify(sortOrderFor(winTabs, "recent")) === JSON.stringify([3, 4, 2]),
    "F13: recent sort puts the active tab first, then lastAccessed desc");
  check(JSON.stringify(sortOrderFor(winTabs, "bogus")) === JSON.stringify([2, 3, 4]),
    "F13: an unknown sort mode falls back to the original non-pinned order");
  const mixed = [
    { id: 10, url: "chrome://settings", title: "settings", pinned: false, index: 0 },
    { id: 11, url: "https://b.com", title: "B", pinned: false, index: 1 }
  ];
  check(JSON.stringify(sortOrderFor(mixed, "domain")) === JSON.stringify([11, 10]),
    "F13: domain sort pushes domain-less tabs (chrome://) to the end");

  // --- organizeTabOf canonicalizes a suspended tab to its underlying page ---
  const suspendedUrl = "chrome-extension://test-ext-id/suspend.html?originalUrl=" +
    encodeURIComponent("https://real.com/page") + "&title=" + encodeURIComponent("Real");
  const ot = organizeTabOf({ id: 5, url: suspendedUrl, title: "suspended", pinned: false, index: 2 });
  check(ot.url === "https://real.com/page" && ot.title === "Real" && domainKeyOf(ot) === "real.com",
    "F13: organizeTabOf resolves a suspended tab to its underlying page (sorts by real domain)");

  // --- pure: gather plan + options ---
  const gwins = [
    { id: 1, tabs: [
      { id: 1, url: "https://github.com/a" }, { id: 2, url: "https://gist.github.com/b" },
      { id: 3, url: "https://news.com/x" }] },
    { id: 2, tabs: [
      { id: 4, url: "https://github.com/c" }, { id: 5, url: "https://only.com/1" }] }
  ];
  check(JSON.stringify(gatherPlanFor("github.com", gwins)) === JSON.stringify([1, 2, 4]),
    "F13: gatherPlanFor collects a domain's tabs across windows in window/index order");
  const gopts = gatherOptionsFor(gwins[0].tabs, gwins);
  check(gopts.length === 1 && gopts[0].domain === "github.com" && gopts[0].count === 3,
    "F13: gatherOptionsFor lists this window's domains with all-window totals, omitting singletons");

  // --- orchestrator: sortWindowById (journal + one worker move + undo) ---
  mem.journal = [];
  tabsMoveCalls = [];
  createdWindows = [];
  mockWindows = [
    { id: 7, tabs: [
      { id: 70, index: 0, url: "https://a.com", title: "Pinned", pinned: true },
      { id: 71, index: 1, url: "https://zed.com", title: "apple", pinned: false, lastAccessed: 100 },
      { id: 72, index: 2, url: "https://alpha.com", title: "Mango", pinned: false, lastAccessed: 300, active: true },
      { id: 73, index: 3, url: "https://alpha.com/2", title: "Banana", pinned: false, lastAccessed: 200 }] }
  ];
  const r1 = await sortWindowById(7, "domain");
  check(r1.ok && r1.moved === 3 && typeof r1.undoId === "string",
    "F13: sortWindowById reports success + the one undo entry id");
  check(tabsMoveCalls.length === 1 &&
        JSON.stringify(tabsMoveCalls[0].ids) === JSON.stringify([73, 72, 71]) &&
        tabsMoveCalls[0].props.index === 1,
    "F13: sortWindowById moves the non-pinned block in sorted order after the pinned tabs");
  const entry1 = (await listOrganizeActions())[0];
  check(entry1 && /Sorted window by Domain/.test(entry1.label) && /best-effort/.test(entry1.label) &&
        entry1.moves.length === 3 && entry1.moves[0].index === 1,
    "F13: sortWindowById journals one best-effort entry with ascending pre-sort positions");
  tabsMoveCalls = [];
  await undoOrganizeAction(r1.undoId);
  check(tabsMoveCalls.length === 3 && tabsMoveCalls.every((c) => typeof c.ids === "number"),
    "F13: undo re-moves each non-pinned tab back to its captured index (best-effort)");

  // no-op: already sorted → no move, no new journal entry
  tabsMoveCalls = [];
  const jBefore = (await listOrganizeActions()).length;
  mockWindows = [
    { id: 8, tabs: [
      { id: 80, index: 0, url: "https://alpha.com", title: "A", pinned: false },
      { id: 81, index: 1, url: "https://beta.com", title: "B", pinned: false }] }
  ];
  const r2 = await sortWindowById(8, "domain");
  check(r2.ok && r2.reason === "noop" && r2.moved === 0 && tabsMoveCalls.length === 0 &&
        (await listOrganizeActions()).length === jBefore,
    "F13: sortWindowById is a no-op (no move, no journal entry) when already sorted");

  const rGone = await sortWindowById(999, "domain");
  check(rGone.ok === false && rGone.reason === "gone",
    "F13: sortWindowById reports 'gone' for a closed window");
  const rBad = await sortWindowById(8, "bogus");
  check(rBad.ok === false && rBad.reason === "bad-mode",
    "F13: sortWindowById rejects an unknown sort mode before touching anything");

  // --- orchestrator: gatherDomainToNewWindow (incognito excluded) ---
  mem.journal = [];
  tabsMoveCalls = [];
  createdWindows = [];
  mockWindows = [
    { id: 1, type: "normal", tabs: [
      { id: 11, index: 0, url: "https://github.com/a", title: "a" },
      { id: 12, index: 1, url: "https://gist.github.com/b", title: "b" },
      { id: 13, index: 2, url: "https://news.com/x", title: "n" }] },
    { id: 2, type: "normal", tabs: [
      { id: 21, index: 0, url: "https://github.com/c", title: "c" }] },
    { id: 3, incognito: true, tabs: [{ id: 31, index: 0, url: "https://github.com/secret" }] }
  ];
  const g1 = await gatherDomainToNewWindow("github.com");
  check(g1.ok && g1.moved === 3 && typeof g1.windowId === "number" && typeof g1.undoId === "string",
    "F13: gatherDomainToNewWindow moves every matching tab into a new window");
  check(createdWindows.length === 1 && createdWindows[0].tabs[0].id === 11,
    "F13: the gather window is created from the first matching tab");
  check(tabsMoveCalls.length === 1 &&
        JSON.stringify(tabsMoveCalls[0].ids) === JSON.stringify([12, 21]) &&
        tabsMoveCalls[0].props.index === -1,
    "F13: the remaining gathered tabs move into the gather window (incognito window excluded)");
  const gEntry = (await listOrganizeActions())[0];
  check(gEntry && /Gathered github\.com/.test(gEntry.label) && gEntry.moves.length === 3,
    "F13: gather journals one entry restoring all three tabs to their home windows");
  const gEmpty = await gatherDomainToNewWindow("nowhere.com");
  check(gEmpty.ok === false && gEmpty.reason === "empty",
    "F13: gatherDomainToNewWindow returns 'empty' when no tab matches");

  // restore shared harness state for the blocks that follow
  mem.journal = [];
  createdWindows = [];
  tabsMoveCalls = [];
  mockWindows = [];

  // --- source contracts: the feature is wired where it must be ---
  const { readFileSync: readF13 } = await import("node:fs");
  const readSrc = (p) => readF13(new URL(p, import.meta.url), "utf8");
  // F14: the Open config moved to list-configs.js and the Open-surface render +
  // inline panels (Organize, drift, nudge, drag) moved to open-surface.js (2b);
  // scan all three so these Open-surface contracts hold regardless of host module.
  const dbSrc = readSrc("../js/ui/dashboard.js") + "\n" + readSrc("../js/ui/list-configs.js")
    + "\n" + readSrc("../js/ui/open-surface.js");
  check(/id: "organize"/.test(dbSrc) && /buildOrganizePanel/.test(dbSrc) &&
        dbSrc.includes('localeMessage("list_gather_help")'),
    "F13: dashboard mounts an Organize panel with the pinned-tabs hint");
  check(/groupPanelTop: true/.test(dbSrc),
    "F13: the Open-tabs list opens header action panels under the header (groupPanelTop)");
  const tlSrc = readSrc("../js/ui/tablist.js");
  check(/class: "item-body-frame"[^\n]*banner, grpSlot, body/.test(tlSrc) && /groupPanelTop/.test(tlSrc) &&
    /const headShell = el\("div", \{ class: "item-head-shell" \}, head\)/.test(tlSrc),
    "F13/F34-17: tablist places grpSlot first below the wrapped header when groupPanelTop is set");
  check(/type: "sort-window"/.test(dbSrc) && /type: "gather-domain"/.test(dbSrc),
    "F13: dashboard sends both sort-window and gather-domain (moves run in the worker)");
  const popSrc = readSrc("../js/ui/popup.js");
  // D4-3d: the caret became an ellipsis (it opens a follow-up panel, and the
  // popup's other panel-openers already read "Snooze…"/"Label…"). The contract
  // still asserts Sort is offered and gather is not.
  check(/popupStatic\.sort\(\)/.test(popSrc) && /type: "sort-window"/.test(popSrc) && !/type: "gather-domain"/.test(popSrc),
    "F13: popup offers Sort for the current window only (gather stays dashboard-only)");
  // Popup tab/window Session actions share the regular searchable picker, keep
  // one request in flight per scope, and acknowledge the work immediately.
  check(/sessionComboboxButton\(popupStatic\.saveSession\(\)/.test(popSrc) &&
        /sessionComboboxButton\(localeMessage\("popup_save_in_session"\)/.test(popSrc) &&
        /tabSessionPending/.test(popSrc) && /windowSessionPending/.test(popSrc) &&
        /setMsg\(popupStatic\.saving\(\)\)/.test(popSrc) &&
        /type: "save-window-session"/.test(popSrc) && /type: "save-tabs-session"/.test(popSrc),
    "popup: tab/window Session actions share the guarded name-or-existing picker");
  const orgSrc = readSrc("../js/lib/organize.js");
  check(!orgSrc.includes("chrome.storage.local.set") && /recordAction\(/.test(orgSrc),
    "F13: organize.js writes no raw storage — it journals through recordAction");
}

/* ===================== F18 — group-aware sessions ===================== */
{
  // --- pure: mapGroupIndexes (first-seen order, ungrouped/pinned skipped) ---
  const winTabs = [
    { id: 1, groupId: -1 },                  // ungrouped
    { id: 2, groupId: 7 },                    // group A
    { id: 3, groupId: 9 },                    // group B
    { id: 4, groupId: 7 },                    // group A again
    { id: 5, groupId: -1, pinned: true }      // pinned → never grouped
  ];
  const m = mapGroupIndexes(winTabs);
  check(JSON.stringify(m.groupIds) === JSON.stringify([7, 9]),
    "F18: mapGroupIndexes lists distinct group ids in first-seen order");
  check(m.groupIndexByPos[0] === undefined && m.groupIndexByPos[1] === 0 &&
        m.groupIndexByPos[2] === 1 && m.groupIndexByPos[3] === 0 && m.groupIndexByPos[4] === undefined,
    "F18: each tab maps to its first-seen group index; ungrouped/pinned skipped");

  // --- pure: groupPlanFromRefs ---
  const planRefs = [{ groupIndex: 0 }, { groupIndex: 1 }, { groupIndex: 0 }, {}];
  const plan = groupPlanFromRefs(planRefs, [10, 11, 12, 13], [{ title: "A", color: "blue" }, { title: "B" }]);
  check(plan.length === 2 && JSON.stringify(plan[0].tabIds) === JSON.stringify([10, 12]) &&
        plan[0].template.title === "A" && JSON.stringify(plan[1].tabIds) === JSON.stringify([11]),
    "F18: groupPlanFromRefs collects tab ids per group index with their template");

  // --- permission helpers ---
  grantedPermissions = new Set();
  permissionRequestGrants = false;
  check(await hasTabGroupsPermission() === false, "F18: permission is absent by default (optional)");
  check(await ensureTabGroupsPermission() === false && !grantedPermissions.has("tabGroups"),
    "F18: a denied request leaves the permission ungranted");
  permissionRequestGrants = true;
  check(await ensureTabGroupsPermission() === true && grantedPermissions.has("tabGroups"),
    "F18: a granted request adds the permission");
  check(await ensureTabGroupsPermission() === true,
    "F18: ensureTabGroupsPermission is a no-op once granted (no re-prompt)");

  // --- fetchGroupTemplates: descriptors with permission, {} without ---
  mockTabGroups = { 7: { id: 7, title: "Work", color: "blue", collapsed: true }, 9: { id: 9, title: "", color: "red" } };
  const withPerm = await fetchGroupTemplates([7, 9], true);
  check(withPerm[0].title === "Work" && withPerm[0].color === "blue" && withPerm[0].collapsed === true &&
        withPerm[1].color === "red" && !("title" in withPerm[1]) && !("collapsed" in withPerm[1]),
    "F18: fetchGroupTemplates reads title/color/collapsed with permission (empty title omitted)");
  const noPerm = await fetchGroupTemplates([7, 9], false);
  check(noPerm.length === 2 && Object.keys(noPerm[0]).length === 0 && Object.keys(noPerm[1]).length === 0,
    "F18: fetchGroupTemplates returns membership-only {} entries without permission");
  const liveDetails = await fetchLiveGroupDetails([7, 9, 7, -1], true);
  check(liveDetails.size === 2 && liveDetails.get(7)?.title === "Work" &&
      liveDetails.get(7)?.color === "blue" && liveDetails.get(9)?.color === "red",
    "F18: live group details deduplicate ids while retaining Chrome names and colors");
  const liveMembershipOnly = await fetchLiveGroupDetails([7, 9], false);
  check(liveMembershipOnly.size === 2 && Object.keys(liveMembershipOnly.get(7)).length === 0,
    "F18: live group membership remains available without optional metadata permission");

  // --- recreateWindowGroups: groups, title/color, collapsed LAST ---
  const rRefs = [{ groupIndex: 0 }, { groupIndex: 0 }, { groupIndex: 1 }, {}];
  const rGroups = [{ title: "A", color: "blue" }, { title: "B", color: "green", collapsed: true }];
  const gate = { preserveEnabled: true, withPermission: true };
  tabsGroupCalls = []; tabGroupsUpdateCalls = []; failGroupOps = false;
  const rc = await recreateWindowGroups(500, rRefs, [21, 22, 23, 24], rGroups, gate);
  check(rc.attempted && rc.ok && tabsGroupCalls.length === 2 &&
        JSON.stringify(tabsGroupCalls[0].tabIds) === JSON.stringify([21, 22]) &&
        tabsGroupCalls[0].windowId === 500,
    "F18: recreateWindowGroups groups each set of member tabs in the target window");
  check(tabGroupsUpdateCalls[tabGroupsUpdateCalls.length - 1].props.collapsed === true &&
        tabGroupsUpdateCalls.filter((c) => c.props.collapsed).length === 1,
    "F18: collapsed is applied exactly once, LAST (after every group exists)");

  // gate off / no permission → flat, no failure
  tabsGroupCalls = [];
  const flat1 = await recreateWindowGroups(500, rRefs, [21, 22, 23, 24], rGroups, { preserveEnabled: true, withPermission: false });
  check(flat1.attempted === false && flat1.ok && tabsGroupCalls.length === 0,
    "F18: no permission → recreate is a flat no-op (attempted:false), never a failure");
  const flat2 = await recreateWindowGroups(500, rRefs, [21, 22, 23, 24], rGroups, { preserveEnabled: false, withPermission: true });
  check(flat2.attempted === false && tabsGroupCalls.length === 0,
    "F18: preference off → recreate does nothing");

  // recreate failure → non-blocking notice, still resolves
  let noticed = null;
  setGroupRestoreNotifier((msg) => { noticed = msg; });
  failGroupOps = true;
  const failed = await recreateWindowGroups(500, rRefs, [21, 22, 23, 24], rGroups, gate);
  check(failed.attempted && failed.ok === false && noticed === "tab-group-restore",
    "F18: a recreate failure leaves tabs ungrouped, reports the notice, and never throws");
  failGroupOps = false;
  setGroupRestoreNotifier(null);

  // --- capture end-to-end: saveWindowAsSession tags refs + stores templates ---
  const groupedWindow = () => [{
    id: 30, type: "normal", tabs: [
      { id: 301, index: 0, url: "https://a.com", title: "A", groupId: 7 },
      { id: 302, index: 1, url: "https://b.com", title: "B", groupId: 7 },
      { id: 303, index: 2, url: "https://c.com", title: "C", groupId: 9 },
      { id: 304, index: 3, url: "https://d.com", title: "D", groupId: -1 }
    ]
  }];
  mockTabGroups = { 7: { id: 7, title: "Docs", color: "blue" }, 9: { id: 9, title: "Chat", color: "green", collapsed: true } };

  grantedPermissions = new Set(["tabGroups"]);
  mem.settings = { preserveTabGroups: true };
  mem.sessions = {};
  mockWindows = groupedWindow();
  const capPerm = await saveWindowAsSession(30, "Grouped");
  const savedPerm = (await listItems(STORE_KEYS.sessions)).find((x) => x.id === capPerm.id);
  check(savedPerm.groups && savedPerm.groups.length === 1 && savedPerm.groups[0].length === 2 &&
        savedPerm.groups[0][0].title === "Docs" && savedPerm.groups[0][1].collapsed === true,
    "F18: capture with permission stores the window's group templates (names/colors/collapsed)");
  check(savedPerm.windows[0][0].groupIndex === 0 && savedPerm.windows[0][2].groupIndex === 1 &&
        savedPerm.windows[0][3].groupIndex === undefined,
    "F18: capture tags each ref with its group index; an ungrouped ref carries none");

  // membership-only capture (no permission)
  grantedPermissions = new Set();
  mem.sessions = {};
  mockWindows = groupedWindow();
  const capMem = await saveWindowAsSession(30, "GroupedMem");
  const savedMem = (await listItems(STORE_KEYS.sessions)).find((x) => x.id === capMem.id);
  check(savedMem.groups && savedMem.groups[0].length === 2 && Object.keys(savedMem.groups[0][0]).length === 0 &&
        savedMem.windows[0][0].groupIndex === 0,
    "F18: without permission, capture keeps membership (groupIndex) with {} templates");

  // preference off → byte-identical to pre-F18 (no groups, no groupIndex)
  grantedPermissions = new Set(["tabGroups"]);
  mem.settings = { preserveTabGroups: false };
  mem.sessions = {};
  mockWindows = groupedWindow();
  const capOff = await saveWindowAsSession(30, "Off");
  const savedOff = (await listItems(STORE_KEYS.sessions)).find((x) => x.id === capOff.id);
  check(!("groups" in savedOff) && savedOff.windows[0].every((r) => r.groupIndex === undefined),
    "F18: preference off → no groups and no groupIndex captured (byte-identical to pre-F18)");

  // --- restore end-to-end ---
  const session = {
    id: "f18-sess", name: "S", auto: false, labels: [],
    windows: [[
      { url: "https://a.com", title: "A", groupIndex: 0 },
      { url: "https://b.com", title: "B", groupIndex: 0 },
      { url: "https://c.com", title: "C", groupIndex: 1 },
      { url: "https://d.com", title: "D" }
    ]],
    groups: [[{ title: "Docs", color: "blue" }, { title: "Chat", color: "green", collapsed: true }]]
  };
  mem.settings = { preserveTabGroups: true };
  grantedPermissions = new Set(["tabGroups"]);
  tabsGroupCalls = []; tabGroupsUpdateCalls = []; createdWindows = [];
  await restoreSession(session);
  check(createdWindows.length === 1 && tabsGroupCalls.length === 2 &&
        tabGroupsUpdateCalls[tabGroupsUpdateCalls.length - 1].props.collapsed === true,
    "F18: restore recreates both groups and collapses last");

  // A window-level Session restore is the exact one-window slice of Restore
  // all: one window, its group template, and its drift binding are preserved.
  createdWindows = []; tabsGroupCalls = []; tabGroupsUpdateCalls = [];
  mem.sessionWindows = {};
  const restoredWindowId = await restoreSessionWindow(session, 0);
  check(createdWindows.length === 1 && restoredWindowId === createdWindows[0].id &&
        JSON.stringify(mem.sessionWindows[restoredWindowId]) ===
          JSON.stringify({ sessionId: session.id, windowIndex: 0 }) &&
        tabsGroupCalls.length === 2,
    "Session window Restore opens and binds exactly that saved window with its groups");
  check(await restoreSessionWindow(session, -1) === null &&
        await restoreSessionWindow(session, 4) === null && createdWindows.length === 1,
    "Session window Restore rejects an unavailable saved-window index");

  // flat restore without permission
  grantedPermissions = new Set();
  tabsGroupCalls = []; createdWindows = [];
  await restoreSession(session);
  check(createdWindows.length === 1 && tabsGroupCalls.length === 0,
    "F18: without permission the restore is flat (tabs open, no groups)");

  // a pre-F18 session (no groups/groupIndex) restores flat, unchanged
  grantedPermissions = new Set(["tabGroups"]);
  tabsGroupCalls = []; createdWindows = [];
  await restoreSession({ id: "leg", name: "L", auto: false, labels: [],
    windows: [[{ url: "https://a.com", title: "A" }, { url: "https://b.com", title: "B" }]] });
  check(createdWindows.length === 1 && tabsGroupCalls.length === 0,
    "F18: a pre-F18 session restores flat with zero group calls");

  // P11-19: Search activation resolves the current record by id rather than
  // trusting the interaction snapshot, and automatic Snapshots are never valid.
  mem.sessions = {
    live: { ...session, id: "live", modifiedAt: 3 },
    auto: { ...session, id: "auto", auto: true, modifiedAt: 2 },
    deleted: { ...session, id: "deleted", deletedAt: 4, modifiedAt: 4 }
  };
  createdWindows = [];
  check(await restoreSessionById("live") === true && createdWindows.length === 1 &&
        await restoreSessionById("missing") === false &&
        await restoreSessionById("auto") === false &&
        await restoreSessionById("deleted") === false,
    "P11-19: restore-by-id rereads one live named Session and rejects missing, deleted, or automatic records");

  // --- vault / export round-trip preserves the additive fields ---
  const { mergeMaps } = await import("../js/lib/merge.js");
  const rec = { id: "g1", modifiedAt: 5, schemaVersion: 1, windows: [[{ url: "x", groupIndex: 0 }]],
    groups: [[{ title: "T", color: "blue" }]] };
  const merged = mergeMaps({}, { g1: rec }).merged;
  check(merged.g1.groups[0][0].title === "T" && merged.g1.windows[0][0].groupIndex === 0,
    "F18: mergeMaps carries additive groups + groupIndex through untouched");
  mem.sessions = { g1: rec };
  const parsed = JSON.parse(await buildJsonExport());
  check(parsed.data.sessions.g1.groups[0][0].color === "blue" && parsed.data.sessions.g1.windows[0][0].groupIndex === 0,
    "F18: JSON export carries groups/groupIndex through untouched");

  // --- source contracts ---
  const { readFileSync: readF18 } = await import("node:fs");
  const readS = (p) => readF18(new URL(p, import.meta.url), "utf8");
  const sessSrc = readS("../js/lib/sessions.js");
  check(!/permissions\.request/.test(sessSrc) && !/ensureTabGroupsPermission/.test(sessSrc),
    "F18: capture/restore (sessions.js) never REQUESTS the permission");
  check(/getFreshItem\(STORE_KEYS\.sessions, sessionId\)/.test(sessSrc),
    "P11-19: command-time Session restore bypasses the interaction read cache before acting");
  const setSrc = readS("../js/ui/settings-form.js");
  // F14-2b: the group-preservation nudge (the second §6 request surface) moved from
  // dashboard.js into the shared Open surface (open-surface.js).
  const nudgeSrc = readS("../js/ui/open-surface.js");
  check(/ensureTabGroupsPermission/.test(setSrc) && /ensureTabGroupsPermission/.test(nudgeSrc),
    "F18: permission is requested only from the two explicit surfaces (Settings + contextual group row)");
  const dashCss = readS("../css/dashboard.css");
  check(Object.keys(GROUP_COLOR_HEX).every((c) => dashCss.includes(`.gdot-${c}`)),
    "F18: every Chrome group color has a matching read-only chip dot class");

  // restore shared harness state for the blocks that follow
  grantedPermissions = new Set();
  permissionRequestGrants = true;
  failGroupOps = false;
  setGroupRestoreNotifier(null);
  mockTabGroups = {};
  tabsGroupCalls = [];
  tabGroupsUpdateCalls = [];
  createdWindows = [];
  mockWindows = [];
  delete mem.sessions;
  delete mem.settings;
}

/* ===================== F19 — copy as markdown ===================== */
{
  const { linksToMarkdown, sessionToMarkdown } = await import("../js/lib/export.js");

  check(linksToMarkdown([{ url: "https://a.com", title: "A" }, { url: "https://b.com", title: "B" }]) ===
    "- [A](https://a.com)\n- [B](https://b.com)",
    "F19: linksToMarkdown builds a `- [title](url)` bullet list");
  check(linksToMarkdown([{ url: "https://a.com", title: "A [beta] guide" }]) === "- [A \\[beta\\] guide](https://a.com)",
    "F19: link titles escape [ and ] so the markdown link never breaks");
  check(linksToMarkdown([{ url: "https://a.com", title: "  multi\n  line  " }]) === "- [multi line](https://a.com)",
    "F19: whitespace and newlines in titles collapse to a single space");
  check(linksToMarkdown([{ url: "https://a.com", title: "" }]) === "- [https://a.com](https://a.com)",
    "F19: an empty title falls back to the URL");
  check(linksToMarkdown([{ url: "chrome://settings", title: "S" }, { url: "https://a.com", title: "A" }]) ===
    "- [A](https://a.com)",
    "F19: non-http(s) tabs are filtered out of the link list");
  check(linksToMarkdown([]) === "" && linksToMarkdown(undefined) === "",
    "F19: empty or absent input yields empty markdown");
  check(linksToMarkdown([{ url: "https://a.com", title: "A", favIconUrl: "data:image/png;base64," + "Z".repeat(400) }]) ===
    "- [A](https://a.com)",
    "F19: only title + url are emitted — favicon/base64 bytes never leak into the markdown");

  check(sessionToMarkdown({ name: "One", windows: [[{ url: "https://a.com", title: "A" }]] }) ===
    "# One\n\n- [A](https://a.com)",
    "F19: a single-window session is a name heading + bullets (no Window subheading)");
  check(sessionToMarkdown({ name: "Research",
    windows: [[{ url: "https://a.com", title: "A" }], [{ url: "https://b.com", title: "B" }]] }) ===
    "# Research\n\n## Window 1\n- [A](https://a.com)\n\n## Window 2\n- [B](https://b.com)",
    "F19: a multi-window session gets a `## Window k` subheading per window");
  check(sessionToMarkdown({ name: "Empty", windows: [[{ url: "chrome://x", title: "x" }]] }) === "# Empty",
    "F19: a session with no linkable tabs is just its name heading");
  check(sessionToMarkdown({ windows: [] }) === "# Session",
    "F19: a nameless/empty session falls back to '# Session'");

  // source contracts: the surfaces call the copy path
  const { readFileSync: readF19 } = await import("node:fs");
  // F14: Open window-header/bulk copy moved to list-configs.js; the copy
  // implementation (navigator.clipboard) moved to list-helpers.js (2b-2b). Scan all.
  const dsrc = readF19(new URL("../js/ui/dashboard.js", import.meta.url), "utf8") +
    "\n" + readF19(new URL("../js/ui/list-configs.js", import.meta.url), "utf8") +
    "\n" + readF19(new URL("../js/ui/list-helpers.js", import.meta.url), "utf8") +
    "\n" + readF19(new URL("../js/ui/archive-surface.js", import.meta.url), "utf8");
  check(/navigator\.clipboard\.writeText/.test(dsrc),
    "F19: copy writes to the clipboard (navigator.clipboard.writeText)");
  check(/id: "copy", label: localeMessage\("list_copy_markdown"\)/.test(dsrc) &&
        /copySession\(ctx\.group\.data\)/.test(dsrc),
    "F19: the card Copy action (labels/inbox/archive/session) is wired");
  check((dsrc.match(/copyRefs\(/g) || []).length >= 9,
    "F19: Copy is wired on the card surfaces (incl. open-tabs windows) and every bulk bar");
  check(/copyRefs\(ctx\.group\.refs\) \}, \/\/ F19: copy this whole window/.test(dsrc),
    "F19: the Open-tabs window header carries a Copy as markdown action");
  const psrc = readF19(new URL("../js/ui/popup.js", import.meta.url), "utf8");
  check(/copyWinBtn/.test(psrc) && /linksToMarkdown/.test(psrc) && /navigator\.clipboard\.writeText/.test(psrc),
    "F19: the popup This-window group offers Copy as markdown");
}

/* ===================== N28 — keyboard shortcut coverage ===================== */
{
  const { SHORTCUTS } = await import("../js/ui/shortcuts.js");
  const keysOf = (g) => new Set((g?.items ?? []).flatMap((it) => it.keys));
  const rowGroup = SHORTCUTS.find((g) => /focused tab row/.test(g.group));
  const cardGroup = SHORTCUTS.find((g) => /focused card header/.test(g.group));
  check(rowGroup && ["x", "r", "l", "s", "d", "a", "i", "t", "z"].every((k) => keysOf(rowGroup).has(k)),
    "N28: the ? overlay documents the universal row keys incl. i (save), t (Session), and z (suspend)");
  check(cardGroup && ["r", "c", "l", "d", "i", "t"].every((k) => keysOf(cardGroup).has(k)),
    "N28: the ? overlay documents the card-header keys (r/c/l/d/i/t)");
  check(!SHORTCUTS.some((g) => g.group === "Inbox (on the focused tab row or card)"),
    "N28: the Inbox-only shortcuts group was generalized to 'Any list'");

  const { readFileSync: readN28 } = await import("node:fs");
  // F14: Open row actions moved to list-configs.js; scan both for the row keys.
  const dsrc = readN28(new URL("../js/ui/dashboard.js", import.meta.url), "utf8") +
    "\n" + readN28(new URL("../js/ui/list-configs.js", import.meta.url), "utf8");
  check(/id: "snooze", label: localeMessage\("list_snooze_ellipsis"\), icon: "snooze", key: "s"/.test(dsrc) &&
        /id: "suspend"[^\n]*key: "z"/.test(dsrc) && /id: "wake"[^\n]*key: "z"/.test(dsrc) &&
        /id: "dump", label: localeMessage\("list_save_to_inbox"\), icon: "inbox", key: "i"/.test(dsrc),
    "N28: Open-tabs rows gained snooze=s, suspend/wake=z, save→Inbox=i");
  check((dsrc.match(/id: "(?:restore-all|open-all|wake)"[^\n]*key: "r"/g) || []).length >= 4,
    "N28: restore-all / open-all / wake-now are all bound to r on their cards");
  check((dsrc.match(/id: "(?:delete|delete-all|cancel)"[^\n]*key: "d"/g) || []).length >= 4,
    "N28: every card-level delete / cancel is bound to d (in addition to Delete/Backspace)");
}

/* ===== F14 batch 1: shared Open list config (behavior-preserving extraction) =====
   Characterization net for the extraction: build the Open config through the
   shared factory with a mock context and INVOKE its callbacks, so a mis-wired or
   missing injected dependency fails loudly (the source-only contracts above can't
   catch a broken closure). Dashboard behavior is unchanged; this proves the same
   config comes out of the shared module. */
{
  const { buildOpenListConfig } = await import("../js/ui/list-configs.js");
  const sent = [];
  const moved = [];
  const noop = () => {};
  let dragId = null;
  const protectionTargets = [];
  const cfg = buildOpenListConfig({
    data: {
      groups: ["G"], bindings: {}, sessionsById: new Map(), simpleWindows: [],
      groupsUnpreserved: true, currentWindowId: 1, browserWindowCount: 2
    },
    rowCap: 20,
    msg: (m) => { sent.push(m); return Promise.resolve(); },
    renderOpen: noop, renderArchive: noop, renderLabels: noop, goToLabel: noop,
    mark: (ic) => ic, cardLabelPanel: () => ({}), buildOpenSnooze: () => ({}),
    idleNudge: () => null, sessionComboboxButton: () => ({}), copyRefs: noop,
    buildOrganizePanel: () => ({}), driftBanner: () => null, groupAccessAction: () => "GROUP ACCESS",
    buildProtectionPanel: (target) => { protectionTargets.push(target); return {}; },
    openRowDrag: { marker: true }, newWindowZone: () => ({}),
    endWindowZone: (group) => ({ endOf: group }),
    moveOpenTabs: async (ids, destination, afterWindowId = null) => {
      moved.push({ ids, destination, afterWindowId });
    },
    dragTabIds: () => dragId == null ? [] : [dragId], flashNote: noop, showNotice: noop
  });

  check(cfg.section === "open" && cfg.selectable === "tab" && cfg.rowCap === 20 &&
        cfg.presentation === "default" && cfg.groupPanelTop === true && cfg.groups[0] === "G" &&
        cfg.rowDrag.marker === true && cfg.groupEndZone("G").endOf === "G",
    "F14: buildOpenListConfig returns the Open config shape (default presentation, injected data)");

  const rowIds = cfg.rowActions.map((a) => a.id);
  check(JSON.stringify(rowIds) === JSON.stringify([
    "star", "switch", "dump", "session", "label", "snooze", "protection", "suspend", "wake", "close", "close-unsaveable"
  ]), "F22/F14: Open keeps one recoverable and one explicitly non-recoverable Close path");
  const keyOf = (id) => cfg.rowActions.find((a) => a.id === id)?.key;
  check(keyOf("protection") === "p", "Open protection owns the available P row shortcut");
  check(keyOf("switch") === "r" && keyOf("dump") === "i" && keyOf("label") === "l" &&
        keyOf("snooze") === "s" && keyOf("suspend") === "z" && keyOf("wake") === "z",
    "F14: Open row action keys preserved (r/i/l/s/z)");
  const grpIds = cfg.groupActions.map((a) => a.id);
  check(JSON.stringify(grpIds) === JSON.stringify(
    ["idle-nudge", "dump-window", "save-session", "label-window", "snooze-window", "protection-window", "copy", "organize", "close-window"]),
    "Open window header keeps the row action order before window-only actions and Close");
  check(cfg.groupActions.at(-1)?.danger === true && typeof cfg.groupActions.at(-1)?.render === "function",
    "P11-03: whole-window Close is an explicit rendered danger confirmation");
  check(cfg.groupActions.find((action) => action.id === "protection-window")?.key === "p",
    "Open-window protection shares P with the row action");
  cfg.groupActions.find((action) => action.id === "protection-window").run({
    group: { data: { id: 42 } }, panel: { toggle: (build) => build() }
  });
  check(protectionTargets[0]?.windowId === 42,
    "Open-window protection opens the shared picker for the exact window");

  // invoke row callbacks → correct background messages (proves msg is wired)
  cfg.rowOpen({ live: { tabId: 5, windowId: 1 } });
  const run = (id, live) => cfg.rowActions.find((a) => a.id === id).run(
    { live, ref: {}, panel: { toggle: noop } });
  run("dump", { tabId: 7 });
  run("suspend", { tabId: 3, suspended: false });
  run("wake", { tabId: 3, suspended: true });
  run("close", { tabId: 9 });
  check(sent.some((m) => m.type === "focus-tab" && m.tabId === 5) &&
        sent.some((m) => m.type === "dump-tab" && m.tabId === 7) &&
        sent.some((m) => m.type === "suspend-tab" && m.tabId === 3) &&
        sent.some((m) => m.type === "wake-tab" && m.tabId === 3) &&
        sent.some((m) => m.type === "close-tabs" && m.tabIds[0] === 9),
    "F14: Open row runs dispatch the same background messages as the dashboard did");
  const susp = cfg.rowActions.find((a) => a.id === "suspend");
  const wake = cfg.rowActions.find((a) => a.id === "wake");
  const closeUnsaveable = cfg.rowActions.find((a) => a.id === "close-unsaveable");
  check(susp.when({ live: { selectable: true, suspended: false } }) === true &&
        susp.when({ live: { selectable: true, suspended: true } }) === false &&
        susp.when({ live: { selectable: false, suspended: false } }) === false &&
        wake.when({ live: { selectable: true, suspended: true } }) === true &&
        wake.when({ live: { selectable: true, suspended: false } }) === false &&
        wake.when({ live: { selectable: false, suspended: true } }) === false,
    "F14: suspend/wake `when` guards are mutually exclusive (one 'z' toggles)");
  check(closeUnsaveable.when({ live: { selectable: false } }) === true &&
        closeUnsaveable.when({ live: { selectable: true } }) === false &&
        closeUnsaveable.danger === true && typeof closeUnsaveable.render === "function",
    "Open exposes the explicit no-Undo Close only for non-saveable live tabs");

  check(!cfg.rowActions.some((action) => action.id === "move") &&
      cfg.rowDrag?.marker === true && typeof cfg.bulkActions === "function",
    "Open rows omit the redundant Move action while drag and selected-set Move remain available");

  check(cfg.groupBanner({ data: {} }) === null &&
      cfg.rowGroupSupplement({ named: false }) === "GROUP ACCESS",
    "F14: group access is contextual to the affected live-group heading");

  // drag-over reads the injected dragged-set getter (empty → no preventDefault)
  let prevented = 0;
  const fakeEvt = () => ({ preventDefault: () => { prevented++; }, dataTransfer: {}, currentTarget: { classList: { add: noop } } });
  cfg.onGroupDragOver({}, fakeEvt());        // dragId null → early return
  dragId = 5;
  cfg.onGroupDragOver({}, fakeEvt());        // now a drag is live → preventDefault
  check(prevented === 1, "F14: onGroupDragOver honors the injected dragTabIds() getter");
}

/* ===== F14 batch 1b: shared Inbox list config (behavior-preserving extraction) ===== */
{
  const { buildInboxListConfig } = await import("../js/ui/list-configs.js");
  const { STORE_KEYS: SK } = await import("../js/lib/types.js");
  const seen = [];
  const noop = () => {};
  let dragState = null;
  // The Inbox config's `empty:` is an eagerly-built DOM node (el(...)); provide a
  // minimal document so the factory can be exercised in Node. Restored after.
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => ({
    addEventListener() {}, setAttribute() {}, append() {}, style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} }
  }) };
  const cfg = buildInboxListConfig({
    data: { groups: ["IG"] },
    renderInbox: noop, renderLabels: noop, goToLabel: () => seen.push("goToLabel"),
    buildSnooze: () => ({}), inboxRowDrag: { m: 1 }, newBundleZone: () => ({}),
    inboxDrag: () => dragState, dropInboxTab: async () => {}, showNotice: noop,
    copyRefs: (refs) => seen.push(["copyRefs", refs]), sessionComboboxButton: () => ({}),
    saveWindowItemToSession: noop, cardLabelPanel: () => ({}), confirmDelete: () => ({}),
    delInboxItem: async () => {}, flashNote: noop, showToast: noop,
    openRowLabel: (_c, store) => seen.push(["openRowLabel", store])
  });

  check(cfg.section === "inbox" && cfg.selectable === "tab" && cfg.presentation === "default" &&
        cfg.groups[0] === "IG" && cfg.groupCap === cfg.groups.length && cfg.rowDrag.m === 1,
    "F14: buildInboxListConfig returns the uncapped Inbox config shape (default presentation, injected data)");
  check(JSON.stringify(cfg.rowActions.map((a) => `${a.id}:${a.key}`)) ===
        JSON.stringify(["star:b", "restore:r", "label:l", "session:t", "snooze:s", "archive:a", "delete:d"]),
    "F22/F14: Inbox adds the Star shortcut and preserves every existing row key");
  const winIds = cfg.groupActions({ data: { kind: "window" } }).map((a) => a.id);
  const tabIds = cfg.groupActions({ data: { kind: "tab" } }).map((a) => a.id);
  check(JSON.stringify(winIds) === JSON.stringify(["restore-all", "copy", "session", "label-window", "snooze", "delete"]) &&
        JSON.stringify(tabIds) === JSON.stringify(["restore", "copy", "snooze", "delete"]),
    "F14: Inbox window-bundle vs single-tab card actions are preserved");

  // invoke the injected-callback paths (domain-op paths proven byte-identical by diff)
  cfg.onChipOpen("x");
  cfg.rowActions.find((a) => a.id === "label").run({ group: { data: {} }, index: 0, panel: { toggle: noop } });
  cfg.groupActions({ data: { kind: "tab" } }).find((a) => a.id === "copy").run({ group: { refs: ["R"] } });
  check(seen.some((s) => s === "goToLabel") &&
        seen.some((s) => Array.isArray(s) && s[0] === "openRowLabel" && s[1] === SK.inbox) &&
        seen.some((s) => Array.isArray(s) && s[0] === "copyRefs" && s[1][0] === "R"),
    "F14: Inbox chip-open/label/copy wire to the injected navigation, row-label, and copy helpers");

  // drag-over reads the injected inboxDrag() getter (null → no preventDefault)
  let prevented = 0;
  const evt = () => ({ preventDefault: () => { prevented++; }, dataTransfer: {}, currentTarget: { classList: { add: noop } } });
  cfg.onGroupDragOver({ data: { id: 1 } }, evt());       // no drag → early return
  dragState = { itemId: 5 };
  cfg.onGroupDragOver({ data: { id: 1 } }, evt());       // live drag onto a different bundle → preventDefault
  cfg.onGroupDragOver({ data: { id: 5 } }, evt());       // own bundle remains a valid selected-set reorder target
  check(prevented === 2, "F14: Inbox onGroupDragOver honors the injected inboxDrag() getter");
  if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
}

/* ===== F14 batch 1c: shared Sessions/Snapshots list config (behavior-preserving) ===== */
{
  const { buildSessionListConfig } = await import("../js/ui/list-configs.js");
  const seen = [];
  const noop = () => {};
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => ({
    addEventListener() {}, setAttribute() {}, append() {}, style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} }
  }) };
  const sessions = [{ id: "s1", name: "S1", windows: [[{ url: "u", title: "t" }]], modifiedAt: 1, labels: [] }];
  const snoozes = new Map([["s1", { dueAt: 2 }]]);
  const mk = (extra) => buildSessionListConfig({
    section: "sessions", sessions, rerender: noop, extra,
    renderLabels: noop, renderSnoozes: noop, goToLabel: () => seen.push("goToLabel"),
    msg: (m) => seen.push(["msg", m]), cardLabelPanel: () => ({}),
    copySession: (s) => seen.push(["copySession", s.id]), buildSnoozePanel: () => ({}),
    confirmDelete: () => ({}), delSession: async () => {},
    sessionComboboxButton: () => ({}), sessionTargetCount: 2
  });

  const cfg = mk({ sessionSnoozes: snoozes, selectable: "tab", empty: "none" });
  check(cfg.section === "sessions" && cfg.selectable === "tab" && cfg.empty === "none" &&
        cfg.immutable({ data: { auto: true } }) === true && cfg.immutable({ data: { auto: false } }) === false,
    "F14: buildSessionListConfig base + `...rest` override (selectable/empty) and immutable(auto) guard");
  check(JSON.stringify(cfg.rowActions.map((a) => `${a.id}:${a.key}`)) ===
        JSON.stringify(["star:b", "restore-tab:r", "label:l", "remove:d"]) &&
        cfg.windowActions[0].id === "restore-window" &&
        cfg.windowActions[0].icon === "refresh",
    "F22/F14: Sessions adds the Star shortcut and exposes a recognizable window Restore action");
  check(JSON.stringify(cfg.groupActions.map((a) => a.id)) ===
        JSON.stringify(["restore-all", "copy", "label-session", "add-session", "rename", "snooze-session", "delete"]),
    "F14: Sessions card actions include snooze-session when a snooze map is supplied");
  const noSnooze = mk({ empty: "none" }).groupActions.map((a) => a.id);
  check(!noSnooze.includes("snooze-session") &&
        JSON.stringify(noSnooze) === JSON.stringify(["restore-all", "copy", "label-session", "add-session", "rename", "delete"]),
    "F14: Snapshots (no snooze map) omit snooze-session");
  check(/snoozed until/.test(cfg.groups[0].meta),
    "F14: a scheduled session gets the 'snoozed until' meta badge");

  cfg.onChipOpen("x");
  cfg.groupActions.find((a) => a.id === "copy").run({ group: { data: { id: "s1" } } });
  cfg.rowActions.find((a) => a.id === "restore-tab").run({ ref: { url: "u" } });
  check(seen.some((s) => s === "goToLabel") &&
        seen.some((s) => Array.isArray(s) && s[0] === "copySession" && s[1] === "s1") &&
        seen.some((s) => Array.isArray(s) && s[0] === "msg" && s[1].type === "open-url" && s[1].url === "u"),
    "F14: Sessions chip-open/copy/restore-tab wire to injected nav/copy + the open-url message");
  if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
}

/* ===== F14 batch 1d: shared Labels list config (behavior-preserving extraction) =====
   The Labels page keeps its own render loop (collect/sort, index bar, N29 quick
   pass); only the createTabList config is shared. Build it through the factory
   and invoke its injected-callback paths; the domain-op runs (unlabel/rename/
   delete/open-all) are proven byte-identical by the source diff and are asserted
   here for shape/keys only (invoking them would touch chrome storage/windows). */
{
  const { buildLabelsListConfig } = await import("../js/ui/list-configs.js");
  const { STORE_KEYS: SK } = await import("../js/lib/types.js");
  const seen = [];
  const noop = () => {};
  let confirmed = 0;
  const renderLabels = () => seen.push("renderLabels");
  const groups = [
    { id: "label::work", kind: "label", title: "work", refs: [{ url: "u" }],
      data: { label: "work", locs: [{ store: SK.inbox }] } },
    { id: "label::home", kind: "label", title: "home", refs: [{ url: "v" }],
      data: { label: "home", locs: [{ store: SK.archive }] } }
  ];
  const cfg = buildLabelsListConfig({
    data: { groups },
    renderLabels, goToLabel: () => seen.push("goToLabel"),
    msg: (m) => seen.push(["msg", m]),
    refreshLabelViews: noop,
    cardLabelPanel: (apply, cta) => { seen.push(["labelPanel", cta]); return "PANEL"; },
    copyRefs: (refs, heading) => seen.push(["copyRefs", refs, heading]),
    confirmDelete: () => { confirmed++; return "CONFIRM"; }
  });

  check(cfg.section === "labels" && cfg.presentation === "default" && cfg.selectable === "tab" &&
        cfg.onChange === renderLabels && cfg.groups.length === 2 && cfg.groupCap === 2,
    "F14: buildLabelsListConfig returns the Labels config shape, uncapped (groupCap = group count)");
  /* F49r: the row's own title link already opens the page, so the duplicate
     "Open" action gave way to the one thing the section could not do — add
     ANOTHER label to a tab that is already here. */
  check(JSON.stringify(cfg.rowActions(groups[0]).map((a) => `${a.id}:${a.key}`)) ===
        JSON.stringify(["star:b", "label:l", "unlabel:d"]),
    "F22/F14/F49r: Labels keeps the Star shortcut, replaces the duplicate Open with Label, and preserves the remove key");
  check(JSON.stringify(cfg.groupActions(groups[0]).map((a) => `${a.id}:${a.key ?? ""}`)) ===
        JSON.stringify(["open-all:r", "copy:c", "rename:", "delete:d"]),
    "F14: Labels card actions + keys are preserved (open-all/copy/rename/delete)");
  const intersectionGroup = { ...groups[0], data: { ...groups[0].data, combined: true } };
  check(JSON.stringify(cfg.rowActions(intersectionGroup).map((a) => a.id)) ===
        JSON.stringify(["star", "label"]) &&
        JSON.stringify(cfg.groupActions(intersectionGroup).map((a) => a.id)) ===
        JSON.stringify(["open-all", "copy"]),
    "Label intersections expose only actions that are truthful for the combined result");

  // rowMeta resolves each tab's location text (inbox / archive / session name) via
  // the whereText helper that moved into the builder.
  check(cfg.rowMeta({}, groups[0], 0) === "inbox" && cfg.rowMeta({}, groups[1], 0) === "archive" &&
        cfg.rowMeta({}, { data: { locs: [{ store: SK.sessions, item: { name: "Trip" } }] } }, 0) === "session “Trip”",
    "F14: Labels rowMeta reports each tab's location via the extracted whereText");

  // injected-callback paths: chip nav, the row Label panel, and copy(refs, heading)
  cfg.onChipOpen("x");
  let labelPanelOpened = null;
  cfg.rowActions(groups[0]).find((a) => a.id === "label").run({
    index: 0,
    group: { data: { locs: [{ store: SK.inbox, item: { id: "i1" }, i: 0 }] } },
    panel: { toggle: (build, kind) => { labelPanelOpened = kind; build(); } }
  });
  cfg.groupActions(groups[0]).find((a) => a.id === "copy").run({ group: { refs: ["R"], data: { label: "work" } } });
  check(seen.some((s) => s === "goToLabel") &&
        labelPanelOpened === "label" &&
        seen.some((s) => Array.isArray(s) && s[0] === "labelPanel" && s[1] === "Add labels") &&
        seen.some((s) => Array.isArray(s) && s[0] === "copyRefs" && s[1][0] === "R" && s[2] === "work"),
    "F14/F49r: Labels chip-open, the row Label panel, and copy(heading) wire to their injected callbacks");

  // the two-step delete affordance renders through the injected confirmDelete
  check(cfg.groupActions(groups[0]).find((a) => a.id === "delete").render({ group: { data: { label: "work" } } }) === "CONFIRM" &&
        confirmed === 1,
    "F14: the Labels delete card action renders through the injected confirmDelete");
}

/* ===== F14 batch 1e: shared Snoozed list config (behavior-preserving extraction) =====
   Last of the five configs. The reschedule datetime panel, subset wake/cancel
   (split-aware), and the two snooze kinds all move into the builder; the dashboard
   injects render/nav/copy and the per-render groups. */
{
  const { buildSnoozedListConfig } = await import("../js/ui/list-configs.js");
  const seen = [];
  const noop = () => {};
  const prevDoc = globalThis.document;
  globalThis.document = { createElementNS: () => ({ setAttribute() {}, appendChild() {} }), createElement: () => ({
    addEventListener() {}, setAttribute() {}, append() {}, focus() {}, style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} }
  }) };
  const cfg = buildSnoozedListConfig({
    data: { groups: ["SG"] },
    renderSnoozes: () => seen.push("renderSnoozes"),
    renderSessions: () => seen.push("renderSessions"),
    msg: (m) => { seen.push(["msg", m]); return { ok: true, status: "delivered" }; },
    copyRefs: (refs) => seen.push(["copyRefs", refs])
  });

  check(cfg.section === "snoozed" && cfg.presentation === "default" && cfg.selectable === "tab" &&
        cfg.groups[0] === "SG" && cfg.empty === "Snooze tabs from the popup or the right-click menu.",
    "F14: buildSnoozedListConfig returns the Snoozed config shape (default presentation, injected data)");
  check(cfg.rowSelectable({ group: { data: {} } }) === true &&
        cfg.rowSelectable({ group: { data: { sessionId: "s1" } } }) === false,
    "F14: Snoozed rows are non-selectable for a session snooze (its rows belong to the template)");
  check(JSON.stringify(cfg.groupActions.map((a) => `${a.id}:${a.key ?? ""}`)) ===
        JSON.stringify(["wake:r", "reschedule:", "cancel:d"]),
    "F14: Snoozed card actions + keys are preserved (wake/reschedule/cancel)");

  // Wake carries its displayed record; cancelling a missing item is not success.
  await cfg.groupActions.find((a) => a.id === "wake").run({ group: { data: { id: "z1" } } });
  await cfg.groupActions.find((a) => a.id === "cancel").run({ group: { data: { id: "z1" } } });
  check(seen.some((s) => Array.isArray(s) && s[0] === "msg" &&
        s[1].type === "wake-snooze" && s[1].id === "z1" && s[1].expected?.id === "z1") &&
        !seen.some((s) => s === "renderSessions") && seen.some((s) => s === "renderSnoozes"),
    "Snoozed actions carry the displayed record and refresh only on success");

  // reschedule opens the inline datetime panel (openReschedule moved into the builder)
  let toggledKey = null;
  cfg.groupActions.find((a) => a.id === "reschedule").run({
    panel: { toggle: (fn, key) => { toggledKey = key; fn(); } }, group: { data: { id: "z1" } }
  });
  check(toggledKey === "reschedule",
    "F14: Snoozed reschedule opens the inline datetime panel (moved into the builder)");

  // bulk bar exposes Wake now / Copy / Cancel selected
  const bulk = cfg.bulkActions({ selection: [{ group: { data: { id: "z1" }, refs: ["R"] }, indexes: [0] }], clear: noop });
  check(Array.isArray(bulk) && bulk.length === 3,
    "F14: Snoozed bulk bar has Wake now / Copy / Cancel selected");
  if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
}

/* ===== F14-2a: side-panel platform + entry points (source/JSON contracts) =====
   The panel document itself (sections/compact) is DOM-heavy and validated by the
   §12 Chrome eyeball; here we lock the platform surface a continuer must not break. */
{
  const { readFileSync: rf } = await import("node:fs");
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const manifest = JSON.parse(rf(new URL("../manifest.json", import.meta.url), "utf8"));
  const sp = rf(new URL("../js/ui/sidepanel.js", import.meta.url), "utf8");
  const popup = rf(new URL("../js/ui/popup.js", import.meta.url), "utf8");
  const bg = rf(new URL("../js/background.js", import.meta.url), "utf8");
  const shortcuts = rf(new URL("../js/ui/shortcuts.js", import.meta.url), "utf8");
  const html = rf(new URL("../sidepanel.html", import.meta.url), "utf8");

  // #1 manifest platform + popup default preserved
  check(manifest.permissions.includes("sidePanel") &&
        manifest.side_panel?.default_path === "sidepanel.html" &&
        manifest.action?.default_popup === "popup.html",
    "F14-2a #1: manifest has sidePanel + side_panel.default_path and keeps action.default_popup = popup.html");

  // #2 no toolbar takeover anywhere in js/
  {
    const root = fileURLToPath(new URL("../js/", import.meta.url));
    const walk = (d) => fsm.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = pathm.join(d, e.name);
      return e.isDirectory() ? walk(p) : e.name.endsWith(".js") ? [p] : [];
    });
    const takeover = walk(root).some((p) => /openPanelOnActionClick\s*:\s*true/.test(fsm.readFileSync(p, "utf8")));
    check(!takeover, "F14-2a #2: no openPanelOnActionClick:true path exists (toolbar stays the popup)");
  }

  // #3 popup Side panel entry opens the panel for THIS window + visible rejection state
  check(/popupStatic\.sidePanel\(\)/.test(popup) && /chrome\.sidePanel\.open\(\{ windowId: win\.id \}\)/.test(popup) &&
        /popupStatic\.sidePanelFailed\(\)/.test(popup),
    "F14-2a #3: popup footer opens the side panel for the current window with a visible rejection state");

  // #4 open-side-panel command: default key; immediate command-tab route with fallback; listed
  check(manifest.commands["open-side-panel"]?.suggested_key?.default === "Alt+Shift+S" &&
        manifest.commands["open-side-panel"]?.suggested_key?.mac === "MacCtrl+Shift+S",
    "F14-2a #4: open-side-panel uses macOS Control+Shift+S and the platform-safe Alt equivalent elsewhere");
  const keyboardCommands = rf(new URL("../js/background/keyboard-command-owner.js", import.meta.url), "utf8");
  check(/installKeyboardCommandOwner/.test(bg) &&
        /command === "open-side-panel"/.test(keyboardCommands) &&
        /commandTab\?\.windowId/.test(keyboardCommands) &&
        /getLastFocused/.test(keyboardCommands) &&
        /candidate\.type === "normal" && !candidate\.incognito/.test(keyboardCommands) &&
        /chrome\.sidePanel\.open/.test(keyboardCommands) &&
        /chrome\.sidePanel\.close/.test(keyboardCommands),
    "F14-2a #4: the command-tab route preserves activation and toggles the Side Panel, with a normal-window fallback");
  check(/"open-side-panel": msg\("command_side_panel_description"\)/.test(shortcuts) &&
        /"open-side-panel"/.test(shortcuts.match(/const ORDER = \[[^\]]*\]/)?.[0] ?? ""),
    "F14-2a #4: the live command list includes open-side-panel");

  // shell: mounts the shared search + theme, defaults to Open, never imports dashboard.js
  check(/createSearchBox/.test(sp) && /initTheme\(\)/.test(sp) &&
        /let activeSection = "open"/.test(sp) && /role: "tablist"/.test(sp),
    "F14-2a: the panel shell mounts createSearchBox + initTheme and the switcher defaults to Open");
  check(!/import[^\n]*["'][^"']*dashboard\.js["']/.test(sp) && !/import\(["'][^"']*dashboard\.js/.test(sp),
    "F14-2a: sidepanel.js never imports the side-effectful dashboard.js");
  check(/js\/boot\.js/.test(html) && /css\/sidepanel\.css/.test(html) && /js\/ui\/sidepanel\.js/.test(html),
    "F14-2a: sidepanel.html loads boot.js (pre-paint theme), the panel stylesheet, and the module");
}

/* ===== F14-2b: shared Open surface (behavior-preserving extraction) =====
   The Open render + its inline panels / drag / nudges moved from dashboard.js into
   `js/ui/open-surface.js` (createOpenSurface), so the dashboard and the coming panel
   build Open from one source. DOM behavior is validated by the §12 eyeball; these
   source contracts lock the shared-module boundary. */
{
  const { readFileSync: rf } = await import("node:fs");
  const os = rf(new URL("../js/ui/open-surface.js", import.meta.url), "utf8");
  const db = rf(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");

  check(/export function createOpenSurface\(/.test(os),
    "F14-2b: open-surface.js exports createOpenSurface(ctx)");
  // the surface owns the Open-only machinery (moved out of dashboard.js verbatim)
  check(/function buildOpenSnooze\(/.test(os) && /function buildOrganizePanel\(/.test(os) &&
        /function driftBanner\(/.test(os) && /const openRowDrag =/.test(os) &&
        /function newWindowZone\(/.test(os) && /function idleNudge\(/.test(os) &&
        /function groupAccessAction\(/.test(os) && /async function moveOpenTabs\(/.test(os),
    "F14-2b: the Open-only inline panels + drag + nudges live in the surface");
  // and builds the shared config
  check(/buildOpenListConfig\(/.test(os) && /import \{ buildOpenListConfig \} from "\.\/list-configs\.js"/.test(os),
    "F14-2b: the surface builds Open through the shared buildOpenListConfig");
  check(/rowCap:\s*\(\)\s*=>\s*undefined/.test(db) &&
        /typeof ctx\.rowCap === "function" \? ctx\.rowCap\(\) : ctx\.rowCap/.test(os) &&
        /const OPEN_WINDOW_CAP = 50;/.test(os) &&
        /const OPEN_SURFACE_INITIAL_BUDGET = 300;/.test(os) &&
        /requestedRowCap \?\? OPEN_WINDOW_CAP/.test(os) &&
        /msg\("list_show_latest_only"/.test(
          rf(new URL("../js/ui/tablist.js", import.meta.url), "utf8")
        ) && /msg\("list_show_all_items"/.test(
          rf(new URL("../js/ui/tablist.js", import.meta.url), "utf8")
        ),
    "F23/E3 DOM evidence: Home Workbench uses the complete Open cap and retains Show all");
  // dashboard delegates to the surface, and those helpers no longer live in dashboard.js
  check(/import \{ createOpenSurface \} from "\.\/open-surface\.js"/.test(db) &&
        /createOpenSurface\(\{/.test(db) && /getOpenSurface\(\)\.render\(\)/.test(db),
    "F14-2b: dashboard builds its Open section through createOpenSurface");
  check(!/function buildOrganizePanel\(/.test(db) && !/const openRowDrag =/.test(db) &&
        !/function driftBanner\(/.test(db),
    "F14-2b: the moved Open helpers no longer have a copy in dashboard.js (one source)");
  // the surface must not import the side-effectful dashboard.js
  check(!/import[^\n]*["'][^"']*dashboard\.js["']/.test(os),
    "F14-2b: open-surface.js never imports the side-effectful dashboard.js");

  // F14-2c prep: the Inbox surface is extracted the same way (shared by dashboard +
  // panel), building Inbox through the shared buildInboxListConfig, owning the inbox
  // drag machinery, and injecting the cross-section helpers via ctx.
  const is = rf(new URL("../js/ui/inbox-surface.js", import.meta.url), "utf8");
  check(/export function createInboxSurface\(/.test(is) && /buildInboxListConfig\(/.test(is) &&
        /const inboxRowDrag = \{/.test(is) && /function newBundleZone\(/.test(is),
    "F14: inbox-surface.js exports createInboxSurface and builds Inbox via the shared config");
  check(/createInboxSurface\(\{/.test(db) && /getInboxSurface\(\)\.render\(\)/.test(db) &&
        !/const inboxRowDrag = \{/.test(db) && !/async function dropInboxTab\(/.test(db),
    "F14: dashboard builds its Inbox section through createInboxSurface (no local drag machinery)");
  check(!/import[^\n]*["'][^"']*dashboard\.js["']/.test(is),
    "F14: inbox-surface.js never imports the side-effectful dashboard.js");

  // Sessions surface extracted the same way (drag machinery + toolbar/bulk in the
  // surface, built via the shared buildSessionListConfig; index bar stays host-owned).
  const ss = rf(new URL("../js/ui/sessions-surface.js", import.meta.url), "utf8");
  check(/export function createSessionsSurface\(/.test(ss) && /buildSessionListConfig\(/.test(ss) &&
        /const sessionRowDrag = \{/.test(ss) && /function newBlockZone\(/.test(ss),
    "F14: sessions-surface.js exports createSessionsSurface and builds Sessions via the shared config");
  check(/createSessionsSurface\(\{/.test(db) && /getSessionsSurface\(\)\.render\(\)/.test(db) &&
        !/const sessionRowDrag = \{/.test(db) && !/async function dropSessionTab\(/.test(db),
    "F14: dashboard builds its Sessions section through createSessionsSurface (no local drag machinery)");
  check(!/import[^\n]*["'][^"']*dashboard\.js["']/.test(ss),
    "F14: sessions-surface.js never imports the side-effectful dashboard.js");
  check(/selectionActionButton\("restore"/.test(ss) &&
        /selectionActionButton\("copy"/.test(ss) &&
        /selectionActionButton\("label"/.test(ss) &&
        /deleteSessionTabs\(toSessionSources\(c\.selection\)\)/.test(ss) &&
        /ctx\.confirmDelete\(/.test(ss) &&
        /cardLabelPanel\(/.test(ss) && !/createLabelInput/.test(ss),
    "shared Sessions bulk selection uses compact icon commands, anchored labels, and confirmed Delete");

  // Labels surface extracted too: collect/sort + shared index bar + N29 quick
  // pass live in one per-document factory; the dashboard is now only a host.
  const ls = rf(new URL("../js/ui/labels-surface.js", import.meta.url), "utf8");
  check(/export function createLabelsSurface\(/.test(ls) && /collectLabels\(\)/.test(ls) &&
        /sortLabelGroups\(rawGroups, sortMode\)/.test(ls) && /createIndexBar\(\{/.test(ls) &&
        /buildLabelsListConfig\(\{/.test(ls) && /buildList\(\[quickTarget\]\)/.test(ls),
    "F14: labels-surface.js owns collect/sort, the shared index, config build, and N29 quick pass");
  check(/createLabelsSurface\(\{/.test(db) && /getLabelsSurface\(\)\.render\(\)/.test(db) &&
        !/async function renderLabelsInner\(/.test(db) && !/function buildLabelIndex\(/.test(db),
    "F14: dashboard builds Labels through createLabelsSurface (no local render/index machinery)");
  check(!/import[^\n]*["'][^"']*dashboard\.js["']/.test(ls),
    "F14: labels-surface.js never imports the side-effectful dashboard.js");

  // 2b-2a: the leaf cross-section helpers are shared (list-helpers.js), imported by
  // the dashboard, so the panel can import the same ones (one behavior source).
  const lh = rf(new URL("../js/ui/list-helpers.js", import.meta.url), "utf8");
  check(/export function mark\(/.test(lh) && /export function flashNote\(/.test(lh) &&
        /export function confirmDelete\(/.test(lh) && /export function cardLabelPanel\(/.test(lh) &&
        /export function sessionComboboxButton\(/.test(lh) &&
        /export function selectionActionButton\(/.test(lh) && /export const selectionRefs =/.test(lh),
    "F14-2b-2a: list-helpers.js exports the shared feedback, picker, and selected-action helpers");
  check(/import \{[^}]*\bcardLabelPanel\b[^}]*\} from "\.\/list-helpers\.js"/.test(db) &&
        !/function cardLabelPanel\(/.test(db) && !/function sessionComboboxButton\(/.test(db) &&
        !/function confirmDelete\(/.test(db),
    "F14-2b-2a: dashboard imports the leaf helpers and no longer defines them locally");
  check(
    /if \(apply\.disabled\) return;/.test(lh) &&
      /await applyFn\(labels\);[\s\S]*?panel\?\.close\(\);/.test(lh) &&
      /localeMessage\("list_save_failed"\)/.test(lh),
    "E3 B10: label confirmation blocks duplicates, closes on durable success, and stays retryable on failure"
  );
  check(!/import[^\n]*["'][^"']*dashboard\.js["']/.test(lh),
    "F14-2b-2a: list-helpers.js never imports the side-effectful dashboard.js");

  // 2b-2b: the copy helpers are a shared factory bound to a showNotice sink, so
  // both surfaces write to the clipboard through one implementation.
  check(/export function createCopyHelpers\(/.test(lh) && /navigator\.clipboard\.writeText/.test(lh),
    "F14-2b-2b: list-helpers.js exports createCopyHelpers (copy-as-markdown) bound to showNotice");
  check(/createCopyHelpers\(showNotice\)/.test(db) && !/async function copyRefs\(/.test(db) &&
        !/async function copyMarkdown\(/.test(db),
    "F14-2b-2b: dashboard builds copyRefs/copySession via createCopyHelpers, no local copy impl");

  // 2b-2c: the undo/notice toast + Ctrl/Cmd+Z is a shared factory; the dashboard
  // destructures it (showToast/showNotice/hideToast) and no longer defines them.
  const toastSrc = rf(new URL("../js/ui/toast.js", import.meta.url), "utf8");
  check(/export function createUndoToast\(/.test(toastSrc) && /export function bindUndoShortcut\(/.test(toastSrc) &&
        /requestUndo/.test(toastSrc),
    "F14-2b-2c: toast.js exports createUndoToast + bindUndoShortcut (undo-backed)");
  check(/createUndoToast\(\{ afterUndo \}\)/.test(db) && /bindUndoShortcut\(showToast, afterUndo\)/.test(db) &&
        !/function showToast\(entry/.test(db) && !/function showNotice\(message, action/.test(db),
    "F14-2b-2c/N42: dashboard builds the toast via the factory (with its undo refresh), no local showToast/showNotice defs");
  check(/\.filter\(Boolean\)/.test(toastSrc.slice(toastSrc.indexOf("function showToast"), toastSrc.indexOf("One-off alert toast"))) &&
        (toastSrc.match(/afterUndo\?\.\(result\.entry\)/g) ?? []).length === 2,
    "N42: an undone toast filters its absent Undo button (no stray \"null\") and reports the undo to its host");
  check(!/import[^\n]*["'][^"']*dashboard\.js["']/.test(toastSrc),
    "F14-2b-2c: toast.js never imports the side-effectful dashboard.js");

  // 2b-2d: the Focus strip is a shared factory; the dashboard builds it via the
  // factory and no longer defines renderFocusStrip locally.
  const fsSrc = rf(new URL("../js/ui/focus-strip.js", import.meta.url), "utf8");
  check(/export function createFocusStrip\(/.test(fsSrc) &&
        /focus-guard-status/.test(fsSrc) && /focus-guard-end/.test(fsSrc) &&
        /formatRemaining/.test(fsSrc),
    "F14-2b-2d: focus-strip.js exports createFocusStrip and owns the site-guard strip render");
  check(/createFocusStrip\(\{/.test(db) && /getSearchInput: \(\) => searchInput/.test(db) &&
        /onMeasure: measureHero/.test(db) && !/async function renderFocusStrip\(/.test(db),
    "F14-2b-2d: dashboard builds the Focus strip via the factory (measureHero injected), no local render");
  check(!/import[^\n]*["'][^"']*dashboard\.js["']/.test(fsSrc),
    "F14-2b-2d: focus-strip.js never imports the side-effectful dashboard.js");

  // 2d (infra): createTabList gains an opt-in compact presentation. D4-2a
  // moved the identical Focus/toast material into the shared primitive layer;
  // D4-2b then moved list geometry into one shared list presentation.
  const tl = rf(new URL("../js/ui/tablist.js", import.meta.url), "utf8");
  check(/presentation = "default"/.test(tl) &&
        /presentation === "compact" \? \{ "data-compact": "" \} : \{\}/.test(tl),
    "F14-2d: createTabList opts into presentation:'compact' → data-compact (default omitted = byte-identical markup)");
  const pcss = rf(new URL("../css/sidepanel.css", import.meta.url), "utf8");
  const primitiveCss = rf(new URL("../css/primitives.css", import.meta.url), "utf8");
  const listCss = rf(new URL("../css/tablist-d4.css", import.meta.url), "utf8");
  const spx = rf(new URL("../js/ui/sidepanel.js", import.meta.url), "utf8");
  check(/\.focus-strip \{/.test(pcss) && /\.toast \{/.test(pcss) &&
        /\.focus-strip \.fs-dot/.test(primitiveCss) && /\.toast\.toast-alert/.test(primitiveCss),
    "F14-2d/D4-2a: sidepanel.css keeps host geometry; primitives.css owns shared Focus/toast material");
  check(/\.tablist \.item-head \{/.test(listCss) && /\.tablist \.trow \{/.test(listCss) &&
        /\.tablist \.chip \{/.test(listCss) && /\.tablist input\[type="checkbox"\]/.test(listCss) &&
        /\[data-surface="sidepanel"\]/.test(listCss),
    "F14-2d/D4-2b: tablist-d4.css owns the shared list skin and compact host adaptations");
  check(/class: "sidepanel-shell"/.test(spx) &&
        /--panel-chrome-h/.test(spx) && /--panel-section-lead-h/.test(spx) &&
        /--panel-local-h/.test(spx) && /new ResizeObserver/.test(spx) &&
        /stickyOffset: panelStickyOffset/.test(spx),
    "P11-13: the side panel measures one dynamic Search, Focus, navigation, section, and local-index sticky stack");
  check(/\.switcher-tabs \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/.test(pcss) &&
        /\.switch-tab\[aria-selected="true"\]::after, \.switch-more\.on::after/.test(pcss) &&
        !/\.switch-tab, \.switch-more \{[^}]*border-radius: 999px/s.test(pcss) &&
        /body \{ margin: 0; \}/.test(pcss),
    "P11-13: flat section navigation remains one connected row at 320px and the panel has one real outer gutter");
  check(/\.tablist\[data-compact\] > \.item > \.item-head-shell \{[\s\S]*?position: sticky;[\s\S]*?--panel-local-h/.test(pcss) &&
        /\.tablist\[data-compact\] > \.item > \.item-body-frame \{[\s\S]*?background: var\(--workbench-row\)/.test(pcss) &&
        /\.tablist\[data-compact\] \.item-head \{[\s\S]*?background: var\(--workbench-header\)/.test(pcss) &&
        /\.section-local-sticky \{[\s\S]*?position: sticky/.test(pcss),
    "P11-13: compact window/group caps reuse the Dashboard ledger material and pin beneath every measured navigation layer");
  const panelHarness = rf(new URL("../../tools/sidepanel-harness.html", import.meta.url), "utf8");
  check(/data-surface="sidepanel"/.test(panelHarness) &&
        /fixtureWidth = Number\(params\.get\("width"\)\)/.test(panelHarness) &&
        /focus-access hidden/.test(panelHarness) && /section-local-sticky/.test(panelHarness) &&
        /params\.get\("view"\) === "sessions"/.test(panelHarness) &&
        /Save all to session/.test(panelHarness),
    "P11-13: the real-style harness covers 320/400 pressure, active Focus access, and a sticky local index");
  check(/\.tablist\[data-compact\] \.tacts \{[\s\S]*?background: inherit/.test(pcss) &&
        /\.tablist\[data-compact\] \.tacts button\.danger \{[\s\S]*?var\(--workbench-row\)/.test(pcss),
    "P11-13r: compact row actions paint one opaque tray and an opaque Close control over long content");
  check(!/requestAnimationFrame\(\(\) => \{\s*measurePanelChrome\(\);\s*searchInput\?\.focus\(\);\s*\}\)/.test(spx) &&
        /e\.key === "\/"[\s\S]*?searchInput\?\.focus\(\)/.test(spx),
    "P11-13r2: opening or switching side-panel sections never autofocuses Search; slash remains explicit focus");
  check(/dataset\.tablist = "sessions"/.test(panelHarness) &&
        /session-action-pressure/.test(panelHarness) &&
        /\.tablist\[data-tablist="sessions"\]\[data-compact\][\s\S]*?--session-row-action-reserve/.test(pcss),
    "P11-13r2: compact Sessions keeps the full four-control action lane above long tab titles");
  check(/const SECTION_ACTION_HOSTS/.test(spx) &&
        /sectionLead\.replaceChildren\(heading, SECTION_ACTION_HOSTS\[id\]\)/.test(spx) &&
        /sectionActionHost: SECTION_ACTION_HOSTS\.sessions/.test(spx),
    "P11-13r: the Sessions save-all command shares the measured section identity line");
  check(/import \{ initTooltips \} from "\.\/tooltip\.js"/.test(spx) &&
        /initTooltips\(\)/.test(spx),
    "P11-13r: the side panel uses the fast shared themed tooltip instead of native-title delay");
  check(/idleNudge: ctx\.presentation === "compact" \? null : idleNudge/.test(
        rf(new URL("../js/ui/open-surface.js", import.meta.url), "utf8")) &&
        /\.\.\.\(idleNudge \? \[\{ id: "idle-nudge"/.test(
          rf(new URL("../js/ui/list-configs.js", import.meta.url), "utf8")),
    "P11-13r: compact Open omits the untouched-tabs nudge while Dashboard retains it");

  // 2b-2e: the panel renders Open via the shared createOpenSurface (compact), mounts
  // the shared Focus strip + undo toast, wires the same bounded tab/window
  // listeners as the dashboard, and copies NO action arrays (one behavior source).
  check(/import \{ createOpenSurface \} from "\.\/open-surface\.js"/.test(spx) &&
        /createOpenSurface\(\{/.test(spx) && /presentation: "compact"/.test(spx) &&
        /OPEN_FILTER_HOST/.test(spx) && /filterHost: OPEN_FILTER_HOST/.test(spx) &&
        /shouldRenderBody: \(\) => activeSection === "open"/.test(spx),
    "F14-2b-2e: the panel builds Open via the shared createOpenSurface in compact presentation");
  check(/createFocusStrip\(\{/.test(spx) && /getSearchInput: \(\) => searchInput/.test(spx) &&
        /createUndoToast\(\)/.test(spx) && /bindUndoShortcut\(showToast\)/.test(spx),
    "F14-2b-2e: the panel mounts the shared Focus strip + undo toast");
  check(!/rowActions:\s*\[/.test(spx) && !/groupActions:\s*\[/.test(spx) && !/bulkActions:/.test(spx),
    "F14-2b-2e: sidepanel.js copies no action arrays (one behavior source)");
  check(/chrome\.tabs\.onCreated\.addListener\(tabsSoon\)/.test(spx) &&
        /chrome\.windows\.onFocusChanged\.addListener\(tabsSoon\)/.test(spx) &&
        /createLeadingTrailingRefresh\([\s\S]{0,100}\(\) => renderOpen\(\),[\s\S]{0,50}delay: 120/.test(spx),
    "F14-2b-2e: the panel keeps its one-context leading/trailing live-tab refresh");
  check(!/import[^\n]*["'][^"']*dashboard\.js["']/.test(spx),
    "F14-2b-2e: sidepanel.js never imports the side-effectful dashboard.js");

  // 2c (start): the panel renders Inbox via the shared createInboxSurface too, and
  // refreshes it on the inbox/snooze store changes. buildSnoozePanel is now shared.
  check(/import \{ createInboxSurface \} from "\.\/inbox-surface\.js"/.test(spx) &&
        /createInboxSurface\(\{/.test(spx) && /shouldRenderBody: \(\) => activeSection === "inbox"/.test(spx) &&
        /SECTION_RENDERERS = \{[\s\S]*?open: buildOpenSection, inbox: buildInboxSection/.test(spx),
    "F14-2c: the panel renders Inbox via the shared createInboxSurface (renderers map)");
  // Snoozed (reached from More): its config is self-contained, so the panel builds it
  // directly via the shared buildSnoozedListConfig (no surface needed).
  check(/import \{ buildSnoozedListConfig \} from "\.\/list-configs\.js"/.test(spx) &&
        /buildSnoozedListConfig\(\{/.test(spx) && /snoozed: buildSnoozedSection/.test(spx),
    "F14-2c: the panel renders Snoozed via the shared buildSnoozedListConfig + refreshes it");
  check(/import \{ createSessionsSurface \} from "\.\/sessions-surface\.js"/.test(spx) &&
        /createSessionsSurface\(\{/.test(spx) && /shouldRenderBody: \(\) => activeSection === "sessions"/.test(spx) &&
        /sessions: buildSessionsSection/.test(spx),
    "F14-2c: the panel renders Sessions via the shared createSessionsSurface");
  check(/import \{ createLabelsSurface \} from "\.\/labels-surface\.js"/.test(spx) &&
        /createLabelsSurface\(\{/.test(spx) && /shouldRenderBody: \(\) => activeSection === "labels"/.test(spx) &&
        /labels: buildLabelsSection/.test(spx) && /presentation: "compact"/.test(spx),
    "F14-2c: the panel renders Labels via the shared createLabelsSurface (compact)");
  check(/activate: \(\) => \{ if \(activeSection !== "labels"\) selectSection\("labels", false\); \}/.test(spx) &&
        /async function goToLabel\(label\)/.test(spx) &&
        /getLabelsSurface\(\)\.goToLabel\(label\)/.test(spx),
    "F14-2c: label chips navigate in-panel through the cached Labels host");
  check(/\.label-index \{/.test(pcss) && /\.label-filter:focus/.test(pcss) &&
        /\.label-sort \.seg\.on/.test(pcss) && /\.label-chip \{/.test(pcss),
    "F14-2c: sidepanel.css carries the compact Labels index/filter/sort/chip skin");
  check(/const SECTION_LIFECYCLE = Object\.fromEntries\(Object\.keys\(HEADINGS\)/.test(spx) &&
        /host: el\("div", \{ class: "panel-section-host"/.test(spx) &&
        /rendered: false,[\s\S]*?dirty: true,[\s\S]*?scrollTop: 0,[\s\S]*?generation: 0/.test(spx),
    "F14-2c lifecycle: one document-local cache registry owns all five stable hosts");
  check(spx.includes('createVisibleDocumentTasks') &&
        spx.includes('if (!panelRefreshTasks.isVisible()) {') &&
        spx.includes('panelRefreshTasks.request(id);') &&
        spx.includes('panelRefreshTasks.request("focus")'),
    "Side Panel list and Focus refresh entry points use document visibility, not keyboard focus");
  check(/selectSection\("open"\);/.test(spx) &&
        /panelBody\.replaceChildren\(state\.host\)/.test(spx) &&
        /if \(renderNow && \(!next\.rendered \|\| next\.dirty\)\) refreshSection\(id\)/.test(spx),
    "F14-2c lifecycle: boot renders only Open and a clean cached switch skips its renderer");
  check(/\{ keys: \[STORE_KEYS\.inbox\], sections: \["inbox", "labels", "open"\] \}/.test(spx) &&
        /\{ keys: \[STORE_KEYS\.archive, ARCHIVE_OVERLAY_KEY\], sections: \["labels", "open"\] \}/.test(spx) &&
        /\{ keys: \[STORE_KEYS\.sessions, NAMED_SESSION_RECORDS_KEY, SESSION_IDENTITY_INDEX_KEY\],[\s\S]*?sections: \["sessions", "snoozed", "labels", "open"\] \}/.test(spx) &&
        /\{ keys: \[STORE_KEYS\.snoozes\], sections: \["snoozed", "inbox", "sessions"\] \}/.test(spx) &&
        /activeSection === id \? refreshSection\(id\)/.test(spx),
    "F14-2c lifecycle: storage dependencies dirty hidden hosts and refresh only the active one");
  check(/previous\.scrollTop = currentScrollTop\(\)/.test(spx) &&
        /window\.scrollTo\(\{ top: state\.scrollTop, left: 0, behavior: "auto" \}\)/.test(spx),
    "F14-2c lifecycle: switches save and instantly restore per-section document scroll");
  check(/sectionCanCommit\(id, generation\)/.test(spx) &&
        /previous\.generation\+\+/.test(spx) &&
        /labelsRenderGeneration/.test(spx),
    "F14-2c lifecycle: generation guards reject stale async host and Labels-surface commits");
  check(/closeMoreMenu\(\);[\s\S]*?discardSectionTransients\(previousId\)/.test(spx) &&
        /focusWasInPrevious/.test(spx) && /focus\(\{ preventScroll: true \}\)/.test(spx),
    "F14-2c lifecycle: switching closes transient UI and preserves switcher focus without scroll theft");
  const lhelp = rf(new URL("../js/ui/list-helpers.js", import.meta.url), "utf8");
  check(/export function buildSnoozePanel\(/.test(lhelp) &&
        /buildSnoozePanel/.test(db) && !/function buildSnoozePanel\(/.test(db),
    "F14-2c: buildSnoozePanel is shared in list-helpers (dashboard imports it, no local copy)");
}

runSmokeCopyPolicy(check);

/* --- F16: popup quick-label (label a tab from the popup; keep it open) --- */
{
  const { readFileSync: readF16 } = await import("node:fs");
  const psrc = readF16(new URL("../js/ui/popup.js", import.meta.url), "utf8");
  const html = readF16(new URL("../popup.html", import.meta.url), "utf8");

  check(/import \{ createLabelInput \} from "\.\/labelinput\.js"/.test(psrc),
    "F16: the popup reuses the createLabelInput combobox (no new component)");
  check(/labelTabBtn/.test(psrc) && /popupStatic\.label\(\)/.test(psrc) &&
        /function buildLabelPanel\(/.test(psrc) && /function toggleLabel\(/.test(psrc),
    "F16: the This-tab group has a Label… toggle + inline label panel");
  check(/keepAwakeBtn/.test(psrc) && /buildProtectionPanel\(active.id/.test(psrc) &&
        /readProtectionStatus\(active.id\)/.test(psrc),
    "popup: This tab uses the shared scoped automation protection picker");
  check(/tabSuspendStatusSlot/.test(psrc) && /renderKeepAwakeStatus/.test(psrc) &&
        /protectionStatusText/.test(psrc) && /settings:protection/.test(psrc),
    "popup: page-exception status persists across opens and links to its Settings manager");
  // nit 1: labeling saves a labeled COPY to the Archive and leaves the tab open —
  // it must NOT close the tab (no dump-tabs / window.close in the label path).
  check(/saveLabeledCopies\(\[ref\], labels\)/.test(psrc),
    "F16 (nit 1): Save labeled copy uses the atomic Archive helper (tab stays open)");
  check(/popupStatic\.saveLabeledCopy\(\)/.test(psrc) && /popupStatic\.labelExplanation\(\)/.test(psrc),
    "F16 (nit 1): the panel primary + hint describe the keep-open copy");
  check(!/type: "dump-tabs"/.test(psrc),
    "F16 (nit 1): the popup no longer sends dump-tabs (which closes tabs)");
  // require a label (empty → nudge, not a no-op copy)
  check(/if \(labels\.length === 0\) \{[\s\S]*?labelMsg\.textContent = popupStatic\.typeLabelFirst\(\);[\s\S]*?return;[\s\S]*?\}/.test(psrc),
    "F16: an empty label set is nudged, not saved");
  // nit 3: the label confirmation lives under This tab (labelMsg), not the shared
  // msg area that sits below This window.
  check(/labelMsg\.textContent = popupLabeledWith\(labels\)/.test(psrc) &&
        /labelPanelTab,\s*labelMsg,\s*tabReason\)/.test(psrc),
    "F16 (nit 3): the label confirmation renders under the This-tab group");
  // enabled under the same gate as Save → Inbox (a knowable-before-click guard)
  check(/if \(active && activeCapture\)/.test(psrc) &&
        /labelTabBtn\.disabled = false;/.test(psrc) &&
        /labelTabBtn\.onclick = \(\) => toggleLabel\(labelPanelTab, active, activeCapture\);/.test(psrc),
    "F16: Label… is enabled in the same branch as the dump button (criterion 2)");
  check(
    /const starTabBtn = el\("button", \{\s*class: "tab-star"/s.test(psrc) &&
      /const action = starred \? popupStatic\.unstarTab\(\) : popupStatic\.starTab\(\)/.test(psrc) &&
      /await isStarredUrl\(starredRef\.url\)/.test(psrc) &&
      /await unstarUrl\(starredRef\.url\)/.test(psrc) &&
      /await starTab\(starredRef\)/.test(psrc) &&
      /undoControl\(undoId\)/.test(psrc),
    "F22: popup This tab exposes an accessible identity-line Star/Unstar with journal-backed Undo"
  );
  // mutual exclusion: the label panel joins the one-open-at-a-time set
  check(/INLINE_PANELS = \[labelPanelTab\]/.test(psrc) &&
        /dismissAnchoredPanel\(\);/.test(psrc) &&
        (psrc.match(/labelPanelTab\.style\.display = "none";/g) ?? []).length >= 3,
    "F16: the label panel is mutually exclusive with the snooze/sort panels (P3)");
  // Label projection behavior is covered directly in popup-label-data.mjs.
  check(psrc.includes('readPopupTabLabels as computeTabLabels') &&
        psrc.includes('computeTabLabels(active, { inbox })') && /tabLabelsSlot/.test(psrc),
    "F16 (nit 2): the popup shows the tab's existing labels as read-only chips");
  check(/renderTabLabels\(initialLabels\)/.test(psrc) && /await refreshTabLabels\(tab\);/.test(psrc),
    "F16 (nit 2): the shown labels refresh on open and after a save");
  check(
    /const visible = labels\.slice\(0, 2\)/.test(psrc) &&
      /class: "tablabels-more"/.test(psrc) &&
      /openDashboard\("labels"\)/.test(psrc),
    "P11-12: This-tab labels stay to two named chips with a discoverable +N overflow"
  );
  // the ported combobox + label styles are present in the popup
  check(/\.tagbox \{/.test(html) && /\.tagmenu \{/.test(html) &&
        /\.label-panel \{/.test(html) && /\.tablabels \{/.test(html) && /\.chip\.labelchip \{/.test(html),
    "F16: popup.html carries the tagbox/tagmenu + label-panel + tablabels styles");
  // nit 4: label suggestions are ordered most-recently-used first, not A–Z
  const lisrc = readF16(new URL("../js/ui/labelinput.js", import.meta.url), "utf8");
  check(/import \{ collectLabels, sortLabelGroups \} from "\.\.\/lib\/labels\.js"/.test(lisrc) &&
        /sortLabelGroups\(await collectLabels\(\), "recent"\)/.test(lisrc),
    "F16 (nit 4): the label combobox suggests most-recently-used labels first");
  // nit 5: the popup's tab-label chips are clickable → dashboard label deep link
  check(/openDashboard\("label:" \+ encodeURIComponent\(l\)\)/.test(psrc) &&
        /class: "chip labelchip"/.test(psrc),
    "F16 (nit 5): the popup tab-label chips deep-link to the dashboard label card");
  // dashboard side: route() handles #label:<name> and lands on that card
  const dfull = readF16(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
  check(/raw\.startsWith\("label:"\)/.test(dfull) &&
        /async function openLabelDeepLink\(/.test(dfull) &&
        /openLabelDeepLink[\s\S]*?await renderLabels\(\);[\s\S]*?positionLabelCard\(label\)/.test(dfull),
    "F16 (nit 5): the dashboard routes #label:<name> to that label's card");
}

/* --- item: labeling an Inbox item must not reorder it (createdAt sort) --- */
{
  const { readFileSync: readR } = await import("node:fs");
  // F14: the Inbox render (data-gathering + sort) moved into inbox-surface.js.
  const isrc = readR(new URL("../js/ui/inbox-surface.js", import.meta.url), "utf8");
  check(/const items = rawItems\s*\.sort\(\(a, b\) => \(b\.createdAt/.test(isrc),
    "Inbox order: the Inbox surface sorts by createdAt (stable), so labeling doesn't jump the item");
}

/* --- item: a single-tab card is headed 'Single tab' in both adapters --- */
{
  const { readFileSync: readR } = await import("node:fs");
  const tl = readR(new URL("../js/ui/tablist.js", import.meta.url), "utf8");
  check((tl.match(/listSingleTabTitle\(\)/g) || []).length >= 2,
    "Single-tab card: fromInboxItems + fromArchiveItems head a single tab 'Single tab'");
}

{
  const { readFileSync } = await import("node:fs");
  const dashboardThemeSrc = readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
  const dashboardCssSrc = readFileSync(new URL("../css/dashboard.css", import.meta.url), "utf8");
  const settingsThemeSrc = readFileSync(new URL("../js/ui/settings-form.js", import.meta.url), "utf8");
  check(dashboardThemeSrc.includes('"aria-label": settingsStatic.appearanceModeAria()') &&
    dashboardThemeSrc.includes('{ id: "light"') && dashboardThemeSrc.includes('{ id: "dark"') &&
    dashboardThemeSrc.includes('{ id: "scheme"') && dashboardThemeSrc.includes('"aria-pressed"'),
    "D3 polish: sidebar exposes explicit Light, Dark, and Scheme default buttons");
  check(settingsThemeSrc.includes('class: "scheme-favorites", open: ""'),
    "D3 polish: rotation favorites are expanded by default but remain collapsible");
  check(!settingsThemeSrc.includes("const schemeSelect") &&
    settingsThemeSrc.includes('class: "scheme-apply"') &&
    settingsThemeSrc.includes('class: "scheme-star-toggle"') &&
    settingsThemeSrc.indexOf('localizedRow("interfaceStyle"') <
      settingsThemeSrc.indexOf('localizedRow("mode"'),
  "Appearance uses one apply/favorite scheme grid and starts with Interface style");
  check(dashboardThemeSrc.includes('class: `mode-choice tip${') &&
    dashboardThemeSrc.includes('title,') &&
    dashboardThemeSrc.includes('settingsModeChoiceLabel(choice.id)') &&
    dashboardThemeSrc.includes('settingsStatic.followingSystem(choice.tip)'),
    "D3 polish: all three sidebar appearance choices expose themed hover and focus tips");
  check(dashboardThemeSrc.indexOf('class: "side-vault-row"') <
    dashboardThemeSrc.indexOf('class: "appearance-row"'),
    "D3 polish: vault sync status occupies its own row above appearance controls");
  check(dashboardThemeSrc.includes('id: "sidebar-scheme-picker"') &&
    dashboardThemeSrc.includes("themePop") &&
    dashboardThemeSrc.includes('app.append(el("div", { class: "app" }, skipLink, sidebar, main, themePop), toast);') &&
    dashboardCssSrc.includes(".theme-pop { position: fixed;") &&
    dashboardCssSrc.includes("left: var(--nav-w, 204px); right: 0; bottom: 0;") &&
    dashboardCssSrc.includes('[data-nav="header"] .theme-pop { left: 0;') &&
    !dashboardThemeSrc.includes("setThemeSidebarTakeover") &&
    !dashboardThemeSrc.includes("child.inert = open"),
    "D3 polish: scheme picker is a content-only bottom sheet that leaves navigation and its trigger visible");
  check(dashboardThemeSrc.includes('class: "theme-favorites-list"') &&
    dashboardThemeSrc.includes('settingsStatic.schemePickerFavorites()') &&
    dashboardThemeSrc.includes('class: "theme-first-column"') &&
    dashboardThemeSrc.indexOf("favoritesSection") < dashboardThemeSrc.indexOf("catalogue)") &&
    dashboardCssSrc.includes(".theme-favorites-list, .theme-group-options { display: flex; flex-direction: column;") &&
    dashboardCssSrc.includes(".theme-opt-label { min-width: 0; overflow-wrap: anywhere;") &&
    settingsThemeSrc.includes('class: "scheme-favorite-label"'),
    "D3 polish: Favorites lead as a one-column list and scheme names remain readable without truncation");
  check(dashboardThemeSrc.includes("renderFavorites();") &&
    dashboardThemeSrc.includes("syncFavoriteButtons();") &&
    !dashboardThemeSrc.includes("renderCatalogue();\n              requestAnimationFrame") &&
    dashboardThemeSrc.includes("settings.uiScheme = s;\n              syncSelection();") &&
    !dashboardThemeSrc.includes("await patchSettings({ uiScheme: s });\n              closeThemePop();"),
    "D3 polish: favorite updates are local and choosing a scheme keeps the comparison sheet open");
  check(dashboardThemeSrc.includes('class: "theme-sheet-settings"') &&
    dashboardThemeSrc.includes('sheetSetting("interfaceStyle", "uiInterfaceStyle", "interfaceStyle")') &&
    dashboardThemeSrc.includes('sheetSetting("rotation", "schemeRotate", "rotation")') &&
    dashboardThemeSrc.includes('event.target.closest?.(".quick-theme")') &&
    dashboardThemeSrc.includes("closeThemePop();") &&
    dashboardCssSrc.includes(".theme-star { width: 28px; height: 30px;") &&
    dashboardCssSrc.includes("display: grid; place-items: center; padding: 0;"),
    "D3 polish: the sheet exposes compact style/rotation controls, aligned stars, and outside-click dismissal");
  check(dashboardCssSrc.includes("transform: translate3d(0, calc(100% + 18px), 0);") &&
    dashboardCssSrc.includes("animation: theme-sheet-in var(--motion-continuity) var(--ease-out) both") &&
    dashboardCssSrc.includes("@keyframes theme-sheet-out") &&
    dashboardCssSrc.includes("@keyframes theme-sheet-rail-in") &&
    dashboardCssSrc.includes("height: min(520px, calc(100vh - 72px));"),
    "D3 polish: the stable-height scheme sheet enters on the compositor with one centre-drawn boundary");
}

/* --- suspender URL unwrapping --- */
check(
  unwrapSuspendedUrl(
    "chrome-extension://abc/suspended.html#ttl=Foo&uri=https://example.com/page"
  ) === "https://example.com/page",
  "unwrap Great-Suspender-style uri="
);
check(
  unwrapSuspendedUrl("https://normal.com/x") === "https://normal.com/x",
  "normal URLs untouched"
);
check(
  unwrapSuspendedUrl("chrome-extension://abc/park.html?url=https%3A%2F%2Fa.com%2Fb") ===
    "https://a.com/b",
  "unwrap encoded url= param"
);
// F19 follow-up: a suspender that packs the favicon after the uri must NOT leak it
// into the real URL (the "…&icon=data:image/…base64,…" long-line bug).
check(
  unwrapSuspendedUrl(
    "chrome-extension://abc/suspended.html#uri=https%3A%2F%2Fwww.tiktok.com%2Fdiscover%2Foura-ring" +
    "&icon=data:image/png;base64,iVBORw0KGgoAAAANSUhEUg"
  ) === "https://www.tiktok.com/discover/oura-ring",
  "unwrap drops a trailing &icon= data-URI from an ENCODED uri"
);
check(
  unwrapSuspendedUrl(
    "chrome-extension://abc/suspended.html#uri=https://tiktok.com/x&icon=data:image/png;base64,iVBOR"
  ) === "https://tiktok.com/x",
  "unwrap drops a trailing &icon= data-URI from an UNENCODED uri"
);
check(
  unwrapSuspendedUrl("chrome-extension://abc/suspended.html#uri=https%3A%2F%2Fa.com%2F%3Fq%3D1%26r%3D2") ===
    "https://a.com/?q=1&r=2",
  "unwrap preserves a real (encoded) query string with its own &"
);
check(
  unwrapSuspendedUrl("chrome-extension://abc/suspended.html#uri=https://site.com/?icon=star") ===
    "https://site.com/?icon=star",
  "unwrap keeps a legit &icon= query value that is not a data URI"
);

/* --- snapshots: capture, dedupe, prune --- */
mockWindows = [
  {
    id: 1,
    tabs: [
      { id: 11, index: 0, url: "https://a.com", title: "A", pinned: true },
      { id: 12, index: 1, url: "", pendingUrl: "https://b.com", title: "B (asleep)" },
      { id: 13, index: 2, url: "chrome://settings", title: "settings" },
      {
        id: 15,
        index: 3,
        url: "file:///Users/example/irreplaceable.html",
        title: "Irreplaceable local page"
      },
      {
        id: 14,
        index: 4,
        url: "chrome-extension://abc/suspended.html#uri=https://c.com",
        title: "C (suspended)"
      }
    ]
  },
  { id: 2, tabs: [{ id: 21, index: 0, url: "https://d.com", title: "D" }] }
];

const snap1 = await takeSnapshot();
check(snap1 !== null, "first snapshot created");
check(snap1.windows.length === 2, "two windows captured");
check(
  JSON.stringify(snap1.windows[0].map((t) => t.url)) ===
    JSON.stringify([
      "https://a.com", "https://b.com", "file:///Users/example/irreplaceable.html", "https://c.com"
    ]),
  "asleep, local-file, and suspended tabs captured while chrome:// stays excluded"
);
check(snap1.windows[0][0].pinned === true, "pinned flag captured");

const snap2 = await takeSnapshot();
check(snap2 === null, "unchanged state → no duplicate snapshot");

mockWindows[1].tabs.push({ id: 22, index: 1, url: "https://e.com", title: "E" });
const snap3 = await takeSnapshot();
check(snap3 !== null, "changed state → new snapshot");

// A legacy explicit snapshotKeep 0 reads as the 1000 maximum: well above six.
mem.settings = { snapshotKeep: 0, snapshotEveryMinutes: 15 };
for (let i = 0; i < 4; i++) {
  mockWindows[1].tabs.push({ id: 30 + i, index: 2 + i, url: `https://f${i}.com`, title: "F" });
  await takeSnapshot();
}
let autosLeft = (await listItems(STORE_KEYS.sessions)).filter((s) => s.auto);
check(autosLeft.length === 6, `legacy 0 keeps all six under the 1000 maximum (got ${autosLeft.length})`);
check(mem.settings.snapshotKeep === 0, "the stored legacy 0 is not rewritten by Snapshot capture");

// opt-in pruning: keep=2
mem.settings = { snapshotKeep: 2, snapshotEveryMinutes: 15 };
mockWindows[1].tabs.push({ id: 40, index: 9, url: "https://g.com", title: "G" });
await takeSnapshot();
autosLeft = (await listItems(STORE_KEYS.sessions)).filter((s) => s.auto);
check(autosLeft.length === 2, `opt-in prune keeps 2 (got ${autosLeft.length})`);

/* --- named session + restore with pinned --- */
const named = await saveAllWindowsAsSession("My project");
check(named.name === "My project" && named.auto === false, "named session saved");

createdWindows = [];
await restoreWindowRefs(named.windows[0]);
check(createdWindows.length === 1, "restore creates one window");
check(
  createdWindows[0].tabs.length === named.windows[0].length,
  "restore opens all tabs of the window"
);

/* --- JSON export / import merge --- */
const exportedOverlayItem = {
  ...(await newMeta()),
  kind: "tab",
  tabs: [{ url: "https://overlay-export.example", title: "Overlay export" }],
  source: "manual",
  labels: ["exported"],
  archivedAt: Date.now()
};
mem[ARCHIVE_OVERLAY_KEY] = { [exportedOverlayItem.id]: exportedOverlayItem };
const exported = await buildJsonExport();
check(
  JSON.parse(exported).data.archive[exportedOverlayItem.id]?.tabs[0].url ===
    "https://overlay-export.example" &&
    !(ARCHIVE_OVERLAY_KEY in JSON.parse(exported).data),
  "E3 Archive overlay: JSON export emits one merged logical Archive and no physical overlay"
);
const sessionsBefore = (await listItems(STORE_KEYS.sessions)).length;

// wipe and re-import
for (const k of Object.values(STORE_KEYS)) delete mem[k];
delete mem[ARCHIVE_OVERLAY_KEY];
const res1 = await importJson(exported);
check(
  (await listItems(STORE_KEYS.sessions)).length === sessionsBefore,
  "import restores sessions after wipe"
);
check(
  (await listItems(STORE_KEYS.archive)).some((item) => item.id === exportedOverlayItem.id) &&
    Object.keys(mem[ARCHIVE_OVERLAY_KEY] ?? {}).length === 0,
  "E3 Archive overlay: JSON import restores the merged Archive and leaves no pending overlay"
);
const res2 = await importJson(exported);
check(res2.imported === 0, `re-import is a no-op (imported ${res2.imported})`);

// newer-wins: tamper a local session to be newer, then import the old export
const sessions = await listItems(STORE_KEYS.sessions);
const target = sessions[0];
await upsertItem(STORE_KEYS.sessions, { ...target, name: "RENAMED LOCALLY" });
await importJson(exported);
const after = (await listItems(STORE_KEYS.sessions)).find((s) => s.id === target.id);
check(after.name === "RENAMED LOCALLY", "newer local copy survives import");

/* --- OneTab round-trip --- */
const items = await parseOneTabImport(
  "https://x.com/1 | Page One\nhttps://x.com/2 | Page Two\n\nhttps://y.com | Solo"
);
check(items.length === 2, "OneTab import: two groups");
check(items[0].kind === "window" && items[0].tabs.length === 2, "group of 2 = window bundle");
check(items[1].kind === "tab", "single line = tab item");
const oneTabText = buildOneTabExport(items);
check(
  (await parseOneTabImport(oneTabText)).length === 2,
  "OneTab export → import round-trip"
);
check(
  (await parseOneTabImport("garbage line\n\nalso not a url")).length === 0,
  "non-URL lines ignored"
);

/* --- per-tab removal from inbox items --- */
const bundle = {
  ...(await newMeta()),
  kind: "window",
  tabs: [
    { url: "https://t1.com", title: "T1" },
    { url: "https://t2.com", title: "T2" }
  ],
  source: "dump",
  labels: []
};
await upsertItem(STORE_KEYS.inbox, bundle);
await removeTabFromInboxItem(bundle, 0);
let inboxNow = await listItems(STORE_KEYS.inbox);
const shrunk = inboxNow.find((i) => i.id === bundle.id);
check(
  shrunk.tabs.length === 1 && shrunk.tabs[0].url === "https://t2.com" && shrunk.kind === "tab",
  "removing a tab shrinks bundle and downgrades kind"
);
await removeTabFromInboxItem(shrunk, 0);
inboxNow = await listItems(STORE_KEYS.inbox);
check(!inboxNow.some((i) => i.id === bundle.id), "removing last tab tombstones the item");

/* --- M2: universal search --- */
const {
  searchAll, parseScope, resolveScope, resolveScopeFromSnapshot, searchResultTarget,
  createSearchSnapshot, buildSearchSnapshot, buildPrimarySearchSnapshot,
  matchSearchSnapshot, createSearchSession,
  bindSearchSnapshotInvalidation, createRunGeneration,
  SEARCH_STORE_KEYS, SEARCH_DEBOUNCE_MS
} = await import("../js/lib/search.js");
const { searchResultMeta } = await import("../js/lib/search-copy.js");

/* --- E3-5: one invalidated search snapshot per active interaction --- */
check(
  typeof createSearchSnapshot === "function" &&
    typeof buildPrimarySearchSnapshot === "function" &&
    typeof matchSearchSnapshot === "function" &&
    typeof createSearchSession === "function" &&
    typeof bindSearchSnapshotInvalidation === "function",
  "E3-5 contract: search exposes one DOM-free snapshot, matcher, session, and invalidation seam"
);
check(SEARCH_DEBOUNCE_MS >= 80 && SEARCH_DEBOUNCE_MS <= 100,
  `E3-5: input debounce is within the approved 80–100 ms window (${SEARCH_DEBOUNCE_MS} ms)`);

if (typeof createSearchSnapshot === "function") {
  const suspended = chrome.runtime.getURL(
    "suspend.html?uri=" + encodeURIComponent("https://same.example/path/") +
    "&title=" + encodeURIComponent("Suspended same")
  );
  const searchFixture = createSearchSnapshot({
    openTabs: [
      { id: 701, windowId: 7, url: suspended, title: "Suspended shell" },
      { id: 702, windowId: 7, url: "https://and.example/docs", title: "Claude guide" }
    ],
    starred: [{
      id: "star", modifiedAt: 7, url: "https://star.example", title: "Launchpad"
    }],
    inbox: [{
      id: "i", modifiedAt: 6, kind: "tab", labels: [],
      tabs: [
        { url: "https://same.example/path", title: "Saved duplicate" },
        { url: "https://label.example", title: "Plain", labels: ["Research"] }
      ]
    }],
    snoozes: [{
      id: "z", modifiedAt: 5, url: "https://z.example", title: "Needle snoozed"
    }],
    archive: [{
      id: "a", modifiedAt: 4, kind: "tab", labels: [],
      tabs: [{ url: "https://a.example", title: "Needle archive" }]
    }],
    collections: [{
      id: "c", modifiedAt: 3, name: "Legacy",
      tabs: [{ url: "https://c.example", title: "Needle collection" }]
    }],
    sessions: [
      {
        id: "s", modifiedAt: 2, name: "Named", auto: false, createdAt: Date.now() - 60_000,
        windows: [[{ url: "https://s.example", title: "Needle session" }]]
      },
      {
        id: "snap", modifiedAt: 1, name: "Auto", auto: true, createdAt: Date.now() - 60_000,
        windows: [[{ url: "https://snap.example", title: "Needle snapshot" }]]
      }
    ]
  });
  const precedence = await matchSearchSnapshot(searchFixture, "same");
  check(precedence.length === 1 && precedence[0].type === "open" &&
      precedence[0].url === "https://same.example/path/",
    "E3-5 characterization: canonical suspended Open wins normalized-URL dedup precedence");
  check((await matchSearchSnapshot(searchFixture, "launchpad"))[0]?.type === "starred",
    "F22/E3-5: universal search includes Starred shortcuts");
  check((await matchSearchSnapshot(searchFixture, "claude docs")).length === 1 &&
      (await matchSearchSnapshot(searchFixture, "docs missing")).length === 0 &&
      (await matchSearchSnapshot(searchFixture, "research")).some((r) => r.type === "inbox"),
    "E3-5 characterization: snapshot matching preserves multi-term AND and label text");
  const presented = await matchSearchSnapshot(searchFixture, "needle");
  check(presented.map((r) => r.type).join(",") ===
      "snoozed,archive,collection,session,session" &&
      presented[3].sourceName === "Named" &&
      presented[4].snapshot === true &&
      presented[4].sourceCreatedAt > 0 &&
      searchResultMeta(presented[4]).startsWith("Snapshot · "),
    "E3-5 characterization: snapshot matching preserves source order and session/snapshot presentation");
  check((await matchSearchSnapshot(searchFixture, "label:research")).length === 1 &&
      (await matchSearchSnapshot(searchFixture, "in:inbox")).length === 2,
    "E3-5 characterization: label/in scope resolution and empty-query browsing share the snapshot");

  const oneCharacterFixture = createSearchSnapshot({
    openTabs: [
      ...Array.from({ length: 7 }, (_, i) => ({
        id: 900 + i, windowId: 9, url: `https://open-${i}.example`, title: `Alpha open ${i}`
      })),
      { id: 910, windowId: 9, url: "https://middle.example", title: "Catalog" },
      { id: 911, windowId: 9, url: "https://alpha-url-only.example", title: "" }
    ],
    starred: [
      { url: "https://star-1.example", title: "Alpha star one" },
      { url: "https://star-2.example", title: "Read Alpha later" },
      { url: "https://open-0.example", title: "Alpha duplicate" }
    ],
    inbox: [{ id: "one-i", tabs: [{ url: "https://inbox-one.example", title: "Alpha inbox" }] }],
    archive: [{ id: "one-a", tabs: [{ url: "https://archive-one.example", title: "Alpha archive" }] }],
    sessions: [{ id: "one-s", name: "Alpha session", auto: false,
      windows: [[{ url: "https://session-one.example", title: "Alpha session tab" }]] }]
  });
  let oneCharacterHistoryCalls = 0;
  chrome.history = { search: async () => { oneCharacterHistoryCalls++; return [
    { url: "https://history-one.example", title: "Alpha history" }
  ]; } };
  const oneCharacter = await matchSearchSnapshot(oneCharacterFixture, "a", { includeHistory: true });
  delete chrome.history;
  check(oneCharacter.length === 8 &&
      oneCharacter.slice(0, 7).every((result) => result.type === "open") &&
      oneCharacter[7]?.type === "starred" &&
      !oneCharacter.some((result) => ["inbox", "archive", "session", "history"].includes(result.type)) &&
      oneCharacterHistoryCalls === 0,
    "P11-18: one character yields at most eight Open-then-Starred title-word starts without URL, saved, or History noise");
  check(!(await matchSearchSnapshot(oneCharacterFixture, "a")).some((result) =>
      result.url === "https://middle.example" || result.url === "https://alpha-url-only.example"),
    "P11-18: a one-character match does not come from the middle of a word or a URL-only title fallback");

  check(parseScope("session:Nam").type === "session" &&
      searchFixture.sessionNames.join(",") === "Named" &&
      resolveScopeFromSnapshot("session:Nam", searchFixture).scope?.value === "Named",
    "P11-20: session is a first-class prefix-resolved scope and Snapshots never become session values");
  const namedEntity = (await matchSearchSnapshot(searchFixture, "named"))[0];
  check(namedEntity?.type === "session-entity" && namedEntity.sessionId === "s" &&
        namedEntity.windowCount === 1 && namedEntity.tabCount === 1 &&
        JSON.stringify(searchResultTarget(namedEntity)) ===
          JSON.stringify({ type: "restore-session", sessionId: "s" }),
    "P11-19: a two-character-plus Session-name match leads with one exact restore entity and counts");
  const namedSessionBrowse = await matchSearchSnapshot(searchFixture, "", {
    scope: { type: "session", value: "Named" }
  });
  check(namedSessionBrowse.length === 2 && namedSessionBrowse[0]?.type === "session-entity" &&
      namedSessionBrowse[1]?.sourceName === "Named" &&
      !namedSessionBrowse.some((result) => result.snapshot),
    "P11-19/P11-20: a Session scope leads with Restore, then only its tabs, never Snapshots");

  const namedScopeFixture = createSearchSnapshot({
    inbox: [{ id: "deep", tabs: [{
      url: "https://deep.example", title: "Roadmap", labels: ["Deep Work"]
    }] }],
    sessions: [
      { id: "client", name: "Client review", auto: false,
        windows: [
          [{ url: "https://client.example/roadmap", title: "Roadmap" }],
          [{ url: "https://client.example/notes", title: "Notes" }]
        ] },
      { id: "word", name: "Project Client", auto: false, windows: [[]] },
      { id: "partial", name: "Preclient archive", auto: false, windows: [[]] },
      { id: "fourth", name: "Client extras", auto: false, windows: [[]] },
      { id: "auto-client", name: "Client snapshot", auto: true, windows: [[]] }
    ]
  });
  const rankedSessions = await matchSearchSnapshot(namedScopeFixture, "client");
  check(rankedSessions.slice(0, 3).map((result) => result.sessionId).join(",") ===
      "client,word,fourth" &&
      rankedSessions.slice(0, 3).every((result) => result.type === "session-entity") &&
      !rankedSessions.some((result) => result.sessionId === "auto-client"),
    "P11-19: Session entities rank exact, word-start, then partial, cap at three, and exclude Snapshots");
  const spacedSession = resolveScopeFromSnapshot(
    "session:Client review Roadmap", namedScopeFixture
  );
  check(spacedSession.scope?.value === "Client review" && spacedSession.query === "Roadmap" &&
      resolveScopeFromSnapshot("label:Deep Work", namedScopeFixture).scope?.value === "Deep Work",
    "P11-20: readable multiword Session and label completions resolve by their longest known name");
  const scopedOneCharacter = await matchSearchSnapshot(namedScopeFixture, "r", {
    scope: { type: "session", value: "Client review" }
  });
  check(scopedOneCharacter.length === 1 && scopedOneCharacter[0]?.sessionId === "client",
    "P11-19: one scoped character keeps the Restore entity while suppressing noisy tab matches");

  const capFixture = createSearchSnapshot({
    openTabs: Array.from({ length: 60 }, (_, i) => ({
      id: 800 + i, windowId: 8, url: `https://cap-${i}.example/needle`, title: `Needle ${i}`
    }))
  });
  check((await matchSearchSnapshot(capFixture, "needle")).length === 50,
    "E3-5 characterization: snapshot matching preserves the universal 50-result cap");

  let historyCalls = 0;
  chrome.history = {
    search: async () => {
      historyCalls += 1;
      throw new Error("permission revoked");
    }
  };
  await matchSearchSnapshot(searchFixture, "needle", { includeHistory: false });
  const quietHistory = await matchSearchSnapshot(searchFixture, "needle", { includeHistory: true });
  check(historyCalls === 1 && quietHistory.length === presented.length,
    "E3-5 characterization: History stays opt-in/query-driven and revocation fails quiet");
  delete chrome.history;

  let builds = 0;
  const oneSession = createSearchSession({
    buildSnapshot: async () => { builds++; return searchFixture; }
  });
  await oneSession.getSnapshot(); // focus/ghost warm
  await oneSession.search("needle");
  await oneSession.search("claude");
  check(builds === 1,
    "E3-5 measurement: one focus session builds once; two later queries perform zero source rebuilds");

  const progressivePrimary = createSearchSnapshot({
    openTabs: [{
      id: 1201, windowId: 12, url: "https://primary.example/needle", title: "Needle primary"
    }]
  });
  const progressiveComplete = createSearchSnapshot({
    openTabs: [{
      id: 1201, windowId: 12, url: "https://primary.example/needle", title: "Needle primary"
    }],
    sessions: [{
      id: "progressive-snapshot", name: "Automatic", auto: true, createdAt: 1,
      windows: [[{ url: "https://secondary.example/needle", title: "Needle secondary" }]]
    }]
  });
  const progressiveSession = createSearchSession({
    buildSnapshot: async () => progressiveComplete,
    buildPrimarySnapshot: async () => progressivePrimary,
    buildCompletionSnapshot: async () => progressiveComplete
  });
  const progressive = await progressiveSession.searchProgressively("needle");
  check(progressive.results.length === 1 && progressive.results[0]?.type === "open" &&
      progressive.complete instanceof Promise &&
      (await progressive.complete)?.map((result) => result.type).join(",") === "open,session",
    "B8: progressive Search publishes ordinary sources first, then preserves exact Snapshot completion order");

  let sharedCompletionBuilds = 0;
  const sharedCompletionSession = createSearchSession({
    buildSnapshot: async () => progressiveComplete,
    buildPrimarySnapshot: async () => progressivePrimary,
    buildCompletionSnapshot: async () => {
      sharedCompletionBuilds += 1;
      return progressiveComplete;
    }
  });
  const completeDomains = await sharedCompletionSession.scopeNames("domain");
  const sharedProgressive = await sharedCompletionSession.searchProgressively("needle");
  await sharedProgressive.complete;
  check(completeDomains.includes("secondary.example") && sharedCompletionBuilds === 1,
    "Search completion shares one transient Session/Snapshot build with complete facets in a generation");
  sharedCompletionSession.invalidate();
  await sharedCompletionSession.scopeNames("domain");
  check(sharedCompletionBuilds === 2,
    "Search completion reuse ends at invalidation so later facets read current saved data");

  let releaseCompletion;
  const heldCompletion = new Promise((resolve) => { releaseCompletion = resolve; });
  const staleProgressiveSession = createSearchSession({
    buildSnapshot: async () => progressiveComplete,
    buildPrimarySnapshot: async () => progressivePrimary,
    buildCompletionSnapshot: async () => heldCompletion
  });
  const staleProgressive = await staleProgressiveSession.searchProgressively("needle");
  staleProgressiveSession.invalidate();
  releaseCompletion(progressiveComplete);
  check(await staleProgressive.complete === null,
    "B8: invalidation prevents a stale secondary Snapshot phase from publishing");

  let shortBuilds = 0;
  const shortSession = createSearchSession({
    buildSnapshot: async () => { shortBuilds++; return oneCharacterFixture; }
  });
  await shortSession.search("");
  check(shortBuilds === 0 && (await shortSession.search("a")).length === 8 && shortBuilds === 1,
    "P11-18: empty unscoped Search keeps its zero-read exit while one character builds exactly one snapshot");

  let releaseOld;
  const oldBuild = new Promise((resolve) => { releaseOld = resolve; });
  let buildNumber = 0;
  const guardedSession = createSearchSession({
    buildSnapshot: () => ++buildNumber === 1 ? oldBuild : Promise.resolve(capFixture)
  });
  const pendingSnapshot = guardedSession.getSnapshot();
  guardedSession.invalidate();
  releaseOld(searchFixture);
  check((await pendingSnapshot) === capFixture && buildNumber === 2,
    "E3-5: invalidation during an in-flight build cannot publish the stale snapshot");

  const listeners = () => {
    const set = new Set();
    return {
      addListener: (fn) => set.add(fn),
      removeListener: (fn) => set.delete(fn),
      fire: (...args) => { for (const fn of set) fn(...args); }
    };
  };
  const storageChanged = listeners();
  const tabCreated = listeners();
  const tabUpdated = listeners();
  const tabRemoved = listeners();
  const tabMoved = listeners();
  const tabAttached = listeners();
  const tabDetached = listeners();
  const tabReplaced = listeners();
  const windowCreated = listeners();
  const windowRemoved = listeners();
  const invalidationChrome = {
    storage: { onChanged: storageChanged },
    tabs: {
      onCreated: tabCreated, onUpdated: tabUpdated, onRemoved: tabRemoved,
      onMoved: tabMoved, onAttached: tabAttached, onDetached: tabDetached,
      onReplaced: tabReplaced
    },
    windows: { onCreated: windowCreated, onRemoved: windowRemoved }
  };
  let invalidationBuilds = 0;
  const invalidationSession = createSearchSession({
    buildSnapshot: async () => { invalidationBuilds++; return searchFixture; }
  });
  const unbind = bindSearchSnapshotInvalidation(invalidationSession, invalidationChrome);
  await invalidationSession.search("needle");
  storageChanged.fire({ unrelated: { newValue: 1 } }, "local");
  await invalidationSession.search("needle");
  check(invalidationBuilds === 1,
    "E3-5: unrelated storage changes do not invalidate the search snapshot");
  for (const key of SEARCH_STORE_KEYS) {
    storageChanged.fire({ [key]: { newValue: {} } }, "local");
    await invalidationSession.search("needle");
  }
  check(invalidationBuilds === 1 + SEARCH_STORE_KEYS.length,
    "E3-5: every searched store key invalidates before the next query");
  storageChanged.fire({ [ARCHIVE_OVERLAY_KEY]: { newValue: {} } }, "local");
  await invalidationSession.search("needle");
  check(invalidationBuilds === 2 + SEARCH_STORE_KEYS.length,
    "E3 Archive overlay: its physical-key change invalidates the logical Archive search source");
  const beforeV2Revision = invalidationBuilds;
  storageChanged.fire({ storageV2Revision: { newValue: {
    id: "remote-session-revision",
    changedKeys: [STORE_KEYS.sessions]
  } } }, "local");
  await invalidationSession.search("needle");
  check(invalidationBuilds === beforeV2Revision + 1,
    "storage revision pulses invalidate Search after a remote Session pull");
  const beforeBrowserEvents = invalidationBuilds;
  tabUpdated.fire(701, { title: "Changed" }, {});
  await invalidationSession.search("needle");
  windowRemoved.fire(7);
  await invalidationSession.search("needle");
  check(invalidationBuilds === beforeBrowserEvents + 2,
    "E3-5 measurement: representative tab and window events each force one rebuild");
  unbind();

  const runGate = createRunGeneration();
  const older = runGate.next();
  const newer = runGate.next();
  check(!older.isCurrent() && newer.isCurrent(),
    "E3-5: a slower earlier query cannot publish rows after a newer run starts");
}

// F14-2e/F20: one pure interpretation of a search result for every host.
const targetInput = { type: "open", url: "https://open.example", tabId: 17, windowId: 4 };
const targetBefore = JSON.stringify(targetInput);
check(
  JSON.stringify(searchResultTarget(targetInput)) ===
    JSON.stringify({ type: "focus-tab", tabId: 17, windowId: 4 }),
  "F14-2e seam: an open result targets its exact live tab + window"
);
check(JSON.stringify(targetInput) === targetBefore,
  "F14-2e seam: mapping does not mutate the search result");
for (const type of ["inbox", "snoozed", "archive", "collection", "session", "history"]) {
  check(
    JSON.stringify(searchResultTarget({ type, url: `https://${type}.example` })) ===
      JSON.stringify({ type: "open-url", url: `https://${type}.example` }),
    `F14-2e seam: ${type} targets its saved URL`
  );
}
check(
  JSON.stringify(searchResultTarget({ type: "starred", url: "https://starred.example" })) ===
    JSON.stringify({ type: "activate-starred", url: "https://starred.example" }),
  "F22: a Starred search result uses switch-if-live launch semantics"
);
check(searchResultTarget({ type: "open", url: "https://do-not-degrade.example" }) === null &&
      searchResultTarget({ type: "session-entity", title: "Missing id" }) === null &&
      searchResultTarget({ type: "unknown", url: "https://do-not-guess.example" }) === null &&
      searchResultTarget(null) === null,
  "F14-2e seam: malformed/unknown results safely no-op instead of guessing");

{
  const { readFileSync } = await import("node:fs");
  const searchSrc = readFileSync(new URL("../js/lib/search.js", import.meta.url), "utf8");
  const boxSrc = readFileSync(new URL("../js/ui/searchbox.js", import.meta.url), "utf8");
  const dashboardSrc = readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
  const manifestSrc = readFileSync(new URL("../manifest.json", import.meta.url), "utf8");
  const backgroundSrc = readFileSync(new URL("../js/background.js", import.meta.url), "utf8");
  const omniboxOwnerSrc = readFileSync(
    new URL("../js/background/omnibox-owner.js", import.meta.url), "utf8"
  );
  const seamBody = searchSrc.match(/export function searchResultTarget\(result\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const commitBody = boxSrc.match(
    /async function commitCurrentInput\(\) \{([\s\S]*?)\n  \}/
  )?.[1] ?? "";
  check(seamBody && !/chrome\.|document\.|window\./.test(seamBody),
    "F14-2e seam: searchResultTarget is pure and DOM/Chrome-free");
  check(/import \{[^}]*searchResultTarget[^}]*\} from "\.\.\/lib\/search\.js"/.test(boxSrc) &&
        /const target = searchResultTarget\(r\);[\s\S]*?if \(target\) chrome\.runtime\.sendMessage\(target\)/.test(boxSrc) &&
        /opts\.navigate \?\?/.test(boxSrc),
    "F14-2e seam: universal result click/Enter uses the seam; typed fallback stays separate");
  check(boxSrc.includes("searchResultAction(r.type)") &&
        /searchResultMeta\(r\)/.test(boxSrc),
    "P11-19: shared Search renders a Restore action with Session window and tab counts");
  check(/hasHistoryAccess\(\)/.test(boxSrc) &&
        /includeHistory/.test(boxSrc) && !/requestHistoryAccess/.test(boxSrc),
    "E3-5: search only checks optional History permission and never requests it");
  check(/e\.key === "ArrowDown"/.test(boxSrc) && /e\.key === "ArrowUp"/.test(boxSrc) &&
        /e\.key === "Enter"/.test(boxSrc) && /e\.key === "Escape"/.test(boxSrc) &&
        /e\.key === "Backspace"/.test(boxSrc) && /showGhosts\(\)/.test(boxSrc) &&
        /scopeSuggestions\(input\.value\)/.test(boxSrc),
    "E3-5 characterization: keyboard selection, Enter/Esc ladder, ghosts, and scope suggestions remain wired");
  check(/runGeneration\.invalidate\(\);[\s\S]*?clearPendingRows\(\);[\s\S]*?inputPreparation =/.test(boxSrc) &&
        /clearPendingRows\(\{ preserveVisible: true \}\);[\s\S]*?timer = setTimeout\(run, SEARCH_DEBOUNCE_MS\);[\s\S]*?inputPreparation =/.test(boxSrc) &&
        /setResultsPending\(true\)/.test(boxSrc) &&
        /searchSession\.searchProgressively\(/.test(boxSrc) &&
        /await inputPreparation/.test(commitBody) && /await run\(true\)/.test(commitBody) &&
        /activateEntry\(rowEntries\[selectedIndex\]\)/.test(commitBody) &&
        !/browserHandoffForInput/.test(commitBody),
    "P11-21/B8 regression: a query retires stale rows, starts its debounce before scope reads, and fast Enter waits for proven local results");
  check(/handoffPending/.test(boxSrc) && /handoffGeneration !== inputGeneration/.test(boxSrc) &&
        boxSrc.includes('msg("search_web_failure")') && boxSrc.includes('msg("action_try_again")'),
    "P11-21 regression: web handoff is single-flight and a current failure remains retryable in place");
  check(!dashboardSrc.includes("openSmartResult") &&
        !dashboardSrc.includes('makeSec("smartviews")'),
    "F14-2e seam/F45: retired Smart Views leave no Dashboard-local result dispatch");
  check(/"omnibox"\s*:/.test(manifestSrc) &&
        /installOmniboxOwner/.test(backgroundSrc) &&
        /chrome\.omnibox\./.test(omniboxOwnerSrc),
    "F20: the shipped omnibox adapter consumes the F14-2e search-result seam");
}

/* ===== F20: `et` omnibox search ===== */
const {
  OMNIBOX_DEFAULT_SUGGESTION,
  escapeOmniboxText,
  encodeOmniboxTarget,
  decodeOmniboxTarget,
  formatOmniboxDescription,
  omniboxSuggestion,
  omniboxFilterCompletions,
  createOmniboxQueryController,
  omniboxTargetForInput,
  omniboxNavigationPlan,
  executeOmniboxPlan
} = await import("../js/lib/omnibox.js");

check(OMNIBOX_DEFAULT_SUGGESTION ===
  "Search every tab: try in:inbox, label:work, or domain:example.com",
"F20: default suggestion copy is exact");
check(escapeOmniboxText(`A&B <C> "D" 'E'`) ===
  "A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;",
"F20: suggestion text escapes all five XML entities");

const liveOmniboxContent = encodeOmniboxTarget({ type: "focus-tab", tabId: 17, windowId: 4 });
const savedOmniboxContent = encodeOmniboxTarget({
  type: "open-url", url: "https://example.com/path?q=a&next=b"
});
const sessionOmniboxContent = encodeOmniboxTarget({
  type: "restore-session", sessionId: "client review/id"
});
check(liveOmniboxContent === "everytab-result:focus:17:4" &&
      JSON.stringify(decodeOmniboxTarget(liveOmniboxContent)) ===
        JSON.stringify({ type: "focus-tab", tabId: 17, windowId: 4 }),
"F20: live suggestion content round-trips the exact tab and window");
check(JSON.stringify(decodeOmniboxTarget(savedOmniboxContent)) === JSON.stringify({
  type: "open-url", url: "https://example.com/path?q=a&next=b"
}), "F20: saved suggestion content round-trips its URL");
check(JSON.stringify(decodeOmniboxTarget(sessionOmniboxContent)) === JSON.stringify({
  type: "restore-session", sessionId: "client review/id"
}), "P11-19: Session suggestions round-trip a stateless exact restore identity");
check(decodeOmniboxTarget("everytab-result:url:javascript%3Aalert(1)") === null &&
      decodeOmniboxTarget("everytab-result:focus:-1:4") === null &&
      decodeOmniboxTarget("everytab-result:session:") === null &&
      decodeOmniboxTarget("plain query") === null,
"F20: forged unsafe, invalid, and raw-query content safely no-op");

const described = formatOmniboxDescription({
  type: "open",
  title: `A&B <C> "D" 'E'`,
  url: "https://example.com/?a=1&b=2",
  sourceName: "Work & play"
});
check(described.includes("<match>Switch</match>") &&
      described.includes("A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;") &&
      described.includes("<dim>Open tab · Work &amp; play</dim>") &&
      described.includes("<url>https://example.com/?a=1&amp;b=2</url>"),
"F20: descriptions distinguish live switching and escape every result-owned field");
const savedSuggestion = omniboxSuggestion({
  type: "history", title: "Docs", url: "https://docs.example"
});
check(savedSuggestion?.description.startsWith("<match>Open</match>") &&
      savedSuggestion.content.startsWith("everytab-result:url:"),
"F20: saved/history suggestions advertise Open and carry a stable URL identity");
const restoredSuggestion = omniboxSuggestion({
  type: "session-entity", title: "Client & review", sessionId: "client",
  windowCount: 1, tabCount: 18
});
check(restoredSuggestion?.content === "everytab-result:session:client" &&
      restoredSuggestion.description ===
        "<match>Restore</match> Client &amp; review <dim>1 window · 18 tabs</dim>" &&
      !restoredSuggestion.description.includes("<url>"),
  "P11-19: Session entities advertise Restore with pluralized counts and no fake URL");

const filterCompletions = await omniboxFilterCompletions("s", async (kind) =>
  kind === "session" ? ["Client review", "Personal"] : []
);
const narrowedCompletion = await omniboxFilterCompletions("label:deep", async (kind) =>
  kind === "label" ? ["Work", "Deep Work"] : []
);
check(filterCompletions.map((item) => item.content).join(",") ===
      "session:Client review,session:Personal" &&
      filterCompletions[0].description.startsWith("<match>Restore</match>") &&
      narrowedCompletion[0]?.content === "label:Deep Work" &&
      narrowedCompletion[0]?.description.startsWith("<match>Filter</match>"),
  "P11-20: `et` exposes real Session and filter values from the first keyword character");

{
  const many = Array.from({ length: 12 }, (_, i) => ({
    type: "history", title: `Result ${i}`, url: `https://result-${i}.example`
  }));
  let includeHistory = null;
  const controller = createOmniboxQueryController({
    hasHistory: async () => true,
    search: async (_query, opts) => { includeHistory = opts.includeHistory; return many; }
  });
  const result = await controller.run("docs");
  check(result.accepted && result.suggestions.length === 10 && includeHistory === true,
    "F20: suggestions reuse optional-history state and cap at 10");
  check((await controller.run(" ")).suggestions.length === 0,
    "F20: an empty omnibox query returns no suggestions");

  const mergedController = createOmniboxQueryController({
    hasHistory: () => false,
    scopeNames: async (kind) => kind === "label"
      ? ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]
      : kind === "session" ? ["Client review"] : [],
    search: async (query) => query === "s"
      ? [
          { type: "session-entity", title: "Client review", sessionId: "client",
            windowCount: 2, tabCount: 8 },
          ...many
        ]
      : many
  });
  const mergedFilters = await mergedController.run("l");
  const mergedSession = await mergedController.run("s");
  check(mergedFilters.suggestions.length === 10 &&
        mergedFilters.suggestions.slice(0, 4).every((item) => item.content.startsWith("label:")) &&
        mergedFilters.suggestions[4].content.startsWith("everytab-result:url:"),
    "P11-20: four actionable `et` completions lead and ordinary results fill the 10-row budget");
  check(mergedSession.suggestions[0]?.content === "session:Client review" &&
        mergedSession.suggestions.filter((item) =>
          item.description.includes("Client review")).length === 1,
    "P11-19/P11-20: a readable Session completion suppresses its duplicate restore entity row");

  const pending = [];
  const staleController = createOmniboxQueryController({
    hasHistory: () => false,
    search: (query) => new Promise((resolve) => pending.push({ query, resolve }))
  });
  const older = staleController.run("older");
  const newer = staleController.run("newer");
  await new Promise((resolve) => setImmediate(resolve));
  pending.find((item) => item.query === "newer").resolve([many[1]]);
  const newerResult = await newer;
  pending.find((item) => item.query === "older").resolve([many[0]]);
  const olderResult = await older;
  check(newerResult.accepted && !olderResult.accepted,
    "F20: a slow older query can never replace newer omnibox suggestions");

  const failed = createOmniboxQueryController({
    hasHistory: () => false,
    search: async () => { throw new Error("search unavailable"); }
  });
  check((await failed.run("docs")).accepted && (await failed.run("docs")).suggestions.length === 0,
    "F20: search failures fail quiet with an empty accepted result");
}

{
  let searches = 0;
  const selected = await omniboxTargetForInput(savedOmniboxContent, {
    hasHistory: () => false,
    search: async () => { searches++; return []; }
  });
  check(selected?.url === "https://example.com/path?q=a&next=b" && searches === 0,
    "F20: choosing a suggestion uses its exact identity without rerunning search");
  const raw = await omniboxTargetForInput("docs", {
    hasHistory: () => true,
    search: async (query, opts) => {
      searches++;
      return query === "docs" && opts.includeHistory
        ? [{ type: "open", url: "https://docs.example", tabId: 8, windowId: 3 }]
        : [];
    }
  });
  check(raw?.type === "focus-tab" && raw.tabId === 8 && searches === 1,
    "F20: raw Enter reruns the query and resolves its top result");
  const rawSession = await omniboxTargetForInput("session:Client review", {
    hasHistory: () => false,
    search: async (query) => query === "session:Client review"
      ? [{ type: "session-entity", title: "Client review", sessionId: "client",
          windowCount: 2, tabCount: 8 }]
      : []
  });
  check(rawSession?.type === "restore-session" && rawSession.sessionId === "client",
    "P11-19: accepting a readable Session completion reruns Search and restores its entity");
  check(JSON.stringify(await omniboxTargetForInput("missing", {
    hasHistory: () => false, search: async () => []
  })) === JSON.stringify({ type: "search-web", text: "missing" }),
  "P11-21: a successful raw `et` miss hands plain text to default-provider search");
  check(await omniboxTargetForInput("x", {
    hasHistory: () => false, search: async () => []
  }) === null && await omniboxTargetForInput("label:Missing", {
    hasHistory: () => false, search: async () => []
  }) === null && await omniboxTargetForInput("la", {
    hasHistory: () => false, search: async () => []
  }) === null, "P11-21: one-character, scoped, and partial-filter `et` misses stay quiet");
  check(JSON.stringify(await omniboxTargetForInput("docs.example/path", {
    hasHistory: () => false, search: async () => []
  })) === JSON.stringify({ type: "open-url", url: "https://docs.example/path" }),
  "P11-21: a raw URL-like `et` miss becomes direct navigation");
  check(await omniboxTargetForInput("private words", {
    hasHistory: () => { throw new Error("permission state unavailable"); },
    search: async () => []
  }) === null, "P11-21: a local Search failure never leaks raw input into web search");
}

check(omniboxNavigationPlan({ type: "focus-tab", tabId: 1, windowId: 2 },
  "newBackgroundTab").kind === "focus",
"F20: live results always switch to the exact tab regardless of disposition");
check(JSON.stringify(omniboxNavigationPlan(
  { type: "restore-session", sessionId: "client" }, "newBackgroundTab"
)) === JSON.stringify({ kind: "restore", sessionId: "client" }),
"P11-19: Session results restore independently of Chrome tab disposition");
check(JSON.stringify(omniboxNavigationPlan({ type: "open-url", url: "https://a.example" },
  "currentTab")) === JSON.stringify({ kind: "reuse", url: "https://a.example" }) &&
  omniboxNavigationPlan({ type: "open-url", url: "https://a.example" },
    "newForegroundTab").active === true &&
  omniboxNavigationPlan({ type: "open-url", url: "https://a.example" },
    "newBackgroundTab").active === false &&
  omniboxNavigationPlan({ type: "open-url", url: "javascript:alert(1)" }, "currentTab") === null,
"F20: saved results honor all three Chrome dispositions");
check(JSON.stringify(omniboxNavigationPlan(
  { type: "search-web", text: "planning notes" }, "currentTab"
)) === JSON.stringify({ kind: "search", text: "planning notes", disposition: "CURRENT_TAB" }) &&
  JSON.stringify(omniboxNavigationPlan(
    { type: "search-web", text: "planning notes" }, "newForegroundTab"
  )) === JSON.stringify({ kind: "search", text: "planning notes", disposition: "NEW_TAB" }) &&
  JSON.stringify(omniboxNavigationPlan(
    { type: "search-web", text: "planning notes" }, "newBackgroundTab"
  )) === JSON.stringify({ kind: "search-background", text: "planning notes" }),
"P11-21: raw `et` web searches preserve all three Chrome dispositions");

{
  const calls = [];
  const effects = {
    focus: async (target) => calls.push(["focus", target]),
    restoreSession: async (sessionId) => calls.push(["restore", sessionId]),
    searchWeb: async (queryInfo) => calls.push(["search", queryInfo]),
    getLastFocusedWindow: async () => ({
      id: 2, type: "normal", incognito: false,
      tabs: [{ id: 21, active: true }, { id: 22, active: false }]
    }),
    updateTab: async (id, props) => calls.push(["update", id, props]),
    createTab: async (props) => calls.push(["create", props])
  };
  await executeOmniboxPlan({ kind: "reuse", url: "https://reuse.example" }, effects);
  check(calls[0][0] === "update" && calls[0][1] === 21 && calls.length === 1,
    "F20: currentTab reuses only the active tab in the last-focused regular window");
  calls.length = 0;
  effects.getLastFocusedWindow = async () => ({
    id: 3, type: "normal", incognito: true, tabs: [{ id: 31, active: true }]
  });
  await executeOmniboxPlan({ kind: "reuse", url: "https://fallback.example" }, effects);
  check(calls[0][0] === "create" && calls[0][1].active === true,
    "F20: currentTab falls back to one active new tab for an unsafe window");
  calls.length = 0;
  await executeOmniboxPlan({ kind: "create", url: "https://bg.example", active: false }, effects);
  check(calls[0][0] === "create" && calls[0][1].active === false,
    "F20: background disposition creates an inactive tab");
  calls.length = 0;
  await executeOmniboxPlan({
    kind: "focus", target: { type: "focus-tab", tabId: 7, windowId: 9 }
  }, effects);
  check(calls[0][0] === "focus" && calls[0][1].tabId === 7 && calls[0][1].windowId === 9,
    "F20: live execution delegates to the shared worker wake/focus path");
  calls.length = 0;
  const restored = await executeOmniboxPlan({ kind: "restore", sessionId: "client" }, effects);
  effects.restoreSession = async () => false;
  const staleRestore = await executeOmniboxPlan({ kind: "restore", sessionId: "stale" }, effects);
  check(restored === true && calls.length === 1 && calls[0][0] === "restore" &&
        calls[0][1] === "client" && staleRestore === false,
    "P11-19: Session execution delegates once and propagates a stale restore failure");
  calls.length = 0;
  await executeOmniboxPlan({
    kind: "search", text: "current query", disposition: "CURRENT_TAB"
  }, effects);
  check(JSON.stringify(calls) === JSON.stringify([
    ["search", { text: "current query", disposition: "CURRENT_TAB" }]
  ]), "P11-21: current-tab `et` search delegates one provider-neutral query");
  calls.length = 0;
  effects.createTab = async (props) => { calls.push(["create", props]); return { id: 91 }; };
  effects.removeTab = async (tabId) => calls.push(["remove", tabId]);
  await executeOmniboxPlan({ kind: "search-background", text: "background query" }, effects);
  check(JSON.stringify(calls) === JSON.stringify([
    ["create", { active: false }], ["search", { text: "background query", tabId: 91 }]
  ]), "P11-21: background `et` search targets a genuinely inactive tab");
  calls.length = 0;
  effects.searchWeb = async () => { throw new Error("search failed"); };
  const failedBackgroundSearch = await executeOmniboxPlan({
    kind: "search-background", text: "failed query"
  }, effects);
  check(failedBackgroundSearch === false &&
        JSON.stringify(calls) === JSON.stringify([
          ["create", { active: false }], ["remove", 91]
        ]), "P11-21: a failed background search removes its blank staging tab");
}

{
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const backgroundSrc = readFileSync(new URL("../js/background.js", import.meta.url), "utf8");
  const omniboxSrc = readFileSync(new URL("../js/lib/omnibox.js", import.meta.url), "utf8");
  const adapter = readFileSync(
    new URL("../js/background/omnibox-owner.js", import.meta.url), "utf8"
  );
  check(manifest.omnibox?.keyword === "et",
    "F20 contract: manifest registers the exact `et` keyword");
  check(JSON.stringify(manifest.permissions) === JSON.stringify([
    "tabs", "favicon", "storage", "unlimitedStorage", "alarms", "notifications",
    "contextMenus", "search", "sessions", "sidePanel"
  ]) && manifest.optional_permissions.includes("history"),
  "P11-21 contract: default-provider handoff declares Search while History stays optional");
  check(/setDefaultSuggestion/.test(adapter) && /onInputChanged\.addListener/.test(adapter) &&
        /onInputEntered\.addListener/.test(adapter) && /onInputCancelled\.addListener/.test(adapter),
  "F20 contract: worker wires default, change, Enter, and cancellation events");
  check(/import \{ hasHistoryAccess \} from "\.\/lib\/history-access\.js"/.test(backgroundSrc) &&
        /hasHistory: omniboxHasHistory/.test(backgroundSrc) &&
        /restoreSession: navigationActions\.restoreSession/.test(backgroundSrc) &&
        /searchWeb: \(queryInfo\) => chrome\.search\.query\(queryInfo\)/.test(adapter) &&
        !/permissions\.request|windows\.remove|storage\.local\.set/.test(adapter),
  "F20/P11-21 contract: History is only checked and accepted actions use explicit effects");
  check(!/\bchrome\.(runtime|tabs|windows|permissions|omnibox)|\bdocument\./.test(omniboxSrc),
    "F20 contract: omnibox behavior helper stays DOM/Chrome-free");
}

// fresh, controlled state
for (const k of Object.values(STORE_KEYS)) delete mem[k];
delete mem.smartviewsSeeded;
mockWindows = [
  {
    id: 1,
    tabs: [
      { id: 11, index: 0, url: "https://github.com/acme/repo/pull/42", title: "Fix login PR" },
      { id: 12, index: 1, url: "https://youtube.com/watch?v=xyz", title: "Cool video" }
    ]
  },
  { id: 10, tabs: [
    { id: 101, windowId: 10, index: 0, pinned: false, url: "https://third.com", title: "Third" }
  ] }
];
createdWindows = [];
await upsertItem(STORE_KEYS.inbox, {
  ...(await newMeta()),
  kind: "tab",
  tabs: [{ url: "https://blog.example.com/login-design", title: "Login design patterns" }],
  source: "dump",
  labels: []
});
await upsertItem(STORE_KEYS.collections, {
  ...(await newMeta()),
  name: "Research",
  tabs: [{ url: "https://papers.example.com/login", title: "Login UX paper" }],
  labels: []
});

const res = await searchAll("login");
check(res.length === 3, `search finds 3 'login' results (got ${res.length})`);
check(res[0].type === "open" && res[0].tabId === 11, "open tab ranked first with tabId");
check(res.some((r) => r.type === "inbox"), "inbox result present");
check(
  res.some((r) => r.type === "collection" && r.sourceName === "Research"),
  "collection result carries source name"
);
const shortRes = await searchAll("l");
check(shortRes.length === 1 && shortRes[0].type === "open" && shortRes[0].tabId === 11,
  "P11-18: one character returns a high-confidence Open title-word match only");

// dedupe: same URL open and in inbox → only the open one
await upsertItem(STORE_KEYS.inbox, {
  ...(await newMeta()),
  kind: "tab",
  tabs: [{ url: "https://youtube.com/watch?v=xyz", title: "Cool video (saved)" }],
  source: "dump",
  labels: []
});
const dedup = await searchAll("cool video");
check(
  dedup.length === 1 && dedup[0].type === "open",
  "duplicate URL deduped, open tab wins"
);

/* --- coalesce: overlapping renders can't interleave --- */
const { coalesce } = await import("../js/ui/dom.js");
let active = 0;
let maxActive = 0;
let runs = 0;
const guarded = coalesce(async () => {
  active++;
  maxActive = Math.max(maxActive, active);
  runs++;
  await new Promise((r) => setTimeout(r, 5));
  active--;
});
guarded();
guarded();
guarded();
guarded();
await new Promise((r) => setTimeout(r, 50));
check(maxActive === 1, "coalesce: never two runs in flight");
check(runs === 2, `coalesce: burst of 4 calls → run + one trailing re-run (got ${runs})`);

/* --- M3: snooze presets & recurrence --- */
const { presetDue, nextOccurrence, recurrenceLabel, createSnooze, fireSnooze, sweepOverdueSnoozes } =
  await import("../js/lib/snooze.js");

const wed10 = new Date("2026-06-10T10:00:00"); // a Wednesday, 10:00
check(presetDue("later-today", wed10) === wed10.getTime() + 3 * 3600_000, "later-today = +3h");
check(
  new Date(presetDue("this-evening", wed10)).getHours() === 18 &&
    new Date(presetDue("this-evening", wed10)).getDate() === 10,
  "evening before 18:00 → today 18:00"
);
const wed20 = new Date("2026-06-10T20:00:00");
check(
  new Date(presetDue("this-evening", wed20)).getDate() === 11,
  "evening after 18:00 → tomorrow"
);
const tmrw = new Date(presetDue("tomorrow", wed10));
check(tmrw.getDate() === 11 && tmrw.getHours() === 9, "tomorrow 9:00");
const sat = new Date(presetDue("weekend", wed10));
check(sat.getDay() === 6 && sat.getDate() === 13, "weekend → Saturday 13th");
const mon = new Date(presetDue("next-week", wed10));
check(mon.getDay() === 1 && mon.getDate() === 15, "next-week → Monday 15th");
const satFromSat = new Date(presetDue("weekend", new Date("2026-06-13T10:00:00")));
check(satFromSat.getDate() === 20, "weekend from Saturday → NEXT Saturday");

const base = Date.parse("2026-06-01T09:00:00");
check(
  nextOccurrence(base, "daily", base + 3.5 * 24 * 3600_000) === base + 4 * 24 * 3600_000,
  "daily recurrence catches up past missed days"
);
check(
  nextOccurrence(base, "weekly", base) === base + 7 * 24 * 3600_000,
  "weekly recurrence advances one week"
);
// F3: new recurrence rules — every N weeks + specific weekday
check(
  nextOccurrence(base, "weeks:2", base) === base + 14 * 24 * 3600_000,
  "F3: weeks:2 advances a fortnight"
);
check(
  nextOccurrence(base, "weeks:3", base + 20 * 24 * 3600_000) === base + 21 * 24 * 3600_000,
  "F3: weeks:3 catches up past missed cycles"
);
const baseDow = new Date(base).getDay();
check(
  nextOccurrence(base, `weekday:${baseDow}`, base) === base + 7 * 24 * 3600_000,
  "F3: weekday recurrence → same weekday next week when already due"
);
const wdTarget = (baseDow + 3) % 7;
const wdNext = new Date(nextOccurrence(base, `weekday:${wdTarget}`, base));
check(
  wdNext.getDay() === wdTarget && wdNext.getTime() > base &&
    wdNext.getTime() - base <= 7 * 24 * 3600_000,
  "F3: weekday recurrence lands on the target weekday within a week"
);
check(
  nextOccurrence(base, "bogus", base) === base + 24 * 3600_000,
  "F3: unknown recurrence falls back to daily (never NaN / stuck)"
);
check(
  recurrenceLabel("weekday:1") === "Every Monday" && recurrenceLabel("weeks:2") === "Every 2 weeks" &&
    recurrenceLabel("daily") === "Daily" && recurrenceLabel("") === "",
  "F3: recurrenceLabel maps stored values to human labels"
);

/* --- M3: snooze lifecycle --- */
delete mem[STORE_KEYS.inbox];
delete mem[STORE_KEYS.snoozes];
mem.settings = { snoozeWakeQuiet: false };
createdTabs = [];

const sn = await createSnooze({
  url: "https://snoozed.example.com",
  title: "Snoozed page",
  dueAt: Date.now() + 3600_000
});
check(`snooze:${sn.id}` in alarms, "createSnooze schedules an alarm");
await fireSnooze(sn.id);
check(createdTabs.includes("https://snoozed.example.com"), "fire reopens the tab");
check(notifications.length === 1, "fire notifies");
check(
  !(await listItems(STORE_KEYS.snoozes)).some((s) => s.id === sn.id),
  "one-shot snooze tombstoned after firing"
);

// Retired quiet preference is preserved in storage but cannot change wake behavior.
mem.settings = { snoozeWakeQuiet: true };
createdTabs = [];
const sn2 = await createSnooze({ url: "https://quiet.example.com", title: "Quiet", dueAt: Date.now() - 1000 });
await sweepOverdueSnoozes();
const inboxAfterWake = await listItems(STORE_KEYS.inbox);
check(
  createdTabs.includes("https://quiet.example.com") &&
    !inboxAfterWake.some((i) => i.source === "snooze"),
  "retired quiet preference cannot stop an overdue snooze reopening its tab"
);

// recurring snooze reschedules instead of dying
mem.settings = { snoozeWakeQuiet: true };
createdTabs = [];
const rec = await createSnooze({
  url: "https://rec.example.com",
  title: "Recurring",
  dueAt: Date.now() - 1000,
  recurrence: "daily"
});
await fireSnooze(rec.id);
const recAfter = (await listItems(STORE_KEYS.snoozes)).find((s) => s.id === rec.id);
check(recAfter && recAfter.dueAt > Date.now() && createdTabs.includes("https://rec.example.com") &&
  !(await listItems(STORE_KEYS.inbox)).some((item) => item.source === "snooze"),
"recurring snooze reopens and reschedules even with the retired quiet preference stored");

// F3: a weekday-recurring snooze also reschedules (not tombstoned) when it fires
const wdSnooze = await createSnooze({
  url: "https://weekly.example.com", title: "Weekly standup",
  dueAt: Date.now() - 1000, recurrence: `weekday:${new Date().getDay()}`
});
await fireSnooze(wdSnooze.id);
const wdAfter = (await listItems(STORE_KEYS.snoozes)).find((s) => s.id === wdSnooze.id);
check(wdAfter && wdAfter.dueAt > Date.now(), "F3: weekday-recurring snooze reschedules after firing");

/* --- P2b-1: whole-window snooze (additive schema: Snooze.tabs[]) --- */
{
  const { recordAction, undoAction } = await import("../js/lib/journal.js");
  const winRefs = [
    { url: "https://w-a.com", title: "WA" },
    { url: "https://w-b.com", title: "WB" }
  ];

  // create: stores tabs[] + empty url; a single-tab snooze keeps no tabs (additive)
  delete mem[STORE_KEYS.snoozes];
  const winSnooze = await createSnooze({ title: "Window (2 tabs)", dueAt: Date.now() + 3600_000, tabs: winRefs });
  check(
    Array.isArray(winSnooze.tabs) && winSnooze.tabs.length === 2 && winSnooze.url === "",
    "P2b-1: window snooze stores tabs[] and empty url"
  );

  // fire (loud): reopens all tabs in one new window, then tombstones
  mem.settings = { snoozeWakeQuiet: false };
  createdWindows = [];
  await fireSnooze(winSnooze.id);
  check(
    createdWindows.length === 1 && createdWindows[0].tabs.length === 2,
    "P2b-1: firing a window snooze reopens all tabs in one new window"
  );
  check(
    !(await listItems(STORE_KEYS.snoozes)).some((s) => s.id === winSnooze.id),
    "P2b-1: one-shot window snooze tombstoned after firing"
  );

  // A stored legacy quiet preference no longer changes window wake behavior.
  mem.settings = { snoozeWakeQuiet: true };
  delete mem[STORE_KEYS.inbox];
  createdWindows = [];
  const winSnoozeQ = await createSnooze({ title: "Window (2 tabs)", dueAt: Date.now() - 1000, tabs: winRefs });
  await fireSnooze(winSnoozeQ.id);
  const wbInbox = await listItems(STORE_KEYS.inbox);
  check(
    createdWindows.length === 1 && createdWindows[0].tabs.length === 2 && wbInbox.length === 0,
    "P2b-1: retired quiet preference cannot stop a window snooze reopening"
  );

  // legacy single-tab snooze is unaffected (additive)
  mem.settings = { snoozeWakeQuiet: false };
  createdTabs = [];
  const legacy = await createSnooze({ url: "https://legacy.example.com", title: "Legacy", dueAt: Date.now() + 1000 });
  check(legacy.tabs === undefined, "P2b-1: single-tab snooze carries no tabs[] (schema stays additive)");
  await fireSnooze(legacy.id);
  check(createdTabs.includes("https://legacy.example.com"), "P2b-1: legacy single snooze still reopens its one tab");

  // undo of a window snooze (journal inverse): reopen the whole window + drop the snooze
  createdWindows = [];
  const winSnoozeU = await createSnooze({ title: "Window (2 tabs)", dueAt: Date.now() + 3600_000, tabs: winRefs });
  await recordAction("Snoozed a window (2 tabs)", {
    dels: [{ store: "snoozes", id: winSnoozeU.id }],
    reopen: [winRefs]
  });
  await undoAction();
  check(
    createdWindows.length === 1 && createdWindows[0].tabs.length === 2,
    "P2b-1: undo of a window snooze reopens the window"
  );
  check(
    !(await listItems(STORE_KEYS.snoozes)).some((s) => s.id === winSnoozeU.id),
    "P2b-1: undo of a window snooze removes the snooze"
  );

  // search surfaces each tab of a window snooze under its own URL
  const { searchAll: searchAllP2b } = await import("../js/lib/search.js");
  delete mem[STORE_KEYS.inbox];
  delete mem[STORE_KEYS.snoozes];
  delete mem[STORE_KEYS.archive];
  delete mem[STORE_KEYS.sessions];
  delete mem[STORE_KEYS.collections];
  mockWindows = [];
  createdWindows = [];
  await createSnooze({ title: "Window (2 tabs)", dueAt: Date.now() + 3600_000,
    tabs: [{ url: "https://find-me.example.com/report", title: "Report in a window snooze" }] });
  const winFound = await searchAllP2b("report in a window");
  check(
    winFound.length === 1 && winFound[0].type === "snoozed" &&
      winFound[0].url === "https://find-me.example.com/report",
    "P2b-1: window-snooze tabs are searchable under their own URL"
  );
  delete mem[STORE_KEYS.snoozes];
}

/* --- M3: dedup --- */
const { normalizeUrl, findDuplicateGroupsFromTabs, findDuplicateGroups, duplicateCount, closeDuplicates } =
  await import("../js/lib/dedup.js");

check(
  normalizeUrl("https://A.com/page/#section") === "https://a.com/page",
  "normalize: fragment dropped, host lowercased, trailing slash trimmed"
);
check(
  normalizeUrl("https://a.com/p?x=1") !== normalizeUrl("https://a.com/p?x=2"),
  "query matters by default"
);
check(
  normalizeUrl("https://a.com/p?x=1", { ignoreQuery: true }) ===
    normalizeUrl("https://a.com/p?x=2", { ignoreQuery: true }),
  "the generic URL helper retains its explicit legacy normalization option"
);

const queryDistinctTabs = [
  { id: 91, index: 0, url: "https://www.youtube.com/watch?v=first", title: "First" },
  { id: 92, index: 1, url: "https://www.youtube.com/watch?v=second", title: "Second" }
];
check(
  findDuplicateGroupsFromTabs(queryDistinctTabs, { ignoreQuery: true }).length === 0,
  "retired Ignore query strings input cannot collapse content-bearing query URLs"
);
mockWindows = [{ id: 9, tabs: queryDistinctTabs }];
removedTabIds = [];
await closeDuplicates({ ignoreQuery: true, auto: true });
check(
  removedTabIds.length === 0,
  "auto-close preserves distinct YouTube videos even if a legacy caller supplies ignoreQuery"
);

const navigatingAwayTabs = [
  { id: 93, index: 0, url: "https://www.youtube.com/watch?v=first", title: "First" },
  {
    id: 94,
    index: 1,
    url: "https://www.youtube.com/watch?v=first",
    pendingUrl: "https://www.youtube.com/watch?v=second",
    title: "Second"
  }
];
check(
  findDuplicateGroupsFromTabs(navigatingAwayTabs).length === 0,
  "a tab navigating to a different page is not offered as a duplicate of its previous URL"
);

const duplicateWindows = () => [
  {
    id: 1,
    tabs: [
      { id: 1, index: 0, url: "https://dup.com/a", title: "A1", active: false },
      { id: 2, index: 1, url: "https://dup.com/a#frag", title: "A2", active: true },
      { id: 3, index: 2, url: "https://dup.com/a", title: "A3", active: false, pinned: true },
      { id: 4, index: 3, url: "https://unique.com", title: "U", active: false }
    ]
  }
];
mockWindows = duplicateWindows();
createdWindows = [];
const dupGroups = await findDuplicateGroups();
check(dupGroups.length === 1, "one duplicate group");
check(dupGroups[0].keep.id === 2, "active tab is kept");
check(
  dupGroups[0].close.length === 1 && dupGroups[0].close[0].id === 1,
  "pinned duplicate never proposed for closing"
);
check(
  dupGroups[0].tabs.length === 3 && dupGroups[0].tabs.some((tab) => tab.id === 3),
  "duplicate group exposes survivor, closable extras, and pinned copies for grouped UI"
);
check((await duplicateCount()) === 1, "duplicate count = 1");
removedTabIds = [];
await closeDuplicates();
check(removedTabIds.length === 1 && removedTabIds[0] === 1, "closeDuplicates removes the right tab");
mockWindows = duplicateWindows();
removedTabIds = [];
check(
  await closeDuplicates({ tabId: 1 }) === 1 &&
    removedTabIds.length === 1 && removedTabIds[0] === 1,
  "closeDuplicates can close one freshly-validated extra"
);
const dedupUndoEntry = (await (await import("../js/lib/journal.js")).listActions())[0];
check(
  dedupUndoEntry?.label === "Closed 1 duplicate" &&
    dedupUndoEntry.reopen?.[0]?.[0]?.url === "https://dup.com/a",
  "an individually closed duplicate is durably journaled for Undo before the action settles"
);
mockWindows = duplicateWindows();
removedTabIds = [];
check(
  await closeDuplicates({ tabId: 1, auto: true }) === 1 &&
    removedTabIds.length === 1 && removedTabIds[0] === 1,
  "P11-25: automatic duplicate cleanup uses the same freshly-validated close path"
);
const autoDedupEntry = (await (await import("../js/lib/journal.js")).listActions())[0];
check(
  autoDedupEntry?.auto === true && autoDedupEntry?.category === "duplicates" &&
    autoDedupEntry.reopen?.[0]?.[0]?.url === "https://dup.com/a",
  "P11-25: automatic duplicate cleanup is visible and exactly undoable in Activity"
);
mockWindows = duplicateWindows();
removedTabIds = [];
check(
  await closeDuplicates({ tabId: 2 }) === 0 && removedTabIds.length === 0,
  "closeDuplicates refuses an individual request for the survivor"
);

/* --- M3: suspension --- */
const {
  autoSuspendPageStatus, isSuspendExempt, listAutoSuspendPageExceptions,
  matchesSuspendWhitelist, recentSuspendFloorIds, removeAutoSuspendPageException,
  suspendSweep, exemptTabFromAutoSuspend,
  TEMPORARY_SUSPEND_EXEMPTIONS_KEY
} = await import("../js/lib/suspend.js");

check(isSuspendExempt({ active: true, url: "https://x.com" }), "active exempt");
check(isSuspendExempt({ pinned: true, url: "https://x.com" }), "pinned exempt");
check(isSuspendExempt({ audible: true, url: "https://x.com" }), "audible exempt");
check(isSuspendExempt({ groupId: 5, url: "https://x.com" }), "grouped exempt");
check(!isSuspendExempt({ groupId: -1, url: "https://x.com" }), "ungrouped http tab not exempt");
check(
  isSuspendExempt({ groupId: -1, url: "chrome-extension://test-ext-id/suspend.html?originalUrl=https://x.com" }),
  "tab already on custom suspend page is exempt (non-http)"
);
// F9 — never-suspend whitelist
check(
  isSuspendExempt({ groupId: -1, url: "https://figma.com/file/1" }, ["figma.com"]),
  "F9: whitelisted host is exempt from auto-suspend"
);
check(
  !isSuspendExempt({ groupId: -1, url: "https://figma.com/file/1" }, ["notion.so"]),
  "F9: non-matching whitelist does not exempt"
);
check(
  !isSuspendExempt({ groupId: -1, url: "https://figma.com/file/1" }),
  "F9: no whitelist arg → not exempt (back-compat)"
);
check(
  matchesSuspendWhitelist("https://exact.example/read?mode=one", [
    "page:https://exact.example/read?mode=one"
  ]) &&
  !matchesSuspendWhitelist("https://exact.example/read?mode=two", [
    "page:https://exact.example/read?mode=one"
  ]) &&
  !matchesSuspendWhitelist("https://exact.example/read/more?mode=one", [
    "page:https://exact.example/read?mode=one"
  ]),
  "Popup Never suspend protects exactly one URL, while domain and fragment rules stay broad"
);
check(
  matchesSuspendWhitelist("https://docs.example/workspace/page-2", [
    "https://docs.example/workspace/"
  ]),
  "Never suspend retains the legacy full-URL substring behavior"
);
// Popup Keep awake: a one-day exact-page exemption stays device-local, while
// Always joins the user's portable Never suspend setting. A parked EveryTab
// suspend page resolves to the original page before either rule is written.
mem.settings = { suspendEnabled: true, suspendAfterMinutes: 60, suspendLazyReload: false };
mockWindows = [{ id: 8, tabs: [
  { id: 191, index: 0, url: "https://awake.example/article?one=1", active: false, groupId: -1 }
] }];
const dayExemption = await exemptTabFromAutoSuspend(191, "day");
check(dayExemption.ok && dayExemption.duration === "day" &&
      mem[TEMPORARY_SUSPEND_EXEMPTIONS_KEY]?.["https://awake.example/article?one=1"] > Date.now() &&
      !mem.settings.suspendWhitelist?.length,
  "Keep awake for 24 hours is exact-page, device-local, and does not alter portable settings");
mem.tabActivity = { 191: Date.now() - 2 * 3600_000 };
discardedTabs = [];
check((await suspendSweep()) === 0 && discardedTabs.length === 0,
  "the automatic suspension sweep respects an active temporary exemption");

const parkedUrl = chrome.runtime.getURL("suspend.html") + "?" + new URLSearchParams({
  originalUrl: "https://parked.example/read", title: "Parked"
});
mockWindows = [{ id: 8, tabs: [
  { id: 192, index: 0, url: parkedUrl, active: false, groupId: -1 }
] }];
const permanentExemption = await exemptTabFromAutoSuspend(192, "always");
check(permanentExemption.ok && permanentExemption.duration === "always" &&
      mem.settings.suspendWhitelist?.includes("page:https://parked.example/read") &&
      mem.settings.archiveWhitelist?.includes("page:https://parked.example/read"),
  "permanent popup protection resolves a suspended page and writes both compatibility aliases");
check((await exemptTabFromAutoSuspend(192, "always")).already === true &&
      mem.settings.suspendWhitelist.length === 1,
  "repeating Never suspend is idempotent");
const exemptionNow = Date.now();
const awakeStatus = autoSuspendPageStatus(
  "https://awake.example/article?one=1", mem.settings.suspendWhitelist,
  mem[TEMPORARY_SUSPEND_EXEMPTIONS_KEY], exemptionNow);
const parkedStatus = autoSuspendPageStatus(
  "https://parked.example/read", mem.settings.suspendWhitelist,
  mem[TEMPORARY_SUSPEND_EXEMPTIONS_KEY], exemptionNow);
const pageExceptions = listAutoSuspendPageExceptions(
  mem.settings.suspendWhitelist, mem[TEMPORARY_SUSPEND_EXEMPTIONS_KEY], exemptionNow);
check(awakeStatus.kind === "temporary" && awakeStatus.expiresAt > exemptionNow &&
      parkedStatus.kind === "permanent" && pageExceptions.length === 2,
  "popup and Settings share persistent temporary and permanent page-exception status");
await removeAutoSuspendPageException("https://awake.example/article?one=1");
await removeAutoSuspendPageException("https://parked.example/read");
check(!mem[TEMPORARY_SUSPEND_EXEMPTIONS_KEY]?.["https://awake.example/article?one=1"] &&
      !mem.settings.suspendWhitelist?.some((rule) => rule === "page:https://parked.example/read"),
  "removing a page exception clears its device timer or exact portable rule");
delete mem[TEMPORARY_SUSPEND_EXEMPTIONS_KEY];
// Incognito privacy: never saveable, never suspended, never auto-dumped — so no
// incognito URL is ever written to storage/the vault.
check(!isSaveableTab({ url: "https://x.com/1", incognito: true }), "incognito tab is never saveable (never captured)");
check(isSaveableTab({ url: "https://x.com/1" }), "non-incognito http tab is saveable (sanity)");
check(isSuspendExempt({ groupId: -1, url: "https://x.com/1", incognito: true }), "incognito tab is exempt from suspension");

// suspendLazyReload:false → use chrome.tabs.discard() path (easier to assert in node mock)
mem.settings = { suspendEnabled: true, suspendAfterMinutes: 60, suspendLazyReload: false };
const oldTs = Date.now() - 2 * 3600_000;
mem.tabActivity = { 101: oldTs, 102: Date.now() };
mockWindows = [
  {
    id: 1,
    tabs: [
      { id: 101, index: 0, url: "https://old.com", active: false, groupId: -1 },
      { id: 102, index: 1, url: "https://fresh.com", active: false, groupId: -1 },
      { id: 103, index: 2, url: "https://neverseen.com", active: false, groupId: -1 },
      { id: 104, index: 3, url: "https://active.com", active: true, groupId: -1 }
    ]
  }
];
discardedTabs = [];
const n1 = await suspendSweep();
check(n1 === 1 && discardedTabs[0] === 101, "sweep discards only the stale tab");
check(mem.tabActivity[103] !== undefined, "never-seen tab gets a fresh clock, not discarded");
// Default suspendMinTabs=0 must not turn the last-moment guard into one full
// tab enumeration per candidate.
mem.settings = { suspendEnabled: true, suspendAfterMinutes: 60, suspendLazyReload: false };
mem.tabActivity = {};
mockWindows = [{ id: 6, tabs: Array.from({ length: 100 }, (_, index) => {
  const id = 1100 + index;
  mem.tabActivity[id] = oldTs;
  return { id, index, url: `https://bulk-${index}.example`, active: false, groupId: -1 };
}) }];
const ordinaryQuery = chrome.tabs.query;
let suspendQueryCount = 0;
chrome.tabs.query = async (...args) => {
  suspendQueryCount += 1;
  return ordinaryQuery(...args);
};
discardedTabs = [];
check((await suspendSweep()) === 100 && suspendQueryCount === 1,
  "time-away revalidation keeps one planning query for 100 candidates when the tab-count gate is zero");
chrome.tabs.query = ordinaryQuery;

// A leave transition can land after planning. The fresh clock must win before
// the browser receives an automatic suspension effect.
mem.settings = { suspendEnabled: true, suspendAfterMinutes: 60, suspendLazyReload: false };
mem.tabActivity = { 1151: oldTs };
mockWindows = [{ id: 7, tabs: [
  { id: 1151, index: 0, url: "https://fresh-leave.example", active: false, groupId: -1 }
] }];
const activityRaceGet = chrome.tabs.get;
chrome.tabs.get = async (tabId) => {
  if (tabId === 1151) mem.tabActivity[tabId] = Date.now();
  return activityRaceGet(tabId);
};
discardedTabs = [];
check((await suspendSweep()) === 0 && discardedTabs.length === 0,
  "a departure clock written during suspension planning prevents the stale automatic effect");
chrome.tabs.get = activityRaceGet;

// The serialized age read can itself be held behind Store work. Protection
// that changes while it waits must be observed by a post-age Chrome read.
const { tabActivity: heldSuspendActivity } = await import("../js/lib/tab-activity.js");
const ordinarySuspendAge = heldSuspendActivity.isOlderThan;
let releaseSuspendAge;
let enterSuspendAge;
const suspendAgeEntered = new Promise((resolve) => { enterSuspendAge = resolve; });
const suspendAgeGate = new Promise((resolve) => { releaseSuspendAge = resolve; });
heldSuspendActivity.isOlderThan = async () => {
  enterSuspendAge();
  await suspendAgeGate;
  return true;
};
mem.settings = { suspendEnabled: true, suspendAfterMinutes: 60, suspendLazyReload: false };
mem.tabActivity = { 1152: oldTs };
mockWindows = [{ id: 7, tabs: [
  { id: 1152, index: 0, url: "https://held-age.example", active: false, groupId: -1 }
] }];
discardedTabs = [];
const heldSuspendSweep = suspendSweep();
await suspendAgeEntered;
mockWindows[0].tabs[0].active = true;
releaseSuspendAge();
check((await heldSuspendSweep) === 0 && discardedTabs.length === 0,
  "activation while the suspension age guard is held wins before the browser effect");
heldSuspendActivity.isOlderThan = ordinarySuspendAge;

let releaseSuspendDurationAge;
let enterSuspendDurationAge;
const suspendDurationAgeEntered = new Promise((resolve) => { enterSuspendDurationAge = resolve; });
const suspendDurationAgeGate = new Promise((resolve) => { releaseSuspendDurationAge = resolve; });
heldSuspendActivity.isOlderThan = async () => {
  enterSuspendDurationAge();
  await suspendDurationAgeGate;
  return true;
};
mem.settings = { suspendEnabled: true, suspendAfterMinutes: 60, suspendLazyReload: false };
mem.tabActivity = { 1153: oldTs };
mockWindows = [{ id: 7, tabs: [
  { id: 1153, index: 0, url: "https://held-duration.example", active: false, groupId: -1 }
] }];
discardedTabs = [];
const heldSuspendDurationSweep = suspendSweep();
await suspendDurationAgeEntered;
mem.settings.suspendAfterMinutes = 120;
releaseSuspendDurationAge();
check((await heldSuspendDurationSweep) === 0 && discardedTabs.length === 0,
  "extending the suspension duration while its age guard is held defers the candidate");
heldSuspendActivity.isOlderThan = ordinarySuspendAge;

// A user can add an exemption after the sweep chose a stale candidate. The
// last-moment fresh read must win before Chrome receives the destructive effect.
mem.settings = { suspendEnabled: true, suspendAfterMinutes: 60, suspendLazyReload: false };
mem.tabActivity = { 105: oldTs };
mockWindows = [{ id: 7, tabs: [
  { id: 105, index: 0, url: "https://late-rule.example/read", active: false, groupId: -1 }
] }];
delete mem[TEMPORARY_SUSPEND_EXEMPTIONS_KEY];
discardedTabs = [];
const originalTabsGet = chrome.tabs.get;
let injectedLateRule = false;
chrome.tabs.get = async (tabId) => {
  if (tabId === 105 && !injectedLateRule) {
    injectedLateRule = true;
    mem[TEMPORARY_SUSPEND_EXEMPTIONS_KEY] = {
      "https://late-rule.example/read": Date.now() + 60_000
    };
  }
  return originalTabsGet(tabId);
};
check((await suspendSweep()) === 0 && discardedTabs.length === 0,
  "a newly added exemption wins the stale automatic-sweep race");
chrome.tabs.get = originalTabsGet;
delete mem[TEMPORARY_SUSPEND_EXEMPTIONS_KEY];
// F9: a stale tab matching the never-suspend list is skipped by the sweep.
mem.settings = { suspendEnabled: true, suspendAfterMinutes: 60, suspendLazyReload: false, suspendWhitelist: ["keep.com"] };
mem.tabActivity = { 201: oldTs };
mockWindows = [{ id: 9, tabs: [{ id: 201, index: 0, url: "https://keep.com/doc", active: false, groupId: -1 }] }];
discardedTabs = [];
check((await suspendSweep()) === 0 && discardedTabs.length === 0, "F9: sweep skips a whitelisted stale tab");
// suspendMinTabs retained-awake floor: keep the N most recently used eligible
// tabs awake, and only suspend older eligible tabs beyond that floor.
mem.settings = { suspendEnabled: true, suspendAfterMinutes: 60, suspendLazyReload: false, suspendMinTabs: 5 };
mem.tabActivity = { 301: oldTs, 302: oldTs };
mockWindows = [{ id: 12, tabs: [
  { id: 301, index: 0, url: "https://a.com", active: false, groupId: -1 },
  { id: 302, index: 1, url: "https://b.com", active: false, groupId: -1 }
] }];
discardedTabs = [];
check((await suspendSweep()) === 0, "suspendMinTabs: 2 eligible tabs fit inside the 5-tab recent floor");
mem.settings = { suspendEnabled: true, suspendAfterMinutes: 60, suspendLazyReload: false, suspendMinTabs: 1 };
discardedTabs = [];
check((await suspendSweep()) === 1 && discardedTabs[0] === 301,
  "suspendMinTabs: with 2 stale tabs and a floor of 1, only the least-recent tab suspends");
const nineTabs = Array.from({ length: 9 }, (_, index) => ({
  id: 320 + index,
  index,
  url: `https://recent-floor-${index}.example`,
  active: index === 0,
  groupId: -1,
  lastAccessed: 9_000 - index
}));
const nineActivity = Object.fromEntries(nineTabs.map((tab, index) => [
  tab.id, index === 0 ? Date.now() : oldTs - index
]));
check(
  JSON.stringify([...recentSuspendFloorIds(nineTabs, nineActivity, 8)].sort((a, b) => a - b)) ===
    JSON.stringify(nineTabs.slice(0, 8).map(({ id }) => id)),
  "suspendMinTabs: at 9 awake tabs, the 8 most recent include the active tab and reserve exactly one older candidate"
);
mem.settings = { suspendEnabled: true, suspendAfterMinutes: 60,
  suspendLazyReload: false, suspendMinTabs: 8 };
mem.tabActivity = nineActivity;
mockWindows = [{ id: 12, tabs: nineTabs }];
discardedTabs = [];
check((await suspendSweep()) === 1 && discardedTabs[0] === nineTabs[8].id,
  "suspendMinTabs: reaching 9 with a recent floor of 8 suspends only the oldest eligible tab");
// suspendMaxTabs hard cap: keep at most N awake, suspend the longest-idled beyond
// it — works with the time-based slider OFF, and never touches the active tab.
createdWindows = []; // clear any windows left over from the session-restore tests
mem.settings = { suspendEnabled: false, suspendLazyReload: false, suspendMaxTabs: 2 };
mem.tabActivity = { 401: 100, 402: 200, 403: 300, 404: 900 };
mockWindows = [{ id: 13, tabs: [
  { id: 401, index: 0, url: "https://a.com", active: false, groupId: -1 },
  { id: 402, index: 1, url: "https://b.com", active: false, groupId: -1 },
  { id: 403, index: 2, url: "https://c.com", active: false, groupId: -1 },
  { id: 404, index: 3, url: "https://d.com", active: true, groupId: -1 } // active: never capped
] }];
discardedTabs = [];
const capN = await suspendSweep();
check(capN === 2 && discardedTabs[0] === 401 && discardedTabs[1] === 402,
  "suspendMaxTabs: 4 awake, cap 2 → suspends the 2 longest-idled (active tab spared)");
mem.settings = { suspendEnabled: false, suspendLazyReload: false, suspendMaxTabs: 10 };
discardedTabs = [];
check((await suspendSweep()) === 0, "suspendMaxTabs: awake ≤ cap → nothing suspended");
mem.settings = { suspendEnabled: false, suspendAfterMinutes: 60, suspendLazyReload: false };
check((await suspendSweep()) === 0, "sweep disabled by setting");

/* --- N4: suspended-tab recovery registry --- */
{
  const { registerSuspended, unregisterSuspended, recoverSuspendedTabs, getSuspendRegistry, wakeTab } =
    await import("../js/lib/suspend.js");
  const SB = "chrome-extension://test-ext-id/suspend.html";

  // lifecycle: register → get → unregister
  delete mem.suspendedRegistry;
  await registerSuspended({ id: 501, title: "A", favIconUrl: "fav", windowId: 1, index: 3, pinned: false }, "https://a.com/x");
  let reg = await getSuspendRegistry();
  check(reg["501"]?.originalUrl === "https://a.com/x" && reg["501"].windowId === 1 && reg["501"].index === 3 &&
    reg["501"].favIconUrl === "fav",
    "N4 registry: registerSuspended stores the entry");
  await unregisterSuspended(501);
  check(!("501" in (await getSuspendRegistry())), "N4 registry: unregisterSuspended removes the entry");

  // wakeTab clears the entry
  mockWindows = [{ id: 1, tabs: [
    { id: 601, index: 0, windowId: 1, url: `${SB}?originalUrl=https%3A%2F%2Fb.com&title=B` }
  ] }];
  await registerSuspended({ id: 601, title: "B", windowId: 1, index: 0, pinned: false }, "https://b.com");
  check((await wakeTab(601)) === true && !("601" in (await getSuspendRegistry())),
    "N4 registry: wakeTab clears the entry");

  // reconciliation: dead → recreated; user-closed → not resurrected; present → skipped
  delete mem.suspendedRegistry;
  mem.tabActivity = { 701: 123 };
  await registerSuspended({ id: 701, title: "Dead", favIconUrl: "fav", windowId: 1, index: 2, pinned: false }, "https://dead.com/p");
  await registerSuspended({ id: 702, title: "Closed", windowId: 1, index: 5, pinned: false }, "https://closed.com");
  await registerSuspended({ id: 703, title: "LiveById", windowId: 1, index: 0, pinned: false }, "https://livebyid.com");
  await registerSuspended({ id: 704, title: "LiveByUrl", windowId: 9, index: 0, pinned: false }, "https://livebyurl.com");
  await unregisterSuspended(702); // the user closed it (onRemoved) before the reload
  mockWindows = [{ id: 1, tabs: [
    { id: 703, index: 0, windowId: 1, url: `${SB}?originalUrl=https%3A%2F%2Flivebyid.com&title=x` },
    { id: 999, index: 1, windowId: 1, url: `${SB}?originalUrl=https%3A%2F%2Flivebyurl.com&title=y` }
  ] }];
  createdTabs = [];
  const recovered = await recoverSuspendedTabs();
  check(recovered === 1, `N4 recover: exactly the one vanished tab is recreated (got ${recovered})`);
  check(createdTabs.some((u) => u.includes("dead.com")), "N4 recover: the vanished tab is recreated from the registry");
  check(!createdTabs.some((u) => u.includes("closed.com")), "N4 recover: a user-closed tab is NOT resurrected");
  check(
    !createdTabs.some((u) => u.includes("livebyid.com")) && !createdTabs.some((u) => u.includes("livebyurl.com")),
    "N4 recover: still-present tabs (matched by id or by originalUrl) are skipped"
  );
  const regAfter = await getSuspendRegistry();
  const recoveredDead = Object.entries(regAfter).find(([, entry]) =>
    entry.originalUrl === "https://dead.com/p");
  check(!("701" in regAfter) && !("702" in regAfter), "N4 recover: stale registry entries pruned");
  check("703" in regAfter && Object.values(regAfter).some((e) => e.originalUrl === "https://dead.com/p"),
    "N4 recover: registry re-keyed to surviving + recreated tabs");
  check(recoveredDead && mem.tabActivity[recoveredDead[0]] === 123,
    "N4 recover: an exact suspended occurrence carries its away clock to a new tab id");

  // Browser-start clearing and suspended recovery can overlap. The browser
  // effect stays prompt, while exact clock transfer waits until the reset has
  // committed so it cannot be erased by the old-session clear.
  const { tabActivity } = await import("../js/lib/tab-activity.js");
  delete mem.suspendedRegistry;
  mem.tabActivity = { 707: 888 };
  await registerSuspended({
    id: 707, title: "Reset race", windowId: 1, index: 0, pinned: false, active: false
  }, "https://reset-race.example");
  mockWindows = [{ id: 1, focused: true, tabs: [] }];
  createdTabs = [];
  const resetRaceGetAll = chrome.windows.getAll;
  let releaseActivityReset = () => {};
  let markResetRead = () => {};
  const resetReadStarted = new Promise((resolve) => { markResetRead = resolve; });
  const heldActivityReset = new Promise((resolve) => { releaseActivityReset = resolve; });
  let holdActivityReset = true;
  chrome.windows.getAll = async (query = {}) => {
    if (query.populate === true && holdActivityReset) {
      holdActivityReset = false;
      markResetRead();
      await heldActivityReset;
    }
    return resetRaceGetAll(query);
  };
  const pendingActivityReset = tabActivity.beginBrowserSession();
  await resetReadStarted;
  let visibleRecovery = false;
  let resetRaceSettled = false;
  const pendingResetRaceRecovery = recoverSuspendedTabs({
    onBrowserRecoveryComplete() { visibleRecovery = true; }
  });
  void pendingResetRaceRecovery.then(() => { resetRaceSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  check(visibleRecovery && !resetRaceSettled,
    "N4 recover: visible recovery completes before a pending browser-start clock reset");
  releaseActivityReset();
  await Promise.all([pendingActivityReset, pendingResetRaceRecovery]);
  chrome.windows.getAll = resetRaceGetAll;
  const resetRaceEntry = Object.entries(await getSuspendRegistry()).find(([, entry]) =>
    entry.originalUrl === "https://reset-race.example");
  check(resetRaceEntry && mem.tabActivity[resetRaceEntry[0]] === 888,
    "N4 recover: exact awayAt transfers only after the browser-start clock reset");

  // A failed clock reset is already diagnosed by its lifecycle caller. It must
  // not strand the essential recovery registry under a vanished source id.
  delete mem.suspendedRegistry;
  mem.tabActivity = { 708: 889 };
  await registerSuspended({
    id: 708, title: "Failed reset", windowId: 1, index: 0, pinned: false, active: false
  }, "https://failed-reset.example");
  mockWindows = [{ id: 1, focused: true, tabs: [] }];
  createdTabs = [];
  chrome.windows.getAll = async (query = {}) => {
    if (query.populate === true) throw new Error("window inventory unavailable");
    return resetRaceGetAll(query);
  };
  await tabActivity.beginBrowserSession().catch(() => {});
  chrome.windows.getAll = resetRaceGetAll;
  check((await recoverSuspendedTabs()) === 1 &&
      Object.values(await getSuspendRegistry()).some((entry) =>
        entry.originalUrl === "https://failed-reset.example"),
    "N4 recover: a rejected activity reset cannot prevent registry rekeying");
  await tabActivity.initialize();

  // A same-id recovery after the browser-start reset restores only a clock
  // proven by that exact local registry occurrence.
  delete mem.suspendedRegistry;
  mem.tabActivity = { 705: 777 };
  const sameIdUrl = `${SB}?originalUrl=https%3A%2F%2Fsame-id.example&title=Same`;
  const sameIdTab = {
    id: 705, index: 0, windowId: 1, url: sameIdUrl, active: false, groupId: -1
  };
  await registerSuspended(sameIdTab, "https://same-id.example");
  mem.tabActivity = {};
  mockWindows = [{ id: 1, tabs: [sameIdTab] }];
  await recoverSuspendedTabs();
  check(mem.tabActivity[705] === 777,
    "N4 recover: a same-id exact occurrence restores its clock after browser-start clearing");

  delete mem.suspendedRegistry;
  delete mem.tabActivity;
  const legacyTab = {
    id: 706, index: 0, windowId: 1,
    url: `${SB}?originalUrl=https%3A%2F%2Flegacy-clock.example&title=Legacy`,
    active: false, groupId: -1
  };
  await registerSuspended(legacyTab, "https://legacy-clock.example");
  mockWindows = [{ id: 1, tabs: [legacyTab] }];
  await recoverSuspendedTabs();
  check(mem.tabActivity?.[706] === undefined,
    "N4 recover: a legacy occurrence without proven awayAt receives fresh grace");

  // One update cycle can run several safety passes. A page that has not yet
  // reasserted readiness is repaired and counted once, never once per pass.
  delete mem.suspendedRegistry;
  mem.suspendRecoveryCycle = {
    id: "cycle-one",
    kind: "reload",
    attemptedOccurrenceIds: [],
    recoveredOccurrenceIds: [],
    complete: false
  };
  mockWindows = [{ id: 1, tabs: [
    { id: 8801, index: 0, windowId: 1,
      url: `${SB}?originalUrl=https%3A%2F%2Fonce.example&title=Once` }
  ] }];
  await registerSuspended(mockWindows[0].tabs[0], "https://once.example");
  updatedTabs = [];
  const firstCyclePass = await recoverSuspendedTabs({
    allowReloadRepair: true,
    recoveryCycleId: "cycle-one"
  });
  const secondCyclePass = await recoverSuspendedTabs({
    allowReloadRepair: true,
    recoveryCycleId: "cycle-one"
  });
  check(firstCyclePass === 1 && secondCyclePass === 0 && updatedTabs.length === 1 &&
      mem.suspendRecoveryCycle.recoveredOccurrenceIds.length === 1,
    "N4 recovery: repeated reload passes repair and count one logical tab once");

  const { readFileSync: readSuspendLifecycle } = await import("node:fs");
  const tabLifecycleOwner = readSuspendLifecycle(
    new URL("../js/background/tab-lifecycle-owner.js", import.meta.url), "utf8"
  );
  const suspendPage = readSuspendLifecycle(new URL("../js/ui/suspend-page.js", import.meta.url), "utf8");
  check(tabLifecycleOwner.includes("suspension.unregister(tabId)") &&
      suspendPage.includes('type: "wake-suspended-page"'),
    "N4 wake: page, worker, and navigation fallback all retire the recovery record");
}

/* --- N4b: the reload race — grace window + serialized passes --- */
{
  const { registerSuspended, unregisterSuspendedOnClose, markRecoveryGrace, inRecoveryGrace,
    getSuspendRegistry, queueRecovery } = await import("../js/lib/suspend.js");

  // during grace, onRemoved-driven unregister is a no-op (reload fallout, not user intent)
  delete mem.suspendedRegistry;
  delete mem.suspendRecoveryGraceUntil;
  await registerSuspended({ id: 801, title: "R", windowId: 1, index: 0, pinned: false }, "https://race.com");
  await markRecoveryGrace();
  check(await inRecoveryGrace(), "N4b grace: window opens on markRecoveryGrace");
  await unregisterSuspendedOnClose(801);
  check("801" in (await getSuspendRegistry()),
    "N4b grace: a close during the grace window does NOT purge the registry");

  // after grace, the same close purges normally
  mem.suspendRecoveryGraceUntil = Date.now() - 1;
  check(!(await inRecoveryGrace()), "N4b grace: window expires");
  await unregisterSuspendedOnClose(801);
  check(!("801" in (await getSuspendRegistry())),
    "N4b grace: a close after the grace window purges the entry");

  // serialized passes: two overlapping recoveries create the tab exactly once
  delete mem.suspendedRegistry;
  await registerSuspended({ id: 802, title: "Once", windowId: 1, index: 0, pinned: false }, "https://once.com");
  mockWindows = [{ id: 1, tabs: [] }];
  createdTabs = [];
  const [a, b] = await Promise.all([queueRecovery(), queueRecovery()]);
  check(a + b === 1 && createdTabs.filter((u) => u.includes("once.com")).length === 1,
    `N4b passes: overlapping recovery passes create the tab exactly once (got ${a}+${b}, ${createdTabs.length} created)`);
}

/* --- N4c: the tab that OUTLIVES its page (the reported data loss) ---
 * Chrome does not always CLOSE an extension page when the extension reloads: it
 * can leave the tab open and navigate it to the New Tab page, which renders
 * Chrome's own default because our override is unregistered at that instant.
 * The old liveness test asked "does a tab with this id exist" and therefore
 * skipped those tabs on every pass, so a real page was silently replaced by a
 * blank new tab and never came back. */
{
  const { registerSuspended, adoptSuspendedPage, recoverSuspendedTabs, getSuspendRegistry, markRecoveryGrace } =
    await import("../js/lib/suspend.js");
  const SB = "chrome-extension://test-ext-id/suspend.html";
  const seed = async (liveUrl, { grace, adopted = false }) => {
    delete mem.suspendedRegistry;
    delete mem.suspendRecoveryGraceUntil;
    await registerSuspended({ id: 901, title: "Kept", windowId: 1, index: 4, pinned: false },
      "https://kept.example/page");
    if (grace) await markRecoveryGrace();
    mockWindows = [{ id: 1, tabs: [{ id: 901, index: 4, windowId: 1, url: liveUrl }] }];
    if (adopted) await adoptSuspendedPage(mockWindows[0].tabs[0]);
    createdTabs = [];
    updatedTabs = [];
    return recoverSuspendedTabs();
  };

  // 1. THE BUG: the tab survived, our page did not. Repair that tab in place —
  //    same window, same position, no duplicate.
  let n = await seed("chrome://newtab/", { grace: true });
  const repair = updatedTabs.find((u) => u.id === 901);
  check(n === 1 && createdTabs.length === 0 && !!repair &&
      repair.url.startsWith(SB) && repair.url.includes("kept.example"),
    "N4c: a suspended tab left as a blank new tab by the reload is restored in place, not duplicated");
  check("901" in (await getSuspendRegistry()),
    "N4c: the repaired tab keeps its registry entry under its own id");

  // 2. Outside the grace window a lost page is not the reload's doing, so the
  //    tab is left alone and the entry dropped.
  n = await seed("chrome://newtab/", { grace: false });
  check(n === 0 && updatedTabs.length === 0 && createdTabs.length === 0 &&
      !("901" in (await getSuspendRegistry())),
    "N4c: outside the grace window a registered tab is left alone and pruned");

  // 3. A live http page means the user is reading something. Never navigate it
  //    away, whatever the registry believes — inside the grace window or not.
  for (const grace of [true, false]) {
    n = await seed("https://somewhere.else/", { grace });
    check(n === 0 && updatedTabs.length === 0 && !("901" in (await getSuspendRegistry())),
      `N4c: a registered tab showing a real page is never navigated away (grace: ${grace})`);
  }
  n = await seed("https://kept.example/page", { grace: true });
  check(n === 0 && updatedTabs.length === 0 && !("901" in (await getSuspendRegistry())),
    "N4c: a tab already showing its original page is never re-suspended, and its entry is dropped");

  // 4. THE ERROR-5 SHAPE: Chrome's tab model still reports suspend.html while
  //    its renderer shows "Can't open this page". Without a readiness message
  //    from that page in this worker generation, force one in-place reload.
  n = await seed(`${SB}?originalUrl=https%3A%2F%2Fkept.example%2Fpage&title=Kept`, { grace: true });
  check(n === 1 && updatedTabs.length === 1 && createdTabs.length === 0 &&
      updatedTabs[0].id === 901 && updatedTabs[0].url.includes("recoveryAttempt="),
    "N4c: a URL-shaped Error 5 document is forcibly reloaded in place during grace");

  // 5. Our page really mounted and reasserted itself in this worker generation
  //    → untouched, no duplicate.
  n = await seed(`${SB}?originalUrl=https%3A%2F%2Fkept.example%2Fpage&title=Kept`,
    { grace: true, adopted: true });
  check(n === 0 && updatedTabs.length === 0 && createdTabs.length === 0 &&
      "901" in (await getSuspendRegistry()),
    "N4c: an adopted live suspend page is still skipped and kept");

  // 6. Persist BEFORE navigating: a worker killed mid-suspend must not leave a
  //    tab parked on our page with nothing recording where it came from.
  const src = (await import("node:fs")).readFileSync(
    new URL("../js/lib/suspend.js", import.meta.url), "utf8");
  const doSuspend = src.slice(src.indexOf("async function doSuspend"), src.indexOf("export async function suspendTab"));
  check(doSuspend.indexOf("await registerSuspended(t, original);") <
        doSuspend.indexOf("chrome.tabs.update(t.id"),
    "N4c: doSuspend registers the recovery entry BEFORE it navigates the tab");
}

/* --- F48/F49: settings list fields, the clickable guarded count, new labels --- */
{
  const fsm = await import("node:fs");
  const readF = (rel) => fsm.readFileSync(new URL(rel, import.meta.url), "utf8");
  const form = readF("../js/ui/settings-form.js");
  const cssF = readF("../css/dashboard.css");
  const optionsF = readF("../options.html");
  const stripF = readF("../js/ui/focus-strip.js");
  const labelsF = readF("../js/ui/labels-surface.js");
  check(
    form.includes("const stackedRow = (title, desc, ...controls) =>") &&
    form.includes('class: "setrow setrow-stacked"') &&
    form.includes('localizedStackedRow("automationExclusions"') &&
    form.includes('localizedRow("protectedPages"') &&
    form.includes('dashboard.html#settings:protection') &&
    form.includes('group("protection"') &&
    !form.includes('localizedStackedRow("keepTabsOpen"') &&
    !form.includes('localizedStackedRow("neverSuspend"') &&
    /\.setrow\.setrow-stacked \{ flex-direction: column/.test(cssF) &&
    /\.setrow\.setrow-stacked textarea \{[^}]*width: 100%/s.test(cssF),
    "F48: the shared automation-protection list uses the full stacked column width"
  );
  check(
    form.includes('localizedStackedRow("suspendPageExceptions"') &&
      form.includes("listAutoSuspendPageExceptions") &&
      form.includes("removeAutoSuspendPageException") &&
      form.includes("visibleSuspendRules") &&
      form.includes("storedSuspendRules") &&
      /\.suspend-page-exception-row \{[^}]*display: grid/s.test(cssF),
    "Suspension Settings shows permanent pages in the regular rule list and manages temporary pages separately"
  );
  check(
    stripF.includes('class: "fs-counts fs-counts-link"') &&
    stripF.includes("onclick: () => openBlockedSites()") &&
    stripF.includes("const { getSearchInput, onMeasure, openBlockedSites, getLayoutFollower = () => null } = ctx;") &&
    readF("../js/ui/dashboard.js").includes("void scrollToFocusSettings({ focusSites: true });") &&
    readF("../js/ui/dashboard.js").includes('focusSelector: focusSites ? ".focus-site-input" : null') &&
    stripF.includes("const focusedAccessDomain = strip.contains(document.activeElement)") &&
    stripF.includes('strip.querySelector(`.focus-access-${focusedAccessAction}[data-domain="${CSS.escape(focusedAccessDomain)}"]`)') &&
    stripF.includes(': strip.querySelector(".fs-counts-link");') &&
    /\.fs-counts-link:hover, \.fs-counts-link:focus-visible \{\s*color: inherit/s.test(cssF) &&
    /\.settings-group \+ \.settings-group \{[^}]*border-top: 3px solid var\(--border\)/s.test(cssF) &&
    readF("../js/ui/sidepanel.js").includes('openBlockedSites: () => openDash("#settings-focus")') &&
    /\.fs-counts-link:hover, \.fs-counts-link:focus-visible \{[^}]*text-decoration: underline/s.test(cssF),
    "F48/F48r: the guarded count opens the Blocked sites editor and lands in its input, keeps readable ink on the accent band, and never hands focus to Search"
  );
  check(
    /\.settings-toolbar \{[^}]*margin: 0;/.test(cssF) &&
      /\.settings-toolbar \{[^}]*position: sticky;[^}]*display: flex;[^}]*flex-direction: column/s.test(cssF) &&
      /scroll-margin-top: calc\(var\(--hero-h,[^;]*var\(--settings-toolbar-h/.test(cssF) &&
      form.includes('navChips.get(g).hidden = !visible;') &&
      form.indexOf('group("intro"') < form.indexOf('keyboardGroup = group("keyboard"') &&
      form.includes('new ResizeObserver(measureToolbar).observe(toolbar)') &&
      /\.settings-toolbar \{ position: sticky; top: 0; z-index: 10;/.test(optionsF) &&
      optionsF.includes("scroll-margin-top: calc(var(--settings-toolbar-h, 0px) + 16px)") &&
      /\.settings-group:first-of-type \{[^}]*margin-top: var\(--sp-12\)/.test(cssF) &&
      /\.settings-group \+ \.settings-group \{[^}]*margin-top: var\(--sp-8\);[^}]*padding-top: var\(--sp-12\);[^}]*border-top: 3px solid var\(--border\)/s.test(cssF),
    "P11: Settings keeps filter + live jump chips in one measured sticky strip above the settled group rhythm"
  );
  const sessionNav = readF("../js/ui/dashboard.js").slice(
    readF("../js/ui/dashboard.js").indexOf("namedSessions.slice(0, 7).map"),
    readF("../js/ui/dashboard.js").indexOf("namedSessions.length > 7")
  );
  check(
    /title: session\.name,[\s\S]*"aria-label": navName\(session\.name, tabCount\)/.test(sessionNav) &&
      /\.subnav > div \{ min-width: 0; min-height: 0; \}/.test(cssF) &&
      /\.subrow \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto auto;[^}]*min-width: 0;[^}]*max-width: 100%/s.test(cssF) &&
      /\.subrow \.navitem \{[^}]*grid-area: 1 \/ 1 \/ 2 \/ -1;[^}]*grid-template-columns: subgrid;[^}]*width: 100%;[^}]*min-width: 0;/s.test(cssF) &&
      /\.subrow \.navitem \.navtext \{[^}]*grid-column: 1;[^}]*min-width: 0;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s.test(cssF) &&
      /\.subrow \.navitem \.n \{ grid-column: 3; margin-left: 0; \}/.test(cssF) &&
      /\.subrow \.subact \{ grid-area: 1 \/ 2; z-index: 1;/.test(cssF),
    "P11: long session names yield while Restore and right-aligned counts keep stable, separate grid lanes"
  );
  check(
    !labelsF.includes("buildAddLabel") &&
    !readF("../js/lib/labels.js").includes("for (const label of Object.keys(meta))") &&
    readF("../js/ui/list-configs.js").includes('{ id: "label", label: localeMessage("action_label"), icon: "labels", key: "l",\n        run: (ctx) => ctx.panel.toggle(() => cardLabelPanel(async (labels) => {\n          const loc = ctx.group.data.locs[ctx.index];'),
    "F49r: labels stay carrier-derived; the Labels section gained a row Label action, not a way to create empty labels"
  );
}

/* --- M4: auto-archive --- */
// The preceding suspension recovery scenarios may leave reload grace open.
// These cases exercise ordinary timer/cap behavior after that grace has ended.
delete mem.suspendRecoveryGraceUntil;
const { archiveSweep, sweepInboxExpiry, isArchiveExempt, matchesWhitelist } =
  await import("../js/lib/archive.js");

const DAY = 86_400_000;
const NOW = Date.now();
const STALE = NOW - 8 * DAY; // past the 7-day default

// whitelist matching
check(matchesWhitelist("https://gist.github.com/x", ["github.com"]), "whitelist: subdomain suffix match");
check(matchesWhitelist("https://github.com/a/b", ["github.com"]), "whitelist: exact host match");
check(!matchesWhitelist("https://github.evil.com/", ["github.com"]), "whitelist: no lookalike-host match");
check(
  matchesWhitelist("https://docs.google.com/spreadsheets/d/1", ["docs.google.com/spreadsheets"]),
  "whitelist: URL-fragment substring match"
);
check(!matchesWhitelist("https://a.com", []), "whitelist: empty list matches nothing");

// exemptions + suspend-page resolution
check(isArchiveExempt({ pinned: true, url: "https://x.com", groupId: -1 }), "archive: pinned exempt");
check(isArchiveExempt({ audible: true, url: "https://x.com", groupId: -1 }), "archive: audible exempt");
check(isArchiveExempt({ groupId: 5, url: "https://x.com" }), "archive: grouped exempt");
check(isArchiveExempt({ groupId: -1, url: "chrome://settings" }), "archive: non-http exempt");
check(isArchiveExempt({ groupId: -1, url: "https://x.com", incognito: true }), "archive: incognito exempt (never auto-dumped)");
check(
  isArchiveExempt({ groupId: -1, url: "https://sub.keep.com/x" }, ["keep.com"]),
  "archive: whitelisted exempt"
);
check(
  isArchiveExempt(
    { groupId: -1, url: "https://exact.keep.example/read?mode=one" },
    ["page:https://exact.keep.example/read?mode=one"]
  ) && !isArchiveExempt(
    { groupId: -1, url: "https://exact.keep.example/read?mode=two" },
    ["page:https://exact.keep.example/read?mode=one"]
  ),
  "Auto-save uses the shared exact-page rule without widening it to sibling URLs"
);
const parkedTab = {
  groupId: -1,
  url: "chrome-extension://test-ext-id/suspend.html?originalUrl=https%3A%2F%2Fparked.com%2Fdoc&title=Parked+Doc"
};
check(
  canonicalRef(parkedTab)?.url === "https://parked.com/doc" &&
    canonicalRef(parkedTab)?.title === "Parked Doc",
  "canonicalRef sees through our own suspend page"
);
check(
  canonicalUrlOf(parkedTab) === "https://parked.com/doc" && isOwnSuspendPage(parkedTab) &&
    isSaveableTab(parkedTab),
  "canonicalUrlOf/isOwnSuspendPage/isSaveableTab agree on our suspend page"
);
check(
  !isArchiveExempt(parkedTab) && isSuspendExempt(parkedTab),
  "suspend page: exempt from suspension but archivable"
);

// sweep is off by default
mem.settings = {};
mem.tabActivity = { 201: STALE };
mockWindows = [
  { id: 1, tabs: [{ id: 201, url: "https://old.com/a", title: "Old A", active: false, groupId: -1 }] }
];
check((await archiveSweep(NOW)) === 0, "auto-archive disabled by default");

// A maximum-open-tabs cap is an independent auto-save trigger, like the
// Suspension hard cap: it works with the idle timer Off, saves the
// longest-idle eligible tabs first, and enforces the limit only as far as
// protected tabs allow.
mem.settings = {
  autoArchiveEnabled: false,
  autoSaveMaxTabs: 3,
  archiveWhitelist: ["keep.com"]
};
mem.tabActivity = { 211: 100, 212: 200, 213: 300, 214: 400, 215: 500 };
mockWindows = [{
  id: 2,
  focused: true,
  tabs: [
    { id: 211, index: 0, url: "https://oldest.example", title: "Oldest", active: false, groupId: -1 },
    { id: 212, index: 1, url: "https://second.example", title: "Second", active: false, groupId: -1 },
    { id: 213, index: 2, url: "https://sub.keep.com/doc", title: "Kept", active: false, groupId: -1 },
    { id: 214, index: 3, url: "https://pinned.example", title: "Pinned", active: false, pinned: true, groupId: -1 },
    { id: 215, index: 4, url: "https://active.example", title: "Active", active: true, groupId: -1 }
  ]
}];
removedTabIds = [];
notifications = [];
delete mem[STORE_KEYS.inbox];
const capped = await archiveSweep(NOW);
let cappedInbox = await listItems(STORE_KEYS.inbox);
check(
  capped === 2 && removedTabIds.join(",") === "211,212",
  "Auto-save max tabs: idle timer Off still saves the oldest eligible surplus tabs"
);
check(
    cappedInbox.length === 1 && cappedInbox[0].kind === "window" &&
    cappedInbox[0].tabs.map((tab) => tab.url).join(",") ===
      "https://oldest.example,https://second.example" &&
    notifications.at(-1)?.message === "2 tabs closed and saved to the Inbox. Nothing lost.",
  "Auto-save max tabs: one source window stays one ordered Inbox bundle with truthful feedback"
);
check(
  !removedTabIds.includes(213) && !removedTabIds.includes(214) && !removedTabIds.includes(215),
  "Auto-save max tabs: whitelist, pinned, and active tabs remain protected"
);
// Both old permanent-list aliases and the popup's device-only 24-hour map are
// real Auto-save guards. Only the unprotected surplus candidate may close.
mem.settings = {
  autoArchiveEnabled: false,
  autoSaveMaxTabs: 1,
  archiveWhitelist: [],
  suspendWhitelist: ["page:https://permanent-protection.example/read"]
};
mem[TEMPORARY_SUSPEND_EXEMPTIONS_KEY] = {
  "https://temporary-protection.example/read": NOW + DAY
};
mem.tabActivity = { 221: 100, 222: 200, 223: 300, 224: 400 };
mockWindows = [{ id: 22, focused: true, tabs: [
  { id: 221, index: 0, url: "https://permanent-protection.example/read", title: "Permanent", active: false, groupId: -1 },
  { id: 222, index: 1, url: "https://temporary-protection.example/read", title: "Temporary", active: false, groupId: -1 },
  { id: 223, index: 2, url: "https://ordinary.example/read", title: "Ordinary", active: false, groupId: -1 },
  { id: 224, index: 3, url: "https://active-protection.example/read", title: "Active", active: true, groupId: -1 }
] }];
removedTabIds = [];
delete mem[STORE_KEYS.inbox];
check((await archiveSweep(NOW)) === 1 && removedTabIds.join(",") === "223",
  "Auto-save effect honors permanent and 24-hour shared page protection");
delete mem[TEMPORARY_SUSPEND_EXEMPTIONS_KEY];
mem.settings = { autoArchiveEnabled: false, autoSaveMaxTabs: 10, archiveWhitelist: [] };
removedTabIds = [];
check(
  (await archiveSweep(NOW)) === 0 && removedTabIds.length === 0,
  "Auto-save max tabs: at or below the cap is a no-op"
);

// In a mixed timer+cap sweep, an unknown tab receives fresh grace for ranking
// too. Chrome's older lastAccessed fallback must not move it ahead of a tab
// with a proven older EveryTab departure clock.
mem.settings = {
  autoArchiveEnabled: true,
  autoDumpAfterMinutes: 525_600,
  autoSaveMaxTabs: 2,
  archiveWhitelist: []
};
mem.tabActivity = { 216: NOW - 10 * DAY, 218: NOW };
mockWindows = [{ id: 21, focused: true, tabs: [
  { id: 216, index: 0, url: "https://known-away.example", title: "Known", active: false, groupId: -1 },
  { id: 217, index: 1, url: "https://unknown-away.example", title: "Unknown", lastAccessed: 1, active: false, groupId: -1 },
  { id: 218, index: 2, url: "https://cap-reader.example", title: "Reader", active: true, groupId: -1 }
] }];
removedTabIds = [];
delete mem[STORE_KEYS.inbox];
check((await archiveSweep(NOW)) === 1 && removedTabIds.join(",") === "216",
  "Auto-save cap ranks a first-sighting tab as fresh instead of trusting an older Chrome age");

// Alarm, Settings, and tab-created triggers can land together in one worker.
// They must share the active sweep rather than capture the same tab twice.
const normalGetAllForAutoSave = chrome.windows.getAll;
let releaseAutoSaveRead;
const heldAutoSaveRead = new Promise((resolve) => { releaseAutoSaveRead = resolve; });
let autoSaveWindowReads = 0;
chrome.windows.getAll = async () => {
  autoSaveWindowReads++;
  await heldAutoSaveRead;
  return mockWindows;
};
mem.settings = { autoArchiveEnabled: false, autoSaveMaxTabs: 1, archiveWhitelist: [] };
mockWindows = [{ id: 22, focused: true, tabs: [
  { id: 221, index: 0, url: "https://coalesced.example", title: "Coalesced", active: false, groupId: -1 },
  { id: 222, index: 1, url: "https://active-coalesced.example", title: "Active", active: true, groupId: -1 }
] }];
mem.tabActivity = { 221: 100, 222: 200 };
removedTabIds = [];
delete mem[STORE_KEYS.inbox];
const capSweepA = archiveSweep(NOW);
const capSweepB = archiveSweep(NOW + 1);
await Promise.resolve();
releaseAutoSaveRead();
const [capResultA, capResultB] = await Promise.all([capSweepA, capSweepB]);
chrome.windows.getAll = normalGetAllForAutoSave;
check(
  capResultA === 1 && capResultB === 1 && autoSaveWindowReads === 1 &&
    removedTabIds.join(",") === "221",
  "Auto-save max tabs: overlapping worker triggers share one capture and one close"
);

// Fresh command-time validation wins over the planning snapshot. The chosen
// tab became active before persistence, so it must remain open and uncaptured.
const plannedCapWindow = { id: 23, focused: true, tabs: [
  { id: 231, index: 0, url: "https://candidate.example", title: "Candidate", active: false, groupId: -1 },
  { id: 232, index: 1, url: "https://was-active.example", title: "Was active", active: true, groupId: -1 }
] };
mockWindows = [{ id: 23, focused: true, tabs: [
  { ...plannedCapWindow.tabs[0], active: true },
  { ...plannedCapWindow.tabs[1], active: false }
] }];
chrome.windows.getAll = async () => [plannedCapWindow];
mem.settings = { autoArchiveEnabled: false, autoSaveMaxTabs: 1, archiveWhitelist: [] };
mem.tabActivity = { 231: 100, 232: 200 };
removedTabIds = [];
check(
  (await archiveSweep(NOW)) === 0 && removedTabIds.length === 0,
  "Auto-save max tabs: a candidate activated after planning is not persisted or closed"
);
chrome.windows.getAll = normalGetAllForAutoSave;

// tab-level sweep: exemptions, grace period, stale-entry pruning
mem.settings = { autoArchiveEnabled: true, autoArchiveDays: 7, archiveWhitelist: ["keep.com"] };
mem.tabActivity = { 201: STALE, 202: NOW, 203: STALE, 204: STALE, 205: STALE, 999: STALE };
mockWindows = [
  {
    id: 1,
    focused: true,
    tabs: [
      { id: 201, url: "https://old.com/a", title: "Old A", active: false, groupId: -1 },
      { id: 202, url: "https://fresh.com", title: "Fresh", active: false, groupId: -1 },
      { id: 203, url: "https://active.com", title: "Active", active: true, groupId: -1 },
      { id: 204, url: "https://pinned.com", title: "P", active: false, pinned: true, groupId: -1 },
      { id: 205, url: "https://sub.keep.com/x", title: "W", active: false, groupId: -1 },
      { id: 206, url: "https://neverseen.com", title: "N", active: false, groupId: -1 }
    ]
  }
];
removedTabIds = [];
delete mem[STORE_KEYS.inbox];
const a1 = await archiveSweep(NOW);
check(a1 === 1 && removedTabIds.length === 1 && removedTabIds[0] === 201, "sweep archives only the idle unexempt tab");
let inboxArch = await listItems(STORE_KEYS.inbox);
check(
  inboxArch.length === 1 &&
    inboxArch[0].source === "auto-archive" &&
    inboxArch[0].kind === "tab" &&
    inboxArch[0].tabs[0].url === "https://old.com/a",
  "archived tab lands in Inbox with source auto-archive"
);
check(mem.tabActivity[206] !== undefined, "never-seen tab stamped, not archived (grace period)");
check(mem.tabActivity[999] === undefined, "stale activity entry pruned");
check(mem.tabActivity[201] === undefined, "archived tab dropped from activity map");

// A tab left while the sweep is validating must receive its full new grace,
// even though the planning snapshot still described it as old.
mem.settings = { autoArchiveEnabled: true, autoDumpAfterMinutes: 60, archiveWhitelist: [] };
mem.tabActivity = { 251: STALE, 252: NOW };
mockWindows = [{ id: 25, focused: true, tabs: [
  { id: 251, index: 0, url: "https://leave-race.example", title: "Leave", active: false, groupId: -1 },
  { id: 252, index: 1, url: "https://reader.example", title: "Reader", active: true, groupId: -1 }
] }];
const archiveActivityRaceGet = chrome.tabs.get;
chrome.tabs.get = async (tabId) => {
  if (tabId === 251) mem.tabActivity[tabId] = NOW;
  return archiveActivityRaceGet(tabId);
};
removedTabIds = [];
delete mem[STORE_KEYS.inbox];
check((await archiveSweep(NOW)) === 0 && removedTabIds.length === 0,
  "a departure clock written during Auto-save planning prevents the stale close");
chrome.tabs.get = archiveActivityRaceGet;

// A protection change made while the queued age read is held must be visible
// before Auto-save persists or closes the candidate.
const { tabActivity: heldArchiveActivity } = await import("../js/lib/tab-activity.js");
const ordinaryArchiveAge = heldArchiveActivity.isOlderThan;
let releaseArchiveAge;
let enterArchiveAge;
const archiveAgeEntered = new Promise((resolve) => { enterArchiveAge = resolve; });
const archiveAgeGate = new Promise((resolve) => { releaseArchiveAge = resolve; });
heldArchiveActivity.isOlderThan = async () => {
  enterArchiveAge();
  await archiveAgeGate;
  return true;
};
mem.tabActivity = { 253: STALE, 254: NOW };
mockWindows = [{ id: 25, focused: true, tabs: [
  { id: 253, index: 0, url: "https://held-archive-age.example", title: "Held", active: false, groupId: -1 },
  { id: 254, index: 1, url: "https://archive-reader.example", title: "Reader", active: true, groupId: -1 }
] }];
removedTabIds = [];
delete mem[STORE_KEYS.inbox];
const heldArchiveSweep = archiveSweep(NOW);
await archiveAgeEntered;
mockWindows[0].tabs[0].pinned = true;
releaseArchiveAge();
check((await heldArchiveSweep) === 0 && removedTabIds.length === 0 &&
    (await listItems(STORE_KEYS.inbox)).length === 0,
  "pinning while the Auto-save age guard is held prevents persistence and close");
heldArchiveActivity.isOlderThan = ordinaryArchiveAge;

// A popup protection added while the final activity read is pending must be
// observed at commit time, just like a pin or permanent Settings-rule change.
let releaseArchiveTemporaryAge;
let enterArchiveTemporaryAge;
const archiveTemporaryAgeEntered = new Promise((resolve) => { enterArchiveTemporaryAge = resolve; });
const archiveTemporaryAgeGate = new Promise((resolve) => { releaseArchiveTemporaryAge = resolve; });
heldArchiveActivity.isOlderThan = async () => {
  enterArchiveTemporaryAge();
  await archiveTemporaryAgeGate;
  return true;
};
mem.settings = { autoArchiveEnabled: true, autoDumpAfterMinutes: 60, archiveWhitelist: [] };
mem.tabActivity = { 265: STALE, 266: NOW };
mockWindows = [{ id: 25, focused: true, tabs: [
  { id: 265, index: 0, url: "https://held-temporary-protection.example", title: "Held", active: false, groupId: -1 },
  { id: 266, index: 1, url: "https://temporary-reader.example", title: "Reader", active: true, groupId: -1 }
] }];
removedTabIds = [];
delete mem[STORE_KEYS.inbox];
const heldArchiveTemporarySweep = archiveSweep(NOW);
await archiveTemporaryAgeEntered;
mem[TEMPORARY_SUSPEND_EXEMPTIONS_KEY] = {
  "https://held-temporary-protection.example/": NOW + DAY
};
releaseArchiveTemporaryAge();
check((await heldArchiveTemporarySweep) === 0 && removedTabIds.length === 0 &&
    (await listItems(STORE_KEYS.inbox)).length === 0,
  "adding 24-hour protection during Auto-save validation prevents persistence and close");
delete mem[TEMPORARY_SUSPEND_EXEMPTIONS_KEY];
heldArchiveActivity.isOlderThan = ordinaryArchiveAge;

let releaseArchiveSettingAge;
let enterArchiveSettingAge;
const archiveSettingAgeEntered = new Promise((resolve) => { enterArchiveSettingAge = resolve; });
const archiveSettingAgeGate = new Promise((resolve) => { releaseArchiveSettingAge = resolve; });
heldArchiveActivity.isOlderThan = async () => {
  enterArchiveSettingAge();
  await archiveSettingAgeGate;
  return true;
};
mem.settings = { autoArchiveEnabled: true, autoDumpAfterMinutes: 60, archiveWhitelist: [] };
mem.tabActivity = { 255: STALE, 256: NOW };
mockWindows = [{ id: 25, focused: true, tabs: [
  { id: 255, index: 0, url: "https://held-archive-setting.example", title: "Held", active: false, groupId: -1 },
  { id: 256, index: 1, url: "https://archive-setting-reader.example", title: "Reader", active: true, groupId: -1 }
] }];
removedTabIds = [];
delete mem[STORE_KEYS.inbox];
const heldArchiveSettingSweep = archiveSweep(NOW);
await archiveSettingAgeEntered;
mem.settings.autoArchiveEnabled = false;
releaseArchiveSettingAge();
check((await heldArchiveSettingSweep) === 0 && removedTabIds.length === 0 &&
    (await listItems(STORE_KEYS.inbox)).length === 0,
  "turning Auto-save off while its age guard is held prevents persistence and close");
heldArchiveActivity.isOlderThan = ordinaryArchiveAge;

let archiveLooseAgeCalls = 0;
let releaseSecondArchiveAge;
let enterSecondArchiveAge;
const secondArchiveAgeEntered = new Promise((resolve) => { enterSecondArchiveAge = resolve; });
const secondArchiveAgeGate = new Promise((resolve) => { releaseSecondArchiveAge = resolve; });
heldArchiveActivity.isOlderThan = async () => {
  archiveLooseAgeCalls += 1;
  if (archiveLooseAgeCalls === 2) {
    enterSecondArchiveAge();
    await secondArchiveAgeGate;
  }
  return true;
};
mem.settings = { autoArchiveEnabled: true, autoDumpAfterMinutes: 60, archiveWhitelist: [] };
mem.tabActivity = { 257: STALE, 258: STALE, 259: NOW };
mockWindows = [{ id: 25, focused: true, tabs: [
  { id: 257, index: 0, url: "https://first-loose.example", title: "First", active: false, groupId: -1 },
  { id: 258, index: 1, url: "https://second-loose.example", title: "Second", active: false, groupId: -1 },
  { id: 259, index: 2, url: "https://loose-reader.example", title: "Reader", active: true, groupId: -1 }
] }];
removedTabIds = [];
delete mem[STORE_KEYS.inbox];
const heldLooseArchiveSweep = archiveSweep(NOW);
await secondArchiveAgeEntered;
mem.settings.autoArchiveEnabled = false;
releaseSecondArchiveAge();
check((await heldLooseArchiveSweep) === 0 && removedTabIds.length === 0 &&
    (await listItems(STORE_KEYS.inbox)).length === 0,
  "turning Auto-save off during a later age guard cancels every accepted tab in the timed plan");
heldArchiveActivity.isOlderThan = ordinaryArchiveAge;
mem.settings = { autoArchiveEnabled: true, autoArchiveDays: 7, archiveWhitelist: [] };

// Arrival does not reset its old stored timestamp. The coherent foreground
// context and final window check must still protect the window the user enters
// while a bundle is being validated.
mem.tabActivity = { 261: STALE, 262: STALE };
delete mem.tabActivityContext;
mockWindows = [{ id: 26, focused: false, tabs: [
  { id: 261, index: 0, url: "https://bundle-reader.example", title: "Reader", active: true, groupId: -1 },
  { id: 262, index: 1, url: "https://bundle-peer.example", title: "Peer", active: false, groupId: -1 }
] }];
const archiveFocusRaceGet = chrome.tabs.get;
let enteredBundle = false;
chrome.tabs.get = async (tabId) => {
  if (!enteredBundle && tabId === 261) {
    enteredBundle = true;
    mockWindows[0].focused = true;
    mem.tabActivityContext = {
      focusedWindowId: 26,
      activeByWindow: { 26: 261 }
    };
  }
  return archiveFocusRaceGet(tabId);
};
removedTabIds = [];
delete mem[STORE_KEYS.inbox];
check((await archiveSweep(NOW)) === 0 && removedTabIds.length === 0,
  "focusing an old-timestamp bundle during validation cannot close its foreground tab");
chrome.tabs.get = archiveFocusRaceGet;
delete mem.tabActivityContext;

// window-level bundle: every tab past threshold, window unfocused
mem.tabActivity = { 301: STALE, 302: STALE, 401: NOW };
mockWindows = [
  {
    id: 3,
    focused: false,
    tabs: [
      { id: 301, url: "https://proj.com/one", title: "One", active: true, groupId: -1 },
      { id: 302, url: "https://proj.com/two", title: "Two", active: false, groupId: -1 }
    ]
  },
  {
    id: 4,
    focused: true,
    tabs: [{ id: 401, url: "https://fresh.com", title: "Fresh", active: true, groupId: -1 }]
  }
];
removedTabIds = [];
delete mem[STORE_KEYS.inbox];
const notifBefore = notifications.length;
const a2 = await archiveSweep(NOW);
inboxArch = await listItems(STORE_KEYS.inbox);
check(a2 === 2, "fully idle unfocused window archives whole");
check(
  inboxArch.length === 1 && inboxArch[0].kind === "window" && inboxArch[0].tabs.length === 2,
  "window archives as a single bundle (active tab included)"
);
check(
  removedTabIds.includes(301) && removedTabIds.includes(302) && !removedTabIds.includes(401),
  "bundle closes exactly the window's tabs"
);
check(notifications.length === notifBefore + 1, "archive sweep notifies");
check(badgeTexts.includes("📥"), "archive sweep flashes the badge");

// suspended (parked) tab archives under its original URL
mem.tabActivity = { 501: STALE };
mockWindows = [
  {
    id: 5,
    focused: true,
    tabs: [
      { ...parkedTab, id: 501, active: false },
      { id: 502, url: "https://fresh2.com", title: "F2", active: true, groupId: -1 }
    ]
  }
];
removedTabIds = [];
delete mem[STORE_KEYS.inbox];
const a3 = await archiveSweep(NOW);
inboxArch = await listItems(STORE_KEYS.inbox);
check(
  a3 === 1 && inboxArch[0].tabs[0].url === "https://parked.com/doc",
  "suspended tab archives under its original URL"
);

/* --- S1/S2/S3: suspended-tab canonicalization across features --- */
const SUSPEND_URL =
  "chrome-extension://test-ext-id/suspend.html?originalUrl=https%3A%2F%2Fparked.com%2Fdoc&title=Parked+Doc";

// clean state (no saved items so search results are unambiguous)
for (const k of Object.values(STORE_KEYS)) delete mem[k];

// S2: a suspended open tab is a search result under its underlying URL, keeps tabId
mockWindows = [{ id: 1, tabs: [{ id: 71, index: 0, url: SUSPEND_URL, title: "EveryTab — asleep" }] }];
createdWindows = [];
const s2res = await searchAll("parked");
check(
  s2res.length === 1 &&
    s2res[0].type === "open" &&
    s2res[0].url === "https://parked.com/doc" &&
    s2res[0].tabId === 71,
  "S2: suspended open tab surfaces in search as an open result (underlying URL, keeps tabId)"
);

// S1 dedup: a suspended tab and its awake twin are one duplicate group; keep the awake copy
mockWindows = [
  {
    id: 1,
    tabs: [
      { id: 71, index: 0, url: SUSPEND_URL, title: "Asleep", active: false },
      { id: 72, index: 1, url: "https://parked.com/doc", title: "Awake", active: false }
    ]
  }
];
const dgroups = await findDuplicateGroups();
check(dgroups.length === 1, "S1 dedup: suspended + awake same page = one duplicate group");
check(dgroups[0].keep.id === 72, "S1 dedup: the awake copy is kept over the suspended one");
check(
  dgroups[0].close.length === 1 && dgroups[0].close[0].id === 71,
  "S1 dedup: the suspended copy is the one proposed for closing"
);

// S3: the same page open (suspended) + in the inbox collapses to one result, open wins
mockWindows = [{ id: 1, tabs: [{ id: 71, index: 0, url: SUSPEND_URL, title: "Asleep" }] }];
await upsertItem(STORE_KEYS.inbox, {
  ...(await newMeta()),
  kind: "tab",
  tabs: [{ url: "https://parked.com/doc", title: "Parked (saved)" }],
  source: "dump",
  labels: []
});
const s3res = await searchAll("parked");
check(
  s3res.length === 1 && s3res[0].type === "open",
  "S3: suspended-open + inbox copies of one page dedupe to a single open result"
);
delete mem[STORE_KEYS.inbox];

// S1 sessions: saving a window with a suspended tab stores its underlying URL
mockWindows = [{ id: 9, tabs: [{ id: 91, index: 0, url: SUSPEND_URL, title: "Asleep" }] }];
const parkedSession = await saveWindowAsSession(9, "Parked session");
check(
  parkedSession && parkedSession.windows[0][0].url === "https://parked.com/doc",
  "S1 sessions: suspended tab saved as a session under its underlying URL"
);

// S1 dump: dumping a suspended tab saves its underlying URL to the Inbox
delete mem[STORE_KEYS.inbox];
mockWindows = [
  {
    id: 9,
    tabs: [
      { id: 91, windowId: 9, index: 0, pinned: false, url: SUSPEND_URL, title: "Asleep" },
      { id: 92, windowId: 9, index: 1, pinned: false, url: "https://other.com", title: "Other" }
    ]
  }
];
removedTabIds = [];
const dumpN = await dumpTab(91);
const dumpInbox = await listItems(STORE_KEYS.inbox);
check(
  dumpN.n === 1 && dumpN.undoId === mem.journal?.[0]?.id &&
    dumpInbox.length === 1 && dumpInbox[0].tabs[0].url === "https://parked.com/doc",
  "S1 dump: dumping a suspended tab saves its underlying URL"
);
check(
  mem.journal?.[0]?.forwardReceipt?.status === "complete" &&
    mem.journal[0].forwardReceipt.tabs[0].windowId === 9 &&
    mem.journal[0].forwardReceipt.tabs[0].index === 0,
  "S1 dump: immediate Undo retains the original live window and tab-strip position"
);
mockWindows.push({
  id: 10,
  tabs: [
    { id: 101, windowId: 10, index: 0, pinned: false, url: "https://third.com", title: "Third" },
    { id: 102, windowId: 10, index: 1, pinned: false, url: "https://stay.com", title: "Stay" }
  ]
});
await dumpTabs([92, 101]);
check(
  mem.journal?.[0]?.forwardReceipt?.tabs?.map(({ windowId, index }) => `${windowId}:${index}`)
    .join("|") === "9:0|10:0",
  "S1 selected save: immediate Undo retains every source window and tab-strip position"
);

// S1: suspend sweep still skips our own suspend page (never re-suspends it)
mem.settings = { suspendEnabled: true, suspendAfterMinutes: 60, suspendLazyReload: false };
mem.tabActivity = { 71: NOW - 2 * DAY };
mockWindows = [{ id: 1, tabs: [{ id: 71, index: 0, url: SUSPEND_URL, active: false, groupId: -1 }] }];
discardedTabs = [];
check(
  (await suspendSweep()) === 0 && discardedTabs.length === 0,
  "S1: suspend sweep still skips our own suspend page (no re-suspend loop)"
);

/* --- S4: scoped search operators (`in:` plus entity scopes) --- */

// parser is pure + case-insensitive; unknown `in:` sources fall back to plain text
check(
  JSON.stringify(parseScope("in:inbox report")) ===
    JSON.stringify({ type: "in", value: "inbox", query: "report" }),
  "S4 parse: in:inbox consumes the token, keeps the query"
);
check(
  parseScope("IN:Archive x").type === "in" && parseScope("IN:Archive x").value === "archive",
  "S4 parse: case-insensitive, value canonicalized to lowercase"
);
check(
  parseScope("in:bogus hi").type === null && parseScope("in:bogus hi").query === "in:bogus hi",
  "S4 parse: unrecognized in: source → plain text (token kept, never errors)"
);
check(parseScope("plain query").type === null, "S4 parse: no leading token → null scope");
check(
  parseScope("in:snoozed").value === "snoozed" && parseScope("in:snoozed").query === "",
  "S4 parse: scope-only input → empty query"
);

// controlled state: the same query word in every searchable source, distinct URLs
for (const k of Object.values(STORE_KEYS)) delete mem[k];
mem.settings = {};
mockWindows = [
  { id: 1, tabs: [{ id: 61, index: 0, url: "https://open.example.com/report", title: "Report open" }] }
];
createdWindows = [];
await upsertItem(STORE_KEYS.inbox, {
  ...(await newMeta()), kind: "tab",
  tabs: [{ url: "https://inbox.example.com/report", title: "Report inbox" }], source: "dump", labels: []
});
await upsertItem(STORE_KEYS.archive, {
  ...(await newMeta()), kind: "tab", archivedAt: Date.now(),
  tabs: [{ url: "https://arch.example.com/report", title: "Report archive" }], source: "dump", labels: []
});
await upsertItem(STORE_KEYS.sessions, {
  ...(await newMeta()), name: "Sess", auto: false,
  windows: [[{ url: "https://sess.example.com/report", title: "Report session" }]], labels: []
});
await createSnooze({ url: "https://snooze.example.com/report", title: "Report snoozed", dueAt: Date.now() + 3600_000 });
// resolveScope: `in:` is static. Retired Smart View records stay portable but
// no longer add another search grammar or UI surface.
const rIn = await resolveScope("in:archive report");
check(
  rIn.scope?.type === "in" && rIn.scope.value === "archive" && rIn.query === "report",
  "S4 resolve: in: scope resolves to its source"
);
check(
  (await resolveScope("view:arch report")).scope === null &&
    (await resolveScope("view:arch report")).query === "view:arch report",
  "S4 resolve: retired view syntax remains ordinary searchable text"
);

// scoped searchAll restricts the source set
check((await searchAll("report")).length === 5, "S4: unscoped search spans all 5 sources");
const inInbox = await searchAll("in:inbox report");
check(inInbox.length === 1 && inInbox[0].type === "inbox", "S4: in:inbox restricts to the Inbox");
const inSnoozed = await searchAll("in:snoozed report");
check(inSnoozed.length === 1 && inSnoozed[0].type === "snoozed", "S4: in:snoozed restricts to snoozes");
const inOpen = await searchAll("in:open report");
check(
  inOpen.length === 1 && inOpen[0].type === "open" && inOpen[0].tabId === 61,
  "S4: in:open restricts to open tabs and keeps tabId"
);
const inArchive = await searchAll("in:archive report");
check(inArchive.length === 1 && inArchive[0].type === "archive", "S4: in:archive restricts to the Archive");
const inSessions = await searchAll("in:sessions report");
check(inSessions.length === 1 && inSessions[0].type === "session", "S4: in:sessions restricts to sessions");

// unknown scope → literal text search; <2-char query → nothing; opts.scope passthrough
check((await searchAll("in:bogus report")).length === 0, "S4: unknown in: scope becomes a literal text search");
check((await searchAll("in:inbox a")).length === 0, "S4: a scope with a <2-char query returns nothing");
const passthrough = await searchAll("report", { scope: { type: "in", value: "inbox" } });
check(
  passthrough.length === 1 && passthrough[0].type === "inbox",
  "S4: pre-parsed opts.scope path restricts sources without re-parsing"
);
/* --- S6: multi-term AND search (whitespace-tokenized; every term must hit) --- */
for (const k of Object.values(STORE_KEYS)) delete mem[k];
mem.settings = {};
mockWindows = [];
createdWindows = [];
await upsertItem(STORE_KEYS.inbox, {
  ...(await newMeta()), kind: "tab", source: "dump", labels: [],
  tabs: [{ url: "https://youtube.com/watch?v=1", title: "Claude explains everything", labels: ["research"] }]
});
check((await searchAll("claude youtube")).length === 1, "S6: two terms hit across title + url (AND)");
check((await searchAll("youtube claude")).length === 1, "S6: term order is irrelevant");
check((await searchAll("claude vimeo")).length === 0, "S6: one missing term → no match (AND, not OR)");
check((await searchAll("claude")).length === 1, "S6: a single term behaves exactly as before");
check(
  (await searchAll("research claude")).length === 1,
  "S6: one term can match a label while another matches the title"
);

/* --- S7: label: scope + chip-scoped browse (empty query returns scope items) --- */
for (const k of Object.values(STORE_KEYS)) delete mem[k];
mem.settings = {};
mockWindows = [];
createdWindows = [];
// item-grain label
await upsertItem(STORE_KEYS.inbox, {
  ...(await newMeta()), kind: "tab", source: "dump", labels: ["Work"],
  tabs: [{ url: "https://a.example.com/x", title: "Alpha" }]
});
// per-tab-grain label alongside an unlabeled tab in the same item
await upsertItem(STORE_KEYS.inbox, {
  ...(await newMeta()), kind: "tab", source: "dump", labels: [],
  tabs: [
    { url: "https://b.example.com/y", title: "Beta", labels: ["Work"] },
    { url: "https://c.example.com/z", title: "Gamma" }
  ]
});
await upsertItem(STORE_KEYS.archive, {
  ...(await newMeta()), kind: "tab", archivedAt: Date.now(), source: "dump", labels: [],
  tabs: [{ url: "https://d.example.com/w", title: "Delta", labels: ["Work"] }]
});
// parseScope / resolveScope understand a label: token
check(
  parseScope("label:Work notes").type === "label" &&
    parseScope("label:Work notes").value === "Work" &&
    parseScope("label:Work notes").query === "notes",
  "S7: parseScope reads a label: token"
);
const rLabel = await resolveScope("label:wor");
check(
  rLabel.scope?.type === "label" && rLabel.scope.value === "Work",
  "S7: resolveScope prefix-matches label: to the canonical label name"
);
// label scope keeps only tabs carrying the label, both grains, across sources
const lWork = await searchAll("label:Work");
check(lWork.length === 3, `S7: label:Work spans item + per-tab grains and archive (got ${lWork.length})`);
check(!lWork.some((r) => r.title === "Gamma"), "S7: label scope excludes an unlabeled tab in a labeled item");
// text after the chip searches within the labeled set
const lWorkText = await searchAll("label:Work alpha");
check(
  lWorkText.length === 1 && lWorkText[0].title === "Alpha",
  "S7: text after label: filters within the labeled set"
);
// empty query + active scope = browse mode (returns the scope's items)
check((await searchAll("in:inbox")).length === 3, "S7: an active in: scope with no query browses its items");
check((await searchAll("label:Work")).length === 3, "S7: an active label: scope with no query browses its items");

/* --- P11-21: direct URL vs. default-provider handoff --- */
const { toNavigationUrl } = await import("../js/ui/searchbox.js");
const { browserHandoffForInput } = await import("../js/lib/search-handoff.js");
check(toNavigationUrl("example.com") === "https://example.com", "F2 nav: bare host → https URL");
check(toNavigationUrl("foo.io/bar?x=1") === "https://foo.io/bar?x=1", "F2 nav: host/path → https URL");
check(toNavigationUrl("https://a.com/x") === "https://a.com/x", "F2 nav: explicit scheme kept as-is");
check(toNavigationUrl("localhost:3000") === "https://localhost:3000", "F2 nav: localhost:port → https URL");
check(
  toNavigationUrl("how do i vim") === null &&
  JSON.stringify(browserHandoffForInput("how do i vim")) ===
    JSON.stringify({ type: "search-web", text: "how do i vim" }),
  "P11-21: plain text becomes a provider-neutral web-search target"
);
check(
  browserHandoffForInput("x") === null &&
  browserHandoffForInput("la") === null &&
  browserHandoffForInput("session:Missing") === null &&
  browserHandoffForInput("view:Today notes") === null,
  "P11-21: one-character, partial-filter, and scoped misses never leave EveryTab"
);
check(JSON.stringify(browserHandoffForInput(" docs.example/path ")) === JSON.stringify({
  type: "open-url", url: "https://docs.example/path"
}), "P11-21: URL-like input remains a direct site target");

/* --- M4: inbox expiry → archive --- */
delete mem[STORE_KEYS.inbox];
delete mem[STORE_KEYS.archive];
mem.settings = { inboxExpiryDays: 30 };

const oldItem = {
  ...(await newMeta()),
  kind: "tab",
  tabs: [{ url: "https://stale.com", title: "Stale saved page" }],
  source: "dump",
  labels: []
};
oldItem.createdAt = NOW - 31 * DAY;
oldItem.modifiedAt = NOW - 31 * DAY;
const freshItem = {
  ...(await newMeta()),
  kind: "tab",
  tabs: [{ url: "https://stale-fresh.com", title: "Stale but fresh" }],
  source: "dump",
  labels: []
};
const legacyItem = {
  ...(await newMeta()),
  kind: "tab",
  tabs: [{ url: "https://legacy-stale.com", title: "Legacy stale saved page" }],
  source: "dump",
  labels: []
};
legacyItem.createdAt = NOW - 50 * DAY;
delete legacyItem.modifiedAt;
mem[STORE_KEYS.inbox] = {
  [oldItem.id]: oldItem,
  [freshItem.id]: freshItem,
  [legacyItem.id]: legacyItem
};

const moved = await sweepInboxExpiry(NOW);
check(moved === 2, "expiry moves old current and legacy items past the age");
const expiryActivity = mem.journal?.find((entry) => entry.actionKind === "auto-archived-items");
check(
  expiryActivity?.actionParams?.count === 2 &&
    expiryActivity.actionParams.name === "Stale saved page",
  "automatic Inbox expiry records a representative affected link for Activity"
);
const archiveItems = await listItems(STORE_KEYS.archive);
check(
  archiveItems.length === 2 && archiveItems.some((item) => item.id === oldItem.id) &&
    archiveItems.some((item) => item.id === legacyItem.id) &&
    archiveItems.every((item) => item.archivedAt === NOW),
  "expired current and legacy items land in Archive with archivedAt and the same ids"
);
const inboxLeft = await listItems(STORE_KEYS.inbox);
check(
  inboxLeft.length === 1 && inboxLeft[0].id === freshItem.id,
  "expired item tombstoned in Inbox, fresh one stays"
);
check((await sweepInboxExpiry(NOW)) === 0, "expiry sweep is idempotent");

const relabeledOldItem = {
  ...(await newMeta()),
  kind: "tab",
  tabs: [{ url: "https://relabeled-old.test", title: "Old Inbox item labeled recently" }],
  source: "dump",
  labels: ["recently-labelled"],
  createdAt: NOW - 57 * DAY,
  modifiedAt: NOW - DAY
};
mem[STORE_KEYS.inbox] = { [relabeledOldItem.id]: relabeledOldItem };
mem.settings = { inboxExpiryDays: 55 };
check((await sweepInboxExpiry(NOW)) === 1,
  "Inbox expiry follows the saved age even when a later label edit refreshed modifiedAt");
check((await listItems(STORE_KEYS.archive)).some((item) => item.id === relabeledOldItem.id),
  "a 57-day-old item moves to Archive at a 55-day threshold");
mem.settings = { inboxExpiryDays: 0 };
mem[STORE_KEYS.inbox] = { [freshItem.id]: { ...inboxLeft[0], modifiedAt: NOW - 400 * DAY } };
check((await sweepInboxExpiry(NOW)) === 0, "expiry 0 = never");

// search covers the archive, ranked after inbox
mockWindows = [];
const staleRes = await searchAll("stale");
check(
  staleRes.some((r) => r.type === "archive" && r.url === "https://stale.com"),
  "searchAll finds archived items"
);
check(
  staleRes[0].type === "inbox" && staleRes[1].type === "archive",
  "search ranks inbox before archive"
);

// N7: auto-snapshots carry structured age data; presentation owns localized copy
for (const k of Object.values(STORE_KEYS)) delete mem[k];
mockWindows = [];
await upsertItem(STORE_KEYS.sessions, { ...(await newMeta()), name: "My workspace", auto: false,
  windows: [[{ url: "https://n7.example.com/named", title: "N7 named" }]], labels: [] });
await upsertItem(STORE_KEYS.sessions, { ...(await newMeta()), name: "Snapshot 2026-07-09 14:30", auto: true,
  windows: [[{ url: "https://n7.example.com/snap", title: "N7 snap" }]], labels: [] });
const n7res = await searchAll("n7.example");
const n7named = n7res.find((r) => r.url === "https://n7.example.com/named");
const n7snap = n7res.find((r) => r.url === "https://n7.example.com/snap");
check(n7named && n7named.type === "session" && !n7named.snapshot && n7named.sourceName === "My workspace",
  "N7: a named session reads with its name");
check(
  n7snap && n7snap.type === "session" && n7snap.snapshot === true &&
    n7snap.sourceCreatedAt > 0 && /^Snapshot · /.test(searchResultMeta(n7snap)),
  "N7: an auto-snapshot is flagged and reads 'Snapshot · {age}', not 'session'"
);

await runSmokeSavedDataWorkflows({
  check,
  local: mem,
  browserEffects: smokeBrowserEffects
});

/* --- N3: slider settings — migration, off-semantics, round-trip, sub-day sweep --- */
{
  const { getSettings } = await import("../js/lib/store.js");
  const {
    SUSPEND_STOPS, AUTO_DUMP_MINUTES, suspendLabel, autoDumpLabel,
    nearestIndex, suspendPatch, autoDumpPatch
  } = await import("../js/ui/slider.js");

  // migration: absent autoDumpAfterMinutes ← autoArchiveDays × 1440 (old installs)
  mem.settings = { autoArchiveDays: 14 };
  check((await getSettings()).autoDumpAfterMinutes === 14 * 1440,
    "N3 migration: absent autoDumpAfterMinutes derives from autoArchiveDays×1440");
  mem.settings = { autoArchiveDays: 14, autoDumpAfterMinutes: 360 };
  check((await getSettings()).autoDumpAfterMinutes === 360,
    "N3 migration: a stored autoDumpAfterMinutes is preserved (no clobber)");
  mem.settings = {};
  check((await getSettings()).autoDumpAfterMinutes === 7 * 1440,
    "N3 migration: fresh install derives from the 7-day default");

  // off-semantics: 0 ⇒ disabled both features; >0 ⇒ enabled + value
  check(JSON.stringify(suspendPatch(0)) === JSON.stringify({ suspendEnabled: false }),
    "N3 off: suspend slider 0 ⇒ suspendEnabled false");
  check(suspendPatch(45).suspendEnabled === true && suspendPatch(45).suspendAfterMinutes === 45,
    "N3 on: suspend slider 45 ⇒ enabled + 45 min");
  check(JSON.stringify(autoDumpPatch(0)) === JSON.stringify({ autoArchiveEnabled: false }),
    "N3 off: auto-dump slider 0 ⇒ autoArchiveEnabled false");
  const adp = autoDumpPatch(360);
  check(adp.autoArchiveEnabled === true && adp.autoDumpAfterMinutes === 360 && adp.autoArchiveDays === 1,
    "N3 on: auto-dump 6h ⇒ enabled + 360 min + autoArchiveDays rounded up to 1 (back-compat)");
  check(autoDumpPatch(10080).autoArchiveDays === 7,
    "N3: the 7-day stop still writes autoArchiveDays 7");

  // stop ↔ minutes round-trip + human labels
  check(AUTO_DUMP_MINUTES[nearestIndex(AUTO_DUMP_MINUTES, 360)] === 360,
    "N3 round-trip: an exact stop (6h) maps to itself");
  check(AUTO_DUMP_MINUTES[nearestIndex(AUTO_DUMP_MINUTES, 5000)] === 4320,
    "N3 round-trip: an off-stop value snaps to the nearest stop (3d)");
  check(autoDumpLabel(360) === "6 hours" && autoDumpLabel(0) === "Off",
    "N3 labels: auto-dump human labels for aria-valuetext");
  check(SUSPEND_STOPS[nearestIndex(SUSPEND_STOPS, 45)] === 45 &&
    suspendLabel(45) === "45 min" && suspendLabel(0) === "Off",
    "N3 labels: suspend stop + label");

  // sub-day sweep: a 6h threshold archives a 7h-idle tab, spares a 3h-idle one
  mem.settings = { autoArchiveEnabled: true, autoDumpAfterMinutes: 360 };
  const NOWX = Date.now();
  mem.tabActivity = { 701: NOWX - 7 * 3600_000, 702: NOWX - 3 * 3600_000 };
  mockWindows = [
    { id: 1, focused: true, tabs: [
      { id: 701, url: "https://stale6h.com", title: "old", active: false, groupId: -1 },
      { id: 702, url: "https://fresh6h.com", title: "fresh", active: false, groupId: -1 }
    ] }
  ];
  createdWindows = [];
  removedTabIds = [];
  delete mem[STORE_KEYS.inbox];
  const swept = await archiveSweep(NOWX);
  check(swept === 1 && removedTabIds.length === 1 && removedTabIds[0] === 701,
    "N3 sweep: a 6h auto-dump threshold archives the 7h-idle tab, not the 3h one");
}

/* --- N5: label input commits pending typed text (minimal DOM shim) --- */
{
  const mkNode = (tag) => {
    const set = new Set();
    const n = {
      tagName: String(tag).toUpperCase(), children: [], type: undefined, className: "", value: "",
      classList: {
        add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
        toggle: (c, f) => { const has = set.has(c); (f ?? !has) ? set.add(c) : set.delete(c); }
      },
      setAttribute(k, v) { if (k === "type") n.type = v; if (k === "class") n.className = v; },
      getAttribute() { return null; },
      removeAttribute() {},
      addEventListener() {},
      append(...ch) { for (const c of ch) if (c != null) n.children.push(c); },
      replaceChildren(...ch) { n.children = ch.filter((c) => c != null); },
      focus() {}, remove() {},
      querySelector(sel) {
        const cls = sel.replace(/^\./, "");
        const walk = (node) => {
          for (const c of node.children || []) {
            if (c && c.className === cls) return c;
            const f = walk(c); if (f) return f;
          }
          return null;
        };
        return walk(n);
      }
    };
    return n;
  };
  globalThis.document = { createElement: mkNode };
  const { createLabelInput } = await import("../js/ui/labelinput.js");
  const li = createLabelInput({ placeholder: "Labels…" });
  const input = li.element.querySelector(".taginput");
  input.value = "  research  "; // typed but never committed (no Enter/Tab)
  const got = li.getLabels();
  check(got.length === 1 && got[0] === "research",
    "N5: getLabels commits pending typed text (trimmed), so type-then-click works");
  check(li.getLabels().length === 1, "N5: getLabels is idempotent after committing");
  delete globalThis.document;
}

/* --- P2g-1: the P2 combobox (pick-or-create + plain flavors, DOM shim with events) --- */
{
  const mkNode = (tag) => {
    const set = new Set();
    const attrs = {};
    const handlers = {};
    const n = {
      tagName: String(tag).toUpperCase(), children: [], type: undefined, value: "", disabled: false,
      classList: {
        add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
        toggle: (c, f) => { const has = set.has(c); (f ?? !has) ? set.add(c) : set.delete(c); }
      },
      setAttribute(k, v) { attrs[k] = String(v); if (k === "type") n.type = v; if (k === "class") for (const c of String(v).split(/\s+/)) set.add(c); },
      removeAttribute(k) { delete attrs[k]; },
      getAttribute(k) { return k in attrs ? attrs[k] : null; },
      addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
      async dispatch(type, evt = {}) {
        const e = { key: "", preventDefault() {}, stopPropagation() {}, ...evt };
        for (const fn of handlers[type] ?? []) await fn(e);
      },
      append(...ch) { for (const c of ch) if (c != null) n.children.push(c); },
      replaceChildren(...ch) { n.children = ch.filter((c) => c != null); },
      focus() {}, select() {}, remove() {}
    };
    return n;
  };
  globalThis.document = { createElement: mkNode };
  const { createCombobox } = await import("../js/ui/combobox.js");
  const sessions = [{ id: "s1", name: "Research" }, { id: "s2", name: "Trip planning" }];
  const make = (over = {}) => {
    const out = { committed: null, cancelled: false };
    const cb = createCombobox({
      loadOptions: async () => sessions,
      emptyCreateLabel: "New session (auto-name)",
      createLabel: (v) => `New session “${v}”`,
      onCommit: (v) => { out.committed = v; },
      onCancel: () => { out.cancelled = true; },
      ...over
    });
    const input = cb.element.children[0];
    const menu = cb.element.children[1];
    return { cb, input, menu, out };
  };

  // opens with the full target list visible (+ the empty-create entry first)
  {
    const { input, menu } = make();
    await input.dispatch("focus");
    check(menu.children.length === 3 && menu.children[0].children[0] === "New session (auto-name)",
      "P2g-1: combobox opens with auto-name entry + every existing session visible");
    check(input.getAttribute("aria-expanded") === "true" && input.getAttribute("role") === "combobox",
      "P2g-1: ARIA combobox semantics (role + aria-expanded)");
  }
  // typing a new name → explicit Create entry first; Enter commits isNew
  {
    const { input, out } = make();
    await input.dispatch("focus");
    input.value = "Shirt hunt";
    await input.dispatch("input");
    await input.dispatch("keydown", { key: "Enter" });
    check(out.committed?.isNew === true && out.committed.name === "Shirt hunt" && out.committed.id === null,
      "P2g-1: Enter on a fresh name commits an explicit create");
  }
  // typing an exact existing name → NO create entry; Enter targets the existing session
  {
    const { input, menu, out } = make();
    await input.dispatch("focus");
    input.value = "research"; // case-insensitive exact match
    await input.dispatch("input");
    check(menu.children.length === 1 && menu.children[0].children[0] === "Research",
      "P2g-1: an exact name match hides the Create entry (no duplicate names by typing)");
    await input.dispatch("keydown", { key: "Enter" });
    check(out.committed?.isNew === false && out.committed.id === "s1",
      "P2g-1: Enter on an exact match appends to the existing session");
  }
  // arrow down onto an existing session and pick it
  {
    const { input, out } = make();
    await input.dispatch("focus");
    await input.dispatch("keydown", { key: "ArrowDown" }); // auto-name entry
    await input.dispatch("keydown", { key: "ArrowDown" }); // Research
    check(input.getAttribute("aria-activedescendant") !== null,
      "P2g-1: arrow navigation sets aria-activedescendant");
    await input.dispatch("keydown", { key: "Enter" });
    check(out.committed?.isNew === false && out.committed.id === "s1",
      "P2g-1: arrows + Enter pick an existing session");
  }
  // Enter on an empty input commits the auto-name create (blank = auto-name)
  {
    const { input, out } = make();
    await input.dispatch("focus");
    await input.dispatch("keydown", { key: "Enter" });
    check(out.committed?.isNew === true && out.committed.name === "",
      "P2g-1: empty Enter commits the auto-name create when allowed");
  }
  // Escape cancels and never commits
  {
    const { input, out } = make();
    await input.dispatch("focus");
    input.value = "half-typed";
    await input.dispatch("input");
    await input.dispatch("keydown", { key: "Escape" });
    check(out.cancelled === true && out.committed === null,
      "P2g-1: Esc cancels without committing");
  }
  // Existing-only flavor never invents a new Session from unmatched text.
  {
    const { input, menu, out } = make({ allowCreate: false, emptyCreateLabel: null });
    await input.dispatch("focus");
    check(menu.children.length === 2 && menu.children[0].children[0] === "Research",
      "P2g-1: existing-only picker opens with named Sessions and no Create row");
    input.value = "Not a saved session";
    await input.dispatch("input");
    check(menu.classList.contains("hidden"),
      "P2g-1: unmatched text cannot become a Session in existing-only mode");
    await input.dispatch("keydown", { key: "Enter" });
    check(out.cancelled === true && out.committed === null,
      "P2g-1: Enter on unmatched text cancels the existing-only picker safely");
  }
  // plain flavor (rename): no menu, Enter commits the text, empty Enter cancels
  {
    const { input, menu, out } = make({ loadOptions: null, emptyCreateLabel: null, value: "Old name" });
    await input.dispatch("focus");
    check(menu.classList.contains("hidden"), "P2g-1: plain (rename) flavor opens no menu");
    input.value = "New name";
    await input.dispatch("keydown", { key: "Enter" });
    check(out.committed?.name === "New name" && out.committed.isNew === true,
      "P2g-1: plain flavor Enter commits the typed name");
    const empty = make({ loadOptions: null, emptyCreateLabel: null, value: "" });
    await empty.input.dispatch("keydown", { key: "Enter" });
    check(empty.out.cancelled === true && empty.out.committed === null,
      "P2g-1: plain flavor with nothing typed cancels instead of committing blank");
  }
  delete globalThis.document;
}

await runSmokeListWorkflows({
  check,
  local: mem,
  browserEffects: smokeBrowserEffects
});

/* --- L2b: competitive import formats (detectFormat + parseImport, pure) --- */
{
  const {
    detectFormat, parseImport, parseCsv, importCounts, IMPORT_FORMAT_IDS
  } = await import("../js/lib/import-formats.js");
  const { importFormatLabel, importFormatOptions } = await import("../js/lib/import-copy.js");

  // Session Buddy v4 — collection/folder → groups; collection+folder titles → labels
  const SB4 = '{"collections":[{"title":"Research","folders":[{"title":"Dogs","links":[{"title":"German Shepherd","url":"https://en.wikipedia.org/wiki/German_Shepherd","favIconUrl":"https://en.wikipedia.org/favicon.ico"},{"title":"Retriever search","url":"https://www.google.com/search?q=retriever","pinned":true}]},{"title":"Cats","links":[{"title":"Ragdoll","url":"https://www.youtube.com/results?search_query=ragdoll"}]}]}]}';
  check(detectFormat(SB4) === "session-buddy", "L2b detect: Session Buddy v4");
  const sb4 = parseImport(SB4, "session-buddy");
  check(sb4.name === "Research" && sb4.groups.map((g) => g.name).join(",") === "Dogs,Cats",
    "L2b SB4: collection name + folder groups");
  check(JSON.stringify(sb4.groups[0].tabs[0].labels) === JSON.stringify(["Research", "Dogs"]),
    "L2b SB4: collection+folder titles become tab labels");
  check(sb4.groups[0].tabs[1].pinned === true &&
    sb4.groups[0].tabs[0].favIconUrl === "https://en.wikipedia.org/favicon.ico",
    "L2b SB4: pinned + http favicon preserved");
  // L2c: aggregate counts for the import preview
  check(JSON.stringify(importCounts(sb4.groups)) === JSON.stringify({ groups: 2, tabs: 3, labels: 3 }),
    "L2c importCounts: groups + links + distinct labels (SB4 = 2/3/3)");
  check(JSON.stringify(importCounts([])) === JSON.stringify({ groups: 0, tabs: 0, labels: 0 }),
    "L2c importCounts: empty → all zero");

  // Session Buddy v3 + a leading BOM (real exports have shipped with one)
  const SB3 = '{"sessions":[{"name":"My session","generated":1700000000000,"windows":[{"tabs":[{"id":1,"index":0,"url":"https://a.example/","title":"A"},{"id":2,"index":1,"url":"https://b.example/","title":"B","favIconUrl":"https://b.example/f.ico"}]}]}]}';
  check(detectFormat("﻿" + SB3) === "session-buddy", "L2b detect: SB v3 with a leading BOM");
  const sb3 = parseImport("﻿" + SB3, "session-buddy");
  check(sb3.name === "My session" && sb3.groups[0].tabs.map((t) => t.title).join(",") === "A,B",
    "L2b SB3: BOM stripped, session name + tabs parsed");

  // Tab Session Manager — windows/tabs keyed by id; sort by index (A before B)
  const TSM = '[{"name":"Work","date":1700000000000,"tag":["job"],"id":"x-1","windowsNumber":1,"tabsNumber":2,"windows":{"11":{"101":{"id":101,"index":1,"windowId":11,"url":"https://b.example/","title":"B","pinned":false},"100":{"id":100,"index":0,"windowId":11,"url":"https://a.example/","title":"A","pinned":true}}},"windowsInfo":{"11":{"id":11,"type":"normal"}}}]';
  check(detectFormat(TSM) === "tab-session-manager", "L2b detect: Tab Session Manager");
  const tsm = parseImport(TSM, "tab-session-manager");
  check(tsm.groups[0].tabs.map((t) => t.title).join(",") === "A,B",
    "L2b TSM: tabs sorted by index (A before B, not object-key order)");
  check(JSON.stringify(tsm.groups[0].tabs[0].labels) === JSON.stringify(["Work", "job"]) &&
    tsm.groups[0].tabs[0].pinned === true,
    "L2b TSM: name + tag → labels; pinned preserved");

  // Toby — customTitle (when non-empty) wins over title
  const TOBY = '{"version":3,"lists":[{"title":"Reading","cards":[{"title":"Article A","url":"https://a.example/read","customTitle":"","customDescription":""},{"title":"raw","url":"https://b.example/","customTitle":"Nice name","customDescription":""}]},{"title":"Shopping","cards":[{"title":"Shirt","url":"https://shop.example/shirt"}]}]}';
  check(detectFormat(TOBY) === "toby", "L2b detect: Toby");
  const toby = parseImport(TOBY, "toby");
  check(toby.groups[0].tabs.map((t) => t.title).join(",") === "Article A,Nice name",
    "L2b Toby: non-empty customTitle wins over title");
  check(JSON.stringify(toby.groups[1].tabs[0].labels) === JSON.stringify(["Shopping"]),
    "L2b Toby: list title → label");

  // Raindrop CSV — RFC-4180 quoting (comma inside a quoted title), folder groups
  const CSV = `folder,url,title,note,tags,created
"Dev/JS",https://a.example/,A page,"a note","js, reading",1629980125
"Dev/JS",https://b.example/,"B, with comma","","js",1629980126
"Recipes",https://c.example/,C page,"","",1629980127`;
  check(detectFormat(CSV) === "raindrop-csv", "L2b detect: Raindrop CSV header");
  const csv = parseImport(CSV, "raindrop-csv");
  check(csv.groups.map((g) => g.name).join("|") === "Dev/JS|Recipes", "L2b CSV: rows grouped by folder path");
  check(csv.groups[0].tabs[1].title === "B, with comma", "L2b CSV: comma inside a quoted field parsed");
  check(JSON.stringify(csv.groups[0].tabs[0].labels) === JSON.stringify(["Dev", "JS", "js", "reading"]),
    "L2b CSV: folder path segments + tags → labels (deduped)");
  check(parseCsv('a,"b,c","d""e"')[0].join("|") === 'a|b,c|d"e',
    "L2b CSV parser: quotes, embedded comma, doubled-quote escape");

  // Bookmarks HTML — folder-path stack; ICON data URIs dropped; root link grouped
  const HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
<DL><p>
  <DT><H3 ADD_DATE="1629980125">Dev</H3>
  <DL><p>
    <DT><H3>JS</H3>
    <DL><p>
      <DT><A HREF="https://a.example/" ADD_DATE="1629980125" TAGS="js,reading">A page</A>
      <DT><A HREF="https://b.example/" ICON="data:image/png;base64,AAAA">B page</A>
    </DL><p>
  </DL><p>
  <DT><A HREF="https://root.example/">Root link</A>
</DL><p>`;
  check(detectFormat(HTML) === "bookmarks-html", "L2b detect: Netscape bookmarks HTML");
  const html = parseImport(HTML, "bookmarks-html");
  check(html.groups.map((g) => g.name).join("|") === "Dev/JS|Imported bookmarks",
    "L2b HTML: folder stack yields Dev/JS + a root group");
  check(JSON.stringify(html.groups[0].tabs[0].labels) === JSON.stringify(["Dev", "JS", "js", "reading"]),
    "L2b HTML: folder path + TAGS → labels");
  check(html.groups[0].tabs[1].favIconUrl === undefined && html.groups[0].tabs[1].url === "https://b.example/",
    "L2b HTML: ICON data: URI dropped, http link kept");

  // EveryTab Markdown — exact copy helpers round-trip names, window order,
  // escaped titles, and URLs whose path contains parentheses.
  const { linksToMarkdown, sessionToMarkdown } = await import("../js/lib/export.js");
  const MD = sessionToMarkdown({
    name: "Shared research",
    windows: [
      [{ url: "https://a.example/guide_(v2)?q=1", title: "A [beta] guide" }],
      [
        { url: "https://b.example/", title: "B" },
        { url: "chrome://settings", title: "Not shareable" }
      ]
    ]
  });
  check(detectFormat(MD) === "everytab-markdown", "Markdown detect: EveryTab session copy");
  const md = parseImport(MD, "everytab-markdown");
  check(md.name === "Shared research" && md.source === "everytab-markdown" &&
    md.groups.map((g) => g.name).join("|") === "Window 1|Window 2",
    "Markdown import: H1 names the import and H2 headings preserve window order");
  check(md.groups[0].tabs[0].title === "A [beta] guide" &&
    md.groups[0].tabs[0].url === "https://a.example/guide_(v2)?q=1" &&
    md.groups[1].tabs.length === 1,
    "Markdown import: escaped titles and parenthesized URLs round-trip; non-web links stay excluded");
  check(JSON.stringify(md.groups[0].tabs[0].labels) === JSON.stringify(["Shared research"]),
    "Markdown import: the shared heading is available through the existing labels toggle");

  const FLAT_MD = linksToMarkdown([
    { url: "https://one.example/", title: "One" },
    { url: "https://two.example/", title: "Two" }
  ]);
  const flatMd = parseImport(FLAT_MD, "everytab-markdown");
  check(detectFormat(FLAT_MD) === "everytab-markdown" && flatMd.groups.length === 1 &&
    flatMd.groups[0].name === "" && flatMd.groups[0].tabs.map((tab) => tab.title).join(",") === "One,Two",
    "Markdown import: a copied window or selection becomes one ordered group without inventing a name");
  check(detectFormat("A prose [link](https://example.com) is not an EveryTab list.") === null &&
    parseImport("# Empty\n\n- [Settings](chrome://settings)", "everytab-markdown").groups.length === 0,
    "Markdown import: ordinary prose is not claimed and unsafe/internal links are rejected");
  const { readFileSync: readMarkdownImportUi } = await import("node:fs");
  const markdownImportUi = readMarkdownImportUi(new URL("../js/ui/data-surface.js", import.meta.url), "utf8");
  check(importFormatLabel("everytab-markdown") === "EveryTab Markdown" &&
    importFormatOptions()[0]?.id === IMPORT_FORMAT_IDS[0] &&
    markdownImportUi.includes(".md,.markdown") &&
    markdownImportUi.includes("dataStatic.importDescription()"),
    "Markdown import: Data exposes paste, .md files, and an explicit EveryTab format");

  // OneTab still detected + parsed through the unified path (regression)
  const ONETAB = "https://a.example/ | A\nhttps://b.example/ | B\n\nhttps://c.example/ | C";
  check(detectFormat(ONETAB) === "onetab", "L2b detect: OneTab plain text");
  const ot = parseImport(ONETAB, "onetab");
  check(ot.groups.length === 2 && ot.groups[0].tabs.length === 2 && ot.groups[1].tabs[0].title === "C",
    "L2b OneTab: blank-line groups preserved");

  // detection refuses garbage / unknown JSON / empty
  check(detectFormat("just some words, no links") === null, "L2b detect: plain prose → null");
  check(detectFormat('{"foo":123}') === null, "L2b detect: unknown JSON shape → null");
  check(detectFormat("") === null, "L2b detect: empty input → null");
  check(detectFormat("<html><body>hi</body></html>") === null, "L2b detect: non-Netscape HTML → null");
}

/* --- L-nav: Labels-page sort/filter helpers (pure) --- */
{
  const { sortLabelGroups, filterLabelGroups, labelCreatedAt, labelLastUsedAt } = await import("../js/lib/labels.js");
  // stamps: [createdAt, modifiedAt] per carrier item
  const g = (label, tabs, stamps) => ({ label, tabs, entries: stamps.map(([c, m]) => ({ item: { createdAt: c, modifiedAt: m } })) });
  const groups = [
    g("Reading", 12, [[100, 700], [300, 750]]), // min created 100, max modified 750
    g("work", 8, [[500, 500]]),
    g("Cats", 2, [[900, 900]]),
    g("dev", 8, [[200, 990]])                   // most recently USED (modified 990)
  ];
  check(sortLabelGroups(groups, "az").map((x) => x.label).join(",") === "Cats,dev,Reading,work",
    "L-nav az: alphabetical, case-insensitive");
  check(sortLabelGroups(groups, "count").map((x) => x.label).join(",") === "Reading,dev,work,Cats",
    "L-nav count: most tabs first, ties break A–Z");
  check(sortLabelGroups(groups, "recent").map((x) => x.label).join(",") === "dev,Cats,Reading,work",
    "L-nav-5 recent: latest usage first (max modifiedAt desc)");
  check(labelLastUsedAt(groups[0]) === 750, "L-nav-5: labelLastUsedAt is the max modifiedAt across carriers");
  check(labelCreatedAt(groups[0]) === 100, "L-nav: labelCreatedAt is the min createdAt");
  check(groups[0].label === "Reading", "L-nav: sort returns a new array, input order untouched");
  check(filterLabelGroups(groups, "RE").map((x) => x.label).join(",") === "Reading",
    "L-nav filter: case-insensitive substring on the label name");
  check(filterLabelGroups(groups, "").length === 4, "L-nav filter: empty query returns all");
  check(filterLabelGroups(groups, "zzz").length === 0, "L-nav filter: no match → empty");
}

/* --- P11-26/27: six-step first run + separate permanent Help --- */
{
  const {
    HELP_GROUPS, HELP_TOPICS, ONBOARDING_PAGES, SECTION_TO_PAGE, helpTopicId, onboardingStepId
  } = await import("../js/lib/onboarding-copy.js");
  const ids = ONBOARDING_PAGES.map((p) => p.id);
  const helpIds = HELP_TOPICS.map((p) => p.id);
  check(ONBOARDING_PAGES.length === 6, `first run has six outcome steps (got ${ONBOARDING_PAGES.length})`);
  check(new Set(ids).size === ids.length, "onboarding page ids are unique");
  check(
    JSON.stringify(ids) === JSON.stringify(["local", "find", "save", "newtab", "scheme", "data"]),
    "first run follows the six approved outcomes in order"
  );
  check(
    ONBOARDING_PAGES.every((p) => p.id && p.title && p.why),
    "every onboarding page has id + title + why"
  );
  // The tour no longer runs live "Try it" actions (2026-07-14 feedback): no page
  // carries a `try` block anymore.
  check(
    ONBOARDING_PAGES.every((p) => !p.try),
    "no onboarding page carries a live Try block (tour is non-disruptive)"
  );
  // The quiet automation beat is part of Save now, sort later.
  const save = ONBOARDING_PAGES.find((p) => p.id === "save");
  check(
    save?.special === "automation" && !JSON.stringify(save).toLowerCase().includes("snapshot"),
    "first run focuses on optional auto-save and suspension, not Snapshot setup"
  );
  const overview = ONBOARDING_PAGES.find((p) => p.id === "local");
  const scheme = ONBOARDING_PAGES.find((p) => p.id === "scheme");
  check(overview?.benefits?.length === 3 &&
    ONBOARDING_PAGES.find((p) => p.id === "find")?.definitions?.length === 3 &&
    scheme?.special === "scheme",
  "first run explains the purpose and saving choices before actual appearance controls");
  check(HELP_TOPICS.length === 14 && new Set(helpIds).size === helpIds.length &&
    ["open", "inbox", "sessions", "labels", "search", "snooze", "focus", "automation",
      "close-day", "appearance", "keyboard", "data", "history", "safety"]
      .every((id) => helpIds.includes(id)),
  "permanent Help is a separate, complete topic library");
  const groupedHelpIds = HELP_GROUPS.flatMap((group) => group.topicIds);
  check(HELP_GROUPS.length === 4 && groupedHelpIds.length === HELP_TOPICS.length &&
    new Set(groupedHelpIds).size === HELP_TOPICS.length &&
    groupedHelpIds.every((id) => helpIds.includes(id)),
  "Help groups every topic exactly once around user goals");
  const helpStructures = new Set(HELP_TOPICS.flatMap((topic) =>
    [topic.how?.length && "points", topic.steps?.length && "steps", topic.terms?.length && "terms"]
      .filter(Boolean)));
  check(
    ["points", "steps", "terms"].every((kind) => helpStructures.has(kind)) &&
      HELP_TOPICS.some((topic) => !topic.how && !topic.steps && !topic.terms) &&
      HELP_TOPICS.filter((topic) => topic.how?.length === 3).length < HELP_TOPICS.length / 2,
    "Help uses prose, task steps, compact references, and selective points instead of one repeated template"
  );
  check(onboardingStepId("machinery") === "save" && onboardingStepId("vault") === "data" &&
    helpTopicId("snapshots") === "sessions" && helpTopicId("unknown") === "open",
  "legacy incomplete tours and old Learn more routes resolve safely");

  // Copy lint: walk every string field of every page.
  const strings = [];
  const walk = (v) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(ONBOARDING_PAGES);
  walk(HELP_TOPICS);
  check(!strings.some((s) => s.includes("—")), "onboarding copy has no em dashes (brand rule)");
  check(!strings.some((s) => s.includes("TabVault")), "onboarding copy never says the old TabVault name");
  check(!strings.some((s) => /phoned home/i.test(s)), "onboarding copy drops the retired 'phoned home' line");
  check(!strings.some((s) =>
    /current window is the one|stable lane model|when useful|receipt supports|same layout|a calm place|undo stays close|set it to 0/i.test(s)),
  "Help omits implementation explanations, mechanical filler, and other AI-sounding copy");
  const openHelp = HELP_TOPICS.find((topic) => topic.id === "open");
  check(openHelp?.why.length === 0 && openHelp.how?.length === 4 &&
    openHelp.how.some((item) => item.includes("Organize")),
  "Open Tabs Help leads with its outcome and covers the real daily tools");
  const introFind = ONBOARDING_PAGES.find((page) => page.id === "find");
  check(introFind?.definitions?.map(([name]) => name).join(",") === "inbox,sessions,labels" &&
    introFind.note?.includes("Search") && !introFind.how,
  "first run distinguishes the three saving tools and keeps Search guidance concise");
  const linkedHelp = Object.fromEntries(HELP_TOPICS.map((topic) => [topic.id, topic.settingsGroups ?? []]));
  check(linkedHelp.inbox.includes("autosave") && linkedHelp.sessions.includes("sessions") &&
    linkedHelp.focus.includes("focus") && linkedHelp.automation.length === 4 &&
    linkedHelp.appearance.includes("newtab") && linkedHelp.keyboard.includes("keyboard") &&
    linkedHelp.history.includes("privacy"),
  "Help topics that name a setting carry exact Settings-section destinations");

  const { readFileSync: readOnboardingSource } = await import("node:fs");
  const settingsFormSource = readOnboardingSource(
    new URL("../js/ui/settings-form.js", import.meta.url), "utf8");
  check(settingsFormSource.includes("replayOnboarding") &&
    !settingsFormSource.includes("location.assign(dashboardHref())"),
  "Replay intro invokes the tour directly instead of relying on a Dashboard reload");
  const dashboardSource = readOnboardingSource(
    new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
  check(dashboardSource.includes("const settingsDeepLink = /^settings:") &&
    dashboardSource.includes("scrollToSettingsGroup(deepSettingsGroup)") &&
    dashboardSource.includes('history.replaceState(null, "", "#settings")'),
  "Help Settings links route to one exact group and settle without repeated scroll theft");

  // Learn more now enters Help, never the first-run sequence.
  check(
    Object.values(SECTION_TO_PAGE).every((pid) => helpIds.includes(pid)),
    "SECTION_TO_PAGE only points at real Help topics"
  );
}

runSmokeSearchContracts(check);

/* --- N25: blank is a first-class new-tab mode; default is unchanged --- */
{
  const { readFileSync } = await import("node:fs");
  const { DEFAULT_SETTINGS } = await import("../js/lib/types.js");
  const newtabCssSrc = readFileSync(new URL("../css/newtab.css", import.meta.url), "utf8");
  const newtabJsSrc = readFileSync(new URL("../js/ui/newtab.js", import.meta.url), "utf8");
  const primitivesSrc = readFileSync(new URL("../css/primitives.css", import.meta.url), "utf8");
  check(DEFAULT_SETTINGS.newTabMode === "dashboard", "N25: default new-tab mode is still 'dashboard'");
  check(
    ["dashboard", "minimal", "blank"].includes(DEFAULT_SETTINGS.newTabMode),
    "N25: newTabMode default is one of the three current modes"
  );
  check(newtabCssSrc.includes(".minimal-deck") &&
    newtabCssSrc.includes("padding-bottom: env(safe-area-inset-bottom)") &&
    newtabCssSrc.includes(".minimal-deck.is-search-expanded") &&
    newtabCssSrc.includes("--minimal-search-expanded-block: min(clamp(560px, 76vh, 720px), calc(100vh - 84px))") &&
    newtabCssSrc.includes("env(safe-area-inset-bottom)") &&
    !newtabCssSrc.includes("margin-top: 112px") &&
    !newtabCssSrc.includes("@media (max-width: 520px) { .links") &&
    newtabJsSrc.includes('document.documentElement.clientHeight') &&
    newtabJsSrc.includes("minimalSearchResultsRoom") &&
    newtabJsSrc.includes('expanded: deck.classList.contains("is-search-expanded")') &&
    newtabJsSrc.includes('deck.classList.toggle("is-search-expanded", expanded)') &&
    newtabJsSrc.includes('"--search-results-max-h"') &&
    primitivesSrc.includes("var(--search-results-max-h, 60vh)"),
    "N34/P11-24: Horizon keeps navigation in its safe-area command deck and measurably caps the Search overlay to the viewport");
}

/* --- N1: Chrome-native new-tab focus routing (2 × 2 matrix) --- */
{
  const { readFileSync } = await import("node:fs");
  const { DEFAULT_SETTINGS } = await import("../js/lib/types.js");
  const { newTabEntryPlan, dashboardHref, dashboardSearchIntent } = await import("../js/lib/newtab-focus.js");
  const plan = (mode, focus, search = "") => newTabEntryPlan({
    newTabMode: mode, newTabFocus: focus
  }, search);

  check(!plan("minimal", "omnibox").needsFocusNavigation &&
        plan("minimal", "omnibox").module === "newtab",
    "N1 matrix: Minimal + Address bar mounts in Chrome's override without navigation");
  check(plan("minimal", "search").needsFocusNavigation &&
        !plan("minimal", "search", "?focus=search").needsFocusNavigation,
    "N1 matrix: Minimal + EveryTab search performs exactly one focus-transfer navigation");
  check(!plan("dashboard", "omnibox").needsFocusNavigation &&
        plan("dashboard", "omnibox").module === "dashboard",
    "N1 matrix: Dashboard + Address bar mounts the shared dashboard in the override");
  check(plan("dashboard", "search").needsFocusNavigation &&
        !plan("dashboard", "search", "?focus=search").needsFocusNavigation,
    "N1 matrix: Dashboard + EveryTab search performs exactly one focus-transfer navigation");
  check(!plan("terminal", "omnibox").needsFocusNavigation &&
        plan("terminal", "omnibox").mode === "dashboard" &&
        plan("terminal", "omnibox").module === "dashboard",
    "N1 legacy: a retired Terminal preference safely falls back to Dashboard");
  check(!plan("blank", "search").needsFocusNavigation &&
        plan("blank", "search").module === "newtab",
    "N1: Blank never navigates or mounts dashboard regardless of the focus preference");
  check(plan("bad-mode", "bad-focus").mode === "dashboard" &&
        plan("bad-mode", "bad-focus").focus === "omnibox",
    "N1: malformed stored values safely fall back to Dashboard + Address bar");
  check(
    dashboardSearchIntent("").autofocus && !dashboardSearchIntent("").dismiss &&
      dashboardSearchIntent("#search").autofocus && !dashboardSearchIntent("#search").dismiss &&
      !dashboardSearchIntent("#inbox").autofocus && dashboardSearchIntent("#inbox").dismiss &&
      dashboardSearchIntent("#label:Work").raw === "label:Work",
    "P11-12r3: only plain Dashboard and the explicit Search handoff own Search focus"
  );
  const runtime = { getURL: (path) => `chrome-extension://test/${path}` };
  check(
    dashboardHref(undefined, runtime) === "chrome-extension://test/dashboard.html#open" &&
      dashboardHref("search", runtime) === "chrome-extension://test/dashboard.html#search" &&
      dashboardHref("#inbox", runtime) === "chrome-extension://test/dashboard.html#inbox",
    "Dashboard links land on a named route without Search focus; only the explicit Search route requests it"
  );

  const html = readFileSync(new URL("../newtab.html", import.meta.url), "utf8");
  const entry = readFileSync(new URL("../js/ui/newtab-entry.js", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
  const minimal = readFileSync(new URL("../js/ui/newtab.js", import.meta.url), "utf8");
  const boot = readFileSync(new URL("../js/boot.js", import.meta.url), "utf8");
  const dashboardHtml = readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");
  const background = readFileSync(new URL("../js/background.js", import.meta.url), "utf8");
  const singleton = readFileSync(new URL("../js/lib/newtab-singleton.js", import.meta.url), "utf8");
  const tabLifecycle = readFileSync(
    new URL("../js/background/tab-lifecycle-owner.js", import.meta.url), "utf8"
  );
  const runtimeLifecycle = readFileSync(
    new URL("../js/background/runtime-lifecycle-owner.js", import.meta.url), "utf8"
  );
  const settingsForm = readFileSync(new URL("../js/ui/settings-form.js", import.meta.url), "utf8");
  check(html.includes('src="./js/ui/newtab-entry.js"') &&
        html.includes('href="css/dashboard.css"') && html.includes('href="css/newtab.css"') &&
        !html.includes('href="css/terminal.css"'),
    "N1 host: the one manifest override mounts Dashboard, Minimal, or Blank without a retired Terminal layer");
  check(entry.includes('await import("./dashboard.js")') &&
        entry.includes('await import("./newtab.js")') && !html.includes("<iframe"),
    "N1 host: New-tab Dashboard and regular Dashboard share one module, with no iframe/copy");
  check(entry.includes('location.replace(chrome.runtime.getURL("newtab.html") + "?focus=search")'),
    "N1 host: EveryTab-search mode uses one explicit full-navigation focus transfer");
  check(dashboard.includes('dataset.newTabHost === "true"') &&
        dashboard.includes('isNewTabHost() && newTabFocus === "omnibox"'),
    "N1 Dashboard: address-bar mode suppresses the sole automatic search focus");
  check(minimal.includes('settings.newTabFocus === "search"') &&
        minimal.includes("href: dashboardHref()") &&
        !minimal.includes('dashboard.html") + "?src=newtab"'),
    "N1 Minimal: only search mode focuses; surface routing no longer redirects to Dashboard");
  check(!boot.includes('location.replace("dashboard.html?src=newtab")') &&
        dashboardHtml.includes('href="css/dashboard.css"'),
    "N1: pre-paint boot never destroys address-bar focus; regular Dashboard uses shared CSS");
  check(dashboard.includes('if (!isNewTabHost()) return;'),
    "N1: the one-time new-tab notice still recognizes Dashboard mounted in the host");
  check(
    DEFAULT_SETTINGS.oneNewTabPerWindow === true &&
      DEFAULT_SETTINGS.newTabWelcomeEnabled === true &&
      typeof getFreshSettings === "function" &&
      settingsForm.includes('check("oneNewTabPerWindow")') &&
      settingsForm.includes('check("newTabWelcomeEnabled")') &&
      entry.includes('type: "everytab-new-tab-mounted"') &&
      runtimeLifecycle.includes("newTabs.resetCreationOrder()") &&
      tabLifecycle.includes("shouldReconcileNewTabUpdate(changeInfo, tab") &&
      singleton.includes("const safeUntrackedReady = ready?.active === true"),
    "One-New-Tab defaults on, runs in the worker, and lets only the active mounted startup page consolidate"
  );
  check(
    dashboard.includes("dashboardSearchIntent(location.hash)") &&
      dashboard.includes("initialSearchIntent.autofocus") &&
      dashboard.includes("routeSearchIntent.dismiss") &&
      dashboard.includes("searchBox.dismissSearch({ blur: true })"),
    "P11-12r3: ordinary Dashboard opens may focus Search, but content deep links dismiss it"
  );
}

await runSmokeFocus({ check, local: mem });

await runSmokePresentationContracts({ check, local: mem });

await runSmokeDashboardContracts({ check });

await runSmokeStorageConcurrency({
  check,
  browserEffects: smokeBrowserEffects
});

finish(); // don't wait out the 6s badge-flash timers
