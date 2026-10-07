import assert from "node:assert/strict";
import { createMessageListener } from "../js/lib/message-handler-registry.js";
import { createCloseDayMessageHandlers } from
  "../js/background/close-day-message-handlers.js";

const calls = [];
const errors = [];
let rejectCheck = false;
const closeDay = {
  async capture(options) {
    calls.push(["capture", options]);
    return { ok: true, ...options };
  },
  async updateChoice(...args) {
    calls.push(["choice", ...args]);
    return { ok: true };
  },
  async updateChoices(...args) {
    calls.push(["choices", ...args]);
    return { ok: true };
  },
  async check(draftId) {
    calls.push(["check", draftId]);
    if (rejectCheck) throw new Error("private check failure");
    return { ok: true, fresh: true };
  },
  async updateWindowMode(...args) {
    calls.push(["window-mode", ...args]);
    return { ok: true };
  },
  async discard(draftId) {
    calls.push(["discard", draftId]);
    return draftId !== "missing";
  },
  async commit(draftId) {
    calls.push(["commit", draftId]);
    return { ok: true, status: "committed" };
  },
  async resume(transactionId) {
    calls.push(["resume", transactionId]);
    return { id: transactionId, phase: transactionId === "missing" ? "missing" : "complete" };
  },
  async undo(transactionId) {
    calls.push(["undo", transactionId]);
    return { transactionId, status: transactionId === "done" ? "undone" : "stale" };
  },
  async status() {
    calls.push(["status"]);
    return { draft: { id: "draft" }, pending: null, latest: null };
  }
};
const handlers = createCloseDayMessageHandlers(closeDay);
assert.equal(handlers.length, 10, "Close the day owns its complete ten-route protocol");
assert.equal(new Set(handlers.map(({ type }) => type)).size, 10,
  "each Close-the-day route has one unique message identity");

const listener = createMessageListener(handlers, {
  onError: (error, type) => errors.push([type, error.message])
});
const invoke = (message, sender = {}) => new Promise((resolve) => {
  let keepAlive;
  keepAlive = listener(message, sender, (response) => {
    queueMicrotask(() => resolve({ keepAlive, response }));
  });
});

assert.deepEqual(await invoke(
  { type: "close-day-capture", refresh: true },
  { tab: { id: 19 } }
), {
  keepAlive: true,
  response: { ok: true, protectedTabId: 19, refresh: true }
});
assert.deepEqual(await invoke({ type: "close-day-capture" }), {
  keepAlive: true,
  response: { ok: true, protectedTabId: null, refresh: false }
});

const patch = { action: "snooze" };
assert.deepEqual((await invoke({
  type: "close-day-choice", draftId: "draft", fingerprintKey: "tab", patch
})).response, { ok: true });
assert.deepEqual(calls.at(-1), ["choice", "draft", "tab", patch]);

assert.deepEqual((await invoke({
  type: "close-day-bulk-choice",
  draftId: "draft",
  fingerprintKeys: ["one", "two"],
  patch
})).response, { ok: true });
assert.deepEqual(calls.at(-1), ["choices", "draft", ["one", "two"], patch]);

assert.deepEqual((await invoke({ type: "close-day-check", draftId: "draft" })).response,
  { ok: true, fresh: true });
assert.deepEqual((await invoke({
  type: "close-day-window-mode", draftId: "draft", windowId: 8, mode: "save"
})).response, { ok: true });
assert.deepEqual(calls.at(-1), ["window-mode", "draft", 8, "save"]);

assert.deepEqual((await invoke({ type: "close-day-discard", draftId: "draft" })).response,
  { ok: true });
assert.deepEqual((await invoke({ type: "close-day-commit", draftId: "draft" })).response,
  { ok: true, status: "committed" });

assert.deepEqual((await invoke({
  type: "close-day-resume", transactionId: "transaction"
})).response, {
  ok: true,
  receipt: { id: "transaction", phase: "complete" }
});
assert.equal((await invoke({
  type: "close-day-resume", transactionId: "missing"
})).response.ok, false, "a missing transaction remains a successful lookup with ok false");

