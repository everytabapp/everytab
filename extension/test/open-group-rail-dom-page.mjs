import { clearSelection, createTabList } from "../js/ui/tablist.js";
import { createBrowserI18nMock } from "./browser-message-fixture.js";

globalThis.chrome = { i18n: await createBrowserI18nMock() };

const params = new URLSearchParams(location.search);
const scheme = params.get("scheme") || "cream";
const mode = params.get("mode") || "light";
document.documentElement.dataset.scheme = scheme;
document.documentElement.dataset.mode = mode;
document.querySelector("#scheme-name").textContent = `${scheme} · ${mode}`;

const refs = [
  ["Roadmap – Q4 priorities", "https://example.test/roadmap"],
  ["Product metrics", "https://example.test/metrics"],
  ["Launch checklist", "https://example.test/checklist"],
  ["Design critique notes", "https://example.test/critique"],
  ["Interface references", "https://example.test/references"],
  ["Untitled grouped research", "https://example.test/research"],
  ["Reading list", "https://example.test/reading"],
  ["EveryTab documentation", "https://example.test/docs"]
].map(([title, url]) => ({ title, url }));

const live = [
  { tabGroup: { id: 31, title: "Project Atlas", color: "blue" } },
  { tabGroup: { id: 31, title: "Project Atlas", color: "blue" } },
  { tabGroup: { id: 31, title: "Project Atlas", color: "blue" } },
  { tabGroup: { id: 47, title: "Design review", color: "yellow" } },
  { tabGroup: { id: 47, title: "Design review", color: "yellow" } },
  { tabGroup: { id: 52 } },
  { tabGroup: { id: 52 } },
  {}
].map((group, index) => ({
  tabId: index + 1,
  windowId: 9,
  chromeIndex: index,
  selectable: true,
  ...group
}));

const group = {
  id: "9",
  title: "Window 1",
  badge: "current window",
  meta: "8 tabs",
  refs,
  live,
  loose: false,
  data: { id: 9 }
};

const root = createTabList({
  section: "open",
  groups: [group],
  selectable: "tab",
  rowCap: 50,
  rowActions: [
    ["star", "Star", "star"], ["inbox", "Inbox", "inbox"],
    ["session", "Session", "sessions"],
    ["label", "Label", "labels"], ["snooze", "Snooze", "moon"],
    ["protect", "Protect", "shield"], ["suspend", "Suspend", "suspend"],
    ["close", "Close", "close"]
  ].map(([id, label, icon]) => ({ id, label, icon, run: () => {} })),
  groupActions: [],
  rowGroup: (candidate, index) => candidate.live[index]?.tabGroup ?? null,
  rowGroupSupplement: (candidate) => {
    if (candidate.named) return null;
    const button = document.createElement("button");
    button.className = "mini2 tip open-tab-group-access";
    button.title = "Allow access to show this tab group's name and preserve groups in Sessions";
    button.textContent = "Show group names";
    return button;
  },
  onChange: () => {}
});
document.querySelector("#fixture").replaceChildren(root);
root.querySelector('[data-live-tab-group="31"].trow')?.classList.add("kbd-reveal");

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

const heads = [...root.querySelectorAll(".open-tab-group-head")];
const blueRow = root.querySelector('[data-live-tab-group="31"].trow');
const lastBlueRow = root.querySelector('[data-live-tab-group="31"][data-live-tab-group-end].trow');
const looseRow = [...root.querySelectorAll(".trow")].at(-1);
const railStyle = getComputedStyle(blueRow, "::after");
const headRailStyle = getComputedStyle(heads[0], "::after");
const lastRailStyle = getComputedStyle(lastBlueRow, "::after");
const nameRect = heads[0].querySelector(".open-tab-group-name").getBoundingClientRect();
const headRect = heads[0].getBoundingClientRect();
// Compare the rendered text itself. The grid lane's box includes its own
// internal alignment and used to conceal the exact 10px visual offset reported
// at non-default browser zoom.
const rowUrlRect = blueRow.querySelector(".t a").getBoundingClientRect();
const actionButtons = [...blueRow.querySelectorAll(".tacts button")];
const lastActionRect = actionButtons.at(-1)?.getBoundingClientRect();
const railLeft = blueRow.getBoundingClientRect().right - 10;
const accentProbe = document.createElement("i");
accentProbe.style.background = "var(--accent)";
document.body.append(accentProbe);
const accent = getComputedStyle(accentProbe).backgroundColor;
accentProbe.remove();

