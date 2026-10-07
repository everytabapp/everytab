/**
 * Memoized presentation helpers must produce exactly what the per-call
 * versions produced: Intl formatters per locale and options, one resolved UI
 * locale per document, cloned icon templates, lazy Archive card fields and
 * positional saved-selection layouts without per-row key strings.
 *
 *     node test/presentation-memoization.mjs   (from extension/)
 */
import assert from "node:assert/strict";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock, getEnglishMessage } from "./message-fixture.mjs";

const dom = installDomFixture();
let localeLookups = 0;
globalThis.chrome = {
  i18n: { getMessage: (key, substitutions) => {
    if (key === "@@ui_locale") localeLookups += 1;
    return getEnglishMessage(key, substitutions);
  } },
  runtime: { getURL: (path) => `chrome-extension://memo/${path}` }
};
void createChromeI18nMock;

const i18n = await import("../js/lib/i18n.js");
const { icon } = await import("../js/ui/icons.js");
const { createTabList, fromArchiveItems } = await import("../js/ui/tablist.js");

/* ---- F6: formatters ---- */
{
  const values = [0, 1, 2, 11, 1234.5, 1_000_000, -7];
  for (const value of values) {
    assert.equal(i18n.formatNumber(value), new Intl.NumberFormat("en").format(value));
    assert.equal(i18n.formatNumber(value, { maximumFractionDigits: 0 }),
      new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value));
    assert.equal(i18n.formatNumber(value, { locale: "de-DE" }),
      new Intl.NumberFormat("de-DE").format(value));
    assert.equal(i18n.pluralCategory(value), new Intl.PluralRules("en").select(value));
    assert.equal(i18n.pluralCategory(value, { type: "ordinal" }),
      new Intl.PluralRules("en", { type: "ordinal" }).select(value));
  }
  const stamp = new Date(Date.UTC(2026, 8, 12, 9, 41));
  const options = { hour: "2-digit", minute: "2-digit", timeZone: "UTC" };
  assert.equal(i18n.formatTime(stamp, options), new Intl.DateTimeFormat("en", options).format(stamp));
  assert.equal(i18n.formatTime(stamp, { ...options, locale: "en-GB" }),
    new Intl.DateTimeFormat("en-GB", options).format(stamp));
  assert.deepEqual(i18n.formatTimeParts(stamp, options),
    new Intl.DateTimeFormat("en", options).formatToParts(stamp));
  assert.equal(i18n.formatDate(stamp, { dateStyle: "medium", timeZone: "UTC" }),
    new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(stamp));
  assert.equal(i18n.formatRelativeTime(-2, "day"),
    new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-2, "day"));
  assert.equal(i18n.formatRelativeTime(3, "hour", { numeric: "always" }),
    new Intl.RelativeTimeFormat("en", { numeric: "always" }).format(3, "hour"));
  assert.equal(i18n.formatList(["a", "b", 3]), new Intl.ListFormat("en").format(["a", "b", "3"]));
  assert.equal(i18n.formatList(["a", "b"], { type: "disjunction" }),
    new Intl.ListFormat("en", { type: "disjunction" }).format(["a", "b"]));
  // Option objects with the same keys in another order still format identically.
  assert.equal(i18n.formatNumber(1234.567, { minimumFractionDigits: 1, maximumFractionDigits: 2 }),
    i18n.formatNumber(1234.567, { maximumFractionDigits: 2, minimumFractionDigits: 1 }));
  // The UI locale was resolved once for this document across every call above.
  assert.equal(localeLookups, 1, "the default UI locale is resolved once per document");
  assert.equal(i18n.uiLocale(), "en");
  assert.equal(i18n.uiLocale((key) => key === "@@ui_locale" ? "fr_CA" : ""), "fr-CA",
    "an explicit lookup is never cached");
  assert.equal(localeLookups, 1);
}

