import assert from "node:assert/strict";
import { readPopupTabLabels } from "../js/ui/popup-label-data.js";

globalThis.chrome = { runtime: { getURL: (path) => `chrome-extension://test/${path}` } };

const tab = { id: 7, url: "https://EXAMPLE.com/page/#current", title: "Current" };
const inbox = [{
  id: "inbox", labels: ["item-label", "shared"], tabs: [{
    url: "https://example.com/page/", title: "Saved", labels: ["tab-label", "shared"]
  }]
}];
const archive = [{
  id: "archive", labels: ["archive-item", "shared"], tabs: [{
    url: "https://example.com/page#archived", title: "Archived", labels: ["archive-tab", "shared"]
  }, {
    url: "https://example.com/page?distinct=1", title: "Different query", labels: ["excluded"]
  }]
}];

let reads = 0;
assert.deepEqual(await readPopupTabLabels(tab, { inbox, archive, readItems: async () => {
  reads += 1;
  return [];
} }), ["item-label", "shared", "tab-label", "archive-item", "archive-tab"]);
assert.equal(reads, 0, "supplied snapshots avoid storage reads");

const deferred = new Map();
const started = [];
const readItems = (family) => {
  started.push(family);
  return new Promise((resolve, reject) => deferred.set(family, { resolve, reject }));
};
const pending = readPopupTabLabels(tab, { readItems });
assert.deepEqual(started, ["inbox", "archive"], "missing families start concurrently");
deferred.get("archive").resolve(archive);
deferred.get("inbox").resolve(inbox);
assert.deepEqual(await pending, ["item-label", "shared", "tab-label", "archive-item", "archive-tab"]);

reads = 0;
assert.deepEqual(await readPopupTabLabels(tab, {
  inbox, readItems: async (family) => { reads += 1; assert.equal(family, "archive"); return archive; }
}), ["item-label", "shared", "tab-label", "archive-item", "archive-tab"]);
assert.equal(reads, 1, "only the missing family is read");

let refreshReads = 0;
let currentRefreshLabel = "fresh";
const refreshingRead = async () => {
  refreshReads += 1;
  return [{ id: "new", labels: [currentRefreshLabel], tabs: [{ url: tab.url, labels: [] }] }];
};
assert.deepEqual(await readPopupTabLabels(tab, { readItems: refreshingRead }), ["fresh"]);
currentRefreshLabel = "fresh-again";
assert.deepEqual(await readPopupTabLabels(tab, { readItems: refreshingRead }), ["fresh-again"]);
assert.equal(refreshReads, 4, "each refresh rereads both families through the same function");

const suspended = {
  url: "chrome-extension://test/suspend.html?originalUrl=https%3A%2F%2Fexample.com%2Fpage%2F%23current",
  title: "Suspended"
};
assert.deepEqual(await readPopupTabLabels(suspended, { inbox, archive }),
  ["item-label", "shared", "tab-label", "archive-item", "archive-tab"],
  "our suspended tab matches its underlying canonical page");

const supplied = { inbox: structuredClone(inbox), archive: structuredClone(archive) };
await readPopupTabLabels(tab, supplied);
assert.deepEqual(supplied, { inbox, archive }, "read does not mutate supplied snapshots");
assert.deepEqual(await readPopupTabLabels(tab, {
  archive, readItems: async (family) => { assert.equal(family, "inbox"); return inbox; }
}), ["item-label", "shared", "tab-label", "archive-item", "archive-tab"]);
assert.deepEqual(await readPopupTabLabels({ url: "chrome://settings" }, {
  readItems: async () => { throw new Error("must not read"); }
}), []);
assert.deepEqual(await readPopupTabLabels(null, {
  readItems: async () => { throw new Error("must not read"); }
}), []);

await assert.rejects(
  () => readPopupTabLabels(tab, { readItems: async (family) => {
    if (family === "inbox") throw new Error("storage unavailable");
    return archive;
  } }),
  /storage unavailable/
);

console.log("PASS: popup label data lookup");