check(heads.length === 3, "Expected three group headers");
check(!heads[0].querySelector("button, input, a") && !heads[1].querySelector("button, input, a") &&
  heads[2].querySelectorAll(".open-tab-group-access").length === 1,
"Only the unnamed group carries its contextual access action");
check(heads.every((head) => !head.querySelector(".open-tab-group-dot, .open-tab-group-rule")),
  "Group headers must not paint a dot or horizontal rule");
check(heads[0].textContent.includes("Tab group: Project Atlas") &&
  heads[0].textContent.includes("3 tabs"), "Named group heading is incomplete");
check(railStyle.backgroundColor === accent && headRailStyle.backgroundColor === accent,
  `Rail did not use the scheme accent: ${railStyle.backgroundColor} / ${accent}`);
check(railStyle.right === "8px" && headRailStyle.right === "8px",
  `Rail did not stay in the right edge lane: ${railStyle.right} / ${headRailStyle.right}`);
check(headRailStyle.top === "0px" && lastRailStyle.bottom === "0px",
  "Rail must begin at the header top and reach the end of the final tab");
check(Math.abs(nameRect.left - rowUrlRect.left) <= 2,
  `Group name did not align with its tab URL: ${nameRect.left}px / ${rowUrlRect.left}px ` +
  `(head ${heads[0].getBoundingClientRect().left}px, row ${blueRow.getBoundingClientRect().left}px, ` +
  `copy ${heads[0].querySelector(".open-tab-group-copy").getBoundingClientRect().left}px, ` +
  `row-copy ${blueRow.querySelector(".row-copy").getBoundingClientRect().left}px, ` +
  `grid ${getComputedStyle(blueRow).gridTemplateColumns}, gap ${getComputedStyle(blueRow).columnGap})`);
check(actionButtons.length === 8 && lastActionRect.right <= railLeft - 3,
  `Group rail collided with the exposed row actions: ${lastActionRect?.right}px / ${railLeft}px`);
check(looseRow && !looseRow.hasAttribute("data-live-tab-group"),
  "Ungrouped rows must remain visually ungrouped");
const groupAccess = heads[2].querySelector(".open-tab-group-access");
const groupAccessTop = heads[2].getBoundingClientRect().top;
blueRow.click();
check(groupAccess?.isConnected && heads[2].getBoundingClientRect().top === groupAccessTop,
  "Selecting a row removed or shifted the contextual group-access action");

const rangeGroup = {
  id: "range-window", title: "Range window", meta: "3 tabs", loose: false,
  refs: ["one", "two", "three"].map((name) => ({
    title: `Range ${name}`, url: `https://range-${name}.example.test`
  })),
  live: [1, 2, 3].map(() => ({ selectable: true }))
};
const mountRangeProbe = (section, onSession) => {
  clearSelection(section);
  const probe = createTabList({
    section, groups: [rangeGroup], selectable: "tab", rowCap: 10,
    rowActions: [], groupActions: [],
    bulkActions: (ctx) => {
      const button = document.createElement("button");
      button.dataset.bulkAction = "session";
      button.textContent = "Session";
      button.onclick = () => onSession?.(ctx.selection);
      return [button];
    },
    onChange: () => {}
  });
  Object.assign(probe.style, { position: "fixed", insetInlineStart: "-10000px" });
  document.body.append(probe);
  return probe;
};

let mountedSessionSelection = null;
const pointerRange = mountRangeProbe("selection-range-pointer", (selection) => {
  mountedSessionSelection = selection.map((entry) => [...entry.indexes]);
});
let pointerRangeRows = pointerRange.querySelectorAll(".trow");
pointerRangeRows[0].click();
pointerRangeRows = pointerRange.querySelectorAll(".trow");
pointerRangeRows[2].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
check(pointerRange.querySelectorAll(".trow.sel").length === 3,
  "Mounted Shift+Click did not select the complete visual range");
