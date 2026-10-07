import assert from "node:assert/strict";
import { createMessageListener } from "../js/lib/message-handler-registry.js";
import { createDuplicateMessageHandlers } from
  "../js/background/duplicate-message-handlers.js";

let releaseRecovery;
const ready = new Promise((resolve) => { releaseRecovery = resolve; });
const calls = [];
const errors = [];
let rejectClose = false;
let rejectRule = false;
const handlers = createDuplicateMessageHandlers({
  ready,
  async close(target) {
    calls.push(["close", target]);
    if (rejectClose) throw new Error("private duplicate failure");
    return 2;
  },
  async refreshBadge() {
    calls.push(["badge"]);
  },
  async setRule(hostname, mode) {
    calls.push(["rule", hostname, mode]);
    if (rejectRule) throw new Error("private rule failure");
  }
});

assert.equal(handlers.length, 2, "duplicate closing and exact-domain rules own two public routes");
const listener = createMessageListener(handlers, {
  onError: (error, type) => errors.push([type, error.message])
});
const invoke = (message) => new Promise((resolve) => {
  let keepAlive;
  keepAlive = listener(message, {}, (response) => {
    queueMicrotask(() => resolve({ keepAlive, response }));
  });
});

const close = invoke({ type: "close-duplicates", key: "canonical", tabId: 4 });
await Promise.resolve();
assert.deepEqual(calls, [], "duplicate closing waits for interrupted action recovery");
releaseRecovery();
assert.deepEqual(await close, { keepAlive: true, response: { n: 2 } });
assert.deepEqual(calls, [
  ["close", { key: "canonical", tabId: 4 }],
  ["badge"]
], "the badge reconciles after the close settles and before completion");

const callsBeforeInvalid = calls.length;
assert.deepEqual(await invoke({ type: "close-duplicates", key: 4 }), {
  keepAlive: true,
  response: { n: 0 }
});
assert.deepEqual(await invoke({ type: "close-duplicates", tabId: -1 }), {
  keepAlive: true,
  response: { n: 0 }
});
assert.equal(calls.length, callsBeforeInvalid,
  "invalid duplicate identities cannot reach closing or badge effects");

rejectClose = true;
assert.deepEqual(await invoke({ type: "close-duplicates", key: "canonical" }), {
  keepAlive: true,
  response: { n: 0 }
});
assert.equal(calls.at(-1)[0], "close",
  "a failed close does not publish a misleading badge reconciliation");
assert.deepEqual(errors, [["close-duplicates", "private duplicate failure"]]);

rejectClose = false;
const rule = await invoke({
  type: "set-duplicate-domain-rule", hostname: "tickets.company", mode: "include-fragment"
});
assert.deepEqual(rule, { keepAlive: true, response: { ok: true } });
assert.deepEqual(calls.slice(-2), [
  ["rule", "tickets.company", "include-fragment"], ["badge"]
], "saving a domain rule refreshes the badge after the device-local commit");

const beforeInvalidRule = calls.length;
assert.deepEqual(await invoke({
  type: "set-duplicate-domain-rule", hostname: "tickets.company", mode: "regex"
}), { keepAlive: true, response: { ok: false } });
assert.equal(calls.length, beforeInvalidRule, "unknown duplicate-rule modes cannot reach storage");

rejectRule = true;
assert.deepEqual(await invoke({
  type: "set-duplicate-domain-rule", hostname: "tickets.company", mode: "skip"
}), { keepAlive: true, response: { ok: false } });
assert.deepEqual(errors.at(-1), ["set-duplicate-domain-rule", "private rule failure"]);

console.log("PASS: duplicate closing and domain rules have directly tested handler contracts");
