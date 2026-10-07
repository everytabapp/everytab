import assert from "node:assert/strict";
import { createDisplayTabReads } from "../js/ui/display-tab-reads.js";
import { coalesceLatest } from "../js/ui/dom.js";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const stored = {};
globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries(
        (typeof keys === "string" ? [keys] : keys).filter((key) => key in stored)
          .map((key) => [key, structuredClone(stored[key])])
      ),
      set: async (values) => Object.assign(stored, structuredClone(values))
    },
    onChanged: { addListener: () => {}, removeListener: () => {} }
  }
};
installBrowserMapStorageAuthority();
const readNoRules = async () => [];

const displayedTabs = [{ id: 1, url: "https://one.example" }];
let queryCount = 0;
let groupCount = 0;
let releaseQuery;
const query = new Promise((resolve) => { releaseQuery = resolve; });
const reads = createDisplayTabReads({
  readRules: readNoRules,
  queryTabs: () => { queryCount += 1; return query; },
  groupTabs: (tabs) => {
    groupCount += 1;
    assert.deepEqual(tabs, displayedTabs);
    return [{ ids: tabs.map(({ id }) => id) }];
  }
});
const tabs1 = reads.tabs();
const tabs2 = reads.tabs();
const groups1 = reads.groups();
const groups2 = reads.groups();
await Promise.resolve();
assert.equal(queryCount, 1, "concurrent tabs/groups share one lazy tab query");
releaseQuery(displayedTabs);
assert.deepEqual(await Promise.all([tabs1, tabs2]), [displayedTabs, displayedTabs]);
assert.deepEqual(await Promise.all([groups1, groups2]), [[{ ids: [1] }], [{ ids: [1] }]]);
assert.equal(groupCount, 1, "concurrent and sequential groups share one computation");
await reads.tabs();
await reads.groups();
assert.equal(queryCount, 1);
assert.equal(groupCount, 1);

const fresh = createDisplayTabReads({
  readRules: readNoRules,
  queryTabs: async () => [{ id: 2 }],
  groupTabs: (tabs) => tabs.map(({ id }) => id)
});
assert.deepEqual(await fresh.groups(), [2], "a new instance starts a fresh scope");

const duplicateFixtures = [
  { id: 11, url: "https://dup.example/page", active: true, pinned: false, incognito: false },
  { id: 12, url: "https://dup.example/page/", pinned: false, incognito: false },
  { id: 13, url: "https://dup.example/page", pinned: true, incognito: false },
  { id: 14, url: "https://dup.example/page", pinned: false, incognito: true },
  { id: 15, url: "https://dup.example/page", pendingUrl: "https://other.example/", pinned: false }
];
const fixtureSnapshot = structuredClone(duplicateFixtures);
const defaultRead = createDisplayTabReads({
  readRules: readNoRules,
  queryTabs: async () => duplicateFixtures
});
const defaultGroups = await defaultRead.groups();
assert.equal(defaultGroups.length, 1, "default grouping finds the duplicate family");
assert.equal(defaultGroups[0].keep.id, 11, "active duplicate is retained");
assert.deepEqual(defaultGroups[0].tabs.map(({ id }) => id), [11, 12, 13],
  "pinned/private/navigating tabs are handled by production grouping");
assert.deepEqual(defaultGroups[0].close.map(({ id }) => id), [12],
  "pinned duplicates are never proposed for closing");
assert.deepEqual(duplicateFixtures, fixtureSnapshot, "grouping does not mutate the source array");

let composedQueryCount = 0;
let composedGroupCount = 0;
let releaseComposed;
const composedQuery = new Promise((resolve) => { releaseComposed = resolve; });
const composedReads = createDisplayTabReads({
  readRules: readNoRules,
  queryTabs: () => { composedQueryCount += 1; return composedQuery; },
  groupTabs: (tabs) => {
    composedGroupCount += 1;
    return tabs.filter(({ id }) => id === 11 || id === 12);
  }
});
const nav = coalesceLatest(async () => {
  const tabs = await composedReads.tabs();
  return composedReads.groups().then((groups) => ({ tabs, groups }));
});
const status = coalesceLatest(() => composedReads.groups());
const duplicates = coalesceLatest(() => composedReads.groups());
const navResult = nav("nav");
const statusResult = status("status");
const duplicateResult = duplicates("duplicates");
await Promise.resolve();
assert.equal(composedQueryCount, 1, "composed consumers share one deferred query");
releaseComposed(duplicateFixtures);
const [navView, statusView, duplicateView] = await Promise.all([
  navResult, statusResult, duplicateResult
]);
assert.equal(composedGroupCount, 1, "composed consumers share one deferred grouping");
assert.equal(navView.tabs.length, duplicateFixtures.length);
assert.equal(navView.groups.length, 2);
assert.equal(statusView.length, 2);
assert.equal(duplicateView.length, 2);

const nextFixtures = [{ id: 21, url: "https://next.example" }];
let nextQueries = 0;
const nextScope = createDisplayTabReads({
  readRules: readNoRules,
  queryTabs: async () => { nextQueries += 1; return nextFixtures; },
  groupTabs: (tabs) => tabs
});
assert.deepEqual(await nextScope.tabs(), nextFixtures, "a fresh scope reads changed fixtures");
await nextScope.groups();
assert.equal(nextQueries, 1);
globalThis.chrome.tabs = { query: async () => nextFixtures };
globalThis.chrome.windows = { getAll: async () => [
  { id: 20, type: "normal", incognito: false, tabs: nextFixtures }
] };
const explicitUndefinedScope = createDisplayTabReads({ readRules: readNoRules });
assert.deepEqual(await explicitUndefinedScope.tabs(), nextFixtures,
  "an explicit undefined configuration creates an independent scope");

