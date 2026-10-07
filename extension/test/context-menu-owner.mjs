import assert from "node:assert/strict";
import { createChromeI18nMock } from "./message-fixture.mjs";

function chromeEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { listeners.forEach((listener) => listener(...args)); }
  };
}

const events = [];
const onClicked = chromeEvent();
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  contextMenus: {
    onClicked,
    removeAll(callback) {
      events.push({ type: "remove-all" });
      callback();
    },
    create(options) { events.push({ type: "create", options }); }
  }
};

const { createContextMenuOwner } = await import(
  "../js/background/context-menu-owner.js"
);

const actions = [];
const owner = createContextMenuOwner({
  saveTab(tabId) { actions.push({ type: "save-tab", tabId }); },
  saveWindow(windowId) { actions.push({ type: "save-window", windowId }); },
  snoozeTab(tab, dueAt) { actions.push({ type: "snooze-tab", tab, dueAt }); }
});

owner.install();
assert.deepEqual(events, [
  { type: "remove-all" },
  {
    type: "create",
    options: {
      id: "dump-tab",
      title: "Save tab → Inbox",
      contexts: ["page"]
    }
  },
  {
    type: "create",
    options: {
      id: "dump-window",
      title: "Save window → Inbox",
      contexts: ["page"]
    }
  },
  {
    type: "create",
    options: {
      id: "snooze-tomorrow",
      title: "Snooze until tomorrow 9:00",
      contexts: ["page"]
    }
  },
  {
    type: "create",
    options: {
      id: "snooze-next-week",
      title: "Snooze until Monday 9:00",
      contexts: ["page"]
    }
  }
], "installation replaces stale menu ids before creating the complete localized menu");

const tab = { id: 17, windowId: 4, title: "Example", url: "https://example.com" };
onClicked.emit({ menuItemId: "dump-tab" }, tab);
onClicked.emit({ menuItemId: "dump-window" }, tab);
onClicked.emit({ menuItemId: "snooze-tomorrow" }, tab);
onClicked.emit({ menuItemId: "snooze-next-week" }, tab);

assert.deepEqual(actions.slice(0, 2), [
  { type: "save-tab", tabId: 17 },
  { type: "save-window", windowId: 4 }
]);
assert.equal(actions[2].type, "snooze-tab");
assert.equal(actions[2].tab, tab);
assert.ok(actions[2].dueAt > Date.now(), "tomorrow is a future due time");
assert.equal(actions[3].type, "snooze-tab");
assert.equal(actions[3].tab, tab);
assert.ok(actions[3].dueAt >= actions[2].dueAt,
  "next Monday is not earlier than tomorrow, including when tomorrow is Monday");

const actionCount = actions.length;
onClicked.emit({ menuItemId: "unknown" }, tab);
onClicked.emit({ menuItemId: "dump-tab" });
onClicked.emit({ menuItemId: "dump-tab" }, { windowId: 4 });
onClicked.emit({ menuItemId: "dump-window" }, { id: 17 });
assert.equal(actions.length, actionCount,
  "unknown, missing-tab, and missing-identity clicks are inert");

console.log("PASS: one background owner installs and routes context menus");
