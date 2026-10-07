// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { BUNDLE_PHASES, makeInboxBundleItems, validateInboxBundleObservation } from "./installed-inbox-bundles.mjs";

const options = (phase = "initial", host = "dashboard.html", width = 360) =>
  ({ phase, host, width, moreLabel: "Show 4 more", fewerLabel: "Show fewer" });
// Deliberately construct observed examples independently of the exported data builders.
function observation(phase = "initial", host = "dashboard.html", width = 360) {
  const cards = Array.from({ length: 25 }, (_, index) => {
    const id = `inbox-bundle-${String(index).padStart(2, "0")}`;
    const folded = phase === "folded" && index === 24;
    const capped = phase === "initial" || (phase === "collapsed" && index === 24);
    const count = folded ? 0 : capped ? 8 : 12;
    return { id, rendered: true, foldExpanded: !folded, left: 8, right: width - 8,
      disclosures: folded ? [] : [{ key: id, expanded: !capped, label: capped ? "Show 4 more" : "Show fewer",
        controlsOwnRows: true, enabled: true }],
      rows: Array.from({ length: count }, (_, tab) => {
        const selected = !["initial", "expanded"].includes(phase) &&
          ((index === 0 && tab === 0) || (index === 24 && tab === 11));
        return { key: `${id}::${tab}`, title: `Bundle ${String(index).padStart(2, "0")} tab ${String(tab).padStart(2, "0")}`,
          url: `https://inbox-bundles.invalid/bundle/${index}/tab/${tab}`, selected, checked: selected,
          checkboxEnabled: true, rendered: true, left: 12, right: width - 12 };
      }) };
  });
  return { host, width, height: 800, documentScrollWidth: width, bodyScrollWidth: width,
    rootCount: 1, sectionDisclosures: 0, routeActive: true,
    visible: true, focused: true, cards, rowCount: cards.reduce((count, card) => count + card.rows.length, 0) };
}
function rejects(change, phase = "initial") {
  const value = observation(phase); change(value);
  assert.throws(() => validateInboxBundleObservation(value, options(phase)));
}

test("all seven phases, both hosts and both widths use the real validator without mutation", () => {
  for (const phase of BUNDLE_PHASES) for (const host of ["dashboard.html", "sidepanel.html"]) for (const width of [360, 400]) {
    const value = observation(phase, host, width), before = structuredClone(value);
    assert.equal(validateInboxBundleObservation(value, options(phase, host, width)), value);
    assert.deepEqual(value, before);
  }
});
test("fixture uses 300 distinct tabs and opposite creation/modification ordering", () => {
  const now = 1_800_000_000_000;
  const fixture = makeInboxBundleItems(now);
  assert.deepEqual(makeInboxBundleItems(now), fixture, "explicit clock makes fixture deterministic");
  const items = Object.values(fixture).sort((a, b) => b.createdAt - a.createdAt);
  assert.equal(items.length, 25); assert.equal(new Set(items.flatMap(item => item.tabs.map(tab => tab.url))).size, 300);
  assert.equal(items[0].id, "inbox-bundle-00"); assert.equal(items.at(-1).id, "inbox-bundle-24");
  assert(items[0].modifiedAt < items.at(-1).modifiedAt);
  for (const [index, item] of items.entries()) {
    assert.equal(item.createdAt, now - 60_000 - index * 1_000);
    assert.equal(item.modifiedAt, now - 60_000 + index * 1_000);
    assert(item.createdAt >= now - 120_000 && item.createdAt <= item.modifiedAt && item.modifiedAt <= now,
      "recent fixture cannot enter the normal Inbox expiry window");
  }
  const before = Date.now(), defaultFixture = Object.values(makeInboxBundleItems()), after = Date.now();
  assert(defaultFixture.every(item => item.createdAt >= before - 120_000 && item.modifiedAt <= after));
});
test("old section cap, missing/extra/reordered cards and rows fail", () => {
  rejects(value => { value.cards.length = 20; });
  rejects(value => { value.cards.push(value.cards[0]); });
  rejects(value => { value.cards.reverse(); });
  rejects(value => { value.cards[24].rows.pop(); });
  rejects(value => { value.cards[0].rows.reverse(); });
  rejects(value => { value.cards[4].rows[3] = value.cards[4].rows[2]; });
  rejects(value => { value.rowCount++; });
});
test("exact titles, URLs, identity and mounted layout are necessary", () => {
  for (const field of ["key", "title", "url"]) rejects(value => { value.cards[24].rows[7][field] = "wrong"; });
  rejects(value => { value.cards[10].rendered = false; });
  rejects(value => { value.cards[24].rows[7].rendered = false; });
});
test("cards, rows and document reject left or right horizontal overflow at narrow widths", () => {
  for (const key of ["left", "right"]) for (const row of [false, true]) {
    rejects(value => { (row ? value.cards[24].rows[7] : value.cards[24])[key] = key === "left" ? -2 : 362; });
    rejects(value => { (row ? value.cards[24].rows[7] : value.cards[24])[key] = NaN; });
  }
  for (const key of ["documentScrollWidth", "bodyScrollWidth"]) rejects(value => { value[key] = 362; });
});
test("every disclosure requires truthful count, state and unique owned body", () => {
  for (const change of [card => { card.disclosures = []; }, card => { card.disclosures.push(card.disclosures[0]); },
    card => { card.disclosures[0].label = "Show 12 more"; }, card => { card.disclosures[0].expanded = true; },
    card => { card.disclosures[0].expanded = null; },
    card => { card.disclosures[0].controlsOwnRows = false; }, card => { card.disclosures[0].enabled = false; },
    card => { card.disclosures[0].key = "wrong"; }]) rejects(value => change(value.cards[24]));
  rejects(value => { value.sectionDisclosures = 1; });
});
test("endpoint selection must agree in both classes and checkboxes before and after disclosure", () => {
  for (const phase of ["selected", "reexpanded", "unfolded"]) for (const field of ["selected", "checked"]) {
    rejects(value => { value.cards[24].rows[11][field] = false; }, phase);
    rejects(value => { value.cards[0].rows[0][field] = false; }, phase);
    rejects(value => { value.cards[12].rows[5][field] = true; }, phase);
  }
  rejects(value => { value.cards[24].rows[7].checked = true; }, "collapsed");
  rejects(value => { value.cards[24].foldExpanded = true; }, "folded");
  rejects(value => { value.cards[24].foldExpanded = null; }, "folded");
  rejects(value => { value.cards[24].disclosures = observation().cards[24].disclosures; }, "folded");
});
test("wrong host, dimensions, route and hidden documents cannot pass", () => {
  for (const field of ["visible", "focused", "routeActive"]) rejects(value => { value[field] = false; });
  for (const field of ["width", "height", "rootCount"]) rejects(value => { value[field] = 0; });
  rejects(value => { value.host = "popup.html"; });
  assert.throws(() => validateInboxBundleObservation(observation(), options("unknown")));
});
