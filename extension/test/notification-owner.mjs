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

const onButtonClicked = chromeEvent();
const onClicked = chromeEvent();
const onClosed = chromeEvent();
const created = [];
const cleared = [];
globalThis.chrome = {
  i18n: createChromeI18nMock(),
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  notifications: {
    onButtonClicked,
    onClicked,
    onClosed,
    async create(id, options) {
      created.push({ id, options });
      return id;
    },
    async clear(id) { cleared.push(id); }
  }
};

const { createNotificationOwner } = await import(
  "../js/background/notification-owner.js"
);

const undone = [];
const accessCalls = [];
let blockUndo = false;
let releaseUndo = () => {};
let rejectAccess = false;
const owner = createNotificationOwner({
  actionRecoveryReady: Promise.resolve(),
  async undoAction(entryId) {
    undone.push(entryId);
    if (blockUndo) await new Promise((resolve) => { releaseUndo = resolve; });
  },
  access: {
    owns: (id) => id.startsWith("focus-access:"),
    async handleButton(notificationId, buttonIndex) {
      accessCalls.push({ type: "button", notificationId, buttonIndex });
      if (rejectAccess) throw new Error("private Focus title https://private.example/focus");
    },
    async handleClick(notificationId) {
      accessCalls.push({ type: "click", notificationId });
      if (rejectAccess) throw new Error("private Focus title https://private.example/focus");
    }
  }
});

assert.deepEqual([
  onButtonClicked.size,
  onClicked.size,
  onClosed.size
], [1, 1, 1], "one owner installs each Chrome notification listener once");

await owner.notify({
  id: "command-one",
  title: "Saved",
  message: "Saved to Inbox",
  undoId: "journal-one"
});
assert.deepEqual(created[0], {
  id: "command-one",
  options: {
    type: "basic",
    iconUrl: "chrome-extension://test/icon.png",
    title: "Saved",
    message: "Saved to Inbox",
    buttons: [{ title: "Undo" }]
  }
}, "command notifications expose Undo only when a receipt is registered");

await onButtonClicked.emit("command-one", 1);
assert.deepEqual(undone, [], "another notification button cannot consume Undo");

blockUndo = true;
let undoSettled = false;
const pendingUndo = onButtonClicked.emit("command-one", 0);
void pendingUndo.then(() => { undoSettled = true; });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(undone, ["journal-one"]);
assert.equal(undoSettled, false,
  "the Chrome event remains pending until its Undo action settles");
releaseUndo();
await pendingUndo;
blockUndo = false;
assert.deepEqual(cleared, ["command-one"]);
await onButtonClicked.emit("command-one", 0);
assert.deepEqual(undone, ["journal-one"],
  "a consumed Undo receipt cannot run twice");

owner.registerUndo("auto-archive", "journal-two");
await onButtonClicked.emit("auto-archive", 0);
assert.deepEqual(undone, ["journal-one", "journal-two"],
  "automatic archive notifications use the same owned Undo path");

owner.registerUndo("dismissed", "journal-three");
await onClosed.emit("dismissed");
await onButtonClicked.emit("dismissed", 0);
assert.deepEqual(undone, ["journal-one", "journal-two"],
  "closing a notification retires its Undo receipt");

await onButtonClicked.emit("focus-access:warning", 0);
await onClicked.emit("focus-access:warning");
assert.deepEqual(accessCalls, [
  { type: "button", notificationId: "focus-access:warning", buttonIndex: 0 },
  { type: "click", notificationId: "focus-access:warning" }
], "Focus access buttons and body clicks keep their distinct domain actions");

owner.registerUndo("focus-access:owned-undo", "journal-four");
await onButtonClicked.emit("focus-access:owned-undo", 0);
assert.equal(undone.at(-1), "journal-four");
assert.equal(accessCalls.length, 2,
  "an exact registered Undo receipt takes precedence over a domain prefix");

const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args);
rejectAccess = true;
await onButtonClicked.emit("focus-access:failure", 0);
await onClicked.emit("focus-access:failure");
console.warn = originalWarn;
assert.match(warnings[0]?.[0] ?? "", /Focus access extension failed/);
assert.match(warnings[1]?.[0] ?? "", /Focus access notification click failed/,
  "Focus failures are contained with their action identity");

await owner.notify({ id: "informational", title: "Done", message: "Nothing to undo" });
assert.equal(Object.hasOwn(created.at(-1).options, "buttons"), false);

assert.deepEqual(warnings, [
  ["EveryTab: Focus access extension failed [name:Error]"],
  ["EveryTab: Focus access notification click failed [name:Error]"]
], "notification event failures contain no private payload or extra sink arguments");

console.log("PASS: one background owner routes notification interactions");
