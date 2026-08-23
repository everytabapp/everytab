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
  const noop = () => {};
  const config = buildOpenListConfig({
    data: {
      groups, bindings: {}, sessionsById: new Map(),
      simpleWindows: groups.map((group) => ({ id: group.data.id, tabs: group.live })),
      groupsUnpreserved: false, currentWindowId: 1, browserWindowCount: 3
    },
    rowCap: 20,
    msg: async (message) => { sent.push(message); return { ok: true, moved: message.tabIds?.length ?? 0 }; },
    renderOpen: noop, renderArchive: noop, renderLabels: noop, goToLabel: noop,
    mark: (node) => node, cardLabelPanel: () => document.createElement("div"),
    buildOpenSnooze: () => document.createElement("div"), idleNudge: null,
    sessionComboboxButton: (label, options = {}) => {
      const button = document.createElement("button");
      button.textContent = label;
      if (options.actionId) button.setAttribute("data-action-id", options.actionId);
      return button;
    },
    copyRefs: noop, buildOrganizePanel: () => document.createElement("div"),
    driftBanner: () => null, groupNudge: () => null,
    openRowDrag: {}, newWindowZone: () => null, journalTabMove: noop,
    dragTabId: () => null, flashNote: noop, showNotice: noop
  });
  const panel = {
    toggle(factory, name) { opened = { name, node: factory() }; },
    close() {}
  };
  const selection = [
    { group: groups[0], indexes: [0] },
    { group: groups[1], indexes: [0] }
  ];
  const actions = config.bulkActions({
    selection, count: 2, clear: () => { cleared += 1; }, rerender: noop, panel
  }).filter(Boolean);
  const move = actions.find((node) => node.getAttribute("data-bulk-action") === "move");
  check(move, "Open bulk actions expose Move for a selected set");

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
  check(cleared === 1, "a successful bulk move clears the selection once", String(cleared));

  console.log(`PASS: ${checks.length} Open bulk-action checks`);
} finally {
  fixture.restore();
}
