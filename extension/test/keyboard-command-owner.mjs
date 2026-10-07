import assert from "node:assert/strict";
import fs from "node:fs";
import { createChromeI18nMock } from "./message-fixture.mjs";

function chromeEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    async emit(...args) {
      await Promise.all(listeners.map((listener) => listener(...args)));
    }
  };
}

const onCommand = chromeEvent();
const onPanelOpened = chromeEvent();
const onPanelClosed = chromeEvent();
const onRuntimeMessage = chromeEvent();
const openedPanels = [];
const closedPanels = [];
let windowLookupCount = 0;
let lastFocusedWindow = { id: 8, type: "normal", incognito: false };
let windows = [];
let activeTabs = [{ id: 17, windowId: 8, title: "Example" }];
let panelFailure = false;
let searchModeFailure = false;
let popupFailure = false;
let popupOpenOptions = null;
let searchModeArmed = false;
let existingPopup = false;
const popupFocusRequests = [];
const sidePanelFocusRequests = [];
let panelProbeOpen = false;
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  commands: { onCommand },
  windows: {
    getLastFocused: async () => {
      windowLookupCount += 1;
      return lastFocusedWindow;
    },
    getAll: async () => windows
  },
  sidePanel: {
    onOpened: onPanelOpened,
    onClosed: onPanelClosed,
    open: async (options) => {
      if (panelFailure) throw new Error("side panel unavailable");
      openedPanels.push(options);
    },
    close: async (options) => { closedPanels.push(options); }
  },
  action: {
    openPopup: async (options) => {
      if (popupFailure || existingPopup) throw new Error("popup unavailable");
      popupOpenOptions = options ?? {};
    }
  },
  runtime: {
    onMessage: onRuntimeMessage,
    async sendMessage(message) {
      if (message?.type === "probe-side-panel-navigation") {
        return panelProbeOpen ? { open: true } : undefined;
      }
      if (message?.type === "focus-side-panel-navigation") {
        sidePanelFocusRequests.push(message);
        return { focused: true };
      }
      if (message?.type !== "focus-popup-search") return undefined;
      popupFocusRequests.push(message);
      return existingPopup ? { focused: true } : undefined;
    }
  },
  storage: {
    session: {
      async set() {
        if (searchModeFailure) throw new Error("session storage unavailable");
        searchModeArmed = true;
      },
      async remove() { searchModeArmed = false; }
    }
  },
  tabs: { query: async () => activeTabs }
};

const { installKeyboardCommandOwner } = await import(
  "../js/background/keyboard-command-owner.js"
);

const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
assert.deepEqual(manifest.commands["open-popup"].suggested_key,
  { default: "Alt+Shift+E", mac: "MacCtrl+Shift+E" });
assert.deepEqual(manifest.commands["open-search-popup"].suggested_key,
  { default: "Alt+Shift+K", mac: "MacCtrl+Shift+K" });
assert.deepEqual(manifest.commands["dump-window"].suggested_key,
  { default: "Alt+Shift+I", mac: "MacCtrl+Shift+I" });
assert.deepEqual(manifest.commands["open-side-panel"].suggested_key,
  { default: "Alt+Shift+S", mac: "MacCtrl+Shift+S" });
assert.equal(Object.values(manifest.commands).filter((command) => command.suggested_key).length, 4,
  "Chrome's four suggested-shortcut slots belong to Popup, Search, Save Window and Side Panel");

const calls = [];
const notices = [];
let saveTabResult = { n: 1, undoId: "dump-exact" };
let snoozeResult = { title: "Example", undoId: "snooze-exact" };
let saveTabStarted = null;
let releaseSaveTab = null;
let latestActivityId = "older-action";
let saveTabFailure = null;
installKeyboardCommandOwner({
  openDashboard(section) { calls.push({ type: "open-dashboard", section }); },
  saveWindow() { calls.push({ type: "save-window" }); },
  async saveTab(tabId) {
    calls.push({ type: "save-tab", tabId });
    if (saveTabStarted) {
      saveTabStarted();
      await new Promise((resolve) => { releaseSaveTab = resolve; });
    }
    if (saveTabFailure) throw saveTabFailure;
    return saveTabResult;
  },
  async snoozeTab(tab, dueAt) {
    calls.push({ type: "snooze-tab", tab, dueAt });
    return snoozeResult;
  },
  async suspendTab(tabId) { calls.push({ type: "suspend-tab", tabId }); },
  async listActions() {
    calls.push({ type: "list-actions" });
    return [{ id: latestActivityId }];
  },
  notify(notice) { notices.push(notice); }
});

await onCommand.emit("open-search-popup");
assert.equal(searchModeArmed, true);
assert.deepEqual(popupOpenOptions, { windowId: 8 },
  "Search mode is armed before opening the popup in its eligible window");
popupOpenOptions = null;
await onCommand.emit("open-popup");
assert.equal(searchModeArmed, false,
  "the plain popup clears any stale Search-focus handoff");
assert.deepEqual(popupOpenOptions, { windowId: 8 },
  "the plain popup opens in the same eligible window without focusing Search");
existingPopup = true;
const dashboardCallsBeforeExistingPopup = calls.length;
const popupFocusRequestsBeforeExistingPopup = popupFocusRequests.length;
await onCommand.emit("open-search-popup");
assert.equal(calls.length, dashboardCallsBeforeExistingPopup,
  "Search focuses an already-open popup instead of opening Dashboard Search");
assert.equal(popupFocusRequests.length, popupFocusRequestsBeforeExistingPopup + 1,
  "Search sends an explicit focus request to the already-open popup");
