// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "./failure-diagnostic.js";
// Most reloads settle in one frame or two. Repair retained Error 5 documents
// promptly, then keep progressively later passes for slower Chrome teardown.
// Every pass is serialized and idempotent; the long-established 2s and 8s
// passes remain as the no-loss safety net.
export const SUSPEND_RELOAD_RECOVERY_DELAYS_MS = Object.freeze([
  180,
  650,
  2_000,
  8_000
]);

export const MAX_RECOVERY_NOTIFICATION_ATTEMPTS = 3;

/**
 * Keep one notification identity within a recovery cycle, but never reuse it
 * for a later reload. Some notification platforms suppress a newly created
 * banner when Chrome clears and immediately recreates the same global id.
 */
export function recoveryNotificationId(cycleId) {
  return `suspend-recovered:${String(cycleId || "unknown")}`;
}

/**
 * The immediate explanation must not share the final receipt's identity.
 * Updating a notification can change Notification Center without raising a
 * second banner, and a very fast update can replace the explanation before the
 * operating system has shown it at all.
 */
export function recoveryStartingNotificationId(cycleId) {
  return `suspend-recovering:${String(cycleId || "unknown")}`;
}

/** Pure transition for the durable, bounded recovery-notification receipt. */
export function advanceRecoveryNotification(cycle, { delivered, now = Date.now() }) {
  const notificationAttempts = Math.max(0, Number(cycle?.notificationAttempts) || 0) + 1;
  if (delivered) {
    return {
      ...cycle,
      notificationAttempts,
      notificationState: "notified",
      notifiedAt: now
    };
  }
  if (notificationAttempts >= MAX_RECOVERY_NOTIFICATION_ATTEMPTS) {
    return {
      ...cycle,
      notificationAttempts,
      notificationState: "failed",
      notificationFailedAt: now
    };
  }
  return { ...cycle, notificationAttempts, notificationState: "pending" };
}

/** Back off after the first quick retry without leaving a permanent alarm loop. */
export function recoveryNotificationRetryDelay(attempts) {
  return Math.max(0, Number(attempts) || 0) <= 1 ? 5_000 : 30_000;
}

/** A later safety pass reopens notification delivery without duplicating it. */
export function recoveryNotificationStateAfterRecovery(cycle) {
  if (!cycle?.complete || cycle.notificationState === "failed") {
    return cycle?.notificationState;
  }
  return "pending";
}

/**
 * Schedule serialized, idempotent suspended-tab recovery passes after an
 * extension reload. Ordinary browser startup is deliberately inert because
 * Chrome owns session restoration and may still be rebuilding its windows.
 *
 * @param {{recoveringReload?: boolean, runPass: () => unknown,
 *   onPassComplete?: (recovered:number) => unknown,
 *   onReadyToNotify?: (recovered:number) => unknown,
 *   onBatchComplete?: (recovered:number) => unknown,
 *   onError?: (error:unknown) => unknown, setTimer?: typeof setTimeout}} options
 */
export function scheduleSuspendRecoveryPasses({
  recoveringReload = false,
  runPass,
  onPassComplete = () => {},
  onReadyToNotify = () => {},
  onBatchComplete = () => {},
  onError = (error) => reportFailure("suspended-recovery-scheduled", error),
  setTimer = setTimeout
}) {
  if (!recoveringReload) {
    void Promise.resolve(onBatchComplete(0)).catch(onError);
    return;
  }
  let remaining = SUSPEND_RELOAD_RECOVERY_DELAYS_MS.length;
  let completedScheduledPasses = 0;
  let recovered = 0;
  const pass = async ({ scheduled = false } = {}) => {
    try {
      const count = await runPass();
      const safeCount = Math.max(0, Number(count) || 0);
      recovered += safeCount;
      await onPassComplete(safeCount);
    } finally {
      if (scheduled) completedScheduledPasses += 1;
      remaining -= 1;
      if (recoveringReload && completedScheduledPasses === 2) {
        await onReadyToNotify(recovered);
      }
      if (remaining === 0) await onBatchComplete(recovered);
    }
  };
  const guardedPass = (options) => pass(options).catch(onError);
  for (const delay of SUSPEND_RELOAD_RECOVERY_DELAYS_MS) {
    setTimer(() => guardedPass({ scheduled: true }), delay);
  }
}
