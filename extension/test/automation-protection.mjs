import assert from "node:assert/strict";
import { installSmokeChrome } from "./smoke-chrome.mjs";
import { createMockLockManager } from "./e2-mocks.mjs";

const local = {};
const session = {};
let windows = [];
const effects = { alarms: {}, notifications: [], badgeTexts: [] };
const tabsEffects = {
  removedIds: [], createdUrls: [], updated: [], discardedIds: [], moves: []
};
installSmokeChrome({
  storage: () => ({ local, session }),
  windows: () => ({ live: windows, created: [], removedIds: [], currentId: windows[0]?.id }),
  tabs: () => tabsEffects,
  effects: () => effects,
  groups: () => ({ records: {}, groupCalls: [], updateCalls: [], fail: false }),
  nextGroupId: () => 1,
  permissions: () => ({ granted: new Set(), requestGrants: false })
});
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});
const { installBrowserMapStorageAuthority } = await import("./storage-authority-fixture.mjs");
installBrowserMapStorageAuthority();

const {
  TAB_PROTECTIONS_KEY,
  protectionStatus,
  readProtectionStatus,
  readTabProtections,
  setProtection,
  removeProtection,
  removeTemporaryTabProtection,
  removeTemporaryTabProtectionOnClose,
  listTemporaryTabProtections,
  withAutomationProtectionEffect
} = await import("../js/lib/automation-protection.js");
const {
  exactAutomationSiteHostname,
  matchesAutomationExclusion
} = await import("../js/lib/tabs.js");

const tab = (id, url, extra = {}) => ({
  id, index: id, url, title: `Tab ${id}`, active: false, groupId: -1, ...extra
});
windows = [{ id: 1, type: "normal", focused: true, tabs: [
  tab(1, "https://shop.example/start"),
  tab(2, "https://shop.example/sibling")
] }];

const temporary = await setProtection(1, "tab");
assert.equal(temporary.ok, true);
assert.equal(temporary.kind, "tab");
assert.equal((await readProtectionStatus(2)).kind, "none",
  "a protected tab does not leak to a sibling on the same page");

windows[0].tabs[0].url = "https://unrelated.test/after-navigation";
assert.equal((await readProtectionStatus(1)).kind, "tab",
  "temporary protection follows the same tab across domains and navigation");
assert.equal((await listTemporaryTabProtections())[0].title, "Tab 1");

// Device-local operational state survives an extension worker/update reload.
// The explicit browser-start boundary clears numeric tab identities.
assert.ok((await readTabProtections())[1]?.expiresAt > Date.now());
const { beginTabProtectionBrowserSession } = await import("../js/lib/automation-protection.js");
let releaseStartupOverlap;
let enterStartupOverlap;
const startupOverlapEntered = new Promise((resolve) => { enterStartupOverlap = resolve; });
const startupOverlapGate = new Promise((resolve) => { releaseStartupOverlap = resolve; });
const overlappingEffect = withAutomationProtectionEffect(async () => {
  enterStartupOverlap();
  await startupOverlapGate;
  return readTabProtections();
});
await startupOverlapEntered;
let resetSettled = false;
const browserReset = beginTabProtectionBrowserSession().then(() => { resetSettled = true; });
releaseStartupOverlap();
assert.ok((await overlappingEffect)[1],
  "an effect-held snapshot never awaits the queued browser reset and deadlocks");
await browserReset;
assert.equal(resetSettled, true);
assert.equal((await readProtectionStatus(1)).kind, "none",
  "browser-start clearing prevents a reused numeric id inheriting protection");

windows[0].tabs[0].url = "https://www.shop.example/cart";
const website = await setProtection(1, "site");
assert.equal(website.kind, "site");
assert.equal(website.hostname, "www.shop.example");
assert.equal(website.siteHostname, "www.shop.example");
const siteRule = local.settings.suspendWhitelist.at(-1);
assert.equal(siteRule, "site:www.shop.example");
assert.equal(exactAutomationSiteHostname(siteRule), "www.shop.example");
assert.equal(matchesAutomationExclusion("https://checkout.www.shop.example/pay", [siteRule]), true);
assert.equal(matchesAutomationExclusion("https://evilwww.shop.example/pay", [siteRule]), false);
assert.equal(matchesAutomationExclusion("https://other.test/www.shop.example", [siteRule]), false);
assert.equal(matchesAutomationExclusion("https://shop.example/parent", [siteRule]), false,
  "the explicit www hostname does not infer a registrable parent");

