import assert from "node:assert/strict";

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

const onRemoved = chromeEvent();
const onFocusChanged = chromeEvent();
globalThis.chrome = { windows: { onRemoved, onFocusChanged } };

const { installWindowLifecycleOwner } = await import(
  "../js/background/window-lifecycle-owner.js"
);

const calls = [];
let rejectSessionCleanup = false;
let blockSessionCleanup = false;
let releaseSessionCleanup = () => {};
let oldFocusCleanupCalls = 0;

installWindowLifecycleOwner({
  activity: {
    async recordWindowFocus(windowId) {
      calls.push({ type: "activity-focus", windowId });
    },
    async forgetWindow(windowId) {
      calls.push({ type: "activity-remove", windowId });
    }
  },
  sessions: {
    async unbind(windowId) {
      calls.push({ type: "unbind", windowId });
      if (rejectSessionCleanup) throw new Error("private title https://private.example/session");
      if (blockSessionCleanup) await new Promise((resolve) => {
        releaseSessionCleanup = resolve;
      });
    }
  },
  focus: {
    async removeWindow() { oldFocusCleanupCalls += 1; }
  }
});

assert.deepEqual([onRemoved.size, onFocusChanged.size], [1, 1],
  "one owner installs each window lifecycle listener once");

await onFocusChanged.emit(21);
assert.deepEqual(calls, [
  { type: "activity-focus", windowId: 21 }
], "window focus changes reach the time-away owner");
calls.length = 0;

await onRemoved.emit(21);
assert.deepEqual(calls, [
  { type: "activity-remove", windowId: 21 },
  { type: "unbind", windowId: 21 }
], "one close reaches activity and Session cleanup without stamping a departure");
assert.equal(oldFocusCleanupCalls, 0, "window removal no longer invokes retired Focus cleanup");

calls.length = 0;
blockSessionCleanup = true;
const pendingRemoval = onRemoved.emit(22);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(calls, [
  { type: "activity-remove", windowId: 22 },
  { type: "unbind", windowId: 22 }
], "both current cleanup tasks start without waiting for one another");
let removalSettled = false;
void pendingRemoval.then(() => { removalSettled = true; });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(removalSettled, false,
  "the event remains pending until its slowest current cleanup settles");
releaseSessionCleanup();
await pendingRemoval;
blockSessionCleanup = false;

calls.length = 0;
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args);
rejectSessionCleanup = true;
await onRemoved.emit(23);
console.warn = originalWarn;
assert.deepEqual(calls, [
  { type: "activity-remove", windowId: 23 },
  { type: "unbind", windowId: 23 }
], "a failed Session cleanup cannot block activity cleanup");
assert.match(warnings[0]?.[0] ?? "", /Session window cleanup failed/,
  "cleanup failures retain their domain identity");

assert.deepEqual(warnings, [["EveryTab: Session window cleanup failed [name:Error]"]],
  "window cleanup emits one bounded line without the private error payload");

console.log("PASS: one background owner coordinates window removal");
