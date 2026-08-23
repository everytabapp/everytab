import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isEveryTabNewTabUrl,
  planNewTabRetirement,
  shouldReconcileNewTabUpdate
} from "../js/lib/newtab-singleton.js";

const base = "chrome-extension://abcdefghijklmnop/";
const newTab = (id, overrides = {}) => ({
  id,
  windowId: 4,
  url: `${base}newtab.html`,
  pinned: false,
  incognito: false,
  ...overrides
});

assert.equal(isEveryTabNewTabUrl(`${base}newtab.html`, base), true);
assert.equal(isEveryTabNewTabUrl(`${base}newtab.html?focus=search`, base), true);
assert.equal(isEveryTabNewTabUrl(`${base}newtab.html#open`, base), true);
assert.equal(isEveryTabNewTabUrl(`${base}dashboard.html#open`, base), false);
assert.equal(isEveryTabNewTabUrl("chrome://newtab/", base), true,
  "Chrome's address-bar New Tab identity is the same EveryTab override");
assert.equal(shouldReconcileNewTabUpdate({ status: "complete" },
  newTab(20, { active: true }), base), true,
"the worker independently reconciles an active override when Chrome completes it");
assert.equal(shouldReconcileNewTabUpdate({ status: "complete" },
  newTab(20, { active: true, url: "chrome://newtab/" }), base), true,
"the worker independently reconciles the address-bar New Tab identity");
assert.equal(shouldReconcileNewTabUpdate({ status: "loading" },
  newTab(20, { active: true }), base), false,
"the worker waits for the override document to complete");
assert.equal(shouldReconcileNewTabUpdate({ status: "complete" },
  newTab(20, { active: false }), base), false,
"an inactive restored override cannot initiate background reconciliation");
assert.equal(shouldReconcileNewTabUpdate({ status: "complete" },
  newTab(20, { active: true, url: `${base}dashboard.html` }), base), false,
"an explicit Dashboard never enters New Tab reconciliation");

const plan = (overrides = {}) => planNewTabRetirement({
  enabled: true,
  readyTabId: 13,
  windowType: "normal",
  extensionBaseUrl: base,
  creationRanks: new Map([[11, 1], [12, 2], [13, 3]]),
  tabs: [newTab(11), newTab(12), newTab(13)],
  ...overrides
});

assert.deepEqual(plan(), { keeperTabId: 13, retireTabIds: [11, 12] },
  "the newest mounted EveryTab New Tab retires every older unpinned override tab");
assert.equal(plan({ enabled: false }), null, "the opt-in defaults to no mutation");
assert.equal(plan({ readyTabId: 12 }), null,
  "an older page cannot win a close race while a newer New Tab is mounting");
assert.deepEqual(plan({
  tabs: [newTab(10, { pinned: true }), newTab(11), newTab(13)],
  creationRanks: new Map([[10, 0], [11, 1], [13, 3]])
}), { keeperTabId: 13, retireTabIds: [11] }, "pinned EveryTab tabs are explicit exceptions");
assert.equal(plan({
  tabs: [newTab(11, { active: true }), newTab(13)],
  creationRanks: new Map([[11, 1], [13, 3]])
}), null, "an older tab the user deliberately reactivated is left alone");
assert.equal(plan({ tabs: [newTab(13, { incognito: true })] }), null,
  "incognito windows are left alone");
assert.equal(plan({ windowType: "popup" }), null, "utility windows are left alone");
assert.deepEqual(plan({
  tabs: [newTab(9, { url: `${base}dashboard.html#open` }), newTab(11), newTab(13)],
  creationRanks: new Map([[9, 0], [11, 1], [13, 3]])
}), { keeperTabId: 13, retireTabIds: [11] }, "explicit Dashboard tabs are never retired");
assert.equal(plan({ creationRanks: new Map([[11, 1]]) }), null,
  "a restored or untracked ready page is not treated as a user-created New Tab");
assert.deepEqual(plan({
  creationRanks: new Map([[11, 1]]),
  tabs: [newTab(11), newTab(13, { active: true })]
}), { keeperTabId: 13, retireTabIds: [11] },
"an active mounted New Tab retires its older peer even during startup or after a missed onCreated event");
assert.deepEqual(plan({
  creationRanks: new Map([[11, 1], [13, 2]]),
  tabs: [
    newTab(11, { url: "chrome://newtab/" }),
    newTab(13, { url: "chrome://newtab/", active: true })
  ]
}), { keeperTabId: 13, retireTabIds: [11] },
"address-bar focus retires the older native New Tab identity");
assert.equal(plan({
  creationRanks: new Map(),
  tabs: [newTab(11), newTab(13, { active: false })]
}), null, "an inactive restored page still cannot initiate cleanup");

const entrySource = readFileSync(new URL("../js/ui/newtab-entry.js", import.meta.url), "utf8");
const backgroundSource = readFileSync(new URL("../js/background.js", import.meta.url), "utf8");
const entryPlanAt = entrySource.indexOf("const plan = newTabEntryPlan");
const earlyClaimAt = entrySource.indexOf("const newTabRetirementClaim");
const dashboardImportAt = entrySource.indexOf('await import("./dashboard.js")');
const minimalImportAt = entrySource.indexOf('await import("./newtab.js")');
assert.ok(entryPlanAt >= 0 && earlyClaimAt > entryPlanAt &&
  earlyClaimAt < dashboardImportAt && earlyClaimAt < minimalImportAt,
"the override claims singleton retirement before either surface starts its data and UI work");
assert.ok(entrySource.includes("await newTabRetirementClaim") &&
  entrySource.includes('type: "everytab-new-tab-mounted"'),
"the entry awaits the early claim after mount so a cold-worker failure can be retried");
const minimalSource = readFileSync(new URL("../js/ui/newtab.js", import.meta.url), "utf8");
assert.ok(entrySource.includes("globalThis.__everyTabNewTabSettings = settings") &&
  minimalSource.includes("globalThis.__everyTabNewTabSettings ?? await getSettings()"),
"Minimal reuses the authoritative entry Settings snapshot instead of repeating its cold read");
assert.ok(minimalSource.indexOf("app.append(clockBlock, deck)") >= 0 &&
  minimalSource.indexOf("app.append(clockBlock, deck)") < minimalSource.indexOf("void renderStarred()") &&
  !minimalSource.includes("await renderStarred("),
"Minimal paints its useful clock/Search deck before reading the optional Starred launcher");
assert.ok(backgroundSource.includes("shouldReconcileNewTabUpdate(changeInfo, tab") &&
  backgroundSource.includes("void retireOlderEveryTabNewTabs(tab)"),
"Chrome's completed-tab event independently invokes the worker-owned singleton policy");

console.log("PASS: one EveryTab New Tab per window planner");
