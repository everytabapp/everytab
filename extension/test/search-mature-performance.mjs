/**
 * Permanent regression for the long-lived profile that exposed Search's
 * snapshot cost. Run from extension/ with:
 *
 *   node --expose-gc test/search-mature-performance.mjs
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const mem = {};
let openTabs = [];

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://search-perf/${path}` },
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === "string") {
          return keys in mem ? { [keys]: structuredClone(mem[keys]) } : {};
        }
        const out = {};
        for (const key of Array.isArray(keys) ? keys : Object.keys(keys ?? {})) {
          if (key in mem) out[key] = structuredClone(mem[key]);
        }
        return out;
      },
      set: async (value) => Object.assign(mem, structuredClone(value))
    }
  },
  tabs: { query: async () => structuredClone(openTabs) }
};

const { installBrowserMapStorageAuthority } = await import(
  "./storage-authority-fixture.mjs"
);
const { STORE_KEYS } = await import("../js/lib/types.js");
const authority = installBrowserMapStorageAuthority();
const readMaps = authority.readMaps.bind(authority);
let sessionFamilyReadCount = 0;
authority.readMaps = async (keys) => {
  if (keys.includes(STORE_KEYS.sessions)) sessionFamilyReadCount += 1;
  return readMaps(keys);
};

const {
  buildPrimarySearchSnapshot, buildSearchSnapshot, createSearchSession,
  SEARCH_DEBOUNCE_MS
} = await import("../js/lib/search.js");

function loadMatureProfile() {
  const sessions = {};
  for (let snapshotIndex = 0; snapshotIndex < 2_000; snapshotIndex += 1) {
    const tabs = [];
    for (let tabIndex = 0; tabIndex < 72; tabIndex += 1) {
      tabs.push({
        url: `https://snapshots.example/${snapshotIndex}/${tabIndex}`,
        title: snapshotIndex === 1_999 && tabIndex === 71
          ? "Immediate primary needle snapshot"
          : `Snapshot ${snapshotIndex} tab ${tabIndex}`
      });
    }
    const id = `snapshot-${snapshotIndex}`;
    sessions[id] = {
      id,
      name: `Automatic snapshot ${snapshotIndex}`,
      auto: true,
      createdAt: snapshotIndex + 1,
      modifiedAt: snapshotIndex + 1,
      windows: [tabs],
      labels: []
    };
  }
  for (let index = 0; index < 3; index += 1) {
    const id = `named-${index}`;
    sessions[id] = {
      id,
      name: `Named Session ${index + 1}`,
      auto: false,
      createdAt: 3_000 + index,
      modifiedAt: 3_000 + index,
      windows: [[]],
      labels: []
    };
  }
  mem[STORE_KEYS.sessions] = sessions;
  openTabs = [{
    id: 41,
    windowId: 7,
    url: "https://primary.example/needle",
    title: "Immediate primary needle",
    incognito: false
  }];
}

loadMatureProfile();
globalThis.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
let primaryBuildMs = 0;
let completionBuildMs = 0;
let completionBuildCount = 0;
const session = createSearchSession({
  buildSnapshot: async () => {
    completionBuildCount += 1;
    const buildStartedAt = performance.now();
    const snapshot = await buildSearchSnapshot();
    completionBuildMs = performance.now() - buildStartedAt;
    return snapshot;
  },
  buildPrimarySnapshot: async () => {
    const buildStartedAt = performance.now();
    const snapshot = await buildPrimarySearchSnapshot();
    primaryBuildMs = performance.now() - buildStartedAt;
    return snapshot;
  }
});
const completeDomains = await session.scopeNames("domain");
assert.ok(completeDomains.includes("snapshots.example"));
const startedAt = performance.now();
const progressive = await session.searchProgressively("immediate primary needle");
const elapsedMs = performance.now() - startedAt;
const results = progressive.results;
const completedResults = await progressive.complete;
const completionMs = performance.now() - startedAt;
const cachedProgressive = await session.searchProgressively(
  "immediate primary needle snapshot"
);
const cachedCompletedResults = await cachedProgressive.complete;
await new Promise((resolve) => setTimeout(resolve, 1_100));
globalThis.gc?.();
const retainedHeapMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

assert.equal(results[0]?.type, "open");
assert.equal(results[0]?.tabId, 41);
assert.equal(completedResults?.[0]?.type, "open");
assert.equal(completedResults?.[1]?.snapshot, true);
assert.equal(cachedProgressive.results.length, 0);
assert.equal(cachedCompletedResults?.[0]?.snapshot, true);
assert.equal(completionBuildCount, 1);
assert.equal(sessionFamilyReadCount, 1,
  "one Search generation should share its complete Session/Snapshot read between facets and results");
console.log(JSON.stringify({
  elapsedMs: Math.round(elapsedMs * 100) / 100,
  primaryBuildMs: Math.round(primaryBuildMs * 100) / 100,
  primaryMatchMs: Math.round((elapsedMs - primaryBuildMs) * 100) / 100,
  completionBuildMs: Math.round(completionBuildMs * 100) / 100,
  completionBuildCount,
  sessionFamilyReadCount,
  completionMs: Math.round(completionMs * 100) / 100,
  estimatedInputToPrimaryMs: Math.round((SEARCH_DEBOUNCE_MS + elapsedMs) * 100) / 100,
  retainedHeapMb: Math.round(retainedHeapMb * 100) / 100,
  primaryResultCount: results.length,
  completedResultCount: completedResults?.length ?? 0
}));
assert.ok(SEARCH_DEBOUNCE_MS + elapsedMs <= 100,
  `input-to-primary Search took ${(SEARCH_DEBOUNCE_MS + elapsedMs).toFixed(2)}ms (budget 100ms)`);
assert.ok(retainedHeapMb <= 12,
  `progressive Search retained ${retainedHeapMb.toFixed(2)}MB (budget 12MB)`);

console.log("PASS: mature-profile Search is fast, complete, and bounded");
