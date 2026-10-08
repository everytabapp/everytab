import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { installBrowserMapStorageAuthority } from "./storage-authority-fixture.mjs";

const dom = installDomFixture();
const item = {
  id: "label-ui", createdAt: 1, modifiedAt: 1, deviceId: "test", schemaVersion: 1,
  kind: "window", labels: [], tabs: [
    { url: "https://one.example/", title: "One", labels: ["work", "keep"] },
    { url: "https://two.example/", title: "Two", labels: ["work"] }
  ]
};
const storage = createInterleavableStorage({ inbox: { [item.id]: item }, journal: [] });
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  runtime: { getURL: path => `chrome-extension://test/${path}` },
  storage: { local: storage.local, onChanged: storage.onChanged }
};
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: createMockLockManager() } });
installBrowserMapStorageAuthority();
const { buildLabelsListConfig, buildOpenListConfig } = await import("../js/ui/list-configs.js");
const { starredRowAction } = await import("../js/ui/starred-button.js");
const { listActions, undoActionResult } = await import("../js/lib/journal.js");
let cleared = 0, refreshed = 0;
const notices = [], copied = [];
let applyPickedLabels;
const group = {
  id: "label::work", refs: item.tabs,
  data: { label: "work", locs: item.tabs.map((_, i) => ({ store: "inbox", item, i })) }
};
const config = buildLabelsListConfig({
  data: { groups: [group] }, renderLabels() {}, refreshLabelViews() { refreshed++; },
  showNotice: message => notices.push(message), copyRefs: refs => copied.push(refs),
  cardLabelPanel: (apply) => { applyPickedLabels = apply; return document.createElement("div"); }
});
const context = { selection: [{ group, indexes: [0, 1] }], clear() { cleared++; },
  panel: { toggle: make => make() } };
try {
  assert.equal(starredRowAction().key, "b",
    "b activates the focused row's Star control like a bookmark key");
  const openConfig = buildOpenListConfig({
    data: { groups: [], bindings: {}, sessionsById: new Map(), simpleWindows: [] },
    rowCap: 8, msg: async () => ({}), renderOpen() {}, renderArchive() {}, renderLabels() {}
  });
  assert.equal(openConfig.rowActions.find((action) => action.id === "close")?.key, "w",
    "w arms the recoverable Close-tab action, separate from browser Command+W");
  assert.equal(config.selectable, "tab", "Labels exposes shared tab selection");
  const actions = config.bulkActions(context);
  for (const button of actions) {
    assert.ok(button.querySelector(".action-icon"));
    assert.ok(button.querySelector(".action-label"));
    assert.ok(button.getAttribute("aria-label"));
  }
  await actions.find(button => button.dataset.bulkAction === "copy").dispatch("click");
  assert.deepEqual(copied[0], item.tabs);
  const remove = actions.find(button => button.dataset.bulkAction === "delete");
  await Promise.all([remove.dispatch("click"), remove.dispatch("click")]);
  assert.equal(cleared, 1, "rapid repeat activation commits once");
  assert.equal(refreshed, 1);
  assert.equal(remove.disabled, false);
  assert.deepEqual(storage.snapshot().inbox[item.id].tabs.map(tab => tab.labels), [["keep"], []]);
  const entries = await listActions();
  assert.equal(entries.length, 1);
  await undoActionResult(entries[0].id);
  assert.deepEqual(storage.snapshot().inbox[item.id].tabs, item.tabs);

  await storage.local.set({ inbox: { [item.id]: { ...item, tabs: [...item.tabs].reverse() } } });
  await remove.dispatch("click");
  assert.equal(cleared, 1, "stale refusal keeps selection");
  assert.equal(refreshed, 1);
  assert.ok(notices.at(-1));
  assert.equal(remove.disabled, false);

  const intersection = { ...group, data: { ...group.data, combined: true, labels: ["work", "keep"] } };
  assert.deepEqual(config.bulkActions({ selection: [{ group: intersection, indexes: [0] }] })
    .map(button => button.dataset.bulkAction), ["copy", "label"], "intersection permits additions but never ambiguous removal");

  await storage.local.set({ inbox: { [item.id]: item } });
  await actions.find(button => button.dataset.bulkAction === "label").dispatch("click");
  assert.equal(typeof applyPickedLabels, "function", "bulk Label opens the shared picker");
  await applyPickedLabels(["added"]);
  assert.equal(cleared, 2);
  assert.equal(refreshed, 2);
  assert.deepEqual(storage.snapshot().inbox[item.id].tabs.map(tab => tab.labels), [["work", "keep", "added"], ["work", "added"]]);
  const addEntry = (await listActions())[0];
  await undoActionResult(addEntry.id);
  assert.deepEqual(storage.snapshot().inbox[item.id].tabs, item.tabs);
  await storage.local.set({ inbox: { [item.id]: { ...item, tabs: [...item.tabs].reverse() } } });
  await assert.rejects(applyPickedLabels(["stale-add"]));
  assert.equal(cleared, 2, "failed bulk Label keeps selection and rejects so the picker stays open");
  assert.equal(refreshed, 2);

  // Source contracts for CSS-only behavior; these are not rendered pixel tests.
  const css = readFileSync(new URL("../css/tablist-d4.css", import.meta.url), "utf8");
  assert.match(css, /\.automation-awareness-inbox\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/);
  assert.match(css, /\.item:is\(:hover, :focus-within, \.palette-source\) \.automation-awareness-inbox\s*\{[^}]*opacity:\s*1;/);
  assert.match(css, /@media \(hover: none\)\s*\{[^}]*\.automation-awareness-inbox\s*\{[^}]*opacity:\s*1;/);
  // The row trigger's base rule is scoped under .row-subline; on touch screens
  // the reveal must match that specificity or the Open status stays invisible.
  assert.match(css, /@media \(hover: none\)\s*\{[^}]*\.tablist \.row-subline > \.automation-awareness-row,[^{]*\{[^}]*opacity:\s*1;/);
  // The final-edge rule counts a wrapped Activity entry as a row, so an entry
  // with a recorded tab list neither loses nor doubles the ledger edge.
  assert.match(css, /\.trow:not\(:has\(~ \.trow, ~ \.disclosure-row, ~ \.activity-entry\)\)[^{]+\{\s*border-bottom-width:\s*0;/);
  assert.match(css, /\.activity-entry:not\(:has\(~ \.trow, ~ \.activity-entry\)\)[^{]+\{\s*border-bottom-width:\s*0;/);
  const dropCss = readFileSync(new URL("../css/primitives.css", import.meta.url), "utf8");
  assert.match(dropCss, /\.drop-zone-window-end\.on::before,[^{]+\{[^}]*height:\s*3px;[^}]*background:\s*var\(--accent\)/);
  console.log("PASS: Labels selection, exact removal/Undo, refusal, shared icons and CSS contracts");
} finally {
  dom.restore();
}