pointerRange.querySelector('.header-bulk-actions [data-bulk-action="session"]')?.click();
check(JSON.stringify(mountedSessionSelection) === JSON.stringify([[0, 1, 2]]),
  `Mounted Session action received a stale selection: ${JSON.stringify(mountedSessionSelection)}`);

const keyboardRange = mountRangeProbe("selection-range-keyboard");
let keyboardRangeRows = keyboardRange.querySelectorAll(".trow");
keyboardRangeRows[0].click();
keyboardRangeRows = keyboardRange.querySelectorAll(".trow");
const keyboardTarget = keyboardRangeRows[2].querySelector('input[type="checkbox"]');
keyboardTarget.focus();
keyboardTarget.dispatchEvent(new KeyboardEvent("keydown", {
  key: "X", shiftKey: true, bubbles: true
}));
check(keyboardRange.querySelectorAll(".trow.sel").length === 3,
  "Mounted Shift+X did not select the complete visual range");
pointerRange.remove();
keyboardRange.remove();

// Exercise the complete perceived-latency regression in an actual browser
// realm. Hold the canonical refresh unresolved and require row paint, owning
// header actions, and the cross-window keeper to commit in the click dispatch.
const selectionSection = `selection-feedback-${scheme}-${mode}`;
clearSelection(selectionSection);
let externalRefreshes = 0;
const copyAction = () => {
  const button = document.createElement("button");
  button.className = "tip";
  button.dataset.bulkAction = "copy";
  button.title = "Copy the selected tabs as a Markdown link list";
  button.setAttribute("aria-label", button.title);
  button.textContent = "Copy";
  return button;
};
const selectionProbe = createTabList({
  section: selectionSection,
  groups: [1, 2].map((number) => ({
    id: `probe-window-${number}`, title: `Probe ${number}`, meta: "1 tab", loose: false,
    refs: [{ title: `Selection probe ${number}`, url: `https://selection-${number}.example.test` }],
    live: [{ selectable: true }]
  })),
  selectable: "tab", rowCap: 2, rowActions: [],
  groupActions: [{ id: "copy", label: "Copy", key: "c", run: () => {} }],
  bulkActions: () => [copyAction()],
  onChange: () => {
    externalRefreshes += 1;
    return new Promise(() => {});
  }
});
Object.assign(selectionProbe.style, { position: "fixed", insetInlineStart: "-10000px" });
document.body.append(selectionProbe);
const currentSelectionRoot = () => document.querySelector(`[data-tablist="${selectionSection}"]`);
let selectionRow = currentSelectionRoot().querySelectorAll(".trow")[0];
const firstStarted = performance.now();
selectionRow.click();
const firstSelectionMs = performance.now() - firstStarted;
let currentSelection = currentSelectionRoot();
check(externalRefreshes === 0, "Selection started a Chrome/storage refresh");
check(currentSelection.querySelectorAll(".trow")[0].classList.contains("sel"),
  "Clicked row did not paint selected in the same transaction");
check(currentSelection.querySelectorAll('.item-head input[type="checkbox"]')[0].checked,
  "Owning window did not paint selected in the same transaction");
check(Boolean(currentSelection.querySelector('.header-bulk-actions [data-bulk-action="copy"]')),
  "Owning-window actions did not appear in the same transaction");

selectionRow = currentSelection.querySelectorAll(".trow")[1];
const secondStarted = performance.now();
selectionRow.click();
const crossWindowSelectionMs = performance.now() - secondStarted;
currentSelection = currentSelectionRoot();
check(externalRefreshes === 0, "Cross-window selection started a Chrome/storage refresh");
check(currentSelection.querySelectorAll(".trow.sel").length === 2,
  "Cross-window selection lost a selected row");
const dockCopy = currentSelection.querySelector('.bulk-bar.has-selection [data-bulk-action="copy"]');
check(Boolean(dockCopy), "Cross-window bulk dock did not appear in the same transaction");
check(/Markdown.+\(C\)/i.test(dockCopy?.getAttribute("title") ?? "") &&
  dockCopy?.dataset.shortcutKey === "c",
  "Bulk Copy did not expose the immediate Markdown shortcut tooltip");

