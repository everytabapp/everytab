// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { MIXED_SCENARIOS, WORKLOADS, makeMixedFixture, editedNamedRecord, queryFor,
  expectedMixedRows, expectedMixedDomRows, expectedMixedFacets, assertMixedRows, assertMixedFacets, assertMixedCache }
  from "../../extension/test/native-mixed-search-fixture.mjs";
import { domRowsMatch } from "../../extension/test/native-search-oracles.mjs";

assert.deepEqual(WORKLOADS, ["selective", "broad", "facets"]);
assert.equal(queryFor("selective"), "zebramixed");
assert.equal(queryFor("broad"), "commonfixture");
assert.equal(queryFor("facets"), null);
assert.throws(() => queryFor("other"));
for (const scenario of MIXED_SCENARIOS) {
  const fixture = makeMixedFixture(scenario);
  const allRecords = [...fixture.inbox, ...fixture.named, ...fixture.snapshots];
  const allTabs = allRecords.flatMap(record => record.tabs ?? record.windows.flat());
  assert.equal(fixture.inbox.length, scenario.inboxTabs);
  assert.equal(fixture.named.length, scenario.namedSessions);
  assert.equal(fixture.snapshots.length, scenario.snapshots);
  assert.equal(allTabs.length, scenario.records);
  assert.equal(new Set(allTabs.map(tab => tab.url)).size, scenario.records);
  assert.equal(new Set(allTabs.map(tab => tab.favIconUrl)).size, 64);
  assert.equal(new Set(allTabs.map(tab => new URL(tab.url).hostname)).size, 16);
  assert(allTabs.every(tab => tab.title.includes("commonfixture")));
  assert.equal(allTabs.filter(tab => tab.title.includes("zebramixed")).length, 3);
  assert.equal(new Set(allRecords.map(record => record.modifiedAt)).size, allRecords.length);
  for (const records of [fixture.inbox, fixture.named, fixture.snapshots]) {
    assert(records.every((record, index) => index === 0 || records[index - 1].modifiedAt > record.modifiedAt));
  }
  for (const record of [...fixture.named, ...fixture.snapshots]) {
    assert.deepEqual(record.windows.map(window => window.length), [scenario.tabsPerSession / 2, scenario.tabsPerSession / 2]);
    assert(!/commonfixture|zebramixed/.test(record.name));
  }
  for (const icon of new Set(allTabs.map(tab => tab.favIconUrl))) {
    const decoded = decodeURIComponent(icon.slice(icon.indexOf(",") + 1));
    assert(decoded.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
    assert(decoded.length >= 1_000 && decoded.length < 1_100);
  }

  // A separate enumeration checks the compact count formulas, without Search normalization.
  const counts = new Map();
  const count = label => counts.set(label, (counts.get(label) ?? 0) + 1);
  for (const record of fixture.inbox) for (const tab of record.tabs) {
    for (const label of new Set([...record.labels, ...tab.labels])) count(label);
  }
  for (const record of fixture.named) for (const tab of record.windows.flat()) for (const label of new Set(tab.labels)) count(label);
  const domainCounts = new Map();
  for (const tab of allTabs) {
    const domain = new URL(tab.url).hostname.slice("tabs.".length);
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
  }
  const actualFacets = {
    labels: [...counts].map(([label, tabs]) => ({ label, tabs })).sort((a, b) => a.label.localeCompare(b.label)),
    sessions: fixture.named.map(record => record.name),
    domains: [...domainCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([domain]) => domain)
  };
  assertMixedFacets(actualFacets, expectedMixedFacets(scenario));
  assert(!actualFacets.labels.some(({ label }) => label.startsWith("snapshot") || label === "record-only-ignored"));
  const baseline = structuredClone(fixture.named[0]);
  const edited = editedNamedRecord(fixture);
  assert.deepEqual(fixture.named[0], baseline, "editing never mutates the shared fixture");
  assert.equal(edited.windows[0][0].title, "commonfixture named 000 000 zebramixed revised");
  assert.deepEqual(edited.windows[0][0].labels, ["named-edited", "shared-label"]);
  const exceptEdit = structuredClone(edited);
  exceptEdit.modifiedAt = baseline.modifiedAt;
  exceptEdit.windows[0][0].title = baseline.windows[0][0].title;
  exceptEdit.windows[0][0].labels = baseline.windows[0][0].labels;
  assert.deepEqual(exceptEdit, baseline, "only intended metadata, title and labels change; all favicon bytes remain");
  counts.set("named-label-0", counts.get("named-label-0") - 1);
  counts.set("named-edited", 1);
  assertMixedFacets({ ...actualFacets,
    labels: [...counts].map(([label, tabs]) => ({ label, tabs })).sort((a, b) => a.label.localeCompare(b.label))
  }, expectedMixedFacets(scenario, true));
  const broad = fixture.inbox.slice(0, 50).map(record => ({ type: "inbox", title: record.tabs[0].title, url: record.tabs[0].url }));
  for (const complete of [false, true]) for (const edited of [false, true]) {
    assertMixedRows(broad, expectedMixedRows(scenario, { workload: "broad", complete, edited }));
  }
}

const small = MIXED_SCENARIOS[0];
assert.deepEqual(makeMixedFixture(small), makeMixedFixture(small), "fixture bytes and order are deterministic");
const expected = expectedMixedRows(small, { workload: "selective", complete: true });
assert.deepEqual(expected, [
  { type: "inbox", title: "commonfixture inbox 000 000 zebramixed", url: "https://tabs.fixture05.invalid/inbox/000/000" },
  { type: "session", title: "commonfixture named 000 000 zebramixed", url: "https://tabs.fixture09.invalid/named/000/000", sourceName: "Bundle 000" },
  { type: "session", title: "commonfixture snapshot 000 000 zebramixed", url: "https://tabs.fixture05.invalid/snapshot/000/000",
    sourceName: undefined, sourceCreatedAt: 1_699_999_999_890, snapshot: true }
]);
assert.deepEqual(expectedMixedRows(small, { workload: "selective" }), expected.slice(0, 1));
assert.equal(expectedMixedRows(small, { workload: "selective", complete: true, edited: true })[1].title,
  "commonfixture named 000 000 zebramixed revised");
for (const scenario of MIXED_SCENARIOS) for (const edited of [false, true]) for (const complete of [false, true]) {
  for (const workload of ["selective", "broad"]) {
    const options = { workload, edited, complete };
    const model = expectedMixedRows(scenario, options);
    const visible = expectedMixedDomRows(scenario, options);
    assert.equal(model.length, workload === "broad" ? 50 : complete ? 3 : 1);
    assert.equal(visible.length, workload === "broad" ? 15 : complete ? 3 : 1);
    assert.deepEqual(visible, model.slice(0, 15), "DOM preserves the first model results in exact order");
    const dom = visible.map(({ title, type }) => ({ title, type, role: "option" }));
    assert(domRowsMatch(dom, visible));
    assert(!domRowsMatch(dom.slice(1), visible), "missing displayed rows fail");
    assert(!domRowsMatch([...dom, dom[0]], visible), "extra displayed rows fail");
    if (dom.length > 1) assert(!domRowsMatch([...dom].reverse(), visible), "reordered displayed rows fail");
    if (workload === "broad") assert(!domRowsMatch(model.map(({ title, type }) => ({ title, type, role: "option" })), visible),
      "all 50 model rows cannot masquerade as the 15 displayed rows");
  }
}
assertMixedRows(expected, expected);
for (const damage of [rows => rows.pop(), rows => rows.reverse(), rows => { rows.length++; }, rows => { rows[1] = rows[0]; },
  rows => { delete rows[2].snapshot; }, rows => { rows[2].sourceCreatedAt++; },
  rows => { rows[2].sourceName = "Incorrect named Snapshot"; }, rows => { rows[1].type = "inbox"; },
  rows => { rows[1].url = "https://wrong.invalid/"; }, rows => { rows[1].title += " stale"; },
  rows => { rows[0].unexpected = true; }]) {
  const changed = structuredClone(expected); damage(changed);
  assert.throws(() => assertMixedRows(changed, expected));
}
const facets = expectedMixedFacets(small);
for (const damage of [value => { value.labels[0].tabs++; }, value => value.labels.reverse(),
  value => value.labels.push({ label: "snapshot-only", tabs: 600 }), value => value.sessions.reverse(),
  value => value.domains.reverse(), value => value.sessions.push("Automatic 000"), value => { value.sessions.length++; },
  value => { value.extra = true; }]) {
  const changed = structuredClone(facets); damage(changed);
  assert.throws(() => assertMixedFacets(changed, facets));
}
assert.throws(() => assertMixedFacets(expectedMixedFacets(small, true), facets), "stale facets cannot survive named edit");
assert.throws(() => expectedMixedRows(small, { workload: "facets" }));
assert.throws(() => expectedMixedRows(small, { workload: "unknown" }));
assert.throws(() => editedNamedRecord({ named: [] }));
for (const invalid of [{ ...small, records: 999 }, { ...small, icons: 0 }, { ...small, inboxTabs: 0 },
  { ...small, tabsPerSession: 3 }, { ...small, snapshots: 1.5 }]) assert.throws(() => makeMixedFixture(invalid));
console.log("PASS mixed Search dimensions, exact rows, facet formulas, isolated edit and corruption oracles");

const countCalls = (primary, inbox, sessions, recovery) => ({ calls: [
  ...Array.from({ length: primary }, () => ({ label: "primarySnapshotBuild" })),
  ...Array.from({ length: inbox }, () => ({ label: "libraryFamilyRead", family: "inbox" })),
  ...Array.from({ length: sessions }, () => ({ label: "libraryFamilyRead", family: "sessions" })),
  ...Array.from({ length: recovery }, () => ({ label: "recoverySnapshotRead" }))
], requests: {} });
const cases = [
  ["selective", "first", [1, 1, 1, 1]], ["selective", "warm-immediate", [0, 0, 0, 0]],
  ["selective", "warm-expired", [0, 0, 1, 1]], ["selective", "after-edit", [1, 0, 1, 1]],
  ["broad", "first", [1, 1, 0, 0]], ["broad", "warm-immediate", [0, 0, 0, 0]],
  ["broad", "warm-expired", [0, 0, 0, 0]], ["broad", "after-edit", [1, 0, 0, 0]],
  ["facets", "first", [0, 1, 1, 1]], ["facets", "warm-immediate", [0, 0, 0, 0]],
  ["facets", "warm-expired", [0, 0, 0, 0]], ["facets", "after-edit", [0, 0, 1, 1]]
];
for (const [workload, phase, counts] of cases) {
  const current = countCalls(...counts);
  assertMixedCache(workload, phase, current);
  for (let index = 0; index < counts.length; index++) {
    const wrong = [...counts]; wrong[index] = wrong[index] ? 0 : 1;
    assert.throws(() => assertMixedCache(workload, phase, countCalls(...wrong)), { code: "cache-phase" });
  }
  assert.throws(() => assertMixedCache(workload, phase, { ...current, requests: { "assets.get": 1 } }), { code: "cache-phase" });
  if (phase.startsWith("warm") && counts.every(count => count === 0)) {
    assert.throws(() => assertMixedCache(workload, phase, { ...current, requests: { "entities.getAll": 1 } }), { code: "cache-phase" });
    assert.throws(() => assertMixedCache(workload, phase, { ...current, calls: [{ label: "authorityMapRead" }] }), { code: "cache-phase" });
  }
}
assert.throws(() => assertMixedCache("unknown", "first", countCalls(1, 1, 1, 1)), { code: "cache-phase" });
assert.throws(() => assertMixedCache("selective", "unknown", countCalls(1, 1, 1, 1)), { code: "cache-phase" });
assert.throws(() => assertMixedCache("selective", "first", {}), { code: "cache-phase" });
console.log("PASS independent mixed cache phase table rejects broad completion, expired facet reads, stale edits and asset reads");

// Production integration is separate from the fixture/oracles, which import no ranking code.
const { createSearchSnapshot, matchSearchSnapshot } = await import("../../extension/js/lib/search.js");
for (const scenario of MIXED_SCENARIOS) {
  const fixture = makeMixedFixture(scenario);
  for (const edited of [false, true]) {
    const named = edited ? [editedNamedRecord(fixture), ...fixture.named.slice(1)] : fixture.named;
    const primary = createSearchSnapshot({ inbox: fixture.inbox });
    const complete = createSearchSnapshot({ inbox: fixture.inbox, sessions: [...named, ...fixture.snapshots] });
    for (const workload of ["selective", "broad"]) {
      assertMixedRows(await matchSearchSnapshot(primary, queryFor(workload)), expectedMixedRows(scenario, { workload, edited }));
      assertMixedRows(await matchSearchSnapshot(complete, queryFor(workload)), expectedMixedRows(scenario, { workload, edited, complete: true }));
    }
    assertMixedFacets({ labels: complete.labelCounts, sessions: complete.sessionNames,
      domains: complete.domainCounts.map(item => item.domain) }, expectedMixedFacets(scenario, edited));
  }
}
console.log("PASS independent mixed expectations match production Search normalization, ranking and facet ordering before/after edit");
