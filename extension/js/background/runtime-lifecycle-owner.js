// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
import { SUSPEND_METADATA_REPAIR_ALARM } from "./alarm-owner.js";

async function runRuntimeTask(name, work) {
  try {
    await work();
  } catch (error) {
    reportFailure(name, error);
  }
}

function scheduleRuntimeTask(name, work, delayMs) {
  setTimeout(() => {
    void runRuntimeTask(name, work);
  }, delayMs);
}

async function recoverFocusAfterReload(focus) {
  await focus.markGuardGrace();
  const initialRecovery = [
    runRuntimeTask("Focus guard recovery", focus.recoverGuard),
    runRuntimeTask("Focus tab recovery", focus.recoverGuardTabs)
  ];
  scheduleRuntimeTask("delayed Focus tab recovery", focus.recoverGuardTabs, 2_000);
  scheduleRuntimeTask("delayed Focus tab recovery", focus.recoverGuardTabs, 8_000);
  await Promise.all(initialRecovery);
}

async function recoverFocusAfterBrowserStart(focus) {
  await focus.markGuardGrace();
  await runRuntimeTask("Focus guard recovery", focus.recoverGuard);
}

/**
 * Own extension installation and browser-start ordering. Domain modules retain
 * their storage and recovery behavior; this module establishes authority and
 * grace before those operations may read product state.
 *
 * @param {{
 *   storage: { initialize: () => Promise<unknown> },
 *   menus: { install: () => unknown },
 *   worker: {
 *     prepareReload: () => (() => void),
 *     start: (options?: {recoveringReload?: boolean,recoveryPreparation?: object|null,
 *       recoverSuspendedTabs?: boolean,captureStartupSnapshot?: boolean}) => unknown
 *   },
 *   newTabs: { resetCreationOrder: () => unknown },
 *   activity: { beginBrowserSession: () => Promise<unknown> },
 *   protection?: { beginBrowserSession: () => Promise<unknown> },
 *   suspension: {
 *     prepareReload?: () => object,
 *     cancelPreparedReload?: (preparation: object) => Promise<unknown>|unknown,
 *     markReloadGrace: () => Promise<unknown>,
 *     repairRecoveryMetadata?: () => Promise<unknown>
 *   },
 *   focus: {
 *     claimGuardLifecycle: () => unknown,
 *     markGuardGrace: () => Promise<unknown>,
 *     recoverGuard: () => Promise<unknown>,
 *     recoverGuardTabs: () => Promise<unknown>
 *   },
 *   openDashboard: () => Promise<unknown>
 * }} domains
 */