chrome.windows = { getAll: async () => [
  { id: 1, type: "normal", incognito: false, tabs: [
    { id: 31, url: "https://normal-one.example" },
    { id: 32, url: "https://normal-two.example" }
  ] },
  { id: 2, type: "popup", incognito: false, tabs: [
    { id: 41, url: "https://popup-one.example" },
    { id: 42, url: "https://popup-two.example" },
    { id: 43, url: "https://popup-three.example" },
    { id: 44, url: "https://popup-four.example" }
  ] },
  { id: 3, type: "normal", incognito: true, tabs: [
    { id: 51, url: "https://private.example" }
  ] }
] };
const alignedOpenScope = createDisplayTabReads({ readRules: readNoRules });
assert.deepEqual((await alignedOpenScope.tabs()).map(({ id }) => id), [31, 32],
  "sidebar Open count uses the same ordinary non-private windows as the Open page");

let failed = true;
let retryQueries = 0;
const rejected = createDisplayTabReads({
  readRules: readNoRules,
  queryTabs: async () => {
    retryQueries += 1;
    if (failed) throw new Error("query failed");
    return [{ id: 3 }];
  },
  groupTabs: (tabs) => tabs
});
await assert.rejects(rejected.tabs(), /query failed/);
await assert.rejects(rejected.groups(), /query failed/);
assert.equal(retryQueries, 1, "a rejected query stays rejected within its instance");
failed = false;
const recovered = createDisplayTabReads({
  readRules: readNoRules,
  queryTabs: async () => [{ id: 4 }],
  groupTabs: (tabs) => tabs
});
assert.deepEqual(await recovered.tabs(), [{ id: 4 }]);

const deferred = (withReject = false) => {
  const result = {};
  result.promise = withReject
    ? new Promise((resolve, reject) => { result.resolve = resolve; result.reject = reject; })
    : new Promise((resolve) => { result.resolve = resolve; });
  return result;
};
const deferredRuns = [];
const runDeferred = coalesceLatest(async (value) => {
  const run = deferredRuns.shift();
  run.value = value;
  return run.promise;
});
const first = deferred();
const latest = deferred();
deferredRuns.push(first, latest);
const firstWaiter = runDeferred("first");
const secondWaiter = runDeferred("second");
const undefinedWaiter = runDeferred(undefined);
assert.equal(deferredRuns.length, 1, "only one run starts while the first is active");
let secondSettled = false;
secondWaiter.then(() => { secondSettled = true; });
await Promise.resolve();
assert.equal(secondSettled, false, "queued waiters wait for the queued run");
first.resolve("first-result");
assert.equal(await firstWaiter, "first-result");
assert.equal(first.value, "first");
assert.equal(latest.value, undefined, "latest undefined is forwarded and resets the queued value");
latest.resolve("latest-result");
assert.equal(await secondWaiter, "latest-result");
assert.equal(await undefinedWaiter, "latest-result");

const failureRuns = [];
const runWithFailure = coalesceLatest(async (value) => {
  const run = failureRuns.shift();
  run.value = value;
  return run.promise;
});
const failedRun = deferred(true);
const recoveryRun = deferred();
failureRuns.push(failedRun, recoveryRun);
const failedWaiter = runWithFailure("bad");
const recoveryWaiter = runWithFailure("recovery");
failedRun.reject(new Error("first run failed"));
await assert.rejects(failedWaiter, /first run failed/);
let recoverySettled = false;
recoveryWaiter.then(() => { recoverySettled = true; });
await Promise.resolve();
assert.equal(recoverySettled, false, "a failed run does not settle queued waiters");
assert.equal(recoveryRun.value, "recovery");
recoveryRun.resolve("recovered");
assert.equal(await recoveryWaiter, "recovered");

// Exercise the actual surface callback: a DOM click event is not a read scope.
const { installDomFixture } = await import("./dom-fixture.mjs");
const { createDuplicatesSurface } = await import("../js/ui/duplicates-surface.js");
const dom = installDomFixture();
try {
  document.addEventListener = () => {}; // Keyboard handling is outside this click/read test.
  const body = document.createElement("div");
  let rescans = 0;
  let supportingWindowReads = 0;
  chrome.tabs = { query: async () => [] };
  chrome.windows = { getAll: async () => { supportingWindowReads += 1; return []; } };
  chrome.i18n = createChromeI18nMock();
  const surface = createDuplicatesSurface({
    getBody: () => body,
    setHeading: () => {},
    msg: async () => { throw new Error("display reads must not invoke actions"); }
  });
  const scheduledReads = createDisplayTabReads({
    readRules: readNoRules,
    queryWindows: async () => { rescans += 1; return []; }
  });
  await surface.render(scheduledReads);
  assert.equal(rescans, 1);
  await surface.render(scheduledReads);
  assert.equal(rescans, 1, "the actual surface reuses its supplied batch");
  const rescan = body.querySelectorAll("button").find((button) =>
    button.getAttribute("title") === "Scan the open tabs again");
  assert.ok(rescan, "the real surface renders Rescan");
  const supportingBeforeRescan = supportingWindowReads;
  await rescan.dispatch("click");
  assert.equal(rescans, 1, "the supplied batch remains isolated from a later Rescan");
  assert.equal(supportingWindowReads, supportingBeforeRescan + 2,
    "actual Rescan click creates one fresh normal-window tab read plus its window labels");
} finally {
  dom.restore();
}

console.log("PASS: display tab reads and latest coalescing");
