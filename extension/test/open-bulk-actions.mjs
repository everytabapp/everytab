import { installDomFixture } from "./dom-fixture.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const fixture = installDomFixture();
globalThis.chrome = { i18n: createChromeI18nMock() };
const checks = [];
const check = (condition, name, detail = "") => {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  checks.push(name);
};

try {
  const { buildOpenListConfig } = await import("../js/ui/list-configs.js");
  const groups = [
    {
      id: "window-1", title: "Window 1", data: { id: 1 },
      refs: [{ title: "One", url: "https://one.test/" }],
      live: [{ tabId: 11, windowId: 1, chromeIndex: 0, selectable: true }]
    },
    {
      id: "window-2", title: "Window 2", data: { id: 2 },
      refs: [{ title: "Two", url: "https://two.test/" }],
      live: [{ tabId: 22, windowId: 2, chromeIndex: 0, selectable: true }]
    },
    {
      id: "window-3", title: "Window 3", data: { id: 3 },
      refs: [{ title: "Three", url: "https://three.test/" }],
      live: [{ tabId: 33, windowId: 3, chromeIndex: 0, selectable: true }]
    }
  ];
  const sent = [];
  let cleared = 0;
  let opened = null;
  let openSnoozeTarget = null;
  let labelPanel = null;
  let copiedRefs = null;
  const noop = () => {};
  const openContext = {
    data: {
      groups, bindings: {}, sessionsById: new Map(),
      simpleWindows: groups.map((group) => ({ id: group.data.id, tabs: group.live })),
      groupsUnpreserved: false, currentWindowId: 1, browserWindowCount: 3
    },
    rowCap: 20,
    initialRowBudget: 300,
    msg: async (message) => { sent.push(message); return { ok: true, moved: message.tabIds?.length ?? 0 }; },
    renderOpen: noop, renderArchive: noop, renderLabels: noop, goToLabel: noop,
    mark: (node) => node, cardLabelPanel: (apply, title) => {
      labelPanel = { apply, title };
      return document.createElement("div");
    },
    buildOpenSnooze: (target) => {
      openSnoozeTarget = target;
      const panel = document.createElement("div");
      panel.append(document.createElement("input"));
      panel.querySelector("input").className = "snooze-custom";
      return panel;
    }, idleNudge: null,
    sessionComboboxButton: (label, options = {}) => {
      const button = document.createElement("button");
      button.textContent = label;
      if (options.actionId) button.setAttribute("data-action-id", options.actionId);
      button._sessionOptions = options;
      return button;
    },
    copyRefs: (refs) => { copiedRefs = refs; }, buildOrganizePanel: () => document.createElement("div"),
    driftBanner: () => null, groupAccessAction: () => null,
    openRowDrag: {}, newWindowZone: () => null, journalTabMove: noop,
    dragTabId: () => null, flashNote: noop, showNotice: noop
  };
  const config = buildOpenListConfig(openContext);
  const compactConfig = buildOpenListConfig({
    ...openContext, presentation: "compact", initialRowBudget: Infinity
  });
  const defaultConfig = buildOpenListConfig({ ...openContext, initialRowBudget: undefined });
  check(config.initialRowBudget === 300 && compactConfig.initialRowBudget === Infinity &&
      defaultConfig.initialRowBudget === undefined,
  "Open forwards Dashboard, compact, and omitted row budgets to the shared kernel");
  const panel = {
    toggle(factory, name) { opened = { name, node: factory() }; },
    close() {}
  };
  const windowSnooze = config.groupActions.find((action) => action.id === "snooze-window");
  check(windowSnooze, "Open window headers expose Snooze");
  check(JSON.stringify(config.rowActions
    .filter((action) => ["dump", "session", "label"].includes(action.id))
    .map((action) => action.id)) === JSON.stringify(["dump", "session", "label"]),
  "Open rows keep Inbox, Session, and Label in one order");
  check(JSON.stringify(config.groupActions
    .filter((action) => ["dump-window", "save-session", "label-window"].includes(action.id))
    .map((action) => action.id)) === JSON.stringify(["dump-window", "save-session", "label-window"]),
  "Open window headers keep Inbox, Session, and Label in one order");
  const windowLabel = config.groupActions.find((action) => action.id === "label-window");
  windowLabel.run({ group: groups[0], panel });
  check(opened?.name === "label" && typeof labelPanel?.apply === "function",
    "whole-window Label opens the shared searchable label picker");
  windowSnooze.run({ group: groups[0], panel });
  check(opened?.name === "snooze" && openSnoozeTarget?.windowId === 1 &&
      opened.node.querySelector(".snooze-custom"),
    "window Snooze opens the complete shared picker for that Chrome window",
    JSON.stringify({ name: opened?.name, target: openSnoozeTarget }));

  const rowSnooze = config.rowActions.find((action) => action.id === "snooze");
  rowSnooze.run({ live: groups[0].live[0], panel });
  check(openSnoozeTarget === 11 && opened.node.querySelector(".snooze-custom"),
    "Open row Snooze uses the same picker, including Custom time");

  const selection = [
    { group: groups[0], indexes: [0] },
    { group: groups[1], indexes: [0] }
  ];
  const actions = config.bulkActions({
    selection, count: 2, clear: () => { cleared += 1; }, rerender: noop, panel
  }).filter(Boolean);
  const actionOrder = actions.map((action) =>
    action.getAttribute("data-action-id") || action.getAttribute("data-bulk-action"));
  check(JSON.stringify(actionOrder) === JSON.stringify([
    "inbox", "session", "label", "snooze", "protection", "copy", "suspend", "move", "close"
  ]),
    "Open selected-set actions follow the row action order and leave Move beside Close",
    JSON.stringify(actionOrder));
  const move = actions.find((node) => node.getAttribute("data-bulk-action") === "move");
  check(move, "Open bulk actions expose Move for a selected set");
  check(move?.getAttribute("title") === "Move selected tabs to another window" &&
      move?.getAttribute("aria-label") === "Move selected tabs to another window",
  "Move names its destination scope in the tooltip and accessible label");
  check(move?.classList.contains("tip"),
    "Move opts into the shared fast themed tooltip instead of the delayed native title");

  const protect = actions.find((node) => node.getAttribute("data-bulk-action") === "protection");
  const protectTitle = "Protect selected tabs from automatic suspension and Auto-save to Inbox";
  check(protect?.textContent?.includes("Protect") &&
      protect?.getAttribute("title") === protectTitle &&
      protect?.getAttribute("aria-label") === protectTitle,
  "Open selected-set protection has a concrete visible name and explanatory tooltip",
  JSON.stringify({ text: protect?.textContent, title: protect?.getAttribute("title"),
    aria: protect?.getAttribute("aria-label") }));

  const copy = actions.find((node) => node.getAttribute("data-bulk-action") === "copy");
  const copyTitle = "Copy the selected tabs as a Markdown link list";
  check(copy?.textContent?.includes("Copy") && copy?.classList.contains("tip") &&
      copy?.getAttribute("title") === copyTitle && copy?.getAttribute("aria-label") === copyTitle,
  "Open selected-set Copy uses the shared immediate Markdown tooltip",
  JSON.stringify({ text: copy?.textContent, title: copy?.getAttribute("title"),
    aria: copy?.getAttribute("aria-label") }));
  await copy.dispatch("click");
  check(JSON.stringify(copiedRefs) === JSON.stringify([groups[0].refs[0], groups[1].refs[0]]),
    "Open selected-set Copy exports every selected tab in visual order",
    JSON.stringify(copiedRefs));

  const rowProtect = config.rowActions.find((action) => action.id === "protection");
  const windowProtect = config.groupActions.find((action) => action.id === "protection-window");
  check(rowProtect?.label === "Protect" &&
      rowProtect?.title === "Protect this tab from automatic suspension and Auto-save to Inbox" &&
      windowProtect?.label === "Protect" &&
      windowProtect?.title === "Protect tabs in this window from automatic suspension and Auto-save to Inbox",
  "Open row and window protection use the same name with scope-specific explanations");

  await move.dispatch("click");
  check(opened?.name === "bulk-move" && opened.node,
    "Move opens the shared destination palette", opened?.name ?? "missing");
  const destination = opened.node.querySelector('[data-move-window-id="3"]');
  check(destination, "the destination palette lists another open window");
  await destination.dispatch("click");

  check(sent.length === 1 && sent[0].type === "move-tabs" &&
      JSON.stringify(sent[0].tabIds) === JSON.stringify([11, 22]) &&
      sent[0].destination?.kind === "window" && sent[0].destination?.windowId === 3,
  "choosing one destination sends the complete selected set in one operation",
  JSON.stringify(sent));
  check(cleared === 0, "a successful bulk move keeps the selected tabs available for another action", String(cleared));

  const session = actions.find((node) => node.getAttribute("data-action-id") === "session");
  check(session?._sessionOptions?.onPick, "Open bulk actions expose the shared Session picker");
  check(!session._sessionOptions.onPick.toString().includes("clear"),
    "saving selected tabs to a Session does not clear the stable selected set");

  const suspend = actions.find((node) => node.getAttribute("data-bulk-action") === "suspend");
  check(suspend, "Open bulk actions expose Suspend for awake selected tabs");
  await suspend.dispatch("click");
  check(cleared === 0 && sent.slice(-2).every((message) => message.type === "suspend-tab"),
    "suspending selected tabs keeps the selection for a follow-up action", JSON.stringify(sent.slice(-2)));

  groups[0].live[0].suspended = true;
  const mixedActions = config.bulkActions({
    selection, count: 2, clear: noop, rerender: noop, panel
  }).filter(Boolean);
  const wake = mixedActions.find((node) => node.getAttribute("data-bulk-action") === "wake");
  check(wake?.getAttribute("title") === "Wake selected suspended tabs" &&
      wake?.getAttribute("aria-label") === "Wake selected suspended tabs",
  "Open Wake uses the concise suspended-tab tooltip, not Snoozed-item guidance");

  console.log(`PASS: ${checks.length} Open bulk-action checks`);
} finally {
  fixture.restore();
}
