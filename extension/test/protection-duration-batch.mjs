import assert from "node:assert/strict";
import { installSmokeChrome } from "./smoke-chrome.mjs";
import { createMockLockManager } from "./e2-mocks.mjs";

const local = {};
const session = {};
let windows = [];
const effects = { alarms: {}, notifications: [], badgeTexts: [] };
const tabEffects = { removedIds: [], createdUrls: [], updated: [], discardedIds: [], moves: [] };
installSmokeChrome({
  storage: () => ({ local, session }),
  windows: () => ({ live: windows, created: [], removedIds: [], currentId: windows[0]?.id }),
  tabs: () => tabEffects,
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
  beginTabProtectionBrowserSession,
  listTemporaryTabProtections,
  protectionStatus,
  removeTemporaryTabProtectionOnClose,
  TAB_PROTECTIONS_KEY,
  readProtectionStatus,
  setProtection,
  setProtections
} = await import("../js/lib/automation-protection.js");
const {
  TEMPORARY_AUTOMATION_EXEMPTIONS_KEY,
  isTemporarilyAutomationProtected
} = await import("../js/lib/tabs.js");
const {
  autoSuspendPageStatus,
  isSuspendExempt,
  listAutoSuspendPageExceptions,
  removeAutoSuspendPageException
} = await import("../js/lib/suspend.js");
const { isArchiveExempt } = await import("../js/lib/archive.js");

const tab = (id, url) => ({
  id, index: id, windowId: 1, url, title: `Tab ${id}`,
  active: false, pinned: false, audible: false, incognito: false, groupId: -1
});
const target = (entry) => ({
  tabId: entry.id,
  url: new URL(entry.url).href,
  hostname: new URL(entry.url).hostname
});
const setTabs = (...tabs) => {
  windows = [{ id: 1, type: "normal", focused: true, tabs }];
};

const first = tab(1, "https://shop.example/item?a=1");
const sibling = tab(2, "https://checkout.shop.example/pay");
setTabs(first, sibling);

// Existing callers retain their defaults: tab=24h, site/page=permanent.
assert.equal((await setProtection(1, "tab")).duration, "day");
delete local[TAB_PROTECTIONS_KEY];
assert.equal((await setProtection(1, "site", target(first))).duration, "always");
assert.ok(local.settings.suspendWhitelist.includes("site:shop.example"));
local.settings = {};
assert.equal((await setProtection(1, "page", target(first))).duration, "always");
assert.ok(local.settings.suspendWhitelist.includes("page:https://shop.example/item?a=1"));
local.settings = {};
assert.equal((await setProtection(1, "site", "week")).reason, "invalid",
  "an unknown duration cannot be mistaken for a stale identity");

// 24h site is one strict hostname key and covers only that host/subdomains.
const siteDay = await setProtection(1, "site", "day", target(first));
assert.equal(siteDay.kind, "temporary-site");
assert.equal(siteDay.scope, "site");
assert.equal(siteDay.duration, "day");
assert.ok(local[TEMPORARY_AUTOMATION_EXEMPTIONS_KEY]["site:shop.example"] > Date.now());
const temporary = local[TEMPORARY_AUTOMATION_EXEMPTIONS_KEY];
assert.equal(isTemporarilyAutomationProtected(sibling.url, temporary), true);
assert.equal(isTemporarilyAutomationProtected("https://evilshop.example/", temporary), false);
assert.equal(isTemporarilyAutomationProtected("https://other.test/shop.example", temporary), false);
assert.equal(isTemporarilyAutomationProtected("https://bob.github.io/", {
  "site:alice.github.io": Date.now() + 60_000
}), false, "an explicit multi-tenant host must not infer its parent as protected");
for (const malformed of ["not-a-time", Number.POSITIVE_INFINITY]) {
  const malformedMap = { "site:shop.example": malformed };
  assert.equal(isTemporarilyAutomationProtected(sibling.url, malformedMap), false);
  assert.equal(protectionStatus(sibling, {}, malformedMap, {}).kind, "none");
  assert.equal(autoSuspendPageStatus(sibling.url, [], malformedMap).kind, "none");
}
assert.equal(isSuspendExempt(sibling, [], temporary), true);
assert.equal(isArchiveExempt(sibling, [], temporary), true);

// 24h page preserves the established canonical-URL key and stays exact.
const pageDayTab = tab(3, "https://page.example/doc?a=1");
setTabs(pageDayTab);
const pageDay = await setProtection(3, "page", "day", target(pageDayTab));
assert.equal(pageDay.kind, "temporary-page");
assert.ok(local[TEMPORARY_AUTOMATION_EXEMPTIONS_KEY][pageDayTab.url] > Date.now());
assert.equal(isTemporarilyAutomationProtected("https://page.example/doc?a=2", temporary), false);

// No-time-limit tab protection uses an explicit browser-scoped record, not
// serialized Infinity. It stays active until exact lifecycle cleanup.
const tabAlways = await setProtection(3, "tab", "always", target(pageDayTab));
assert.equal(tabAlways.kind, "tab");
assert.equal(tabAlways.duration, "always");
assert.equal(tabAlways.permanent, true);
assert.equal(tabAlways.expiresAt, null);
assert.deepEqual({
  permanent: local[TAB_PROTECTIONS_KEY][3].permanent,
  duration: local[TAB_PROTECTIONS_KEY][3].duration,
  expiresAt: local[TAB_PROTECTIONS_KEY][3].expiresAt
}, { permanent: true, duration: "always", expiresAt: null });
assert.equal(JSON.stringify(local[TAB_PROTECTIONS_KEY]).includes("Infinity"), false);
assert.equal(protectionStatus(
  pageDayTab, {}, {}, local[TAB_PROTECTIONS_KEY], Number.MAX_SAFE_INTEGER
).protected, true);
assert.equal(isSuspendExempt(
  pageDayTab, [], {}, Number.MAX_SAFE_INTEGER, local[TAB_PROTECTIONS_KEY]
), true);
assert.equal(isArchiveExempt(
  pageDayTab, [], {}, Number.MAX_SAFE_INTEGER, local[TAB_PROTECTIONS_KEY]
), true);
const permanentRow = (await listTemporaryTabProtections()).find((row) => row.tabId === 3);
assert.equal(permanentRow?.permanent, true);
assert.equal(permanentRow?.expired, false);
assert.equal(permanentRow?.expiresAt, null);
await setProtection(3, "tab", "day", target(pageDayTab));
assert.equal(local[TAB_PROTECTIONS_KEY][3].permanent, true,
  "a shorter request cannot weaken an existing no-time-limit tab promise");
assert.equal(await removeTemporaryTabProtectionOnClose(3), true);
assert.equal(local[TAB_PROTECTIONS_KEY][3], undefined);

// Frozen batch validation is all-or-nothing for stale and closed targets.
const one = tab(11, "https://batch.example/a");
const two = tab(12, "https://batch.example/b");
setTabs(one, two);
const beforeStale = structuredClone(local[TEMPORARY_AUTOMATION_EXEMPTIONS_KEY]);
const stale = await setProtections([
  target(one), { ...target(two), url: "https://batch.example/old" }
], "site", "day");
assert.equal(stale.ok, false);
assert.equal(stale.reason, "changed");
assert.deepEqual(local[TEMPORARY_AUTOMATION_EXEMPTIONS_KEY], beforeStale);
const gone = await setProtections([target(one), {
  tabId: 999, url: "https://batch.example/gone", hostname: "batch.example"
}], "page", "always");
assert.equal(gone.reason, "gone");
assert.deepEqual(local.settings, {});

// Two same-site targets deduplicate to one strict rule and one Store write,
// while preserving unrelated old URL timers.
let localWrites = 0;
const originalSet = chrome.storage.local.set;
chrome.storage.local.set = async (values) => {
  if (Object.hasOwn(values, TEMPORARY_AUTOMATION_EXEMPTIONS_KEY)) localWrites += 1;
  return originalSet(values);
};
const batchSite = await setProtections([target(one), target(two)], "site", "day");
assert.deepEqual({
  ok: batchSite.ok,
  protectedTabCount: batchSite.protectedTabCount,
  uniqueRuleCount: batchSite.uniqueRuleCount
}, { ok: true, protectedTabCount: 2, uniqueRuleCount: 1 });
assert.equal(localWrites, 1);
assert.ok(local[TEMPORARY_AUTOMATION_EXEMPTIONS_KEY][pageDayTab.url],
  "batch writes preserve an unrelated existing URL timer");

// Same-page permanent targets likewise deduplicate and preserve broad rules.
const duplicate = tab(13, one.url);
setTabs(one, duplicate);
local.settings = { suspendWhitelist: ["legacy-fragment"], archiveWhitelist: ["legacy-fragment"] };
const batchPage = await setProtections([target(one), target(duplicate)], "page", "always");
assert.equal(batchPage.protectedTabCount, 2);
assert.equal(batchPage.uniqueRuleCount, 1);
assert.deepEqual(local.settings.suspendWhitelist, [
  "legacy-fragment", "page:https://batch.example/a"
]);

// Tab batch writes every exact id together once.
let tabMapWrites = 0;
chrome.storage.local.set = async (values) => {
  if (Object.hasOwn(values, TAB_PROTECTIONS_KEY)) tabMapWrites += 1;
  return originalSet(values);
};
const batchTabs = await setProtections([target(one), target(duplicate)], "tab", "always");
assert.equal(batchTabs.protectedTabCount, 2);
assert.equal(batchTabs.uniqueRuleCount, 2);
assert.equal(tabMapWrites, 1);
assert.ok(local[TAB_PROTECTIONS_KEY][11] && local[TAB_PROTECTIONS_KEY][13]);
assert.equal(local[TAB_PROTECTIONS_KEY][11].permanent, true);
chrome.storage.local.set = originalSet;
await setProtections([target(one), target(duplicate)], "tab", "day");
assert.equal(local[TAB_PROTECTIONS_KEY][11].permanent, true,
  "a batch preserves a stronger protection already held by a target");

// Site timers retain their key/scope in Settings lists and expire cleanly.
const now = Date.now();
local[TEMPORARY_AUTOMATION_EXEMPTIONS_KEY]["site:expired.example"] = now - 1;
const rows = listAutoSuspendPageExceptions(
  local.settings.suspendWhitelist,
  local[TEMPORARY_AUTOMATION_EXEMPTIONS_KEY],
  now
);
const siteRow = rows.find((row) => row.rule === "site:batch.example");
assert.equal(siteRow?.scope, "site");
assert.equal(siteRow?.hostname, "batch.example");
assert.equal(siteRow?.url, "site:batch.example");
assert.equal(rows.some((row) => row.rule === "site:expired.example"), false);
assert.equal(autoSuspendPageStatus(
  "https://x.expired.example/", [], local[TEMPORARY_AUTOMATION_EXEMPTIONS_KEY], now
).kind, "none");
await removeAutoSuspendPageException(siteRow.url);
assert.equal(local[TEMPORARY_AUTOMATION_EXEMPTIONS_KEY]["site:batch.example"], undefined);

// Browser startup is the other lifecycle boundary for both tab durations.
await beginTabProtectionBrowserSession();
assert.deepEqual(local[TAB_PROTECTIONS_KEY], {});

console.log("PASS: duration-aware protection and frozen atomic batches preserve scope boundaries");