existingPopup = false;
await onCommand.emit("open-dashboard");
await onCommand.emit("dump-window");
assert.deepEqual(calls.slice(0, 2), [
  { type: "open-dashboard", section: undefined },
  { type: "save-window" }
], "commands without a tab lookup route directly");

searchModeFailure = true;
await onCommand.emit("open-search-popup");
searchModeFailure = false;
assert.deepEqual(calls.at(-1), { type: "open-dashboard", section: "search" },
  "Search falls back to Dashboard when its one-shot mode cannot be armed");

popupFailure = true;
await onCommand.emit("open-search-popup");
popupFailure = false;
assert.equal(searchModeArmed, false,
  "a failed popup open clears its one-shot Search request");
assert.deepEqual(calls.at(-1), { type: "open-dashboard", section: "search" },
  "a failed popup open falls back to Dashboard Search");

const lookupsBeforeCommandTab = windowLookupCount;
await onCommand.emit("open-side-panel", { id: 17, windowId: 8, incognito: false });
assert.deepEqual(openedPanels, [{ windowId: 8 }],
  "side panel opens in the last-focused normal non-incognito window");
assert.equal(windowLookupCount, lookupsBeforeCommandTab,
  "the command tab opens the Side Panel before any asynchronous window lookup can consume the gesture");
assert.deepEqual(sidePanelFocusRequests.at(-1), {
  type: "focus-side-panel-navigation", windowId: 8
}, "a shortcut-opened Side Panel receives its immediate keyboard-entry handoff");
await onPanelOpened.emit({ windowId: 8, path: "sidepanel.html" });
await onCommand.emit("open-side-panel", { id: 17, windowId: 8, incognito: false });
assert.deepEqual(closedPanels, [{ windowId: 8 }],
  "the same shortcut closes an already-open Side Panel");
await onPanelClosed.emit({ windowId: 8, path: "sidepanel.html" });

lastFocusedWindow = { id: 9, type: "popup", incognito: false };
windows = [
  { id: 10, type: "normal", incognito: true },
  { id: 11, type: "normal", incognito: false }
];
await onCommand.emit("open-side-panel");
assert.deepEqual(openedPanels.at(-1), { windowId: 11 },
  "side panel falls back to an eligible normal window");
await onPanelClosed.emit({ windowId: 11, path: "sidepanel.html" });

panelFailure = true;
await onCommand.emit("open-side-panel");
panelFailure = false;
assert.equal(openedPanels.length, 2,
  "an unavailable side-panel API is contained by the command owner");

lastFocusedWindow = { id: 12, type: "popup", incognito: false };
windows = [{ id: 13, type: "normal", incognito: true }];
await onCommand.emit("open-side-panel");
assert.equal(openedPanels.length, 2,
  "side-panel routing never targets an ineligible window");

panelProbeOpen = true;
await onCommand.emit("open-side-panel", { id: 18, windowId: 14, incognito: false });
panelProbeOpen = false;
assert.deepEqual(openedPanels.at(-1), { windowId: 14 });
assert.deepEqual(closedPanels.at(-1), { windowId: 14 },
  "an already-mounted Side Panel still toggles closed after the worker loses its in-memory open set");
await onPanelClosed.emit({ windowId: 14, path: "sidepanel.html" });

const saveStarted = new Promise((resolve) => { saveTabStarted = resolve; });
const pendingSave = onCommand.emit("dump-tab");
await saveStarted;
latestActivityId = "newer-unrelated-action";
releaseSaveTab();
saveTabStarted = null;
await pendingSave;
assert.deepEqual(calls.at(-1), { type: "save-tab", tabId: 17 });
assert.match(notices.at(-1).id, /^cmd-dump-\d+$/);
assert.deepEqual({ ...notices.at(-1), id: "stable" }, {
  id: "stable",
  title: "Saved to Inbox",
  message: "This tab moved to your Inbox. Nothing was deleted.",
  undoId: "dump-exact"
});
assert.equal(calls.some((call) => call.type === "list-actions"), false,
  "a newer Activity entry cannot replace the save operation's exact Undo receipt");

saveTabResult = { n: 0, undoId: null };
const noticeCount = notices.length;
await onCommand.emit("dump-tab");
assert.equal(notices.length, noticeCount,
  "a save no-op produces no misleading notification");

saveTabFailure = new Error("save failed");
await assert.rejects(onCommand.emit("dump-tab"), /save failed/);
saveTabFailure = null;
assert.equal(notices.length, noticeCount,
  "a failed save cannot borrow an unrelated Undo identity");

await onCommand.emit("snooze-tab");
assert.equal(calls.at(-1).type, "snooze-tab");
assert.equal(calls.at(-1).tab, activeTabs[0]);
assert.ok(calls.at(-1).dueAt > Date.now());
assert.match(notices.at(-1).id, /^cmd-snooze-\d+$/);
assert.deepEqual({ ...notices.at(-1), id: "stable" }, {
  id: "stable",
  title: "Snoozed until tomorrow 9:00",
  message: "“Example” will come back tomorrow at 9:00.",
  undoId: "snooze-exact"
});

snoozeResult = null;
const noticeCountAfterSnooze = notices.length;
await onCommand.emit("snooze-tab");
assert.equal(notices.length, noticeCountAfterSnooze,
  "a Snooze no-op produces no misleading notification");

await onCommand.emit("suspend-tab");
assert.deepEqual(calls.at(-1), { type: "suspend-tab", tabId: 17 });

activeTabs = [];
const callCount = calls.length;
await onCommand.emit("dump-tab");
activeTabs = [{ id: 17, windowId: 8, title: "Example" }];
await onCommand.emit("unknown-command");
assert.equal(calls.length, callCount,
  "per-tab and unknown commands are inert when no active tab exists");

console.log("PASS: one background owner routes every keyboard command");
