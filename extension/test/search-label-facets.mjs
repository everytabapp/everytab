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
  matchSearchSnapshot,
  resolveSearchFiltersFromSnapshot
} = await import("../js/lib/search.js");

const snapshot = createSearchSnapshot({
  inbox: [{ id: "inbox", tabs: [
    { title: "Roadmap", url: "https://example.com/roadmap", labels: ["Work", "Urgent"] },
    { title: "Notes", url: "https://example.com/notes", labels: ["Work"] },
    { title: "Launch brief", url: "https://example.com/launch", labels: ["Client Work", "Urgent"] }
  ] }],
  archive: [{ id: "archive", tabs: [
    { title: "Old roadmap", url: "https://example.com/old", labels: ["Work", "Urgent"] }
  ] }],
  sessions: [{
    id: "session", name: "Project", windows: [[
      { title: "Session roadmap", url: "https://example.com/session", labels: ["Work", "Urgent"] }
    ]]
  }]
});

assert.deepEqual(
  resolveSearchFiltersFromSnapshot("label:Work label:Urgent roadmap", snapshot),
  { scope: null, labels: ["Work", "Urgent"], query: "roadmap" },
  "repeated labels become independent AND facets"
);
assert.deepEqual(
  resolveSearchFiltersFromSnapshot("in:archive label:Work label:Urgent", snapshot),
  { scope: { type: "in", value: "archive" }, labels: ["Work", "Urgent"], query: "" },
  "one source scope composes with repeated labels"
);
assert.deepEqual(
  resolveSearchFiltersFromSnapshot("label:Client Work label:Urgent", snapshot),
  { scope: null, labels: ["Client Work", "Urgent"], query: "" },
  "the longest known multiword label wins"
);

const browse = await matchSearchSnapshot(snapshot, "label:Work label:Urgent");
assert.deepEqual(browse.map((result) => result.title), [
  "Roadmap", "Old roadmap", "Session roadmap"
], "empty text browses the deduplicated intersection across saved sources");

const narrowed = await matchSearchSnapshot(snapshot, "label:Work label:Urgent old");
assert.deepEqual(narrowed.map((result) => result.title), ["Old roadmap"],
  "ordinary text narrows an active label intersection");

const oneCharacter = await matchSearchSnapshot(snapshot, "r", {
  labels: ["Work", "Urgent"]
});
assert.deepEqual(oneCharacter.map((result) => result.title), [
  "Roadmap", "Old roadmap", "Session roadmap"
], "one typed character narrows an established facet instead of clearing it");

const archiveOnly = await matchSearchSnapshot(snapshot,
  "in:archive label:Work label:Urgent");
assert.deepEqual(archiveOnly.map((result) => result.title), ["Old roadmap"],
  "source and label filters compose without widening either one");

const explicit = await matchSearchSnapshot(snapshot, "roadmap", {
  labels: ["Work", "Urgent"]
});
assert.deepEqual(explicit.map((result) => result.title), [
  "Roadmap", "Old roadmap", "Session roadmap"
], "the shared UI can pass selected labels without serializing them into text");

const legacy = await matchSearchSnapshot(snapshot, "", {
  scope: { type: "label", value: "Work" }
});
assert.equal(legacy.length, 4, "the original single-label scope remains compatible");

console.log("PASS: Search label facets combine with AND and preserve source/text filters");
