import assert from "node:assert/strict";
import { createMessageListener } from "../js/lib/message-handler-registry.js";
import { createJournalMessageHandlers } from
  "../js/background/journal-message-handlers.js";

let releaseRecovery;
const ready = new Promise((resolve) => { releaseRecovery = resolve; });
const calls = [];
const errors = [];
let rejectClear = false;
const handlers = createJournalMessageHandlers({
  ready,
  async undo(id) {
    calls.push(["undo", id]);
    return id === "missing"
      ? { status: "unavailable", entry: null }
      : { status: "undone", entry: { id: id ?? "latest" } };
  },
  async clear() {
    calls.push(["clear"]);
    if (rejectClear) throw new Error("private clear failure");
    return { ok: true, cleared: 3 };
  }
});

assert.equal(handlers.length, 2, "the action journal owns exactly two public routes");
assert.equal(new Set(handlers.map(({ type }) => type)).size, 2,
  "each action-journal route has one unique message identity");

const listener = createMessageListener(handlers, {
  onError: (error, type) => errors.push([type, error.message])
});
const invoke = (message) => new Promise((resolve) => {
  let keepAlive;
  keepAlive = listener(message, {}, (response) => {
    queueMicrotask(() => resolve({ keepAlive, response }));
  });
});

const undo = invoke({ type: "undo-last", id: "action-one" });
const clear = invoke({ type: "clear-journal" });
await Promise.resolve();
assert.deepEqual(calls, [], "journal commands wait for interrupted action recovery");
releaseRecovery();
assert.deepEqual(await undo, {
  keepAlive: true,
  response: { ok: true, status: "undone", entry: { id: "action-one" } }
});
assert.deepEqual(await clear, {
  keepAlive: true,
  response: { ok: true, cleared: 3 }
});

assert.deepEqual((await invoke({ type: "undo-last" })).response, {
  ok: true,
  status: "undone",
  entry: { id: "latest" }
}, "an omitted identity preserves latest-action semantics");
assert.deepEqual((await invoke({ type: "undo-last", id: "missing" })).response, {
  ok: false,
  status: "unavailable",
  entry: null
});

const callsBeforeInvalid = calls.length;
assert.deepEqual(await invoke({ type: "undo-last", id: 4 }), {
  keepAlive: true,
  response: { ok: false, status: "unavailable", entry: null }
});
assert.equal(calls.length, callsBeforeInvalid,
  "an invalid Undo identity cannot reach journal state");

rejectClear = true;
assert.deepEqual(await invoke({ type: "clear-journal" }), {
  keepAlive: true,
  response: { ok: false }
});
assert.deepEqual(errors, [["clear-journal", "private clear failure"]],
  "the shared registry contains journal failures behind the public result shape");

console.log("PASS: action-journal messages have one directly tested handler contract");
