import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createChromeI18nMock } from "./message-fixture.mjs";

let granted = false;
let requests = 0;
let removals = 0;
const permissionListeners = { added: new Set(), removed: new Set() };
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  permissions: {
    contains: async () => granted,
    request: async () => { requests += 1; granted = true; return true; },
    remove: async () => { removals += 1; granted = false; return true; },
    onAdded: {
      addListener: (fn) => permissionListeners.added.add(fn),
      removeListener: (fn) => permissionListeners.added.delete(fn)
    },
    onRemoved: {
      addListener: (fn) => permissionListeners.removed.add(fn),
      removeListener: (fn) => permissionListeners.removed.delete(fn)
    }
  }
};

const {
  HISTORY_FETCH_LIMIT, HISTORY_UNSCOPED_LIMIT, HISTORY_WINDOW_MS,
  createSearchSnapshot, matchSearchSnapshot
} = await import("../js/lib/search.js");
const { formatOmniboxDescription } = await import("../js/lib/omnibox.js");
const {
  hasHistoryAccess, requestHistoryAccess, removeHistoryAccess, onHistoryAccessChanged
} = await import("../js/lib/history-access.js");

assert.equal(await hasHistoryAccess(), false);
assert.equal(await requestHistoryAccess(), true);
assert.equal(requests, 1);
assert.equal(await removeHistoryAccess(), true);
assert.equal(removals, 1);
const changes = [];
const unsubscribe = onHistoryAccessChanged((enabled) => changes.push(enabled));
for (const listener of permissionListeners.added) listener({ permissions: ["history"] });
for (const listener of permissionListeners.removed) listener({ permissions: ["history"] });
unsubscribe();
assert.deepEqual(changes, [true, false]);
assert.equal(permissionListeners.added.size + permissionListeners.removed.size, 0);

const now = 1_800_000_000_000;
const realNow = Date.now;
Date.now = () => now;
let calls = [];
chrome.history = {
  search: async (query) => {
    calls.push(query);
    return [
      { title: "Local duplicate", url: "https://local.example/path", lastVisitTime: now - 60_000 },
      ...Array.from({ length: 19 }, (_, i) => ({
        title: `History ${i}`,
        url: `https://history-${i}.example/docs`,
        lastVisitTime: now - (i + 1) * 3_600_000,
        visitCount: 9_999
      }))
    ];
  }
};

const snapshot = createSearchSnapshot({
  openTabs: [{ id: 1, windowId: 1, title: "Local docs", url: "https://local.example/path" }]
});
const blended = await matchSearchSnapshot(snapshot, "docs", { includeHistory: true });
assert.equal(calls.length, 1);
assert.deepEqual(calls[0], {
  text: "docs",
  startTime: now - HISTORY_WINDOW_MS,
  maxResults: HISTORY_FETCH_LIMIT
});
assert.equal(blended[0].type, "open");
assert.equal(blended.filter((item) => item.type === "history").length, HISTORY_UNSCOPED_LIMIT);
assert.equal(blended.some((item) => item.type === "history" && item.url.includes("local.example")), false);
assert.equal(blended.find((item) => item.type === "history")?.lastVisitTime, now - 3_600_000);
assert.equal("visitCount" in blended.find((item) => item.type === "history"), false);
assert.match(formatOmniboxDescription(blended.find((item) => item.type === "history")),
  /<dim>Browser history · 1h ago<\/dim>/);

calls = [];
const scoped = await matchSearchSnapshot(snapshot, "docs", {
  includeHistory: true,
  scope: { type: "in", value: "history" }
});
assert.equal(scoped.length, HISTORY_FETCH_LIMIT);
assert.ok(scoped.every((item) => item.type === "history"));
await matchSearchSnapshot(snapshot, "d", { includeHistory: true });
await matchSearchSnapshot(snapshot, "docs", {
  includeHistory: true,
  scope: { type: "in", value: "archive" }
});
assert.equal(calls.length, 1, "one-character and non-History scopes never query browser History");
Date.now = realNow;

const production = [
  "../js/lib/search.js", "../js/lib/history-access.js"
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
assert.doesNotMatch(production, /chrome\.history\.(?:addUrl|deleteAll|deleteRange|deleteUrl)\s*\(/);

const settingsSource = readFileSync(new URL("../js/ui/settings-form.js", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("../js/ui/dashboard.js", import.meta.url), "utf8");
const searchboxSource = readFileSync(new URL("../js/ui/searchbox.js", import.meta.url), "utf8");
assert.match(settingsSource, /group\("privacy",\s*historyAccessRow\(\)\)/);
assert.match(settingsSource, /removeHistoryAccess\(\)/);
assert.match(settingsSource, /settingsStatic\.historyRemoved\(\)/);
assert.match(dashboardSource, /createHistoryAccessDisclosure/);
assert.doesNotMatch(dashboardSource, /chrome\.permissions\.request\(\{ permissions: \["history"\] \}\)/);
assert.match(searchboxSource, /searchResultMeta\(r\)/);
assert.match(searchboxSource, /onHistoryAccessChanged\(\(enabled\) =>/);
assert.match(readFileSync(new URL("../js/ui/popup.js", import.meta.url), "utf8"),
  /historyPlaceholder: localeMessage\("search_popup_history_placeholder"\)/);
assert.match(readFileSync(new URL("../js/ui/newtab.js", import.meta.url), "utf8"),
  /historyPlaceholder: msg\("newtab_search_history_placeholder"\)/);
for (const host of ["sidepanel.js", "dashboard.js"]) {
  const source = readFileSync(new URL(`../js/ui/${host}`, import.meta.url), "utf8");
  assert.doesNotMatch(source, /historyPlaceholder:/);
}

console.log("PASS: optional History access, local-first 30-day Search, caps, and privacy guards");
