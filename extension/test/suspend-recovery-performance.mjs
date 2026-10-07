import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createMockLockManager } from "./e2-mocks.mjs";

const tabCount = 40;
const storageDelayMs = 3;
const browserEffectDelayMs = 18;
const registry = Object.fromEntries(Array.from({ length: tabCount }, (_, index) => {
  const tabId = 1_000 + index;
  return [tabId, {
    originalUrl: `https://kept.example/${index}`,
    title: `Kept ${index}`,
    windowId: 7,
    index,
    pinned: false,
    recoveryOccurrenceId: `occurrence-${index}`
  }];
}));
const mem = {
  suspendedRegistry: registry,
  suspendRecoveryCycle: {
    id: "latency-cycle",
    kind: "reload",
    attemptedOccurrenceIds: [],
    recoveredOccurrenceIds: [],
    complete: false
  }
};
const listeners = new Set();
let storageOperations = 0;
let nextTabId = 2_000;

const waitForStorage = async () => {
  storageOperations += 1;
  await new Promise((resolve) => setTimeout(resolve, storageDelayMs));
};

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test-ext-id/${path}` },
  storage: {
    local: {
      get: async (keys) => {
        await waitForStorage();
        const requested = typeof keys === "string" ? [keys] : keys;
        return Object.fromEntries(requested.filter((key) => key in mem)
          .map((key) => [key, structuredClone(mem[key])]));
      },
      set: async (values) => {
        await waitForStorage();
        const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
          oldValue: structuredClone(mem[key]),
          newValue: structuredClone(value)
        }]));
        Object.assign(mem, structuredClone(values));
        for (const listener of listeners) listener(changes, "local");
      }
    },
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener)
    }
  },
  windows: { getAll: async () => [{ id: 7, type: "normal" }] },
  tabs: {
    query: async () => [],
    create: async (props) => {
      await new Promise((resolve) => setTimeout(resolve, browserEffectDelayMs));
      return {
        id: nextTabId++, windowId: props.windowId, index: props.index,
        pinned: Boolean(props.pinned), url: props.url
      };
    },
    remove: async () => {}
  }
};

Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const { installBrowserMapStorageAuthority } = await import(
  "./storage-authority-fixture.mjs"
);
installBrowserMapStorageAuthority();

const { recoverSuspendedTabs } = await import("../js/lib/suspend.js");
const started = performance.now();
let browserRecoveryCompletedAt = null;
let browserRecoveryTotal = 0;
const recovered = await recoverSuspendedTabs({
  recoveryCycleId: "latency-cycle",
  onBrowserRecoveryComplete: (total) => {
    browserRecoveryCompletedAt = performance.now();
    browserRecoveryTotal = total;
  }
});
const elapsedMs = performance.now() - started;

assert.equal(recovered, tabCount, "the latency fixture must recover every occurrence");
assert.equal(browserRecoveryTotal, tabCount,
  "the prompt-notification boundary must receive the complete visible recovery total");
assert.ok(Number.isFinite(browserRecoveryCompletedAt),
  "visible browser recovery must be observable before durable reconciliation settles");
assert.ok(browserRecoveryCompletedAt - started < elapsedMs - storageDelayMs,
  "notification ownership must begin before the delayed durable recovery writes finish");
assert.ok(storageOperations <= 20,
  `recovery used ${storageOperations} storage operations and ${elapsedMs.toFixed(1)} ms for ${tabCount} tabs; expected bounded per-pass bookkeeping`);
assert.ok(elapsedMs < 300,
  `recovery took ${elapsedMs.toFixed(1)} ms with ${storageDelayMs} ms storage latency and ${browserEffectDelayMs} ms browser effects`);

console.log(`PASS: recovered ${tabCount} suspended tabs in ${elapsedMs.toFixed(1)} ms with ${storageOperations} storage operations`);
