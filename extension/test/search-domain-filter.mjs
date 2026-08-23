import assert from "node:assert/strict";
import { createChromeI18nMock } from "./message-fixture.mjs";

globalThis.chrome = {
  i18n: createChromeI18nMock(),
  history: null,
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: { local: { get: async () => ({}) } },
  tabs: { query: async () => [] }
};

const {
  createSearchSnapshot,
  createSearchSession,
  matchSearchSnapshot,
  parseScope,
  resolveScopeFromSnapshot
} = await import("../js/lib/search.js");
const { omniboxFilterCompletions } = await import("../js/lib/omnibox.js");

const snapshot = createSearchSnapshot({
  openTabs: [
    { id: 1, windowId: 1, title: "Issue", url: "https://github.com/org/repo/issues/1" },
    { id: 2, windowId: 1, title: "Docs", url: "https://docs.github.com/en" },
    { id: 3, windowId: 1, title: "Mail", url: "https://mail.google.com/mail/u/0" }
  ],
  inbox: [{ id: "inbox", tabs: [
    { title: "Repo", url: "https://github.com/org/repo" },
    { title: "Search", url: "https://www.google.com/search?q=tabs" }
  ] }],
  archive: [{ id: "archive", tabs: [
    { title: "GitHub duplicate", url: "https://github.com/org/repo/issues/1" }
  ] }]
});

assert.deepEqual(snapshot.domainCounts, [
  { domain: "github.com", tabs: 4 },
  { domain: "google.com", tabs: 2 }
]);
assert.deepEqual(parseScope("domain:github.com issue"), {
  type: "domain", value: "github.com", query: "issue"
});
assert.deepEqual(resolveScopeFromSnapshot("domain:git", snapshot), {
  scope: { type: "domain", value: "github.com" }, query: ""
});

const github = await matchSearchSnapshot(snapshot, "domain:github.com");
assert.equal(github.length, 3, "domain browse dedupes repeated local URLs");
assert.ok(github.every((result) => new URL(result.url).hostname.endsWith("github.com")));

const narrowed = await matchSearchSnapshot(snapshot, "domain:github.com docs");
assert.deepEqual(narrowed.map((result) => result.title), ["Docs"]);

const session = createSearchSession({ buildSnapshot: async () => snapshot });
assert.deepEqual(await session.scopeNames("domain"), ["github.com", "google.com"]);
assert.equal((await omniboxFilterCompletions("do", (kind) => session.scopeNames(kind)))[0]?.content,
  "domain:github.com");

console.log("PASS: domain: ranks captured domains and filters local results without stored state");
