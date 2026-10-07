import assert from "node:assert/strict";
import { createNewTabMessageHandlers } from
  "../js/background/new-tab-message-handlers.js";
import { createMessageListener } from "../js/lib/message-handler-registry.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function invoke(listener, message, sender = {}) {
  return new Promise((resolve) => {
    let keepAlive;
    keepAlive = listener(message, sender, (response) => {
      queueMicrotask(() => resolve({ keepAlive, response }));
    });
  });
}

let counts = { active: 2, handled: 3 };
const calls = [];
const errors = [];
let rotationTask = null;
let mountedTask = null;
const handlers = createNewTabMessageHandlers({
  diagnostics: {
    arm(active, handled) {
      calls.push(["arm", active, handled]);
      return { ok: true, kind: "armed", active, handled };
    },
    report(active, handled) {
      calls.push(["report", active, handled]);
      return { ok: true, kind: "report", active, handled };
    },
    record(event, details) {
      calls.push(["record", event, details]);
      return event !== "page-paint" || details.tabId !== null;
    },
    safeScheme(value) {
      calls.push(["mask", value]);
      return { masked: value?.kind ?? "unknown" };
    }
  },
  rotation: {
    counts: () => ({ ...counts }),
    run(tabId) {
      calls.push(["rotate", tabId]);
      return rotationTask?.promise ?? Promise.resolve({ ok: true, tabId });
    }
  },
  retireMounted(tab) {
    calls.push(["retire", tab]);
    return mountedTask?.promise ?? Promise.resolve({ ok: true, tabId: tab.id });
  }
});

assert.equal(handlers.length, 5, "the New Tab protocol owns exactly five routes");
assert.equal(new Set(handlers.map(({ type }) => type)).size, 5,
  "each New Tab route has one unique message identity");

const listener = createMessageListener(handlers, {
  onError: (error, type) => errors.push([type, error.message])
});

let syncResponse;
let keepAlive = listener({ type: "scheme-rotation-diagnostics-arm" }, {}, (response) => {
  syncResponse = response;
});
assert.equal(keepAlive, false);
assert.deepEqual(syncResponse, { ok: true, kind: "armed", active: 2, handled: 3 });

counts = { active: 4, handled: 9 };
keepAlive = listener({ type: "scheme-rotation-diagnostics" }, {}, (response) => {
  syncResponse = response;
});
assert.equal(keepAlive, false);
assert.deepEqual(syncResponse, { ok: true, kind: "report", active: 4, handled: 9 },
  "diagnostic reads use current rotation counts rather than captured startup values");

keepAlive = listener({
  type: "scheme-rotation-diagnostics-page-paint",
  bootSelection: { kind: "custom", privateId: "not-forwarded" },
  finalSelection: { kind: "built-in", id: "forest" }
}, { tab: { id: 17 } }, (response) => { syncResponse = response; });
assert.equal(keepAlive, false);
assert.deepEqual(syncResponse, { ok: true, recorded: true });
assert.deepEqual(calls.slice(-3), [
  ["mask", { kind: "custom", privateId: "not-forwarded" }],
  ["mask", { kind: "built-in", id: "forest" }],
  ["record", "page-paint", {
    tabId: 17,
    source: "page",
    before: { masked: "custom" },
    after: { masked: "built-in" }
  }]
], "page-paint routing masks both selections before recording them");

keepAlive = listener({
  type: "scheme-rotation-diagnostics-page-paint"
}, {}, (response) => { syncResponse = response; });
assert.equal(keepAlive, false);
assert.deepEqual(syncResponse, { ok: true, recorded: false });
assert.equal(calls.at(-1)[2].tabId, null,
  "diagnostic paint can be recorded without exposing an invalid sender identity");

const beforeInvalidRotation = calls.length;
const invalidRotation = await invoke(listener, { type: "scheme-rotation-new-tab-ready" });
assert.deepEqual(invalidRotation, {
  keepAlive: true,
  response: { ok: false, reason: "rotation-failed" }
});
assert.equal(calls.length, beforeInvalidRotation,
  "invalid readiness messages cannot record or start rotation work");

rotationTask = deferred();
const pendingRotation = invoke(listener, { type: "scheme-rotation-new-tab-ready" }, {
  tab: { id: 23, windowId: 7 }
});
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(calls.slice(-2), [
  ["record", "readiness-received", { tabId: 23 }],
  ["rotate", 23]
], "readiness is recorded before the exact sender tab begins rotation");
let rotationSettled = false;
void pendingRotation.then(() => { rotationSettled = true; });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(rotationSettled, false, "the response channel stays open for rotation work");
rotationTask.resolve({ ok: true, result: { changed: true } });
assert.deepEqual(await pendingRotation, {
  keepAlive: true,
  response: { ok: true, result: { changed: true } }
});
rotationTask = null;

const beforeInvalidMount = calls.length;
const invalidMount = await invoke(listener, { type: "everytab-new-tab-mounted" }, {
  tab: { id: -1, windowId: 7 }
});
assert.deepEqual(invalidMount, {
  keepAlive: true,
  response: { ok: false, reason: "unavailable" }
});
assert.equal(calls.length, beforeInvalidMount,
  "invalid mounted-page messages cannot start retirement work");

const exactTab = { id: 31, windowId: 8, active: true, pinned: false };
mountedTask = deferred();
const pendingMount = invoke(listener, { type: "everytab-new-tab-mounted" }, { tab: exactTab });
await new Promise((resolve) => setImmediate(resolve));
assert.strictEqual(calls.at(-1)[1], exactTab,
  "mounted-page retirement receives Chrome's exact sender tab record");
mountedTask.reject(new Error("window unavailable"));
assert.deepEqual(await pendingMount, {
  keepAlive: true,
  response: { ok: false, reason: "unavailable" }
});
assert.deepEqual(errors, [["everytab-new-tab-mounted", "window unavailable"]],
  "the shared registry owns rejected-effect containment");

console.log("PASS: New Tab messages have one directly tested handler contract");
