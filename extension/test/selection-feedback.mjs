import assert from "node:assert/strict";
import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";
import { exerciseSelectionIdentity } from "./selection-identity-cases.js";

const fixture = installDomFixture();
globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://everytab/${path}` },
  i18n: createChromeI18nMock(),
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener() {}, removeListener() {} }
  }
};

try {
  const regressions = [];
  const regressionCheck = (condition, message, detail) => {
    if (!condition) regressions.push(`${message}: ${detail}`);
  };
  const { createTabList, clearSelection } = await import("../js/ui/tablist.js");
  clearSelection("selection-feedback");
  let refreshes = 0;
  const copyAction = () => {
    const button = document.createElement("button");
    button.dataset.bulkAction = "copy";
    button.setAttribute("data-bulk-action", "copy");
    button.setAttribute("data-tip", "Copy the selected tabs as a Markdown link list · C");
    button.textContent = "Copy";
    return button;
  };
  const root = createTabList({
    section: "selection-feedback",
    groups: [1, 2].map((number) => ({
      id: `window-${number}`,
      title: `Window ${number}`,
      meta: "1 tab",
      refs: [{ title: `Immediate feedback ${number}`, url: `https://example-${number}.test` }],
      live: [{ selectable: true }],
      loose: false
    })),
    selectable: "tab",
    rowCap: 10,
    rowActions: [],
    groupActions: [],
    bulkActions: () => [copyAction()],
    onChange: () => {
      refreshes += 1;
      // Real Open refreshes cross asynchronous Chrome/storage boundaries. The
      // old tree must acknowledge the click without waiting for its replacement.
      return new Promise(() => {});
    }
  });
  document.body.append(root);
  const currentRoot = () => document.body.querySelector('[data-tablist="selection-feedback"]');
  let row = currentRoot().querySelectorAll(".trow")[0];
  const checkbox = row.querySelector('input[type="checkbox"]');

  await row.dispatch("click");
  let liveRoot = currentRoot();
  assert.equal(refreshes, 0,
    "selection-only state must not start a Chrome/storage refresh");
  assert.equal(liveRoot.querySelectorAll(".trow")[0].classList.contains("sel"), true,
    "the clicked row paints selected in the same interaction");
  assert.equal(liveRoot.querySelectorAll('.item-head input[type="checkbox"]')[0].checked, true,
    "the owning window checkbox paints selected in the same interaction");
  assert.ok(liveRoot.querySelector('.header-bulk-actions [data-bulk-action="copy"]'),
    "a one-window selection exposes its complete action header immediately");

  row = liveRoot.querySelectorAll(".trow")[1];
  await row.dispatch("click");
  liveRoot = currentRoot();
  assert.equal(refreshes, 0,
    "cross-window selection must remain a local list-state update");
  assert.equal(liveRoot.querySelectorAll(".trow.sel").length, 2,
    "both selected rows remain painted without a flicker handoff");
  const dockCopy = liveRoot.querySelector('.bulk-bar.has-selection [data-bulk-action="copy"]');
  assert.ok(dockCopy, "the cross-window bulk dock appears immediately with Copy as Markdown");
  assert.match(dockCopy.getAttribute("data-tip") ?? "", /Markdown.+C/i,
    "Copy as Markdown uses the shared immediate shortcut tooltip");

  row = liveRoot.querySelectorAll(".trow")[0];
  await row.dispatch("click");
  liveRoot = currentRoot();
  assert.equal(liveRoot.querySelectorAll(".trow.sel").length, 1,
    "deselection updates the surviving selected row without an empty flash");
  assert.equal(liveRoot.querySelectorAll('.item-head input[type="checkbox"]')[0].checked, false,
    "the deselected window checkbox clears immediately");

  // Sessions and Snapshots have a second selection owner for each nested
  // source window. It must use the same local transaction as flat Open/Inbox
  // cards instead of falling back to the external async refresh.
  const nestedSection = "selection-window-header";
  clearSelection(nestedSection);
  let nestedRefreshes = 0;
  const nested = createTabList({
    section: nestedSection,
    groups: [{
      id: "session-1", title: "Session", meta: "2 tabs", loose: false,
      windows: [{
        id: "session-1::0", meta: "Window 1 · 2 tabs",
        refs: [
          { title: "Nested one", url: "https://nested-one.test" },
          { title: "Nested two", url: "https://nested-two.test" }
        ]
      }]
    }],
    selectable: "tab", rowCap: 10, rowActions: [], groupActions: [], windowActions: [],
    bulkActions: () => [copyAction()],
    onChange: () => { nestedRefreshes += 1; return new Promise(() => {}); }
  });
  document.body.append(nested);
  const currentNested = () => document.body.querySelector(`[data-tablist="${nestedSection}"]`);
  let windowCheckbox = currentNested().querySelector(".window-block > .item-head input");
  await windowCheckbox.dispatch("change");
  let liveNested = currentNested();
  assert.equal(nestedRefreshes, 0,
    "nested window selection must not start a Chrome/storage refresh");
  assert.equal(liveNested.querySelectorAll(".trow.sel").length, 2,
    "nested window selection paints every member immediately");
  assert.equal(liveNested.querySelector(":scope > .item .item-head input").checked, true,
    "nested window selection updates its owning card checkbox immediately");
  assert.ok(liveNested.querySelector('.header-bulk-actions [data-bulk-action="copy"]'),
    "nested window selection exposes its card actions immediately");
  windowCheckbox = liveNested.querySelector(".window-block > .item-head input");
  await windowCheckbox.dispatch("change");
  liveNested = currentNested();
  assert.equal(liveNested.querySelectorAll(".trow.sel").length, 0,
    "nested window deselection clears every member immediately");
  assert.equal(nestedRefreshes, 0,
    "nested window deselection remains local");

  const rangeGroups = [{
    id: "range-window", title: "Range window", meta: "3 tabs", loose: false,
    refs: ["one", "two", "three"].map((name) => ({
      title: `Range ${name}`, url: `https://range-${name}.test`
    })),
    live: [1, 2, 3].map(() => ({ selectable: true }))
  }];
  const mountRangeList = (section) => {
    clearSelection(section);
    const list = createTabList({
      section, groups: rangeGroups, selectable: "tab", rowCap: 10,
      rowActions: [], groupActions: [], bulkActions: () => [copyAction()], onChange: () => {}
    });
    document.body.append(list);
    return list;
  };

  const pointerRange = mountRangeList("selection-shift-click");
  let pointerRows = pointerRange.querySelectorAll(".trow");
  await pointerRows[0].dispatch("click");
  pointerRows = pointerRange.querySelectorAll(".trow");
  await pointerRows[2].dispatch("click", { shiftKey: true, target: pointerRows[2] });
  regressionCheck(pointerRange.querySelectorAll(".trow.sel").length === 3,
    "Shift+Click selects the complete visual range from the current anchor",
    `${pointerRange.querySelectorAll(".trow.sel").length} of 3 selected`);

  const keyboardRange = mountRangeList("selection-shift-x");
  let keyboardRows = keyboardRange.querySelectorAll(".trow");
  await keyboardRows[0].dispatch("click");
  keyboardRows = keyboardRange.querySelectorAll(".trow");
  keyboardRows[2].focus();
  await document.dispatch("keydown", {
    target: keyboardRows[2], key: "X", shiftKey: true
  });
  regressionCheck(keyboardRange.querySelectorAll(".trow.sel").length === 3,
    "Shift+X selects the complete visual range from the current anchor",
    `${keyboardRange.querySelectorAll(".trow.sel").length} of 3 selected`);

  let sessionSelection = null;
  const sessionSection = "selection-session-payload";
  clearSelection(sessionSection);
  const sessionList = createTabList({
    section: sessionSection, groups: rangeGroups, selectable: "tab", rowCap: 10,
    rowActions: [], groupActions: [],
    bulkActions: (ctx) => {
      const button = document.createElement("button");
      button.dataset.bulkAction = "session";
      button.setAttribute("data-bulk-action", "session");
      button.textContent = "Session";
      button.addEventListener("click", () => {
        sessionSelection = ctx.selection.map((entry) => [...entry.indexes]);
      });
      return [button];
    },
    onChange: () => {}
  });
  document.body.append(sessionList);
  let sessionRows = sessionList.querySelectorAll(".trow");
  await sessionRows[0].dispatch("click");
  sessionRows = sessionList.querySelectorAll(".trow");
  await sessionRows[1].dispatch("click");
  const sessionButton = sessionList.querySelector('.header-bulk-actions [data-bulk-action="session"]');
  await sessionButton.dispatch("click");
  regressionCheck(JSON.stringify(sessionSelection) === JSON.stringify([[0, 1]]),
    "a mounted Session action receives every tab currently selected in its window",
    JSON.stringify(sessionSelection));

  assert.deepEqual(regressions, []);

  const identityHost = document.createElement("div");
  document.body.append(identityHost);
  await exerciseSelectionIdentity({ host: identityHost, click: (node) => node.dispatch("click") });

  console.log("PASS: selection feedback, ranges, saved identities and mounted bulk payloads stay current");
} finally {
  fixture.restore();
}
