import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  isEveryTabNewTab,
  runThemeRotationDiagnostics
} from "../js/ui/theme-rotation-diagnostics.js";

const poolKey = "cream|tide";
const baseInput = (workerTrace = [], expectedHandshake = false, expectedTabId = null) => ({
  settings: {
    uiScheme: "tide",
    schemeRotate: "open",
    schemeFavorites: ["cream", "tide"]
  },
  customRecords: {},
  state: { poolKey, remaining: [] },
  prepared: { from: "tide", next: "cream", poolKey },
  cache: {
    selection: "tide",
    scheme: "tide",
    schemeRotate: "open",
    schemeRotationPoolKey: poolKey,
    preparedTheme: { selection: "cream", scheme: "cream" }
  },
  painted: { bootSelection: "cream", currentSelection: "tide" },
  workerTrace,
  expectedHandshake,
  ...(Number.isInteger(expectedTabId) ? { expectedTabId } : {}),
  context: { appVersion: "0.8.test", vault: { state: "unset" } }
});

let removed = [];
let createdWith = null;
const successfulTrace = (tabId) => [
  { event: "page-handshake-sent", tabId },
  { event: "worker-handshake-received", tabId },
  { event: "worker-result", tabId, outcome: "changed", scheme: "tide" }
];
const report = await runThemeRotationDiagnostics(() => {}, {
  observationMs: 0,
  armTrace: async () => ({ ok: true }),
  createTab: async (properties) => {
    createdWith = properties;
    return { id: 77 };
  },
  getTab: async (tabId) => ({
    id: tabId,
    status: "complete",
    url: "chrome-extension://fixture/newtab.html?focus=search"
  }),
  runtimeGetURL: (path) => `chrome-extension://fixture/${path}`,
  readTrace: async () => successfulTrace(77),
  readInput: async (workerTrace, expectedHandshake, expectedTabId) =>
    baseInput(workerTrace, expectedHandshake, expectedTabId),
  removeTab: async (tabId) => { removed.push(tabId); }
});

assert.deepEqual(createdWith, { active: true }, "the check exercises an ordinary visible New Tab");
assert.deepEqual(removed, [77], "the check removes only the temporary tab it created");
assert.equal(report.verdict, "rotation-successful");
assert.equal(report.context.check.completed, true);
assert.equal(report.context.check.tabState, "complete");

assert.equal(isEveryTabNewTab(
  { url: "chrome-extension://fixture/newtab.html?focus=search" },
  (path) => `chrome-extension://fixture/${path}`
), true, "the exact EveryTab New Tab remains eligible for cleanup");
assert.equal(isEveryTabNewTab(
  { url: "https://example.com/claimed" },
  (path) => `chrome-extension://fixture/${path}`
), false, "a navigated tab is never treated as the diagnostic page");

let reads = 0;
removed = [];
await runThemeRotationDiagnostics(() => {}, {
  observationMs: 0,
  armTrace: async () => ({ ok: true }),
  createTab: async () => ({ id: 78 }),
  getTab: async () => {
    reads += 1;
    return reads === 1
      ? { id: 78, status: "complete", url: "chrome-extension://fixture/newtab.html" }
      : { id: 78, status: "complete", url: "https://example.com/user-took-over" };
  },
  runtimeGetURL: (path) => `chrome-extension://fixture/${path}`,
  readTrace: async () => successfulTrace(78),
  readInput: async (workerTrace, expectedHandshake, expectedTabId) =>
    baseInput(workerTrace, expectedHandshake, expectedTabId),
  removeTab: async (tabId) => { removed.push(tabId); }
});
assert.deepEqual(removed, [], "a temporary tab navigated mid-check is left open");

removed = [];
await runThemeRotationDiagnostics(() => {}, {
  observationMs: 0,
  armTrace: async () => ({ ok: true }),
  createTab: async () => ({ id: 79 }),
  getTab: async () => { throw new Error("already closed"); },
  readTrace: async () => successfulTrace(79),
  readInput: async (workerTrace, expectedHandshake, expectedTabId) =>
    baseInput(workerTrace, expectedHandshake, expectedTabId),
  removeTab: async (tabId) => { removed.push(tabId); }
});
assert.deepEqual(removed, [], "a disappeared temporary tab is not removed again");

removed = [];
const failed = await runThemeRotationDiagnostics(() => {}, {
  observationMs: 0,
  armTrace: async () => ({ ok: true }),
  createTab: async () => { throw new Error("fixture failure"); },
  readTrace: async () => [],
  readInput: async (workerTrace, expectedHandshake) =>
    baseInput(workerTrace, expectedHandshake),
  removeTab: async (tabId) => { removed.push(tabId); }
});
assert.deepEqual(removed, [], "a failed create cannot remove any user-owned tab");
assert.equal(failed.context.check.completed, false);
assert.equal(failed.context.check.reason, "check-failed");
assert.equal(JSON.stringify(failed).includes("fixture failure"), false,
  "arbitrary browser errors never enter the copyable report");

let created = false;
const unavailable = await runThemeRotationDiagnostics(() => {}, {
  observationMs: 0,
  armTrace: async () => ({ ok: false, reason: "trace-unavailable" }),
  createTab: async () => { created = true; return { id: 91 }; },
  readInput: async (workerTrace, expectedHandshake) =>
    baseInput(workerTrace, expectedHandshake)
});
assert.equal(created, false, "a missing diagnostic worker never opens a temporary tab");
assert.equal(unavailable.context.check.reason, "trace-unavailable");

const source = await readFile(new URL("../js/ui/theme-rotation-diagnostics.js", import.meta.url), "utf8");
for (const destructive of [
  "chrome.storage.local.clear",
  "chrome.storage.local.remove",
  "localStorage.clear",
  "localStorage.removeItem"
]) {
  assert.equal(source.includes(destructive), false, `diagnostics do not call ${destructive}`);
}
assert.match(source, /tab URLs, titles, labels, Sessions, history, Vault folder names/);
assert.match(source, /status,\s*result,\s*evidence,/, "the visible component renders its evidence list");

console.log("PASS: bounded profile rotation check cleans up only its own tab");