await new Promise((resolve) => setTimeout(resolve, 180));
currentSelection = currentSelectionRoot();
check(externalRefreshes === 0 && currentSelection.querySelectorAll(".trow.sel").length === 2 &&
  Boolean(currentSelection.querySelector('.bulk-bar.has-selection [data-bulk-action="copy"]')),
"Selection state flickered after its immediate commit");

selectionRow = currentSelection.querySelectorAll(".trow")[0];
selectionRow.click();
currentSelection = currentSelectionRoot();
check(currentSelection.querySelectorAll(".trow.sel").length === 1 &&
  !currentSelection.querySelectorAll('.item-head input[type="checkbox"]')[0].checked,
"Deselection did not update the row and owning window in one transaction");
currentSelection.remove();

// Dashboard can mount its complete 300-row initial budget. Keep the same local
// transaction under that realistic upper bound so the fix cannot regress into
// a correct-but-sluggish full data refresh.
const largeSection = `selection-budget-${scheme}-${mode}`;
clearSelection(largeSection);
const largeGroups = Array.from({ length: 90 }, (_, windowIndex) => ({
  id: `large-window-${windowIndex}`,
  title: `Large window ${windowIndex + 1}`,
  meta: "4 tabs",
  loose: false,
  refs: Array.from({ length: 4 }, (_, tabIndex) => ({
    title: `Budget tab ${windowIndex + 1}.${tabIndex + 1}`,
    url: `https://budget-${windowIndex}-${tabIndex}.example.test`
  })),
  live: Array.from({ length: 4 }, () => ({ selectable: true }))
}));
const largeProbe = createTabList({
  section: largeSection,
  groups: largeGroups,
  selectable: "tab",
  rowCap: 50,
  initialRowBudget: 300,
  groupCap: 100,
  rowActions: ["star", "inbox", "session", "label", "snooze", "protect", "suspend", "close"]
    .map((id) => ({ id, label: id, run: () => {} })),
  groupActions: ["inbox", "session", "label", "copy", "snooze", "protect", "suspend", "close"]
    .map((id) => ({ id, label: id, key: id === "copy" ? "c" : null, run: () => {} })),
  bulkActions: () => [copyAction()],
  onChange: () => { externalRefreshes += 1; return new Promise(() => {}); }
});
Object.assign(largeProbe.style, { position: "fixed", insetInlineStart: "-10000px", width: "980px" });
document.body.append(largeProbe);
const largeStarted = performance.now();
largeProbe.querySelector(".trow").click();
const largeSelectionMs = performance.now() - largeStarted;
const currentLarge = document.querySelector(`[data-tablist="${largeSection}"]`);
check(currentLarge.querySelectorAll(".trow").length === 300 &&
  currentLarge.querySelectorAll("[data-tablist-card]").length === 90 &&
  currentLarge.querySelectorAll(".trow.sel").length === 1 &&
  Boolean(currentLarge.querySelector(".header-bulk-actions")),
"A 300-row Dashboard budget did not commit selection and its header atomically");
check(largeSelectionMs < 12,
  `A 300-row selection transaction exceeded the 12ms response budget: ${largeSelectionMs.toFixed(2)}ms`);
currentLarge.remove();

const result = document.querySelector("#result");
result.dataset.status = failures.length ? "fail" : "pass";
result.dataset.firstSelectionMs = firstSelectionMs.toFixed(2);
result.dataset.crossWindowSelectionMs = crossWindowSelectionMs.toFixed(2);
result.dataset.largeSelectionMs = largeSelectionMs.toFixed(2);
result.textContent = failures.length
  ? `FAIL: ${failures.join("\n")}`
  : `PASS: ${scheme}/${mode} group rail and atomic selection (${firstSelectionMs.toFixed(2)}ms / ${crossWindowSelectionMs.toFixed(2)}ms / 300 rows ${largeSelectionMs.toFixed(2)}ms)`;
