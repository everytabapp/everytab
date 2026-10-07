import assert from "node:assert/strict";
import { createVisibleDocumentTasks } from "../js/ui/visible-document-tasks.js";

class Events {
  #listeners = new Map();
  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }
  dispatch(type) {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }
}

const document = Object.assign(new Events(), { visibilityState: "hidden" });
const window = new Events();
const calls = [];
const tasks = createVisibleDocumentTasks(
  (requested) => calls.push(requested),
  { document, window }
);
assert.equal(tasks.isVisible(), false);

for (let index = 0; index < 100; index += 1) {
  tasks.request(["open", "focus"]);
}
assert.deepEqual(calls, [], "hidden requests do not run callbacks");
document.dispatch("visibilitychange");
window.dispatch("focus");
window.dispatch("pageshow");
assert.deepEqual(calls, [], "hidden wake events do not flush deferred work");

document.visibilityState = "visible";
assert.equal(tasks.isVisible(), true);
document.dispatch("visibilitychange");
assert.deepEqual(calls, [["open", "focus"]], "visibilitychange flushes one deduplicated batch");
document.dispatch("visibilitychange");
window.dispatch("focus");
window.dispatch("pageshow");
assert.deepEqual(calls, [["open", "focus"]], "repeated wake events do not rerun clean work");

document.visibilityState = "hidden";
tasks.request("attention");
window.dispatch("focus");
window.dispatch("pageshow");
assert.equal(calls.length, 1, "focus/pageshow remain inert while hidden");
document.visibilityState = "visible";
window.dispatch("pageshow");
assert.deepEqual(calls, [["open", "focus"], ["attention"]],
  "pageshow flushes once after the document becomes visible");

const focuslessDocument = Object.assign(new Events(), {
  visibilityState: "visible", hasFocus: () => false
});
const focuslessCalls = [];
createVisibleDocumentTasks((requested) => focuslessCalls.push(requested), {
  document: focuslessDocument, window: new Events()
}).request(["open", "focus"]);
assert.deepEqual(focuslessCalls, [["open", "focus"]],
  "visible documents run without a hasFocus predicate");

for (const visibilityState of [undefined, "prerender"]) {
  const unknownDocument = new Events();
  if (visibilityState !== undefined) unknownDocument.visibilityState = visibilityState;
  const unknownCalls = [];
  createVisibleDocumentTasks((requested) => unknownCalls.push(requested), {
    document: unknownDocument, window: new Events()
  }).request("open");
  assert.deepEqual(unknownCalls, [["open"]],
    "missing and unknown visibility states remain runnable");
}

console.log("PASS: visible document tasks");
