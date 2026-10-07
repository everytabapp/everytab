import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const base = "chrome-extension://test-ext-id/suspend.html";
const suspended = (originalUrl, title, recoveryOccurrenceId = "") => `${base}?${new URLSearchParams({
  originalUrl,
  title,
  ...(recoveryOccurrenceId ? { recoveryOccurrenceId } : {})
})}`;
const recent = [
  {
    lastModified: 100,
    tab: { sessionId: "tab-a", url: suspended("https://a.example/one", "A", "occ-a") }
  },
  {
    lastModified: 99,
    tab: { sessionId: "ordinary", url: "https://ordinary.example/" }
  },
  {
    lastModified: 98,
    window: { tabs: [
      { sessionId: "tab-b", url: suspended("https://b.example/two", "B") },
      { sessionId: "tab-c", url: suspended("https://c.example/three", "C") },
      { sessionId: "ordinary-in-window", url: "https://ordinary.example/in-window" }
    ] }
  },
  {
    lastModified: 97,
    tab: {
      sessionId: "other-extension",
      url: "chrome-extension://other-id/suspend.html?originalUrl=https%3A%2F%2Fprivate.example"
    }
  },
  {
    lastModified: 96,
    tab: { sessionId: "unsafe-original", url: suspended("file:///private.txt", "Unsafe") }
  },
  {
    lastModified: 95,
    tab: { sessionId: "tab-a", url: suspended("https://duplicate.example/", "Duplicate id") }
  },
  {
    lastModified: 94,
    tab: {
      sessionId: "tab-a-again",
      url: suspended("https://a.example/one", "A again", "occ-a")
    }
  },
  {
    lastModified: 93,
    tab: {
      sessionId: "already-live",
      url: suspended("https://live.example/", "Already live", "occ-live")
    }
  }
];

const mem = {};
const restoredIds = [];
let nextTabId = 8000;

globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test-ext-id/${path}` },
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === "string") return keys in mem ? { [keys]: structuredClone(mem[keys]) } : {};
        return Object.fromEntries(keys.filter((key) => key in mem)
          .map((key) => [key, structuredClone(mem[key])]));
      },
      set: async (value) => Object.assign(mem, structuredClone(value))
    }
  },
  sessions: {
    getRecentlyClosed: async ({ maxResults }) => {
      assert.equal(maxResults, 25, "recovery audit must request Chrome's bounded maximum");
      return structuredClone(recent);
    },
    restore: async (sessionId) => {
      restoredIds.push(sessionId);
      if (sessionId === "tab-c") throw new Error("entry expired");
      const candidate = sessionId === "tab-a"
        ? { originalUrl: "https://a.example/one", title: "A" }
        : { originalUrl: "https://b.example/two", title: "B" };
      return {
        tab: {
          id: nextTabId++,
          sessionId,
          windowId: 7,
          index: 2,
          pinned: false,
          title: candidate.title,
          url: suspended(candidate.originalUrl, candidate.title)
        }
      };
    }
  },
  tabs: {
    query: async () => [{
      id: 77,
      url: suspended("https://live.example/", "Already live", "occ-live")
    }]
  }
};

installBrowserMapStorageAuthority();
Object.defineProperty(globalThis, "navigator", {
  value: { locks: createMockLockManager() }, configurable: true
});

const {
  inspectRecentlyClosedSuspendedTabs,
  recoverRecentlyClosedSuspendedTabs
} = await import("../js/lib/suspend-recent-recovery.js");

const audit = await inspectRecentlyClosedSuspendedTabs();
assert.equal(audit.ok, true);
assert.deepEqual(audit.candidates.map((candidate) => ({
  sessionId: candidate.sessionId,
  title: candidate.title,
  domain: candidate.domain,
  closedAt: candidate.closedAt
})), [
  { sessionId: "tab-a", title: "A", domain: "a.example", closedAt: 100_000 },
  { sessionId: "tab-b", title: "B", domain: "b.example", closedAt: 98_000 },
  { sessionId: "tab-c", title: "C", domain: "c.example", closedAt: 98_000 }
]);

const result = await recoverRecentlyClosedSuspendedTabs([
  "tab-a", "unknown", "tab-c", "tab-a"
]);
assert.deepEqual(restoredIds, ["tab-a", "tab-c"],
  "only fresh, selected EveryTab suspended sessions may reach Chrome restore");
assert.deepEqual(result, {
  ok: false,
  requested: 3,
  restored: 1,
  failed: 1,
  unavailable: 1
});
assert.equal(mem.suspendedRegistry?.[8000]?.originalUrl, "https://a.example/one",
  "a restored suspended page is adopted into the durable registry immediately");
assert.equal(mem.suspendedRegistry?.[8000]?.recoveryOccurrenceId, "occ-a",
  "recent recovery preserves the logical occurrence used for exact deduplication");

const pageSource = readFileSync(new URL("../js/ui/suspend-page.js", import.meta.url), "utf8");
assert.match(pageSource, /sendMessage\(\{ type: "adopt-suspended-page" \}\)/,
  "every mounted suspended page repairs its own registry identity");

console.log("PASS: recently closed recovery is bounded, exact, explicit, and registry-safe");