/* ---- F7: icon templates ---- */
{
  const first = icon("labels", 14);
  const second = icon("labels", 20);
  const third = icon("labels");
  assert.notEqual(first, second, "every call returns its own node");
  assert.equal(first.getAttribute("width"), "14");
  assert.equal(second.getAttribute("height"), "20");
  assert.equal(third.getAttribute("width"), "18");
  assert.equal(first.innerHTML, second.innerHTML);
  assert.match(first.innerHTML, /<path/);
  assert.equal(first.getAttribute("stroke-width"), "1.75");
  assert.equal(icon("favorite").getAttribute("stroke-width"), "1.65");
  assert.equal(first.getAttribute("class"), "ic");
  assert.equal(first.getAttribute("aria-hidden"), "true");
  assert.equal(first.getAttribute("viewBox"), "0 0 24 24");
  first.setAttribute("class", "ic changed");
  assert.equal(icon("labels").getAttribute("class"), "ic", "mutating one instance never changes the template");
  assert.equal(icon("missing-name").innerHTML, "", "unknown names keep producing an empty glyph");
  // Minimal documents without cloneNode still get a complete icon.
  const previousDocument = globalThis.document;
  globalThis.document = { createElementNS: () => {
    const attributes = new Map();
    return { setAttribute: (name, value) => attributes.set(name, value), getAttribute: (name) => attributes.get(name) ?? null, innerHTML: "" };
  } };
  try {
    const plain = icon("open", 12);
    assert.equal(plain.getAttribute("width"), "12");
    assert.match(plain.innerHTML, /<rect/);
  } finally {
    globalThis.document = previousDocument;
  }
}

/* ---- F8: lazy Archive card fields ---- */
{
  const now = Date.now();
  const items = [
    { id: "w1", kind: "window", source: "auto-archive", archivedAt: now - 3 * 3600_000, modifiedAt: now,
      labels: ["read"], tabs: [{ url: "https://a.example/1", title: "A" }, { url: "https://b.example/2", title: "B" }] },
    { id: "t1", kind: "tab", source: "dump", modifiedAt: now - 2 * 86400_000, labels: [],
      tabs: [{ url: "https://c.example/3", title: "C" }] }
  ];
  let membershipLookups = 0;
  const groups = fromArchiveItems(items, (url) => { membershipLookups += 1; return url.endsWith("/3") ? [{ id: "s", name: "S" }] : []; });
  assert.equal(membershipLookups, 3, "memberships are resolved eagerly at tab grain");
  assert.deepEqual(Object.keys(groups[0]).sort(), ["chips", "data", "id", "kind", "loose", "meta", "refs", "title"].sort(),
    "lazy fields stay enumerable");
  assert.equal(groups[0].title, "Window · 2 tabs");
  assert.equal(groups[1].title, "Single tab");
  assert.match(groups[0].meta, /^auto-saved · archived 3h/);
  assert.match(groups[1].meta, /^saved · archived 2d/);
  assert.equal(groups[1].refs[0].sessionMemberships[0].name, "S");
  assert.equal(groups[0].refs[0], items[0].tabs[0], "unlabeled refs keep their identity");
  const spread = { ...groups[0] };
  assert.equal(spread.title, "Window · 2 tabs");
  groups[0].title = "Renamed";
  assert.equal(groups[0].title, "Renamed", "assignment replaces a lazy field");
  assert.equal(JSON.parse(JSON.stringify(groups[1])).meta, groups[1].meta);
}

/* ---- F9: positional selection retirement without per-row key strings ---- */
{
  const makeItems = (order) => order.map((suffix, index) => ({
    id: `item-${index}`, kind: "tab", source: "dump", modifiedAt: 1000 + index, labels: [],
    tabs: [{ url: `https://site.example/${suffix}`, title: `Page ${suffix}` }]
  }));
  const render = (items) => createTabList({
    section: "memo-archive", groups: fromArchiveItems(items), selectable: "tab",
    onChange: () => {}, empty: "empty", rowActions: [], groupActions: []
  });
  const root = render(makeItems(["a", "b", "c"]));
  dom.document.body.append(root);
  const rows = root.querySelectorAll("[data-tablist-row]");
  assert.equal(rows.length, 3);
  const checkbox = rows[1].querySelector('.row-select-slot input[type="checkbox"]');
  assert.ok(checkbox, "saved rows expose a selection checkbox");
  checkbox.checked = true;
  await checkbox.dispatch("change", { target: checkbox });
  await rows[1].dispatch("click", { target: checkbox });
  const selectedAfterClick = root.querySelectorAll("[data-tablist-row].sel").length;
  assert.equal(selectedAfterClick, 1, "one positional row is selected");

  // Same layout: the selection survives a re-render.
  const again = render(makeItems(["a", "b", "c"]));
  assert.equal(again.querySelectorAll("[data-tablist-row].sel").length, 1,
    "an unchanged saved layout keeps its positional selection");

  // The carrier changed under the selected position: the selection retires.
  const changed = render(makeItems(["a", "x", "c"]).map((item, index) => index === 1
    ? { ...item, tabs: [{ url: "https://site.example/x", title: "Page x" }] }
    : item));
  assert.equal(changed.querySelectorAll("[data-tablist-row].sel").length, 0,
    "a changed saved layout retires the positional selection conservatively");
  root.remove();
}

dom.restore();
console.log("PASS: memoized formatters, icon templates, lazy Archive fields and positional selection layouts behave identically");
