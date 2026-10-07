/**
 * A background tab's title or favicon change keeps Search's prepared saved
 * sources and refreshes only the Open source. URL, structural and storage
 * changes still retire the whole snapshot. Pure behavior over injected builders.
 *
 *     node test/search-open-source-refresh.mjs   (from extension/)
 */
import assert from "node:assert/strict";

globalThis.chrome = { runtime: { getURL: (path) => `chrome-extension://open-source/${path}` } };
const {
  createSearchSession, createSearchSnapshot, searchSnapshotWithOpenTabs,
  bindSearchSnapshotInvalidation, matchSearchSnapshot
} = await import("../js/lib/search.js");

const saved = {
  starred: [{ url: "https://star.example/one", title: "Starred needle" }],
  inbox: [{ id: "i1", labels: ["work"], tabs: [
    { url: "https://github.com/org/repo/pull/1", title: "Inbox needle pull" },
    { url: "https://docs.example/a", title: "Docs" }
  ] }],
  archive: [{ id: "a1", labels: [], tabs: [{ url: "https://github.com/org/repo/pull/2", title: "Archive needle" }] }],
  snoozes: [], collections: [],
  sessionIdentities: [{ id: "s1", name: "Needle session", windowUrls: [["https://s.example/1"]] }],
  organizationGroups: [], organizationMemberships: []
};
const openA = [
  { id: 1, windowId: 1, url: "https://github.com/org/repo/pull/3", title: "Open needle" },
  { id: 2, windowId: 1, url: "https://mail.example/inbox", title: "Mail (3)" },
  { id: 3, windowId: 2, url: "https://private.example/x", title: "hidden", incognito: true }
];
const openB = openA.map((tab) => tab.id === 2 ? { ...tab, title: "Mail needle (4)" } : tab);
const openC = [...openB, { id: 4, windowId: 2, url: "https://other.example/needle", title: "Other needle" }];

/* The Open-only rebuild equals a complete rebuild over the same data. */
for (const [fromTabs, toTabs] of [[openA, openB], [openA, openC], [openC, openA], [openA, []]]) {
  const rebuilt = searchSnapshotWithOpenTabs(createSearchSnapshot({ openTabs: fromTabs, ...saved }, 5), toTabs);
  const complete = createSearchSnapshot({ openTabs: toTabs, ...saved }, 5);
  assert.deepEqual(rebuilt, complete, "patched snapshot equals a complete rebuild");
  assert.deepEqual(Object.keys(rebuilt.sources), Object.keys(complete.sources), "source order is retained");
  assert.deepEqual(JSON.stringify(rebuilt), JSON.stringify(complete), "serialized shape is identical");
}

