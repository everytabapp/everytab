import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(path.join(root, name), "utf8");

globalThis.chrome = {
  runtime: { getURL: (name) => `chrome-extension://everytab/${name}` }
};

const { canonicalRef, isSaveableTab, saveableTabRef } = await import("../js/lib/tabs.js");

const privateTab = {
  id: 91,
  windowId: 9,
  incognito: true,
  url: "https://private.example/account",
  title: "Private account"
};
const ordinaryTab = { ...privateTab, id: 11, windowId: 1, incognito: false };
const suspendedUrl = "chrome-extension://everytab/suspend.html?originalUrl=" +
  encodeURIComponent("https://sleeping.example/article") + "&title=Sleeping+article";
const suspendedTab = { ...ordinaryTab, id: 12, url: suspendedUrl };
const privateSuspendedTab = { ...suspendedTab, id: 92, incognito: true };

assert.equal(isSaveableTab(privateTab), false,
  "the established saveability boundary rejects an incognito HTTP tab");
assert.equal(canonicalRef(privateTab)?.url, privateTab.url,
  "canonicalRef remains provenance-neutral for read-only presentation paths");

const popup = read("js/ui/popup.js");
assert.match(popup, /const activeCapture = active \? saveableTabRef\(active\) : null;/,
  "popup active-tab actions are derived from the saveable capture adapter");
assert.match(popup, /active\?\.incognito\s*\? popupStatic\.privateTab\(\)\s*:\s*popupStatic\.unsupportedPage\(\)/,
  "popup explains the intentional Incognito boundary instead of blaming a restricted page");
assert.match(popup, /const dumpable = winTabs\.filter\(\(t\) => !t\.pinned && isSaveableTab\(t\)\);/,
  "popup window Save eligibility excludes incognito tabs");
assert.match(popup, /const saveable = winTabs\.filter\(isSaveableTab\);/,
  "popup window Session/Snooze eligibility excludes incognito tabs");
const labelStart = popup.indexOf("function buildLabelPanel");
const labelEnd = popup.indexOf("async function computeTabLabels", labelStart);
assert.ok(labelStart >= 0 && labelEnd > labelStart, "popup Label boundary is present");
assert.doesNotMatch(popup.slice(labelStart, labelEnd), /canonicalRef\(tab\)/,
  "popup Label does not reconstruct a provenance-free ref after eligibility");

const background = read("js/background.js");
const snoozeStart = background.indexOf("async function snoozeTab");
const snoozeEnd = background.indexOf("async function snoozeWindow", snoozeStart);
assert.ok(snoozeStart >= 0 && snoozeEnd > snoozeStart, "single-tab Snooze boundary is present");
const snoozeBody = background.slice(snoozeStart, snoozeEnd);
assert.match(snoozeBody, /const ref = saveableTabRef\(tab\);\s*if \(!ref\) return null;/,
  "worker Snooze rechecks provenance before every caller can persist or close the tab");
assert.doesNotMatch(snoozeBody, /canonicalUrlOf\(tab\)/,
  "worker Snooze no longer treats an HTTP scheme as sufficient permission to capture");

assert.equal(typeof saveableTabRef, "function", "the capture adapter is exported");
assert.equal(saveableTabRef(privateTab), null,
  "the capture adapter never returns an incognito URL");
assert.equal(saveableTabRef(ordinaryTab)?.url, ordinaryTab.url,
  "the capture adapter preserves an ordinary HTTP tab");
assert.deepEqual(saveableTabRef(suspendedTab), {
  url: "https://sleeping.example/article",
  title: "Sleeping article",
  favIconUrl: undefined,
  pinned: undefined
}, "the capture adapter preserves the accepted underlying page of a suspended normal tab");
assert.equal(saveableTabRef(privateSuspendedTab), null,
  "incognito provenance wins even when a tab resembles EveryTab's suspend page");

console.log("PASS: incognito live-tab capture boundary");
