import { installDomFixture } from "./dom-fixture.mjs";
import { createInterleavableStorage, createMockLockManager } from "./e2-mocks.mjs";
import { createChromeI18nMock } from "./message-fixture.mjs";

const fixture = installDomFixture();
document.addEventListener = () => {};
document.removeEventListener = () => {};
const failures = [];
let passed = 0;
const check = (condition, name, detail = "") => {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};

const eventChannel = { addListener() {}, removeListener() {} };
const storage = createInterleavableStorage({});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { locks: createMockLockManager() }
});

const tab = (id, windowId, index) => ({
  id, windowId, index, type: "normal", pinned: false, groupId: -1,
  title: `Tab ${id}`, url: `https://tab-${id}.test/`
});
let windows = [
  { id: 1, type: "normal", incognito: false, tabs: [tab(11, 1, 0), tab(12, 1, 1)] },
  { id: 2, type: "normal", incognito: false, tabs: [tab(21, 2, 0)] },
  { id: 3, type: "normal", incognito: false, tabs: [tab(31, 3, 0)] }
];
const sent = [];
const appendNewWindow = (ids) => {
  if (windows.some((window) => window.id === 4)) return;
  windows.push({
    id: 4, type: "normal", incognito: false,
    tabs: ids.map((id, index) => tab(id, 4, index))
  });
};

globalThis.chrome = {
  i18n: createChromeI18nMock(),
  storage: { local: storage.local, onChanged: storage.onChanged },
  runtime: {
    onMessage: eventChannel,
    getURL: (path = "") => `chrome-extension://fixture/${path}`
  },
  tabs: {
    get: async (id) => structuredClone(windows.flatMap((window) => window.tabs).find((entry) => entry.id === id))
  },
  windows: {
    getAll: async () => structuredClone(windows),
    getCurrent: async () => ({ id: 1, type: "normal" })
  },
  permissions: { contains: async () => false }
};

const dataTransfer = () => {
  const values = new Map();
  return {
    effectAllowed: "", dropEffect: "",
    dragImage: null,
    setData(type, value) { values.set(type, String(value)); },
    getData(type) { return values.get(type) ?? ""; },
    setDragImage(node, x, y) { this.dragImage = { node, x, y }; }
  };
};

const { createOpenSurface } = await import("../js/ui/open-surface.js");
const { clearSelection } = await import("../js/ui/tablist.js");
const noop = () => {};
const makeSurface = () => {
  const actionHost = document.createElement("div");
  actionHost.prepend = (...nodes) => actionHost.append(...nodes);
  return createOpenSurface({
  msg: async (message) => {
    sent.push(structuredClone(message));
    if (message.type === "move-tabs" && message.destination?.kind === "new-window") {
      appendNewWindow(message.tabIds);
      return { ok: true, moved: message.tabIds.length, windowId: 4 };
    }
    if (message.type === "new-window-with-tab") {
      appendNewWindow([message.tabId]);
      return { ok: true, windowId: 4 };
    }
    return { ok: true };
  },
  rerender: noop,
  shouldRenderBody: () => true,
  sectionActionHost: actionHost,
  getFlashAnchor: () => document.body,
  showNotice: noop,
  flashNote: noop,
  mark: (node) => node,
  cardLabelPanel: () => document.createElement("div"),
  sessionComboboxButton: (label) => {
    const button = document.createElement("button");
    button.textContent = label;
    return button;
  },
  copyRefs: noop,
  renderArchive: noop,
  renderLabels: noop,
  goToLabel: noop,
  takeInitialSnapshot: () => Promise.resolve([structuredClone(windows), [], {}, [], []])
  });
};

try {
  clearSelection("open");
  const surface = makeSurface();
  const first = await surface.render();
  document.body.replaceChildren(first.node);
  const rows = [...document.querySelectorAll("[data-tablist-row]")];
  await rows[0].querySelector('input[type="checkbox"]').dispatch("change");
  await rows[1].querySelector('input[type="checkbox"]').dispatch("change");
  const transfer = dataTransfer();
  await rows[0].dispatch("dragstart", { dataTransfer: transfer });
  check(transfer.dragImage?.node?.classList.contains("open-drag-preview") &&
      transfer.dragImage.node.textContent.includes("2 tabs"),
    "the native drag image states the complete selected-tab count",
    transfer.dragImage?.node?.textContent ?? "missing");
  const endSlot = document.querySelector('[data-tablist-card="3"] .drop-zone-window-end');
  check(Boolean(endSlot) && endSlot.textContent === "" &&
      endSlot.getAttribute("aria-label") === "Move to end of Window 3",
    "each Open window exposes a visually quiet, accessibly named terminal slot");
  if (endSlot) await endSlot.dispatch("drop", { dataTransfer: transfer });
  await rows[0].dispatch("dragend", { dataTransfer: transfer });

  const selectedMove = sent.find((message) => message.type === "move-tabs");
  check(selectedMove && JSON.stringify(selectedMove.tabIds) === JSON.stringify([11, 12]) &&
      selectedMove.destination?.kind === "window" && selectedMove.destination.windowId === 3 &&
      selectedMove.destination.index === -1,
  "dragging one selected row to a window-end slot appends the complete selected set",
  JSON.stringify(sent));
  check(!document.querySelector(".open-drag-preview"),
    "ending the drag removes its transient count preview");

  clearSelection("open");
  sent.length = 0;
  windows = [
    { id: 1, type: "normal", incognito: false, tabs: [tab(11, 1, 0), tab(12, 1, 1)] },
    { id: 2, type: "normal", incognito: false, tabs: [tab(21, 2, 0)] },
    { id: 3, type: "normal", incognito: false, tabs: [tab(31, 3, 0)] }
  ];
  const orderedSurface = makeSurface();
  const before = await orderedSurface.render();
  document.body.replaceChildren(before.node);
  const source = document.querySelector('[data-tablist-card="1"] [data-tablist-row]');
  const zoneAfterFirst = document.querySelectorAll(".drop-zone-new")[0];
  const newTransfer = dataTransfer();
  await source.dispatch("dragstart", { dataTransfer: newTransfer });
  await zoneAfterFirst.dispatch("drop", { dataTransfer: newTransfer });
  await source.dispatch("dragend", { dataTransfer: newTransfer });
  const after = await orderedSurface.render();
  document.body.replaceChildren(after.node);
  const cardOrder = [...document.querySelectorAll("[data-tablist-card]")]
    .map((card) => card.getAttribute("data-tablist-card"));
  check(JSON.stringify(cardOrder) === JSON.stringify(["1", "4", "2", "3"]),
    "a new window dropped between cards remains at that visible slot",
    JSON.stringify(cardOrder));
} finally {
  fixture.restore();
}

if (failures.length) {
  console.error(`FAIL: ${failures.join("\nFAIL: ")}`);
  process.exit(1);
}
console.log(`PASS: ${passed} selected Open drag checks`);