/* Sessions refresh only the Open source after a tab-presentation change. */
{
  let openTabs = openA;
  let builds = 0;
  let completionBuilds = 0;
  let openReads = 0;
  const session = createSearchSession({
    buildPrimarySnapshot: async () => { builds += 1; return createSearchSnapshot({ openTabs, ...saved }); },
    buildCompletionSnapshot: async () => { completionBuilds += 1; return createSearchSnapshot({ openTabs, ...saved }); },
    readOpenTabs: async () => { openReads += 1; return openTabs; }
  });
  const chromeEvents = {};
  const event = (name) => {
    const fns = new Set();
    chromeEvents[name] = { addListener: (fn) => fns.add(fn), removeListener: (fn) => fns.delete(fn),
      fire: (...args) => { for (const fn of fns) fn(...args); } };
    return chromeEvents[name];
  };
  const chromeApi = {
    storage: { onChanged: event("storage") },
    tabs: { onCreated: event("created"), onRemoved: event("removed"), onMoved: event("moved"),
      onAttached: event("attached"), onDetached: event("detached"), onReplaced: event("replaced"),
      onUpdated: event("updated") },
    windows: { onCreated: event("windowCreated"), onRemoved: event("windowRemoved") }
  };
  // The shared Search box wraps the session and forwards the call without its
  // reason; the binding still carries the reason to the session.
  const wrapper = { invalidate() { session.invalidate(); } };
  const unbind = bindSearchSnapshotInvalidation(wrapper, chromeApi);

  const first = await session.searchProgressively("needle");
  assert.equal(builds, 1);
  assert.ok(first.results.some((result) => result.type === "open" && result.tabId === 1));
  assert.ok(!first.results.some((result) => result.tabId === 2), "Mail (3) does not match yet");
  const completeFirst = await first.complete;
  assert.equal(completionBuilds, 1);

  openTabs = openB;
  chromeEvents.updated.fire(2, { title: "Mail needle (4)" }, openB[1]);
  const second = await session.searchProgressively("needle");
  assert.equal(builds, 1, "a title change does not rebuild the primary snapshot");
  assert.equal(openReads, 1, "the Open source is read once for that change");
  assert.ok(second.results.some((result) => result.tabId === 2 && result.title === "Mail needle (4)"),
    "the renamed background tab is searchable");
  assert.deepEqual(second.results,
    await matchSearchSnapshot(createSearchSnapshot({ openTabs: openB, ...saved }), "needle", { includeHistory: false }),
    "primary results equal a complete rebuild");
  const completeSecond = await second.complete;
  assert.equal(completionBuilds, 1, "the completion snapshot keeps its Session candidates");
  assert.deepEqual(completeSecond,
    await matchSearchSnapshot(createSearchSnapshot({ openTabs: openB, ...saved }), "needle", {}),
    "completion results equal a complete rebuild");
  assert.ok(completeFirst.length < completeSecond.length);

  const third = await session.searchProgressively("needle");
  assert.equal(openReads, 1, "a quiet keystroke reads nothing");
  assert.deepEqual(third.results, second.results);

  // Several presentation changes before the next keystroke cost one read.
  chromeEvents.updated.fire(1, { favIconUrl: "https://github.com/favicon.ico" }, openB[0]);
  chromeEvents.updated.fire(2, { title: "Mail needle (5)" }, openB[1]);
  await session.searchProgressively("needle");
  assert.equal(openReads, 2);
  assert.equal(builds, 1);

  // URL and structural changes retire everything, as before.
  chromeEvents.updated.fire(1, { url: "https://github.com/org/repo/pull/9" }, openB[0]);
  await session.searchProgressively("needle");
  assert.equal(builds, 2, "a URL change rebuilds the snapshot");
  chromeEvents.created.fire({ id: 9 });
  await session.searchProgressively("needle");
  assert.equal(builds, 3, "a created tab rebuilds the snapshot");
  chromeEvents.storage.fire({ inbox: { newValue: {} } }, "local");
  await session.searchProgressively("needle");
  assert.equal(builds, 4, "a saved-store change rebuilds the snapshot");

  // resolveScope/resolveFilters/empty facets also use the fresh Open source.
  openTabs = openC;
  chromeEvents.updated.fire(4, { title: "Other needle" }, openC[3]);
  const facets = await session.emptySuggestionFacets();
  assert.ok(facets.domainCounts.some((entry) => entry.domain === "other.example"),
    "domain facets follow the refreshed Open source");
  assert.equal(builds, 4);
  unbind();
}

/* Without a way to read open tabs, injected builders keep complete invalidation. */
{
  let builds = 0;
  const session = createSearchSession({
    buildSnapshot: async () => { builds += 1; return createSearchSnapshot({ openTabs: openA, ...saved }); }
  });
  await session.search("needle");
  session.invalidate({ kind: "tab-presentation", repaint: false });
  await session.search("needle");
  assert.equal(builds, 2, "no open-tab reader means the whole snapshot is rebuilt");
}

/* A failed open-tab read falls back to a complete rebuild instead of stale rows. */
{
  let builds = 0;
  let fail = true;
  const session = createSearchSession({
    buildPrimarySnapshot: async () => { builds += 1; return createSearchSnapshot({ openTabs: openB, ...saved }); },
    buildCompletionSnapshot: async () => createSearchSnapshot({ openTabs: openB, ...saved }),
    readOpenTabs: async () => { if (fail) throw new Error("tabs unavailable"); return openB; }
  });
  await session.searchProgressively("needle");
  session.invalidate({ kind: "tab-presentation", repaint: false });
  const result = await session.searchProgressively("needle");
  assert.equal(builds, 2, "the failed open read retires the cache and rebuilds once");
  assert.ok(result.results.some((item) => item.tabId === 2));
  fail = false;
  session.invalidate({ kind: "tab-presentation", repaint: false });
  await session.searchProgressively("needle");
  assert.equal(builds, 2, "a later presentation change refreshes Open without rebuilding");
}

/* A complete invalidation during an open refresh wins. */
{
  let openTabs = openA;
  let builds = 0;
  let release;
  const session = createSearchSession({
    buildPrimarySnapshot: async () => { builds += 1; return createSearchSnapshot({ openTabs, ...saved }); },
    buildCompletionSnapshot: async () => createSearchSnapshot({ openTabs, ...saved }),
    readOpenTabs: () => new Promise((resolve) => { release = () => resolve(openTabs); })
  });
  await session.searchProgressively("needle");
  openTabs = openB;
  session.invalidate({ kind: "tab-presentation", repaint: false });
  const pending = session.searchProgressively("needle");
  await new Promise((resolve) => setTimeout(resolve, 0));
  openTabs = openC;
  session.invalidate({ kind: "tab-structure", repaint: true });
  release();
  const result = await pending;
  assert.equal(builds, 2, "the structural change rebuilt the snapshot");
  assert.ok(result.results.some((item) => item.tabId === 4), "results come from the newest build");
}

console.log("PASS: tab presentation changes refresh only the Search Open source");
