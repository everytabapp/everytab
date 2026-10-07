import { clearSelection, createTabList } from "../js/ui/tablist.js";
import { createBrowserI18nMock } from "./browser-message-fixture.js";
import { createAutomationAwareness } from "../js/ui/automation-awareness.js";
import { duplicateIdentityBanner } from "../js/ui/duplicates-surface.js";
import { exerciseSelectionIdentity } from "./selection-identity-cases.js";
import { exerciseUiInteractionSafety } from "./ui-interaction-safety-cases.js";

const interactionMessages = [];
globalThis.chrome = {
  i18n: await createBrowserI18nMock(),
  runtime: { getURL: path => `chrome-extension://fixture/${path}`,
    sendMessage: async message => { interactionMessages.push(message); return { ok: true }; } },
  permissions: { contains: async () => false, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
};

const resultNode = document.querySelector("#result");
const fixture = document.querySelector("#fixture");
const failures = [];
const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const oneFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const automationAwareness = createAutomationAwareness({ openSettings: () => {} });

function check(condition, message, detail = "") {
  if (!condition) failures.push(`${message}${detail ? `: ${detail}` : ""}`);
}

function action(id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mini";
  button.dataset.actionId = id;
  button.textContent = id;
  return button;
}

function geometry(host) {
  return {
    heads: [...host.querySelectorAll(":scope .item-head")]
      .map((node) => Number(node.getBoundingClientRect().height.toFixed(2))),
    rows: [...host.querySelectorAll(":scope .trow")]
      .map((node) => Number(node.getBoundingClientRect().height.toFixed(2)))
  };
}

function sameGeometry(before, after) {
  return before.heads.length === after.heads.length && before.rows.length === after.rows.length &&
    before.heads.every((height, index) => Math.abs(height - after.heads[index]) <= 0.5) &&
    before.rows.every((height, index) => Math.abs(height - after.rows[index]) <= 0.5);
}

async function exercise(surface, listName, width) {
  document.body.dataset.surface = surface === "sidepanel" ? "sidepanel" : "dashboard";
  document.body.dataset.rowInfo = listName === "open" ? "detailed" : "clean";
  fixture.style.width = `${width}px`;
  const section = listName;
  clearSelection(section);
  const groups = [0, 1].map((groupIndex) => ({
    id: `${section}-group-${groupIndex}`,
    title: `${listName === "open" ? "Window" : "Saved window"} ${groupIndex + 1}`,
    meta: "2 tabs",
    refs: [0, 1].map((rowIndex) => ({
      title: `Tab ${groupIndex + 1}.${rowIndex + 1}`,
      url: `https://example-${groupIndex + 1}.test/${rowIndex + 1}`
    }))
  }));
  let host;
  const render = () => {
    host = createTabList({
      section,
      presentation: surface === "sidepanel" ? "compact" : "default",
      groups,
      selectable: "tab",
      rowCap: 10,
      rowActions: ["star", "inbox", "session", "label", "snooze", "close"].map((id) => ({
        id, label: id, render: () => action(id)
      })),
      groupActions: ["inbox", "session", "label", "copy", "snooze", "close"].map((id) => ({
        id, label: id, render: () => action(id)
      })),
      bulkActions: () => ["inbox", "session", "label", "copy", "snooze", "archive", "close", "keep"]
        .map(action),
      rowSupplement: listName === "open"
        ? (ctx) => automationAwareness.row({
          display: "timed", action: "archive", state: "running", reason: null,
          awayAt: Date.now() - 86_400_000, awayMs: 86_400_000,
          afterMs: 3 * 86_400_000, progress: 1 / 3, settingsGroup: "autosave"
        }, ctx.ref.url)
        : null,
      onChange: render
    });
    fixture.replaceChildren(host);
  };

  render();
  // Selection-only transactions replace this list locally without invoking
  // the external `render` callback. Follow the mounted instance after every
  // click so geometry and continuity assertions inspect what users see.
  const clickRowCheckbox = (index) => {
    host.querySelectorAll('.trow input[type="checkbox"]')[index].click();
    host = fixture.querySelector(`[data-tablist="${section}"]`);
  };
  await frame();
  const rest = geometry(host);
  const awarenessBeforeSelection = host.querySelector(".automation-awareness-row");
  if (awarenessBeforeSelection) {
    awarenessBeforeSelection.closest(".trow").classList.add("kbd-reveal");
    await wait(180);
  }
  clickRowCheckbox(0);
  await oneFrame();
  const awarenessAfterSelection = host.querySelector(".automation-awareness-row");
  const selectionAwarenessOpacity = awarenessAfterSelection
    ? Number.parseFloat(getComputedStyle(awarenessAfterSelection).opacity)
    : 0;
  awarenessAfterSelection?.closest(".trow")?.classList.add("kbd-reveal");
  await wait(180);
  clickRowCheckbox(0);
  await oneFrame();
  const awarenessAfterDeselection = host.querySelector(".automation-awareness-row");
  const deselectionAwarenessOpacity = awarenessAfterDeselection
    ? Number.parseFloat(getComputedStyle(awarenessAfterDeselection).opacity)
    : 0;
  awarenessAfterDeselection?.closest(".trow")?.classList.add("kbd-reveal");
  await frame();
  clickRowCheckbox(0);
  await frame();
  const one = geometry(host);
  const oneOwnership = {
    headerButtons: host.querySelectorAll(".header-bulk-actions button").length,
    dock: Boolean(host.querySelector(".bulk-bar.has-selection"))
  };
  clickRowCheckbox(1);
  await frame();
  const twoInOneCard = geometry(host);
  const oneCardOwnership = {
    headerButtons: host.querySelectorAll(".header-bulk-actions button").length,
    dock: Boolean(host.querySelector(".bulk-bar.has-selection"))
  };
  clickRowCheckbox(1);
  await frame();
  clickRowCheckbox(2);
  await frame();
  const twoAcrossCards = geometry(host);
  const keeper = host.querySelector(".bulk-bar.has-selection");
  const keeperStyle = keeper ? getComputedStyle(keeper) : null;
  const quietHeaderLanes = [...host.querySelectorAll(".item-head > .gacts:not(.header-bulk-actions)")];
  const actionOwnership = {
    visibleHeaderControls: quietHeaderLanes.flatMap((lane) => [...lane.querySelectorAll("button, input, a[href]")])
      .filter((control) => getComputedStyle(control.closest(".gacts")).visibility !== "hidden").length,
    headerLanesInert: quietHeaderLanes.length > 0 && quietHeaderLanes.every((lane) => lane.inert),
    keeperButtons: host.querySelectorAll(".bulk-bar.has-selection button").length,
    keeperEntering: keeper?.classList.contains("keeper-enter") ?? false,
    transitionDuration: keeperStyle?.transitionDuration ?? "",
    transitionTiming: keeperStyle?.transitionTimingFunction ?? ""
  };

  check(sameGeometry(rest, one) && sameGeometry(one, twoInOneCard) &&
      sameGeometry(twoInOneCard, twoAcrossCards),
    `${surface} ${listName} at ${width}px keeps geometry across local and cross-card selections`,
    JSON.stringify({ rest, one, twoInOneCard, twoAcrossCards }));
  check(oneOwnership.headerButtons > 0 && !oneOwnership.dock &&
      oneCardOwnership.headerButtons > 0 && !oneCardOwnership.dock,
    `${surface} ${listName} at ${width}px keeps one-card selection actions local`,
    JSON.stringify({ oneOwnership, oneCardOwnership }));
  if (listName === "open") {
    check(awarenessBeforeSelection === awarenessAfterSelection,
      `${surface} ${listName} at ${width}px keeps automation awareness mounted through selection`);
    check(selectionAwarenessOpacity >= .99 && deselectionAwarenessOpacity >= .99,
      `${surface} ${listName} at ${width}px keeps automation awareness visually continuous through selection and deselection`,
      JSON.stringify({ selectionAwarenessOpacity, deselectionAwarenessOpacity }));
  }
  check(actionOwnership.visibleHeaderControls === 0 && actionOwnership.headerLanesInert &&
      actionOwnership.keeperButtons > 0 && actionOwnership.keeperEntering,
    `${surface} ${listName} at ${width}px retains layout without duplicate interactive actions`,
    JSON.stringify(actionOwnership));
  check(actionOwnership.transitionDuration.split(",").every((value) => value.trim() === "0.14s") &&
      actionOwnership.transitionTiming.includes("cubic-bezier(0.2, 0.8, 0.2, 1)"),
    `${surface} ${listName} at ${width}px uses the shared swift reveal motion`,
    JSON.stringify(actionOwnership));
}

async function exerciseNestedWindow(surface, width) {
  document.body.dataset.surface = surface === "sidepanel" ? "sidepanel" : "dashboard";
  document.body.dataset.rowInfo = "clean";
  fixture.style.width = `${width}px`;
  const section = `nested-${surface}`;
  clearSelection(section);
  let externalRefreshes = 0;
  const config = {
    section,
    presentation: surface === "sidepanel" ? "compact" : "default",
    groups: [{
      id: `${section}-card`, title: "Session", meta: "2 tabs", loose: false,
      windows: [{
        id: `${section}-window`, meta: "Window 1 · 2 tabs",
        refs: [
          { title: "Nested one", url: "https://nested-one.example.test" },
          { title: "Nested two", url: "https://nested-two.example.test" }
        ]
      }]
    }],
    selectable: "tab", rowCap: 10,
    rowActions: [],
    groupActions: ["open", "copy", "label", "snooze", "rename", "delete"].map((id) => ({
      id, label: id, render: () => action(id)
    })),
    windowActions: ["restore", "copy"].map((id) => ({
      id, label: id, render: () => action(id)
    })),
    bulkActions: () => [action("copy")],
    onChange: () => { externalRefreshes += 1; return new Promise(() => {}); }
  };
  let host = createTabList(config);
  fixture.replaceChildren(host);
  await frame();
  const rest = geometry(host);
  host.querySelector(".window-block > .item-head input").click();
  host = fixture.querySelector(`[data-tablist="${section}"]`);
  await frame();
  const selected = geometry(host);
  check(externalRefreshes === 0 && host.querySelectorAll(".trow.sel").length === 2 &&
      host.querySelector(":scope > .item .item-head input").checked &&
      Boolean(host.querySelector(".header-bulk-actions [data-bulk-action='copy']")),
    `${surface} nested window selection updates rows, parent header and actions locally`);
  check(sameGeometry(rest, selected),
    `${surface} nested window selection retains card and row geometry`,
    JSON.stringify({ rest, selected }));
  host.querySelector(".window-block > .item-head input").click();
  host = fixture.querySelector(`[data-tablist="${section}"]`);
  await frame();
  check(externalRefreshes === 0 && host.querySelectorAll(".trow.sel").length === 0 &&
      sameGeometry(rest, geometry(host)),
    `${surface} nested window deselection remains local and geometry-stable`);
}

try {
  await exercise("dashboard", "inbox", 880);
  await exercise("dashboard", "open", 880);
  await exercise("sidepanel", "inbox", 360);
  await exercise("sidepanel", "open", 360);
  await exercise("sidepanel", "inbox", 240);
  await exercise("sidepanel", "open", 240);
  await exerciseNestedWindow("dashboard", 880);
  await exerciseNestedWindow("sidepanel", 360);
  fixture.style.width = "320px";
  const duplicateBanner = duplicateIdentityBanner({
    data: { canonicalUrl: "https://tickets.example.test/view" }
  }, () => {});
  fixture.replaceChildren(Object.assign(document.createElement("div"), { className: "tablist" }));
  fixture.firstElementChild.append(duplicateBanner);
  await frame();
  const duplicateAddress = duplicateBanner.querySelector(".dup-identity-url");
  const duplicateRule = duplicateBanner.querySelector(".dup-rule-trigger");
  check(duplicateAddress.getBoundingClientRect().bottom >=
      duplicateRule.getBoundingClientRect().top &&
      duplicateRule.getBoundingClientRect().bottom >= duplicateAddress.getBoundingClientRect().top,
    "Duplicates keeps the false-match action on the address line",
    JSON.stringify({ address: duplicateAddress.getBoundingClientRect(),
      action: duplicateRule.getBoundingClientRect() }));
  automationAwareness.close();
  await exerciseSelectionIdentity({ host: fixture, click: (node) => node.click() });
  await exerciseUiInteractionSafety({ host: fixture, messages: interactionMessages,
    click: node => node.click(), inputEvent: node => node.dispatchEvent(new Event("input", { bubbles: true })),
    key: (node, init, type = "keydown") => {
      const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
      node.dispatchEvent(event);
      return event;
    }
  });
  if (failures.length) throw new Error(failures.join("\n"));
  resultNode.dataset.status = "pass";
  resultNode.textContent = "PASS: selection geometry/identity, refreshed row actions, composing input ownership and deliberate destructive shortcuts";
} catch (error) {
  resultNode.dataset.status = "fail";
  resultNode.textContent = `FAIL: ${error?.stack || error}`;
}
