import assert from "node:assert/strict";
import { createSnoozeActions } from "../js/background/snooze-actions.js";

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://everytab/${path}` }
};

const calls = [];
let queryTabs = [];
let windows = [{ id: 1 }];
let rejectRemove = false;
let nextId = 1;
let afterCreate = null;
const actions = createSnoozeActions({
  async createWithCloseReceipt(record, tabs, options) {
    calls.push(["create", record, options, tabs]);
    const result = { id: `snooze-${nextId++}`, ...record };
    const hook = afterCreate;
    afterCreate = null;
    if (hook) hook();
    return { snooze: result, entryId: `entry-${result.id}` };
  },
  async finishCloseReceipt(entryId, tabs, effect) {
    calls.push(["finish", entryId, tabs]);
    const outcome = await effect();
    calls.push(["settle", outcome]);
    return outcome;
  },
  async capturePlacement(tab) {
    calls.push(["placement", tab.id]);
    return { windowIndex: 2, tabIndex: 3 };
  },
  async openDashboard() { calls.push(["dashboard"]); },
  tabs: {
    async get(tabId) {
      calls.push(["get", tabId]);
      const tab = queryTabs.find((candidate) => candidate.id === tabId);
      if (!tab) throw new Error("already gone");
      return structuredClone(tab);
    },
    async query(query) {
      calls.push(["query-tabs", query]);
      return queryTabs;
    },
    async remove(ids) {
      calls.push(["remove", ids]);
      if (rejectRemove) throw new Error("already gone");
      const removed = new Set(Array.isArray(ids) ? ids : [ids]);
      queryTabs = queryTabs.filter((candidate) => !removed.has(candidate.id));
    }
  },
  windows: {
    async getAll(query) {
      calls.push(["windows", query]);
      return windows;
    }
  }
});

const privateTab = {
  id: 4, windowId: 1, incognito: true,
  url: "https://private.example/", title: "Private"
};
assert.equal(await actions.tab(privateTab, 1000), null,
  "incognito provenance is rejected at the action interface");
assert.deepEqual(calls, [], "an ineligible tab causes no storage or browser effect");

const tab = {
  id: 5, windowId: 1, incognito: false,
  url: "https://example.com/", title: "Example", favIconUrl: "data:image/png;base64,AA=="
};
queryTabs = [structuredClone(tab)];
const snoozedTab = await actions.tab(tab, 2000, "daily");
assert.equal(snoozedTab.id, "snooze-1");
assert.equal(snoozedTab.undoId, "entry-snooze-1");
assert.deepEqual(calls.map(([name]) => name), [
  "placement", "create", "query-tabs", "dashboard", "finish", "get", "remove", "get", "settle"
], "a tab and pending Undo receipt are persisted before its browser tab closes");
assert.deepEqual(calls[1][1], {
  url: "https://example.com/",
  title: "Example",
  dueAt: 2000,
  favIconUrl: "data:image/png;base64,AA==",
  recurrence: "daily"
});
assert.deepEqual(calls[1][2], {
  placement: { windowIndex: 2, tabIndex: 3 }, label: "Snoozed “Example”"
});

calls.length = 0;
queryTabs = [
  { id: 7, windowId: 2, incognito: false, url: "https://one.example/", title: "One" },
  { id: 8, windowId: 2, incognito: false, url: "chrome://settings", title: "Settings" },
  { id: 9, windowId: 2, incognito: true, url: "https://private.example/", title: "Private" }
];
windows = [{ id: 2 }, { id: 3 }];
rejectRemove = true;
const snoozedWindow = await actions.window(2, 3000);
assert.equal(snoozedWindow.tabs.length, 1,
  "window Snooze persists only saveable, non-incognito pages");
assert.equal(snoozedWindow.undoId, "entry-snooze-2");
assert.deepEqual(calls.map(([name]) => name), [
  "query-tabs", "create", "windows", "finish", "get", "remove", "get", "settle"
], "a partial Chrome removal failure cannot discard the durable Snooze or Undo record");
assert.deepEqual(calls[5], ["remove", [7]]);
assert.deepEqual(calls[7][1].closed, [],
  "receipt settlement is told that a tab which remained open was not closed");

calls.length = 0;
rejectRemove = false;
windows = [{ id: 2 }, { id: 3 }];
const reviewedSnoozeTab = {
  id: 10, windowId: 2, index: 0, pinned: false, incognito: false,
  url: "https://snooze-reviewed.example/", title: "Reviewed"
};
queryTabs = [structuredClone(reviewedSnoozeTab)];
afterCreate = () => {
  queryTabs = [{ ...reviewedSnoozeTab,
    url: "https://valuable-snooze-replacement.example/form", title: "Draft" }];
};
const racedSnooze = await actions.tab(reviewedSnoozeTab, 5000);
assert.equal(racedSnooze.url, "https://snooze-reviewed.example/");
assert.equal(queryTabs[0].url, "https://valuable-snooze-replacement.example/form");
assert.equal(calls.some(([name]) => name === "remove"), false);
assert.deepEqual(calls.find(([name]) => name === "settle")[1].closed, [],
  "Snooze retains its durable reviewed copy but never closes a navigated replacement");

calls.length = 0;
queryTabs = [{ id: 8, url: "chrome://settings", title: "Settings" }];
assert.equal(await actions.window(2, 4000), null);
assert.deepEqual(calls, [["query-tabs", { windowId: 2 }]],
  "a window with no saveable page produces no stored record or close");

console.log("PASS: live Snooze actions preserve provenance and persist-before-close ordering");
