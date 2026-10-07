// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Synthetic bundle data and exact observations for installed Inbox hosts. */
import assert from "node:assert/strict";

export const BUNDLE_COUNT = 25;
export const TABS_PER_BUNDLE = 12;
export const INITIAL_ROWS = 8;
export const BUNDLE_PHASES = ["initial", "expanded", "selected", "collapsed", "reexpanded", "folded", "unfolded"];
export const bundleId = index => `inbox-bundle-${String(index).padStart(2, "0")}`;
export const bundleRow = (bundle, tab) => ({ key: `${bundleId(bundle)}::${tab}`,
  title: `Bundle ${String(bundle).padStart(2, "0")} tab ${String(tab).padStart(2, "0")}`,
  url: `https://inbox-bundles.invalid/bundle/${bundle}/tab/${tab}` });

export function makeInboxBundleItems(now = Date.now()) {
  assert.ok(Number.isSafeInteger(now) && now >= 120_000, "fixture clock must be a recent valid timestamp");
  const base = now - 60_000;
  return Object.fromEntries(Array.from({ length: BUNDLE_COUNT }, (_, index) => {
    const id = bundleId(index);
    return [id, { id, deviceId: "bundle-fixture", schemaVersion: 1, kind: "window", source: "manual",
      createdAt: base - index * 1_000,
      // Opposite modified order proves the Inbox's createdAt ordering contract.
      modifiedAt: base + index * 1_000, labels: [],
      tabs: Array.from({ length: TABS_PER_BUNDLE }, (_, tab) => {
        const { title, url } = bundleRow(index, tab);
        return { title, url, labels: [], favIconUrl: "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E" };
      }) }];
  }).reverse());
}

/** Validate every visible identity, disclosure and selection bit. Offscreen rows may still be mounted. */
export function validateInboxBundleObservation(value, { host, width, phase, moreLabel, fewerLabel }) {
  assert.ok(["dashboard.html", "sidepanel.html"].includes(host) && [360, 400].includes(width));
  assert.ok(BUNDLE_PHASES.includes(phase), "known observation phase required");
  assert.ok(typeof moreLabel === "string" && moreLabel.length > 0 && typeof fewerLabel === "string" && fewerLabel.length > 0);
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.equal(value.host, host); assert.equal(value.width, width); assert.equal(value.height, 800);
  assert.equal(value.rootCount, 1); assert.equal(value.sectionDisclosures, 0);
  assert.equal(value.routeActive, true); assert.equal(value.visible, true); assert.equal(value.focused, true);
  for (const scrollWidth of [value.documentScrollWidth, value.bodyScrollWidth]) {
    assert.ok(Number.isFinite(scrollWidth) && scrollWidth > 0 && scrollWidth <= width + 1,
      "narrow host must not have document-level horizontal overflow");
  }
  const fits = ({ left, right }) => Number.isFinite(left) && Number.isFinite(right) &&
    right > left && left >= -1 && right <= width + 1;
  assert.equal(value.cards.length, BUNDLE_COUNT, "all 25 cards must be present, including those past the former cap");
  const selectedPhase = !["initial", "expanded"].includes(phase);
  let rowCount = 0;
  for (let bundle = 0; bundle < BUNDLE_COUNT; bundle++) {
    const card = value.cards[bundle], last = bundle === BUNDLE_COUNT - 1;
    const folded = phase === "folded" && last;
    const capped = phase === "initial" || (phase === "collapsed" && last);
    const count = folded ? 0 : capped ? INITIAL_ROWS : TABS_PER_BUNDLE;
    assert.equal(card.id, bundleId(bundle), "creation order and card identities are exact");
    assert.equal(card.rendered, true); assert.equal(card.foldExpanded, !folded);
    assert.ok(fits(card), "every card fits the narrow viewport horizontally");
    assert.equal(card.rows.length, count, "each card has the exact disclosed row count");
    for (let tab = 0; tab < count; tab++) {
      const selected = selectedPhase && ((bundle === 0 && tab === 0) || (last && tab === TABS_PER_BUNDLE - 1));
      const { left, right, ...row } = card.rows[tab];
      assert.ok(fits({ left, right }), "every mounted row fits the narrow viewport horizontally");
      assert.deepEqual(row, { ...bundleRow(bundle, tab), selected, checked: selected,
        checkboxEnabled: true, rendered: true }, "row identity, content, order and checkbox/class agreement are exact");
    }
    assert.deepEqual(card.disclosures, folded ? [] : [{ key: bundleId(bundle), expanded: !capped,
      label: capped ? moreLabel : fewerLabel, controlsOwnRows: true, enabled: true }],
    "disclosure count, hidden-row wording and accessible ownership must match its actual body");
    rowCount += count;
  }
  assert.equal(value.rowCount, rowCount, "no extra rows can live outside observed cards");
  return value;
}
