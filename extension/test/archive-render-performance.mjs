/**
 * Archive shows twenty cards but maps every saved record. Card titles and
 * formatted ages are now computed only for cards that render, and positional
 * selection layouts no longer allocate one key string per saved row.
 *
 * T2 (3,097 Archive records / 10,000 tabs) carries the budget; T3 is printed
 * for information. Node compute with the minimal DOM double: no style, layout
 * or paint cost is included.
 *
 *     node test/archive-render-performance.mjs   (from extension/)
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const dom = installDomFixture();
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  runtime: { getURL: (path) => `chrome-extension://archive-perf/${path}` }
};
const { buildTierData } = await import("../../tools/perf-seed.mjs");
const { STORE_KEYS } = await import("../js/lib/types.js");
const { createTabList, fromArchiveItems } = await import("../js/ui/tablist.js");
const { normalizeUrl } = await import("../js/lib/dedup.js");

function archiveItems(tier) {
  return Object.values(buildTierData(tier).payload.data[STORE_KEYS.archive])
    .filter((item) => !item.deletedAt)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function median(fn, runs = 5) {
  for (let index = 0; index < 2; index += 1) fn();
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(runs / 2)];
}

const render = (items, lookup) => createTabList({
  section: "archive", foldable: true, groups: fromArchiveItems(items, lookup), selectable: "tab",
  onChange: () => {}, empty: "empty", rowActions: [], groupActions: []
});

const rows = [];
let failures = 0;
for (const [tier, budgetMs] of [["t2", 45], ["t3", null]]) {
  const items = archiveItems(tier);
  const memberships = new Map([[normalizeUrl(items[0].tabs[0].url), [{ id: "s1", name: "Session" }]]]);
  const lookup = (url) => memberships.get(normalizeUrl(url));
  const withoutMemberships = median(() => render(items, null));
  const withMemberships = median(() => render(items, lookup));
  const root = render(items, lookup);
  const cards = root.querySelectorAll("[data-tablist-card]").length;
  assert.equal(cards, 20, `${tier}: the Archive list shows its twenty latest cards`);
  const ok = budgetMs == null || withMemberships <= budgetMs;
  if (!ok) failures += 1;
  rows.push({
    tier, records: items.length, visibleCards: cards,
    mapAndListMs: withMemberships.toFixed(2),
    withoutSessionMembershipsMs: withoutMemberships.toFixed(2),
    budgetMs: budgetMs ?? "(info)", result: budgetMs == null ? "-" : ok ? "PASS" : "FAIL"
  });
}

console.log("\nArchive map + list build (Node compute, median of 5)");
console.table(rows);
dom.restore();
if (failures) {
  console.error(`${failures} Archive render budget assertion(s) FAILED`);
  process.exit(1);
}
console.log("PASS: Archive render stays within budget");
