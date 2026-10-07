import assert from "node:assert/strict";
import { createChromeI18nMock } from "./message-fixture.mjs";

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://everytab/${path}` },
  i18n: createChromeI18nMock()
};

const { filterOpenGroups, reconcileOpenTabUpdate } = await import("../js/ui/open-surface.js");
const { fromOpenWindows } = await import("../js/ui/tablist.js");

const makeWindow = (count, titleOf = (index) => `Tab ${index}`) => ({
  id: 7,
  focused: true,
  tabs: Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    windowId: 7,
    index,
    url: `https://example.com/${index}`,
    title: titleOf(index),
    pinned: false,
    audible: false
  }))
});

let prepared = 0;
const [large] = fromOpenWindows(
  [makeWindow(2_000)], null, 7, null, null,
  { onPrepareRef: () => { prepared += 1; } }
);
assert.equal(prepared, 0, "building a large Open group must not prepare hidden row refs");
for (let index = 0; index < 50; index += 1) void large.refs[index];
assert.equal(prepared, 50, "the initial 50-row view prepares exactly its visible refs");
void large.refs[0];
assert.equal(prepared, 50, "a prepared ref is memoized");

prepared = 0;
const [filterSource] = fromOpenWindows(
  [makeWindow(2_000, (index) => index % 2 === 0 ? `Target ${index}` : `Other ${index}`)],
  null, 7, null, null,
  { onPrepareRef: () => { prepared += 1; } }
);
const [filtered] = filterOpenGroups([filterSource], "target");
assert.equal(filtered.refs.length, 1_000, "filtering retains every matching row identity");
assert.equal(prepared, 0, "filtering uses lightweight metadata instead of preparing every matching ref");
for (let index = 0; index < 50; index += 1) void filtered.refs[index];
assert.equal(prepared, 50, "a filtered first view also prepares only its visible refs");

const titleLink = {
  textContent: "Old title",
  getAttribute: (name) => name === "href" ? "https://example.com/42" : null
};
const titleRow = {
  querySelector: (selector) => selector === ".row-copy .t a" ? titleLink : null
};
const titleRoot = {
  querySelector: (selector) => selector === '[data-tablist-row="t42"]' ? titleRow : null
};
assert.equal(reconcileOpenTabUpdate(titleRoot, 42, { title: "Live title" }), true);
assert.equal(titleLink.textContent, "Live title",
  "a title update patches only its mounted Open row");
assert.equal(reconcileOpenTabUpdate(titleRoot, 42, { status: "complete" }), true,
  "load completion does not rebuild Open when it changes no displayed field");
assert.equal(reconcileOpenTabUpdate(titleRoot, 42, { url: "https://example.com/new" }), false,
  "a URL change still requests a structural Open refresh");
assert.equal(reconcileOpenTabUpdate(titleRoot, 42, { pinned: true }), false,
  "a pinned-state change still requests a structural Open refresh");
assert.equal(reconcileOpenTabUpdate(titleRoot, 42, { groupId: 17 }), false,
  "a live Chrome group membership change requests a structural Open refresh");

console.log("PASS: Open preparation is bounded to visible rows before expansion");