assert.deepEqual((await invoke({ type: "close-day-undo", transactionId: "done" })).response, {
  ok: true,
  transactionId: "done",
  status: "undone"
});
assert.equal((await invoke({
  type: "close-day-undo", transactionId: "stale"
})).response.ok, false);

assert.deepEqual((await invoke({ type: "close-day-status" })).response, {
  draft: { id: "draft" }, pending: null, latest: null
});

const callsBeforeInvalid = calls.length;
for (const message of [
  { type: "close-day-capture", refresh: "yes" },
  { type: "close-day-choice", draftId: "", fingerprintKey: "tab", patch },
  { type: "close-day-bulk-choice", draftId: "draft", fingerprintKeys: [""] , patch },
  { type: "close-day-window-mode", draftId: "draft", windowId: -1, mode: "save" },
  { type: "close-day-commit", draftId: " " },
  { type: "close-day-resume", transactionId: "" }
]) await invoke(message);
assert.equal(calls.length, callsBeforeInvalid,
  "invalid review identities and patches cannot reach Close-the-day state");

rejectCheck = true;
assert.deepEqual(await invoke({ type: "close-day-check", draftId: "draft" }), {
  keepAlive: true,
  response: { ok: false, fresh: false }
});
assert.deepEqual(errors, [["close-day-check", "private check failure"]],
  "the shared registry contains review failures behind the public result shape");

const invokeListener = (target, message) => new Promise(resolve => {
  target(message, {}, response => resolve(response));
});
const validMessages = [
  { type: "close-day-capture" },
  { type: "close-day-choice", draftId: "draft", fingerprintKey: "tab", patch },
  { type: "close-day-bulk-choice", draftId: "draft", fingerprintKeys: ["tab"], patch },
  { type: "close-day-check", draftId: "draft" },
  { type: "close-day-window-mode", draftId: "draft", windowId: 8, mode: "save" },
  { type: "close-day-discard", draftId: "draft" },
  { type: "close-day-commit", draftId: "draft" },
  { type: "close-day-resume", transactionId: "transaction" },
  { type: "close-day-undo", transactionId: "done" },
  { type: "close-day-status" }
];
rejectCheck = false;
for (const outcome of ["resolved", "rejected"]) {
  let settle;
  const ready = new Promise((resolve, reject) => {
    settle = outcome === "resolved" ? resolve : () => reject(new Error("Synthetic recovery failure"));
  });
  const gatedHandlers = createCloseDayMessageHandlers({ ...closeDay, ready });
  const gatedListener = createMessageListener(gatedHandlers, { onError() {} });
  const before = calls.length;
  const pending = validMessages.map(message => invokeListener(gatedListener, message));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, before, "every Close-the-day route waits for recovery");
  settle();
  const responses = await Promise.all(pending);
  if (outcome === "resolved") {
    assert.equal(calls.length, before + validMessages.length,
      "successful recovery releases each waiting route once");
  } else {
    assert.equal(calls.length, before, "failed recovery cannot enter any domain operation");
    responses.forEach((response, index) => assert.deepEqual(response,
      gatedHandlers.find(route => route.type === validMessages[index].type).failure,
      "recovery rejection uses each route's existing safe failure projection"));
  }
}

for (const status of ["busy", "incomplete"]) {
  const receipt = { id: "transaction", phase: status === "busy" ? "undoing" : "undo-incomplete" };
  const outcomeListener = createMessageListener(createCloseDayMessageHandlers({
    ...closeDay, async undo() { return { status, receipt }; }
  }));
  assert.deepEqual(await invokeListener(outcomeListener, {
    type: "close-day-undo", transactionId: "transaction"
  }), { ok: false, status, receipt }, "non-success Undo outcomes retain their honest status and receipt");
}

console.log("PASS: Close-the-day messages have one directly tested handler contract");
