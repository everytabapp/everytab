import assert from "node:assert/strict";
import fs from "node:fs";
import { createChromeI18nMock } from "./message-fixture.mjs";

globalThis.chrome = {
  i18n: createChromeI18nMock(),
  runtime: { getURL: (path) => `chrome-extension://test/${path}` }
};

const {
  createSearchSnapshot,
  createSearchSnapshotAsync,
  createSearchSession
} = await import("../js/lib/search.js");
const searchSource = fs.readFileSync(new URL("../js/lib/search.js", import.meta.url), "utf8");
const transientBuilder = searchSource.slice(searchSource.indexOf("async function buildTransientSearchSnapshot()"),
  searchSource.indexOf("export async function buildPrimarySearchSnapshot()"));
assert.match(transientBuilder, /, createSearchSnapshotAsync\s*\);/,
  "the default completion builder uses cooperative normalization");

const data = {
  openTabs: [
    { id: 1, windowId: 2, title: "Open", url: "https://open.example/page" },
    { id: 2, windowId: 2, title: "Private", url: "https://private.example", incognito: true },
    { id: 3, windowId: 2, title: "Suspended", url: "chrome-extension://test/suspend.html?originalUrl=https%3A%2F%2Fsuspended.example%2F" }
  ],
  starred: [{ id: "star", title: "Starred", url: "https://star.example" }],
  inbox: [{ id: "inbox", labels: ["item"], tabs: [{
    title: "Inbox", url: "https://inbox.example", labels: ["tab"]
  }] }],
  snoozes: [{ id: "sleep", url: "https://snooze.example", title: "Snoozed", favIconUrl: "data:image/png;base64,AA" }],
  archive: [{ id: "archive", labels: ["old"], tabs: [{ title: "Archive", url: "https://archive.example" }] }],
  collections: [{ id: "collection", name: "Collection", tabs: [{ title: "Collected", url: "https://collection.example" }] }],
  sessions: [{ id: "session", name: "Named", auto: false, windows: [[{
    title: "Session tab", url: "https://session.example"
  }]], labels: [] }],
  sessionIdentities: [{ id: "session", name: "Named", windowUrls: [["https://session.example"]] }],
  organizationGroups: [{ id: "group", organizationKind: "label", name: "Item group", createdAt: 1, modifiedAt: 1 }],
  organizationMemberships: [{ id: "membership", organizationKind: "label", groupId: "group", memberKey: "item", createdAt: 1, modifiedAt: 1 }]
};
const original = structuredClone(data);
const clockCalls = [];
const asyncSnapshot = await createSearchSnapshotAsync(data, 1234, {
  clock: () => { clockCalls.push(true); return 0; },
  yieldTask: async () => { throw new Error("unexpected small-fixture yield"); }
});
assert.deepEqual(asyncSnapshot, createSearchSnapshot(data, 1234),
  "cooperative normalization preserves every source projection");
assert.equal(asyncSnapshot.organizationEntities.length, 1, "organization fixture actually projects a group");
assert.equal(asyncSnapshot.sources.open.length, 2, "private tabs stay excluded");
assert.equal(asyncSnapshot.sources.snoozed.length, 1);
assert.equal(asyncSnapshot.sources.open[1].result.url, "https://suspended.example/");
assert.equal(clockCalls.length > 0, true, "the cooperative builder checks its injected clock");
assert.deepEqual(data, original, "async normalization does not mutate input");

const largeData = {
  inbox: [{ id: "large", tabs: Array.from({ length: 256 }, (_, index) => ({
    title: `Large ${index}`, url: `https://large.example/${index}`, labels: index % 2 ? ["odd"] : []
  })) }]
};
let cooperativeClock = 0;
let yields = 0;
const largeAsync = await createSearchSnapshotAsync(largeData, 9, {
  clock: () => { cooperativeClock += 5; return cooperativeClock; },
  yieldTask: async () => { yields += 1; }
});
assert.deepEqual(largeAsync, createSearchSnapshot(largeData, 9));
assert.ok(yields > 0, "large normalization yields after elapsed cooperative slices");

// Use the default yield implementation, not a resolved-promise test substitute.
let buildFinished = false;
const inputTask = new Promise((resolve) => setTimeout(() => resolve(buildFinished), 0));
let taskClock = 0;
const yieldingBuild = createSearchSnapshotAsync(largeData, 9, {
  clock: () => (taskClock += 5)
}).then(() => { buildFinished = true; });
assert.equal(await inputTask, false, "a queued task runs before normalization finishes");
await yieldingBuild;

await assert.rejects(
  () => createSearchSnapshotAsync(largeData, 9, {
    clock: (() => { let now = 0; return () => (now += 5); })(),
    yieldTask: async () => { throw new Error("yield stopped"); }
  }),
  /yield stopped/
);

const primary = createSearchSnapshot({
  openTabs: [{ id: 41, windowId: 7, title: "needle primary", url: "https://primary.example" }]
});
const completionData = (id) => ({
  sessions: [{ id, name: id, auto: true, windows: [Array.from({ length: 256 }, (_, i) => ({
    title: `needle ${id} snapshot`, url: `https://${id}.example${i ? `/${i}` : ""}`
  }))], labels: [] }]
});
const completionGates = [];
const gate = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  completionGates.push({ promise, resolve });
  return promise;
};
const session = createSearchSession({
  buildPrimarySnapshot: async () => primary,
  buildCompletionSnapshot: async () => {
    const index = completionGates.length;
    let clock = 0;
    let first = true;
    return createSearchSnapshotAsync(completionData(index === 0 ? "old" : "new"), 1234, {
      clock: () => (clock += 5),
      yieldTask: async () => {
        if (!first) return;
        first = false;
        await gate();
      }
    });
  }
});
const oldProgressive = await session.searchProgressively("needle");
const oldComplete = oldProgressive.complete;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(completionGates.length, 1, "completion pauses behind the injected gate");
session.invalidate();
const newProgressive = await session.searchProgressively("needle");
const newComplete = newProgressive.complete;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(completionGates.length, 2, "new generation starts a fresh completion build");
completionGates[1].resolve();
const newResults = await newComplete;
assert.ok(newResults?.some((result) => result.url === "https://new.example"));
completionGates[0].resolve();
assert.equal(await oldComplete, null, "late invalidated normalization cannot publish old results");
const cached = await session.searchProgressively("needle");
assert.ok((await cached.complete)?.some((result) => result.url === "https://new.example"),
  "a late old build cannot overwrite the newer completion cache");

console.log("PASS: cooperative Search snapshot builds");