windows[0].tabs[1].url = "https://tenant.host.example/work";
await setProtection(2, "site");
const tenantRule = local.settings.suspendWhitelist.at(-1);
assert.equal(tenantRule, "site:tenant.host.example");
assert.equal(matchesAutomationExclusion("https://other.host.example/work", [tenantRule]), false,
  "one multi-tenant hostname never protects its sibling tenant");

await removeProtection(1);
assert.equal(local.settings.suspendWhitelist.includes(siteRule), false,
  "removal deletes the exact explicit website marker");
local.settings.suspendWhitelist.push("shop.example/path");
local.settings.archiveWhitelist = [...local.settings.suspendWhitelist];
await removeProtection(1);
assert.equal(local.settings.suspendWhitelist.includes("shop.example/path"), true,
  "removal never deletes a legacy broad/substring rule");

windows[0].tabs[0].url = "https://page.example/doc?a=1";
await setProtection(1, "page");
assert.equal((await readProtectionStatus(1)).kind, "page");
windows[0].tabs[0].url = "https://page.example/doc?a=2";
assert.notEqual((await readProtectionStatus(1)).kind, "page",
  "an exact page marker does not follow navigation");
assert.equal((await setProtection(1, "page", {
  url: "https://page.example/doc?a=1", hostname: "page.example"
})).reason, "changed", "a stale exact-page picker cannot protect the navigated page");
assert.equal((await setProtection(1, "site", {
  url: "https://page.example/doc?a=1", hostname: "page.example"
})).ok, true, "site scope remains valid after a same-host path navigation");
windows[0].tabs[0].url = "https://different.example/";
assert.equal((await setProtection(1, "site", {
  url: "https://page.example/doc?a=2", hostname: "page.example"
})).reason, "changed", "a stale site picker cannot protect a different hostname");

local[TAB_PROTECTIONS_KEY] = {
  1: { tabId: 1, createdAt: 1, expiresAt: Date.now() - 1, url: windows[0].tabs[0].url }
};
const expired = await readProtectionStatus(1);
assert.equal(expired.kind, "expired");
assert.equal(expired.protected, false);
assert.equal((await listTemporaryTabProtections())[0].expired, true,
  "an expired row remains visible while its tab stays open");
await removeTemporaryTabProtection(1);
assert.equal((await readTabProtections())[1], undefined);

// Reload grace belongs only to registered suspended occurrences. An ordinary
// close during the same interval must still retire its exact numeric identity.
local.suspendRecoveryGraceUntil = Date.now() + 60_000;
local.suspendedRegistry = { 72: { originalUrl: "https://suspended.example" } };
local[TAB_PROTECTIONS_KEY] = {
  71: { tabId: 71, createdAt: 1, expiresAt: Date.now() + 60_000 },
  72: { tabId: 72, createdAt: 1, expiresAt: Date.now() + 60_000 }
};
assert.equal(await removeTemporaryTabProtectionOnClose(71), true);
assert.equal(await removeTemporaryTabProtectionOnClose(72), false);
assert.equal(local[TAB_PROTECTIONS_KEY][71], undefined,
  "normal close cleanup is not widened by suspended-page reload grace");
assert.ok(local[TAB_PROTECTIONS_KEY][72],
  "a registered suspended source survives reload teardown for id transfer");
delete local.suspendRecoveryGraceUntil;
delete local.suspendedRegistry;

const activeMap = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [index + 10, {
  tabId: index + 10, createdAt: Date.now(), expiresAt: Date.now() + 60_000
}]));
local[TAB_PROTECTIONS_KEY] = activeMap;
windows[0].tabs.push(tab(3, "https://scale.example"));
await setProtection(3, "tab");
assert.equal(Object.keys(await readTabProtections()).length, 1001,
  "bounding history never silently evicts an active protection at 1k scale");

const supplied = await readTabProtections();
assert.equal(protectionStatus(
  windows[0].tabs.at(-1), {}, {}, supplied, Date.now()).protected, true,
  "the synchronous resolver consumes a shared snapshot without storage work");