export function installRuntimeLifecycleOwner({
  storage,
  menus,
  worker,
  newTabs,
  activity,
  protection,
  suspension,
  focus,
  openDashboard
}) {
  // Invariant: only one lifecycle path may reconstruct suspended pages per
  // worker. An extension `install` or `update` (the user reloaded, or a Store
  // update applied while Chrome runs) invalidates EveryTab's own pages, so it
  // owns the reload cycle. `chrome_update` and `shared_module_update` arrive
  // with a browser launch where Chrome restores its own session; onStartup
  // owns that path and never reconstructs. An `update` can also be applied at
  // browser launch (pending while Chrome was closed): onStartup claims the
  // browser session synchronously and the update path yields to that claim
  // right before it would start the cycle.
  let browserStartClaimed = false;

  chrome.runtime.onInstalled.addListener(async (details) => {
    const reason = details?.reason;
    const reloadsExtensionPages = reason === "install" || reason === "update";
    if (!reloadsExtensionPages || (reason === "update" && browserStartClaimed)) {
      await runRuntimeTask("context menu installation", menus.install);
      return;
    }
    const cancelReloadPreparation = worker.prepareReload();
    // A first install has no registry yet and no authority to read it with.
    // The recovery owner prepares its own cycle after storage exists.
    const recoveryPreparation = reason === "update"
      ? suspension.prepareReload?.() ?? null
      : null;
    let recoveryStarted = false;
    let storageReady;
    try {
      storageReady = reason === "install"
        ? storage.initialize()
        : Promise.resolve();
    } catch (error) {
      cancelReloadPreparation();
      reportFailure("extension installation", error, console.error);
      return;
    }

    // Menu repair is independent of saved-data authority and must still run
    // when initialization rejects.
    const menuTask = runRuntimeTask("context menu installation", menus.install);
    try {
      await storageReady;
      // Re-check the claim after each await: onStartup may have fired while
      // this update was waiting. Yielding leaves the finally block to release
      // the prepared reload and any starting banner.
      let yieldsToBrowserStart = reason === "update" && browserStartClaimed;
      if (!yieldsToBrowserStart) {
        await suspension.markReloadGrace();
        yieldsToBrowserStart = reason === "update" && browserStartClaimed;
      }
      if (!yieldsToBrowserStart) {
        worker.start({ recoveringReload: true, recoveryPreparation });
        recoveryStarted = true;

        // Packed builds clamp chrome.alarms to at least 30 s. Run the prompt
        // repair on a retained timer while this worker is alive; the alarm is
        // only the fallback when the worker stops before the timer fires.
        // alarm-fallback: the retained 3 s timer below clears it after running.
        const metadataTask = runRuntimeTask("suspended metadata repair scheduling", () => (
          chrome.alarms.create(SUSPEND_METADATA_REPAIR_ALARM, {
            when: Date.now() + 30_000
          })
        ));
        scheduleRuntimeTask("suspended metadata repair", async () => {
          await suspension.repairRecoveryMetadata?.();
          await chrome.alarms.clear?.(SUSPEND_METADATA_REPAIR_ALARM);
        }, 3_000);
        focus.claimGuardLifecycle();
        const guardTask = runRuntimeTask(
          "Focus reload recovery",
          () => recoverFocusAfterReload(focus)
        );
        const dashboardTask = reason === "install"
          ? runRuntimeTask("first-install Dashboard", openDashboard)
          : Promise.resolve();
        await Promise.all([metadataTask, guardTask, dashboardTask]);
      }
    } catch (error) {
      reportFailure("extension installation", error, console.error);
    } finally {
      if (!recoveryStarted) {
        cancelReloadPreparation();
        await suspension.cancelPreparedReload?.(recoveryPreparation);
      }
    }
    await menuTask;
  });

  chrome.runtime.onStartup.addListener(async () => {
    // Claim the browser session synchronously so a launch-time `update`
    // onInstalled cannot start a reload reconstruction cycle in this worker.
    browserStartClaimed = true;
    try {
      // Claim New Tab creation order before the first await so worker-spin
      // recovery cannot act on pre-restart tab identities.
      newTabs.resetCreationOrder();
      // Claim the browser-session reset before automatic work starts. Only a
      // final automatic effects wait for its lock; recovery is independent.
      const protectionTask = protection?.beginBrowserSession
        ? runRuntimeTask(
          "temporary automation protection browser-start reset",
          protection.beginBrowserSession
        )
        : Promise.resolve();
      const activityTask = runRuntimeTask(
        "tab activity browser-start reset",
        activity.beginBrowserSession
      );
      // Chrome owns ordinary session restore. Reconstructing suspended pages
      // here races that restore and can manufacture duplicate/recently-closed
      // entries while windows are still arriving. Only onInstalled reloads
      // have authority to repair extension pages that Chrome invalidated.
      worker.start({
        recoverSuspendedTabs: false,
        captureStartupSnapshot: false
      });
      focus.claimGuardLifecycle();
      const guardTask = runRuntimeTask(
        "Focus browser-start recovery",
        () => recoverFocusAfterBrowserStart(focus)
      );
      await Promise.all([protectionTask, activityTask, guardTask]);
    } catch (error) {
      reportFailure("browser startup", error, console.error);
    }
  });
}
