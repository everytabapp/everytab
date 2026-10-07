import assert from "node:assert/strict";
import { createRecoveryMessageHandlers } from
  "../js/background/recovery-message-handlers.js";
import { createMessageListener } from "../js/lib/message-handler-registry.js";

const calls = [];
const errors = [];
let rejectReview = false;
const handlers = createRecoveryMessageHandlers({
  recentlyClosed: {
    async inspect() {
      calls.push(["inspect-recent"]);
      return { ok: true, candidates: [{ sessionId: "recent-one" }] };
    },
    async recover(sessionIds) {
      calls.push(["recover-recent", sessionIds]);
      return { ok: true, requested: sessionIds.length, restored: sessionIds.length };
    }
  },
  snapshots: {
    async inspect() {
      calls.push(["inspect-snapshots"]);
      return { ok: true, snapshots: [{ id: "snapshot-one" }] };
    },
    async review(snapshotId) {
      calls.push(["review-snapshot", snapshotId]);
      if (rejectReview) throw new Error("private review failure");
      return { ok: true, snapshot: { id: snapshotId }, candidates: [] };
    },
    async recover(snapshotId, pickKeys) {
      calls.push(["recover-snapshot", snapshotId, pickKeys]);
      return { ok: true, requested: pickKeys.length, restored: pickKeys.length };
    }
  }
});

assert.equal(handlers.length, 5, "the Data recovery protocol owns exactly five routes");
assert.equal(new Set(handlers.map(({ type }) => type)).size, 5,
  "each Data recovery route has one unique message identity");

const listener = createMessageListener(handlers, {
  onError: (error, type) => errors.push([type, error.message])
});
const invoke = (message) => new Promise((resolve) => {
  let keepAlive;
  keepAlive = listener(message, {}, (response) => {
    queueMicrotask(() => resolve({ keepAlive, response }));
  });
});

assert.deepEqual(await invoke({ type: "inspect-recently-closed-suspended" }), {
  keepAlive: true,
  response: { ok: true, candidates: [{ sessionId: "recent-one" }] }
});
assert.deepEqual(await invoke({
  type: "recover-recently-closed-suspended",
  sessionIds: ["recent-one", "recent-two"]
}), {
  keepAlive: true,
  response: { ok: true, requested: 2, restored: 2 }
});
assert.deepEqual(calls.at(-1), ["recover-recent", ["recent-one", "recent-two"]],
  "selected Chrome session identities cross unchanged");

const callsBeforeRecentOverflow = calls.length;
assert.deepEqual(await invoke({
  type: "recover-recently-closed-suspended",
  sessionIds: Array.from({ length: 26 }, (_, index) => `recent-${index}`)
}), {
  keepAlive: true,
  response: { ok: false, requested: 0, restored: 0, failed: 0, unavailable: 0 }
});
assert.equal(calls.length, callsBeforeRecentOverflow,
  "recently closed recovery cannot exceed Chrome's bounded 25-entry inspection");

assert.deepEqual(await invoke({ type: "inspect-snapshot-recovery" }), {
  keepAlive: true,
  response: { ok: true, snapshots: [{ id: "snapshot-one" }] }
});
assert.deepEqual(await invoke({
  type: "review-snapshot-recovery",
  snapshotId: "snapshot-one"
}), {
  keepAlive: true,
  response: { ok: true, snapshot: { id: "snapshot-one" }, candidates: [] }
});
assert.deepEqual(await invoke({
  type: "recover-snapshot-missing-tabs",
  snapshotId: "snapshot-one",
  pickKeys: ["window-one:tab-one", "window-one:tab-two"]
}), {
  keepAlive: true,
  response: { ok: true, requested: 2, restored: 2 }
});
assert.deepEqual(calls.at(-1), [
  "recover-snapshot",
  "snapshot-one",
  ["window-one:tab-one", "window-one:tab-two"]
]);

const callsBeforeEmptyPick = calls.length;
assert.deepEqual(await invoke({
  type: "recover-snapshot-missing-tabs",
  snapshotId: "snapshot-one",
  pickKeys: []
}), {
  keepAlive: true,
  response: { ok: false, requested: 0, restored: 0, windows: 0, unavailable: 0, failed: 0 }
});
assert.equal(calls.length, callsBeforeEmptyPick,
  "Snapshot recovery requires an explicit non-empty selection");

const callsBeforeSnapshotOverflow = calls.length;
assert.deepEqual(await invoke({
  type: "recover-snapshot-missing-tabs",
  snapshotId: "snapshot-one",
  pickKeys: Array.from({ length: 1001 }, (_, index) => `pick-${index}`)
}), {
  keepAlive: true,
  response: { ok: false, requested: 0, restored: 0, windows: 0, unavailable: 0, failed: 0 }
});
assert.equal(calls.length, callsBeforeSnapshotOverflow,
  "Snapshot recovery retains its 1,000-selection safety bound");

rejectReview = true;
assert.deepEqual(await invoke({
  type: "review-snapshot-recovery",
  snapshotId: "snapshot-two"
}), {
  keepAlive: true,
  response: { ok: false, reason: "review-failed", snapshot: null, candidates: [] }
});
assert.deepEqual(errors, [["review-snapshot-recovery", "private review failure"]],
  "the shared registry contains domain failures behind the public response shape");

console.log("PASS: Data recovery messages have one directly tested handler contract");