// Real automatic Suspend effect: a late tab-scoped promise added after the
// planning snapshot must win at the fresh Chrome/effect boundary. Its sibling
// remains independently eligible.
local[TAB_PROTECTIONS_KEY] = {};
local.settings = {
  suspendEnabled: true,
  suspendAfterMinutes: 60,
  suspendLazyReload: false,
  suspendMinTabs: 0,
  suspendMaxTabs: 0
};
const old = Date.now() - 2 * 60 * 60_000;
local.tabActivity = { 51: old, 52: old };
windows = [{ id: 5, type: "normal", focused: true, tabs: [
  tab(51, "https://late-protected.example"),
  tab(52, "https://eligible-sibling.example")
] }];
tabsEffects.discardedIds.length = 0;
const ordinaryGet = chrome.tabs.get;
let injectedSuspendProtection = false;
chrome.tabs.get = async (tabId) => {
  if (tabId === 51 && !injectedSuspendProtection) {
    injectedSuspendProtection = true;
    local[TAB_PROTECTIONS_KEY] = {
      51: { tabId: 51, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }
    };
  }
  return ordinaryGet(tabId);
};
const { suspendSweep } = await import("../js/lib/suspend.js");
assert.equal(await suspendSweep(), 1);
assert.deepEqual(tabsEffects.discardedIds, [52],
  "fresh automatic Suspend honors late protection without leaking to a sibling");
chrome.tabs.get = ordinaryGet;

// Deterministic write-first race: setProtection owns the shared boundary while
// its fresh tab read is held. The automatic effect queues, then sees the lease.
local[TAB_PROTECTIONS_KEY] = {};
local.tabActivity = { 53: old };
windows = [{ id: 5, type: "normal", focused: true, tabs: [
  tab(53, "https://write-first.example")
] }];
tabsEffects.discardedIds.length = 0;
let releaseSetRead;
let enterSetRead;
const setReadEntered = new Promise((resolve) => { enterSetRead = resolve; });
const setReadGate = new Promise((resolve) => { releaseSetRead = resolve; });
let holdSetRead = true;
chrome.tabs.get = async (tabId) => {
  if (tabId === 53 && holdSetRead) {
    holdSetRead = false;
    enterSetRead();
    await setReadGate;
  }
  return ordinaryGet(tabId);
};
const writeFirstSet = setProtection(53, "tab");
await setReadEntered;
const queuedSuspend = suspendSweep();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(tabsEffects.discardedIds, [],
  "automatic Suspend cannot pass a protection write already owning the boundary");
releaseSetRead();
assert.equal((await writeFirstSet).ok, true);
assert.equal(await queuedSuspend, 0);
chrome.tabs.get = ordinaryGet;

