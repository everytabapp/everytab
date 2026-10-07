import assert from "node:assert/strict";
import {
  advanceRecoveryNotification,
  MAX_RECOVERY_NOTIFICATION_ATTEMPTS,
  recoveryNotificationId,
  recoveryStartingNotificationId,
  recoveryNotificationStateAfterRecovery,
  recoveryNotificationRetryDelay,
  scheduleSuspendRecoveryPasses,
  SUSPEND_RELOAD_RECOVERY_DELAYS_MS
} from "../js/lib/suspend-recovery-schedule.js";

const firstCycleNotificationId = recoveryNotificationId("first-cycle");
const retriedFirstCycleNotificationId = recoveryNotificationId("first-cycle");
const secondCycleNotificationId = recoveryNotificationId("second-cycle");
const firstCycleStartingId = recoveryStartingNotificationId("first-cycle");
assert.equal(firstCycleNotificationId, retriedFirstCycleNotificationId,
  "worker retries in one recovery cycle must retain one notification identity");
assert.notEqual(firstCycleNotificationId, secondCycleNotificationId,
  "a later reload must not reuse an identity the platform may treat as an old banner");
assert.match(firstCycleNotificationId, /^suspend-recovered:/,
  "recovery notification identities must stay recognizable in diagnostics");
assert.match(firstCycleStartingId, /^suspend-recovering:/);
assert.notEqual(firstCycleStartingId, firstCycleNotificationId,
  "the immediate explanation and final receipt must surface independently");

let notification = { notificationAttempts: 0, notificationState: "pending" };
for (let attempt = 1; attempt <= MAX_RECOVERY_NOTIFICATION_ATTEMPTS; attempt += 1) {
  notification = advanceRecoveryNotification(notification, { delivered: false, now: attempt });
}
assert.equal(notification.notificationState, "failed",
  "repeated notification API failures must terminate instead of recreating the alarm forever");
assert.equal(notification.notificationAttempts, MAX_RECOVERY_NOTIFICATION_ATTEMPTS);
assert.ok(recoveryNotificationRetryDelay(2) > recoveryNotificationRetryDelay(0),
  "later notification retries must back off");
assert.equal(
  advanceRecoveryNotification({ notificationAttempts: 1 }, { delivered: true, now: 9 }).notificationState,
  "notified"
);
assert.equal(recoveryNotificationStateAfterRecovery({
  complete: true, notificationState: "none"
}), "pending", "a late recovered tab must reopen notification delivery");
assert.equal(recoveryNotificationStateAfterRecovery({
  complete: true, notificationState: "notified"
}), "pending", "a stable notification id can be updated with a later recovered tab");
assert.equal(recoveryNotificationStateAfterRecovery({
  complete: true, notificationState: "failed"
}), "failed", "a terminal delivery failure remains bounded");

const timers = [];
let passes = 0;
const completed = [];
const readyToNotify = [];
const passCounts = [];
scheduleSuspendRecoveryPasses({
  recoveringReload: true,
  runPass: () => { passes += 1; return passes <= 2 ? 1 : 0; },
  onPassComplete: (recovered) => passCounts.push(recovered),
  onReadyToNotify: (recovered) => readyToNotify.push(recovered),
  onBatchComplete: (recovered) => completed.push(recovered),
  setTimer: (callback, delay) => timers.push({ callback, delay })
});

assert.equal(passes, 0, "reload recovery must not run synchronously inside onInstalled");
assert.deepEqual(timers.map(({ delay }) => delay), SUSPEND_RELOAD_RECOVERY_DELAYS_MS);
assert.ok(timers[0]?.delay <= 250,
  `the first suspended-tab repair waits ${timers[0]?.delay} ms; expected at most 250 ms`);
assert.ok(timers.some(({ delay }) => delay >= 2_000),
  "reload recovery must retain a later safety pass after the fast repair");

await timers[0].callback();
assert.deepEqual(readyToNotify, [],
  "the first fast pass leaves one short settling window for Chrome teardown");
await timers[1].callback();
assert.deepEqual(readyToNotify, [2],
  "the second fast pass releases one consolidated notification");
assert.ok(timers[1].delay <= 750,
  `recovery notification waited ${timers[1].delay} ms; expected at most 750 ms`);
await Promise.all(timers.slice(2).map(({ callback }) => callback()));
assert.equal(passes, timers.length, "every scheduled recovery pass must remain active");
assert.deepEqual(passCounts, [1, 1, 0, 0],
  "each pass is durably receiptable before the aggregate notification runs");
assert.deepEqual(completed, [2],
  "the scheduler reports one aggregate after every retry has settled");

const errors = [];
const rejectedTimers = [];
scheduleSuspendRecoveryPasses({
  recoveringReload: true,
  runPass: () => Promise.reject(new Error("worker stopped")),
  onError: (error) => errors.push(error.message),
  setTimer: (callback) => rejectedTimers.push(callback)
});
await Promise.all(rejectedTimers.map((callback) => callback()));
assert.equal(errors.length, rejectedTimers.length,
  "every rejected scheduled pass is owned instead of becoming unhandled");

let ordinaryPasses = 0;
let ordinaryCompleted = 0;
const ordinaryTimers = [];
scheduleSuspendRecoveryPasses({
  runPass: () => { ordinaryPasses += 1; return 0; },
  onBatchComplete: () => { ordinaryCompleted += 1; },
  setTimer: (callback) => ordinaryTimers.push(callback)
});
assert.equal(ordinaryPasses, 0,
  "ordinary browser startup leaves Chrome's session restoration untouched");
assert.equal(ordinaryTimers.length, 0,
  "ordinary browser startup schedules no delayed suspended-tab mutation");
await Promise.all(ordinaryTimers.map((callback) => callback()));
await Promise.resolve();
assert.equal(ordinaryCompleted, 1, "the inert ordinary path still settles its owner callback");

console.log(`PASS: first reload repair is scheduled after ${timers[0].delay} ms with safety retries`);
