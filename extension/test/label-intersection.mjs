import assert from "node:assert/strict";

const { intersectLabelGroups } = await import("../js/lib/labels.js");

const item = { id: "item", name: "Saved" };
const other = { id: "other", name: "Other" };
const roadmap = { title: "Roadmap", url: "https://example.com/roadmap" };
const notes = { title: "Notes", url: "https://example.com/notes" };

const groups = [
  { label: "Work", entries: [
    { store: "tvInbox", item, tabs: [
      { wi: null, i: 0, ref: roadmap },
      { wi: null, i: 1, ref: notes }
    ] }
  ] },
  { label: "Urgent", entries: [
    { store: "tvInbox", item, tabs: [{ wi: null, i: 0, ref: roadmap }] },
    // Same URL in another record is not the same saved tab occurrence.
    { store: "tvArchive", item: other, tabs: [{ wi: null, i: 0, ref: roadmap }] }
  ] }
];

assert.deepEqual(intersectLabelGroups(groups, ["work", "URGENT"]), {
  labels: ["Work", "Urgent"],
  refs: [roadmap],
  locs: [{ store: "tvInbox", item, wi: null, i: 0 }]
});
assert.deepEqual(intersectLabelGroups(groups, ["missing"]), {
  labels: [], refs: [], locs: []
});

console.log("PASS: Labels intersection is exact, case-insensitive, and occurrence-safe");