// Deterministic effect-first race: once final validation owns the boundary, a
// protection call cannot acknowledge in the gap before Chrome mutation.
local[TAB_PROTECTIONS_KEY] = {};
local.tabActivity = { 54: old };
windows = [{ id: 5, type: "normal", focused: true, tabs: [
  tab(54, "https://effect-first.example")
] }];
tabsEffects.discardedIds.length = 0;
const ordinaryDiscard = chrome.tabs.discard;
let enterDiscard;
let releaseDiscard;
const discardEntered = new Promise((resolve) => { enterDiscard = resolve; });
const discardGate = new Promise((resolve) => { releaseDiscard = resolve; });
chrome.tabs.discard = async (tabId) => {
  enterDiscard();
  await discardGate;
  return ordinaryDiscard(tabId);
};
const effectFirstSweep = suspendSweep();
await discardEntered;
let lateSetSettled = false;
const lateSet = setProtection(54, "tab").then((result) => {
  lateSetSettled = true;
  return result;
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(lateSetSettled, false,
  "protection cannot acknowledge between final Suspend validation and mutation");
releaseDiscard();
assert.equal(await effectFirstSweep, 1);
assert.equal((await lateSet).ok, true);
chrome.tabs.discard = ordinaryDiscard;

// Real Auto-save cap skips a protected tab without leaking that protection to
// its eligible sibling.
local[TAB_PROTECTIONS_KEY] = {
  61: { tabId: 61, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }
};
local.settings = {
  autoArchiveEnabled: false,
  autoDumpAfterMinutes: 60,
  autoSaveMaxTabs: 1
};
local.tabActivity = { 61: old - 1, 62: old };
windows = [{ id: 6, type: "normal", focused: true, tabs: [
  tab(61, "https://late-autosave-protected.example"),
  tab(62, "https://autosave-sibling.example")
] }];
tabsEffects.removedIds.length = 0;
const { archiveSweep } = await import("../js/lib/archive.js");
assert.equal(await archiveSweep(), 1);
assert.deepEqual(tabsEffects.removedIds, [62],
  "Auto-save protection stays scoped to one tab and leaves its sibling eligible");

// A promise added after cap planning must also win at the final fresh boundary.
local[TAB_PROTECTIONS_KEY] = {};
local.tabActivity = { 61: old - 1, 62: old };
windows = [{ id: 6, type: "normal", focused: true, tabs: [
  tab(61, "https://late-autosave-protected.example"),
  tab(62, "https://autosave-sibling.example")
] }];
tabsEffects.removedIds.length = 0;
let injectedArchiveProtection = false;
chrome.tabs.get = async (tabId) => {
  if (tabId === 61 && !injectedArchiveProtection) {
    injectedArchiveProtection = true;
    local[TAB_PROTECTIONS_KEY] = {
      61: { tabId: 61, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }
    };
  }
  return ordinaryGet(tabId);
};
assert.equal(await archiveSweep(), 0);
assert.deepEqual(tabsEffects.removedIds, [],
  "fresh Auto-save protection invalidates the queued automatic close plan");
chrome.tabs.get = ordinaryGet;

// Auto-save likewise holds ownership through its Inbox/journal commit and
// browser close, so a late picker cannot acknowledge in that destructive gap.
local[TAB_PROTECTIONS_KEY] = {};
local.settings = { autoArchiveEnabled: false, autoSaveMaxTabs: 0 };
local.tabActivity = { 63: old };
windows = [{ id: 6, type: "normal", focused: true, tabs: [
  tab(63, "https://autosave-effect-first.example")
] }];
// Use the timer path for the single non-active tab.
local.settings.autoArchiveEnabled = true;
local.settings.autoDumpAfterMinutes = 60;
tabsEffects.removedIds.length = 0;
const ordinaryRemove = chrome.tabs.remove;
let enterRemove;
let releaseRemove;
const removeEntered = new Promise((resolve) => { enterRemove = resolve; });
const removeGate = new Promise((resolve) => { releaseRemove = resolve; });
chrome.tabs.remove = async (ids) => {
  enterRemove();
  await removeGate;
  return ordinaryRemove(ids);
};
const effectFirstArchive = archiveSweep();
await removeEntered;
let archiveSetSettled = false;
const archiveLateSet = setProtection(63, "tab").then((result) => {
  archiveSetSettled = true;
  return result;
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(archiveSetSettled, false,
  "protection cannot acknowledge between Auto-save commit and tab close");
releaseRemove();
assert.equal(await effectFirstArchive, 1);
assert.equal((await archiveLateSet).ok, false,
  "a picker that loses to the completed close reports the vanished tab");
chrome.tabs.remove = ordinaryRemove;

// A tab can navigate while its durable Inbox copy and pending receipt are
// committed. Preserve that reviewed copy, but never close the replacement.
local[TAB_PROTECTIONS_KEY] = {};
local.settings = {
  autoArchiveEnabled: true, autoDumpAfterMinutes: 60, autoSaveMaxTabs: 0
};
local.tabActivity = { 64: old };
local.inbox = {};
local.journal = [];
windows = [{ id: 6, type: "normal", focused: true, tabs: [
  tab(64, "https://autosave-reviewed.example"),
  tab(65, "https://active-survivor.example", { active: true })
] }];
tabsEffects.removedIds.length = 0;
const ordinaryLocalSet = chrome.storage.local.set;
let navigatedDuringAutoSaveCommit = false;
chrome.storage.local.set = async (values) => {
  await ordinaryLocalSet(values);
  if (!navigatedDuringAutoSaveCommit && values.inbox &&
      values.journal?.some((entry) => entry.forwardReceipt?.status === "pending")) {
    navigatedDuringAutoSaveCommit = true;
    windows[0].tabs[0].url = "https://valuable-autosave-replacement.example/form";
  }
};
assert.equal(await archiveSweep(), 1);
chrome.storage.local.set = ordinaryLocalSet;
const autoSaved = Object.values(local.inbox).find((item) => item && !item.deletedAt);
assert.equal(navigatedDuringAutoSaveCommit, true);
assert.equal(windows[0].tabs[0].url, "https://valuable-autosave-replacement.example/form");
assert.deepEqual(tabsEffects.removedIds, []);
assert.equal(autoSaved.tabs[0].url, "https://autosave-reviewed.example");
assert.deepEqual(local.journal[0].reopen, [],
  "Auto-save keeps the reviewed durable copy but does not claim the skipped replacement in Undo");

console.log("PASS: automation protection scopes follow exact tab/site/page identities safely");
