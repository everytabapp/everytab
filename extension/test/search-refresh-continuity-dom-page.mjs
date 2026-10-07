import { createBrowserI18nMock } from "./browser-message-fixture.js";

const event = () => {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    fire: (...args) => { for (const listener of listeners) listener(...args); }
  };
};

const storageChanged = event();
const tabEvents = {
  onCreated: event(), onUpdated: event(), onRemoved: event(), onMoved: event(),
  onAttached: event(), onDetached: event(), onReplaced: event()
};
const windowEvents = { onCreated: event(), onRemoved: event() };
const permissionEvents = { onAdded: event(), onRemoved: event() };
globalThis.chrome = {
  i18n: await createBrowserI18nMock(),
  permissions: {
    contains: async () => false,
    onAdded: permissionEvents.onAdded,
    onRemoved: permissionEvents.onRemoved
  },
  runtime: {
    getURL: (path) => `chrome-extension://test/${path}`,
    sendMessage: async () => ({ ok: true })
  },
  storage: {
    local: { get: async () => ({}) },
    onChanged: storageChanged
  },
  tabs: {
    ...tabEvents,
    query: async () => []
  },
  windows: {
    ...windowEvents,
    getAll: async () => []
  }
};

const { createSearchBox } = await import("../js/ui/searchbox.js");
const fixture = document.querySelector("#fixture");
const result = document.querySelector("#result");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let searches = 0;
let invalidations = 0;
const searchSession = {
  invalidate() { invalidations += 1; },
  async searchProgressively() {
    searches += 1;
    return {
      results: [{
        type: "open", title: "Stable work page", url: "https://work.example/ticket",
        tabId: 41, windowId: 7
      }],
      complete: null
    };
  },
  async scopeNames() { return []; },
  async resolveFilters(raw) { return { scope: null, labels: [], query: raw }; }
};

try {
  const box = createSearchBox({ searchSession });
  fixture.append(box);
  const input = box.querySelector("input");
  box.setInputValue("work");
  await wait(240);
  const rowBefore = box.querySelector(".search-row");
  const searchesBefore = searches;
  if (!rowBefore || document.activeElement !== input) {
    throw new Error(`fixture did not settle before notification: ${JSON.stringify({
      row: Boolean(rowBefore), focused: document.activeElement === input, searches
    })}`);
  }

  // Unread-message badges commonly update a background tab's title without
  // changing its URL or structure. Search may invalidate its next snapshot,
  // but repainting the active result set makes the field visibly flicker.
  tabEvents.onUpdated.fire(99, { title: "(1) Messages" }, {
    id: 99, windowId: 8, title: "(1) Messages", url: "https://messages.example/"
  });
  await wait(180);
  const rowAfter = box.querySelector(".search-row");
  if (rowAfter !== rowBefore || searches !== searchesBefore) {
    throw new Error(`a background title notification repainted focused Search: ${JSON.stringify({
      sameRow: rowAfter === rowBefore, searchesBefore, searchesAfter: searches, invalidations
    })}`);
  }
  if (invalidations !== 1) {
    throw new Error(`the title update did not invalidate the next Search snapshot: ${invalidations}`);
  }
  result.dataset.status = "pass";
  result.textContent = "PASS: background title notifications keep focused Search visually stable";
} catch (error) {
  result.dataset.status = "fail";
  result.textContent = `FAIL: ${error?.stack || error}`;
}
