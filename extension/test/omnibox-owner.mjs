import assert from "node:assert/strict";
import { createChromeI18nMock } from "./message-fixture.mjs";

function chromeEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    async emit(...args) {
      await Promise.all(listeners.map((listener) => listener(...args)));
    },
    get size() { return listeners.length; }
  };
}

const onInputChanged = chromeEvent();
const onInputCancelled = chromeEvent();
const onInputEntered = chromeEvent();
const defaultSuggestions = [];
const browserCalls = [];
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  omnibox: {
    async setDefaultSuggestion(suggestion) { defaultSuggestions.push(suggestion); },
    onInputChanged,
    onInputCancelled,
    onInputEntered
  },
  search: {
    async query(queryInfo) { browserCalls.push({ type: "search", queryInfo }); }
  },
  windows: {
    async getLastFocused(options) {
      browserCalls.push({ type: "last-window", options });
      return {
        id: 7,
        type: "normal",
        incognito: false,
        tabs: [{ id: 71, active: true }]
      };
    }
  },
  tabs: {
    async update(tabId, properties) {
      browserCalls.push({ type: "update", tabId, properties });
    },
    async create(properties) {
      browserCalls.push({ type: "create", properties });
      return { id: 72 };
    },
    async remove(tabId) { browserCalls.push({ type: "remove", tabId }); }
  }
};

const { installOmniboxOwner } = await import(
  "../js/background/omnibox-owner.js"
);

const actionCalls = [];
let slowSearchResolve;
let releaseFocus = () => {};
let blockFocus = false;
const searchCalls = [];
const searchSession = {
  async search(query, options) {
    searchCalls.push({ query, options });
    if (query === "slow") {
      return new Promise((resolve) => { slowSearchResolve = resolve; });
    }
    if (query === "docs") {
      return [{
        type: "open",
        title: "Documentation",
        url: "https://docs.example/guide",
        tabId: 31,
        windowId: 3,
        sourceName: "Window 3"
      }];
    }
    return [];
  },
  scopeNames(kind) {
    return kind === "label" ? ["Design"] : [];
  }
};

installOmniboxOwner({
  searchSession,
  hasHistory: async () => false,
  actions: {
    async focus(target) {
      actionCalls.push({ type: "focus", target });
      if (blockFocus) await new Promise((resolve) => { releaseFocus = resolve; });
    },
    async restoreSession(sessionId) {
      actionCalls.push({ type: "restore", sessionId });
    },
    async openOrganizationGroup(kind, groupId) {
      actionCalls.push({ type: "group", kind, groupId });
    },
    async activateStarred(url) {
      actionCalls.push({ type: "starred", url });
    }
  }
});

assert.deepEqual([
  onInputChanged.size,
  onInputCancelled.size,
  onInputEntered.size
], [1, 1, 1], "one owner installs each omnibox listener once");
assert.equal(defaultSuggestions[0]?.description,
  "Search every tab: try in:inbox, label:work, or domain:example.com",
  "the owner installs the localized default suggestion");

let suggestions = [];
await onInputChanged.emit("docs", (next) => { suggestions = next; });
assert.equal(suggestions.length, 1);
assert.match(suggestions[0].description, /Documentation/,
  "input changes publish accepted Search suggestions");

let staleSuggestCalls = 0;
const staleQuery = onInputChanged.emit("slow", () => { staleSuggestCalls++; });
await new Promise((resolve) => setTimeout(resolve, 0));
await onInputCancelled.emit();
slowSearchResolve([{
  type: "history",
  title: "Old result",
  url: "https://old.example"
}]);
await staleQuery;
assert.equal(staleSuggestCalls, 0,
  "cancelling the omnibox prevents a late query from publishing suggestions");

blockFocus = true;
let enterSettled = false;
const pendingEnter = onInputEntered.emit(suggestions[0].content, "newBackgroundTab");
void pendingEnter.then(() => { enterSettled = true; });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(actionCalls.at(-1), {
  type: "focus",
  target: { type: "focus-tab", tabId: 31, windowId: 3 }
}, "selecting a live suggestion preserves its exact tab identity");
assert.equal(enterSettled, false,
  "the Chrome event remains pending while navigation is still running");
releaseFocus();
await pendingEnter;
blockFocus = false;

browserCalls.length = 0;
await onInputEntered.emit("docs.example/path", "currentTab");
assert.deepEqual(browserCalls, [
  { type: "last-window", options: { populate: true } },
  {
    type: "update",
    tabId: 71,
    properties: { url: "https://docs.example/path", active: true }
  }
], "a typed address reuses the eligible active tab for current-tab disposition");

browserCalls.length = 0;
await onInputEntered.emit("planning notes", "newForegroundTab");
assert.deepEqual(browserCalls, [{
  type: "search",
  queryInfo: { text: "planning notes", disposition: "NEW_TAB" }
}], "a raw query uses Chrome's default search provider with its disposition");

await onInputEntered.emit("everytab-result:session:client", "newForegroundTab");
await onInputEntered.emit(
  "everytab-result:group:label:deep%20work",
  "newForegroundTab"
);
await onInputEntered.emit(
  "everytab-result:star:https%3A%2F%2Fstarred.example%2F",
  "newForegroundTab"
);
assert.deepEqual(actionCalls.slice(-3), [
  { type: "restore", sessionId: "client" },
  { type: "group", kind: "label", groupId: "deep work" },
  { type: "starred", url: "https://starred.example/" }
], "saved entities retain their existing worker-owned actions");

await onInputChanged.emit("docs", () => {
  throw new Error("omnibox already closed");
});

console.log("PASS: one background owner binds Search to the Chrome omnibox");
