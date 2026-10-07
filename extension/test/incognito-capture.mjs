import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(path.join(root, name), "utf8");

globalThis.chrome = {
  runtime: { getURL: (name) => `chrome-extension://everytab/${name}` }
};

const { canonicalRef, isSaveableTab, recoverableTabRef, saveableTabRef } =
  await import("../js/lib/tabs.js");

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
const localFileTab = {
  id: 13,
  windowId: 1,
  incognito: false,
  url: "file:///Users/example/irreplaceable.html",
  title: "Irreplaceable local page"
};

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
const labelEnd = popup.indexOf("function renderTabLabels", labelStart);
assert.ok(labelStart >= 0 && labelEnd > labelStart, "popup Label boundary is present");
assert.doesNotMatch(popup.slice(labelStart, labelEnd), /canonicalRef\(tab\)/,
  "popup Label does not reconstruct a provenance-free ref after eligibility");

assert.equal(typeof saveableTabRef, "function", "the capture adapter is exported");
assert.equal(saveableTabRef(privateTab), null,
  "the capture adapter never returns an incognito URL");
assert.equal(saveableTabRef(ordinaryTab)?.url, ordinaryTab.url,
  "the capture adapter preserves an ordinary HTTP tab");
assert.deepEqual(saveableTabRef(suspendedTab), {
  url: "https://sleeping.example/article",
  title: "Sleeping article",
  pinned: false
}, "the capture adapter preserves the accepted underlying page of a suspended normal tab");
assert.equal(JSON.stringify(saveableTabRef(ordinaryTab)).includes("favIconUrl"), false,
  "a live tab without a favicon omits the optional field instead of persisting undefined");
assert.equal(saveableTabRef(privateSuspendedTab), null,
  "incognito provenance wins even when a tab resembles EveryTab's suspend page");
assert.equal(saveableTabRef(localFileTab), null,
  "ordinary Library capture remains web-only for a local-file tab");
assert.equal(recoverableTabRef(localFileTab)?.url, localFileTab.url,
  "a normal local-file tab remains eligible for automatic recovery capture");

console.log("PASS: incognito live-tab capture boundary");
