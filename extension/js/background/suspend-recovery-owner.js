// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
import { formatNumber, msg as localeMessage } from "../lib/i18n.js";
import {
  SUSPEND_RECOVERY_CYCLE_KEY, SUSPEND_REGISTRY_KEY,
  refreshAlreadyReadyRecoveryOccurrences
} from "../lib/suspend.js";
import {
  advanceRecoveryNotification,
  recoveryNotificationId,
  recoveryStartingNotificationId,
  recoveryNotificationRetryDelay,
  scheduleSuspendRecoveryPasses
} from "../lib/suspend-recovery-schedule.js";
import { RECOVERY_ALARM } from "./alarm-owner.js";

const SUSPEND_RECOVERY_SESSION_CLAIM_KEY = "suspendRecoverySessionClaim";

/**
 * Own one suspended-tab reload recovery cycle from browser repair through its
 * durable notification receipt. Callers only start a cycle or resume the two
 * alarm-driven tails; cycle shape, prompt ordering, and retry identity stay
 * private to this module.
 *
 * @param {{
 *   mutateStore: (keys: string[], mutator: (maps: object) => object|null) => Promise<unknown>,
 *   readStore: (key: string) => Promise<object|null>,
 *   recover: (options: object) => Promise<number>,
 *   repairMetadata: (options: object) => Promise<number>,
 *   refreshReady?: (cycleId: string) => Promise<void>,
 *   setTimer?: typeof setTimeout
 * }} dependencies
 */
export function createSuspendRecoveryOwner({
  mutateStore,
  readStore,
  recover,
  repairMetadata,
  refreshReady = refreshAlreadyReadyRecoveryOccurrences,
  setTimer = setTimeout
}) {
  // A visible browser result must not wait behind the durable Store queue.
  // Retain the in-flight starting request by cycle so the final receipt cannot
  // race ahead of it. The two phases deliberately use separate notification
  // identities because platform updates do not reliably raise a second banner.
  const promptNotifications = new Map();
  // Whether the starting banner was shown, by cycle, so completion can clear
  // it. It is a separate identity from the final receipt and never updated.
  const startingNotifications = new Map();
  const deliveries = new Map();

  async function begin({ recoveringReload = false, recoveryPreparation = null } = {}) {
    const id = recoveryPreparation?.cycleId || crypto.randomUUID();
    await mutateStore([SUSPEND_RECOVERY_CYCLE_KEY, SUSPEND_REGISTRY_KEY], (maps) => {
      const registry = maps[SUSPEND_REGISTRY_KEY] ?? {};
      let upgraded = false;
      for (const entry of Object.values(registry)) {
        if (entry && !entry.recoveryOccurrenceId) {
          entry.recoveryOccurrenceId = crypto.randomUUID();
          upgraded = true;
        }
      }
      return {
        ...(upgraded ? { [SUSPEND_REGISTRY_KEY]: registry } : {}),
        [SUSPEND_RECOVERY_CYCLE_KEY]: {
          id,
          kind: "reload",
          attemptedOccurrenceIds: [],
          recoveredOccurrenceIds: [],
          initialOccurrenceIds: [...new Set(Object.values(registry)
            .map(entry => entry?.recoveryOccurrenceId).filter(Boolean))],
          alreadyReadyOccurrenceIds: [],
          startedAt: Date.now(),
          complete: false,
          notificationAttempts: 0,
          notificationState: "collecting"
        }
      };
    });
    // storage.session survives worker suspension but not a browser restart.
    // The durable cycle alone therefore cannot authorize browser mutations:
    // an interrupted reload may resume in this Chrome session, while the same
    // alarm after relaunch must be retired and left to Chrome session restore.
    await chrome.storage.session.set({ [SUSPEND_RECOVERY_SESSION_CLAIM_KEY]: id });
    return id;
  }

  async function sessionOwnsCycle(cycleId) {
    try {
      const stored = await chrome.storage.session.get(SUSPEND_RECOVERY_SESSION_CLAIM_KEY);
      return stored[SUSPEND_RECOVERY_SESSION_CLAIM_KEY] === cycleId;
    } catch {
      return false;
    }
  }

  async function retireCycle(cycle) {
    let retired = cycle;
    await mutateStore([SUSPEND_RECOVERY_CYCLE_KEY], (maps) => {
      const current = maps[SUSPEND_RECOVERY_CYCLE_KEY];
      if (!current || current.id !== cycle.id) return null;
      retired = {
        ...current,
        total: 0,
        summaryTotal: 0,
        alreadyReadyOccurrenceIds: [],
        complete: true,
        completedAt: Date.now(),
        notificationState: "none"
      };
      return { [SUSPEND_RECOVERY_CYCLE_KEY]: retired };
    });
    await chrome.alarms.clear(RECOVERY_ALARM);
    return retired;
  }

  async function complete(cycleId) {
    const before = await readStore(SUSPEND_RECOVERY_CYCLE_KEY);
    if (before?.id === cycleId && before.initialOccurrenceIds?.length) await refreshReady(cycleId);
    let result = null;
    await mutateStore([SUSPEND_RECOVERY_CYCLE_KEY], (maps) => {
      const current = maps[SUSPEND_RECOVERY_CYCLE_KEY];
      if (!current || current.id !== cycleId) return null;
      // Later settling passes must retain the first completion and its
      // delivery receipt. A genuinely new occurrence reopens the receipt in
      // the suspend domain at its own atomic record boundary.
      if (current.complete) {
        result = current;
        return null;
      }
      const total = new Set(current.recoveredOccurrenceIds ?? []).size;
      const summaryTotal = current.summaryTotal ?? new Set([
        ...(current.recoveredOccurrenceIds ?? []), ...(current.alreadyReadyOccurrenceIds ?? [])
      ]).size;
      result = {
        ...current,
        total,
        summaryTotal,
        complete: true,
        completedAt: Date.now(),
        notificationState: summaryTotal > 0 ? "pending" : "none"
      };
      return { [SUSPEND_RECOVERY_CYCLE_KEY]: result };
    });
    return result;
  }

  async function recordNotificationOutcome(cycleId, delivered, total, includesReady) {
    let result = null;
    await mutateStore([SUSPEND_RECOVERY_CYCLE_KEY], (maps) => {
      const current = maps[SUSPEND_RECOVERY_CYCLE_KEY];
      if (!current || current.id !== cycleId || current.notificationState !== "pending") {
        return null;
      }
      if ((current.summaryTotal ?? current.total) !== total ||
          ((current.alreadyReadyOccurrenceIds?.length ?? 0) > 0) !== includesReady) return null;
      result = advanceRecoveryNotification(current, { delivered });
      return { [SUSPEND_RECOVERY_CYCLE_KEY]: result };
    });
    return result;
  }

  async function notifyRecovered(total, { fresh = false, notificationId, includesReady = false } = {}) {
    try {
      const title = includesReady
        ? localeMessage("notification_ready_suspended_title")
        : localeMessage("notification_recovered_suspended_title");
      const message = includesReady
        ? (total === 1
            ? localeMessage("notification_ready_suspended_one")
            : localeMessage("notification_ready_suspended_other", [formatNumber(total)]))
        : (total === 1
            ? localeMessage("notification_recovered_suspended_one")
            : localeMessage("notification_recovered_suspended_other", [formatNumber(total)]));
      const updated = !fresh && typeof chrome.notifications.update === "function"
        ? await chrome.notifications.update(notificationId, {
            title,
            message
          })
        : false;
      if (updated) return true;
      await chrome.notifications.create(notificationId, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon.png"),
        title,
        message
      });
      return true;
    } catch (error) {
      reportFailure("recovery notification", error);
      return false;
    }
  }

  async function notifyRecoveryStarting(cycleId) {
    try {
      await chrome.notifications.create(recoveryStartingNotificationId(cycleId), {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon.png"),
        title: localeMessage("notification_recovery_starting_title"),
        message: localeMessage("notification_recovery_starting_message")
      });
      return true;
    } catch (error) {
      reportFailure("recovery start notification", error);
      return false;
    }
  }

  async function registryHasSuspendedOccurrences() {
    try {
      const registry = await readStore(SUSPEND_REGISTRY_KEY);
      return Object.values(registry ?? {}).some(Boolean);
    } catch (error) {
      reportFailure("recovery start notification", error);
      return false;
    }
  }

  function prepareReload() {
    const cycleId = crypto.randomUUID();
    // The banner explains tabs that are about to reopen. A first install or a
    // reload with nothing suspended has nothing to explain, so read the
    // registry before showing it. Completion clears whatever was shown.
    const starting = registryHasSuspendedOccurrences()
      .then((hasSuspended) => (hasSuspended ? notifyRecoveryStarting(cycleId) : false));
    startingNotifications.set(cycleId, starting);
    const promise = starting.then((delivered) => ({ total: null, delivered }));
    promptNotifications.set(cycleId, { total: null, promise });
    return Object.freeze({ cycleId });
  }

  async function clearStartingNotification(cycleId) {
    const starting = startingNotifications.get(cycleId);
    startingNotifications.delete(cycleId);
    if (!starting || !(await starting)) return;
    try {
      await chrome.notifications.clear?.(recoveryStartingNotificationId(cycleId));
    } catch { /* best effort */ }
  }

  async function cancelPreparedReload(preparation) {
    const cycleId = preparation?.cycleId;
    if (!cycleId) return;
    promptNotifications.delete(cycleId);
    await clearStartingNotification(cycleId);
  }

  function requestPromptNotification(cycleId, total) {
    const notificationId = recoveryNotificationId(cycleId);
    const previous = promptNotifications.get(cycleId);
    const promise = previous
      ? previous.promise.then(async (result) => {
          if (result.delivered && result.total === total) return result;
          return {
            total,
            delivered: await notifyRecovered(total, {
              fresh: result.total === null || !result.delivered, notificationId
            })
          };
        })
      : notifyRecovered(total, { fresh: true, notificationId })
          .then((delivered) => ({ total, delivered }));
    const owned = promise.catch((error) => {
      reportFailure("prompt recovery notification", error);
      return { total, delivered: false };
    });
    promptNotifications.set(cycleId, { total, promise: owned });
    return owned;
  }

  async function deliverCurrent(cycle) {
    if (cycle?.complete && cycle.notificationState === "none") {
      // Recovery completed with nothing to report; the banner is stale.
      await clearStartingNotification(cycle.id);
    }
    if (!cycle?.complete || cycle.notificationState !== "pending") return cycle;
    const attempts = Math.max(0, Number(cycle.notificationAttempts) || 0);
    // alarm-fallback: the retry only matters if this worker stops before the
    // receipt settles; a packed-build 30 s minimum is acceptable for it.
    chrome.alarms.create(RECOVERY_ALARM, {
      when: Date.now() + recoveryNotificationRetryDelay(attempts)
    });
    const notificationId = recoveryNotificationId(cycle.id);
    const prompt = promptNotifications.get(cycle.id);
    const promptOutcome = prompt ? await prompt.promise : null;
    // The starting banner or an earlier delivery can be slow. Revalidate
    // retained pages after that wait, immediately before claiming readiness.
    if (cycle.initialOccurrenceIds?.length) {
      await refreshReady(cycle.id);
      const current = await readStore(SUSPEND_RECOVERY_CYCLE_KEY);
      if (current?.id !== cycle.id) return current;
      cycle = current;
    }
    const total = cycle.summaryTotal ?? cycle.total ?? new Set(cycle.recoveredOccurrenceIds ?? []).size;
    const includesReady = (cycle.alreadyReadyOccurrenceIds?.length ?? 0) > 0;
    if (total <= 0 || cycle.notificationState !== "pending") {
      if (cycle.notificationState === "none") await chrome.alarms.clear(RECOVERY_ALARM);
      return cycle;
    }
    const delivered = !includesReady && promptOutcome?.delivered && promptOutcome.total === total
      ? true
      : await notifyRecovered(total, { fresh: attempts === 0, notificationId, includesReady });
    const outcome = await recordNotificationOutcome(cycle.id, delivered, total, includesReady);
    // Never let an older attempt clear a newer cycle's alarm.
    if (outcome?.id === cycle.id && outcome.notificationState !== "pending") {
      await chrome.alarms.clear(RECOVERY_ALARM);
      // The final receipt now carries the result; the starting banner is done.
      await clearStartingNotification(cycle.id);
    }
    return outcome ?? cycle;
  }

  function deliver(cycle) {
    if (!cycle?.id) return Promise.resolve(cycle);
    if (deliveries.has(cycle.id)) return deliveries.get(cycle.id);
    const task = deliverCurrent(cycle).finally(() => deliveries.delete(cycle.id));
    deliveries.set(cycle.id, task);
    return task;
  }

  async function notifyCycle(cycleId) {
    return deliver(await complete(cycleId));
  }

  async function completeAndNotify(cycleId) {
    return deliver(await complete(cycleId));
  }

  function start({
    recoveringReload = false,
    recoveryPreparation = null,
    onInitialPassSettled = () => {}
  } = {}) {
    // Ordinary Chrome startup owns its own session restoration. Starting an
    // extension reconstruction cycle while that work is incomplete can create
    // tabs/windows Chrome was already about to restore. Keep this guard here as
    // defense in depth even though the runtime lifecycle also opts out.
    if (!recoveringReload) {
      onInitialPassSettled();
      return Promise.resolve(null);
    }
    const preparedReload = recoveringReload
      ? (recoveryPreparation ?? prepareReload())
      : null;
    let initialPassSettled = false;
    const settleInitialPass = () => {
      if (initialPassSettled) return;
      initialPassSettled = true;
      onInitialPassSettled();
    };
    return begin({ recoveringReload, recoveryPreparation: preparedReload }).then(async (cycleId) => {
      scheduleSuspendRecoveryPasses({
        recoveringReload,
        runPass: async () => {
          try {
            return await recover({
              recoveryCycleId: cycleId,
              onBrowserRecoveryComplete: (total, { deferSummary = false } = {}) => {
                if (!deferSummary) requestPromptNotification(cycleId, total);
              }
            });
          } catch (error) {
            reportFailure("suspended-tab recovery pass", error);
            return 0;
          } finally {
            // Zero recovered tabs and failed passes also release startup
            // maintenance; later safety passes do not launch it again.
            settleInitialPass();
          }
        },
        onPassComplete: () => completeAndNotify(cycleId),
        onReadyToNotify: () => completeAndNotify(cycleId),
        onBatchComplete: async () => {
          promptNotifications.delete(cycleId);
          // Every pass has run. Whatever happened, the "about to reopen"
          // explanation is no longer true and must not linger.
          await clearStartingNotification(cycleId);
        },
        setTimer
      });
      // Worker-death fallback for the final pass; 31 s is above the packed
      // alarm minimum by design.
      chrome.alarms.create(RECOVERY_ALARM, { when: Date.now() + 31_000 });
      return cycleId;
    }).catch(async (error) => {
      reportFailure("suspended-tab recovery cycle", error);
      await cancelPreparedReload(preparedReload);
      settleInitialPass();
      return null;
    });
  }

  async function finishInterrupted() {
    const cycle = await readStore(SUSPEND_RECOVERY_CYCLE_KEY);
    if (!cycle?.id) return cycle;
    if (cycle.kind !== "reload" || !await sessionOwnsCycle(cycle.id)) {
      return retireCycle(cycle);
    }
    if (!cycle.complete) {
      await recover({
        allowReloadRepair: cycle.kind === "reload",
        recoveryCycleId: cycle.id
      });
    }
    return completeAndNotify(cycle.id);
  }

  async function repairLateMetadata() {
    const cycle = await readStore(SUSPEND_RECOVERY_CYCLE_KEY);
    if (!cycle?.id || cycle.kind !== "reload" || !await sessionOwnsCycle(cycle.id)) {
      return cycle;
    }
    const recovered = await repairMetadata({
      allowReloadRepair: cycle.kind === "reload",
      recoveryCycleId: cycle.id
    });
    return recovered > 0 ? notifyCycle(cycle.id) : cycle;
  }

  return Object.freeze({
    prepareReload,
    cancelPreparedReload,
    start,
    finishInterrupted,
    repairLateMetadata
  });
}
