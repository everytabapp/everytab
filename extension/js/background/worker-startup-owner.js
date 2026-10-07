// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
/**
 * Own ordinary worker-start maintenance and its deferred initialization work.
 * Runtime install/browser-start ordering remains in runtime-lifecycle-owner;
 * this module owns the independent tasks each accepted start launches.
 *
 * @param {{
 *   identity: { ensure: () => Promise<unknown> },
 *   schedules: {
 *     snapshot: () => Promise<unknown>,
 *     suspension: () => Promise<unknown>,
 *     inbox: () => Promise<unknown>,
 *     rotation: () => Promise<unknown>
 *   },
 *   snapshots: { take: () => Promise<unknown> },
 *   assets: { collect: () => Promise<unknown> },
 *   snooze: { ready: Promise<unknown>, sweep: () => Promise<unknown> },
 *   inbox: { sweep: () => Promise<unknown>, expire: () => Promise<unknown> },
 *   badge: { refresh: () => Promise<unknown> },
 *   closeDay: { resume: () => Promise<unknown> },
 *   suspension: {
 *     retryCloseCleanups: () => Promise<unknown>,
 *     startRecovery: (options:{recoveringReload:boolean,recoveryPreparation?:object|null,onInitialPassSettled:()=>void}) => Promise<unknown>|unknown
 *   },
 *   deferred: {
 *     ensureSessionIdentities: () => Promise<unknown>,
 *     scheduleGuardRecovery: () => unknown
 *   },
 *   schedule?: (callback:Function,delay:number) => unknown,
 *   warn?: (message:string) => void
 * }} dependencies
 */
export function createWorkerStartupOwner(dependencies) {
  const schedule = dependencies.schedule ?? setTimeout;
  const warn = dependencies.warn ?? console.warn;

  const run = (name, work) => Promise.resolve().then(() => work()).catch((error) => {
    reportFailure(name, error, warn);
  });

  let initialReloadPending = false;
  const collectAssetsWhenReady = async () => {
    if (initialReloadPending) return;
    return dependencies.assets.collect();
  };
  let sessionIndexDue = false;
  let sessionIndexStarted = false;
  const startSessionIndexWhenReady = () => {
    if (!sessionIndexDue || initialReloadPending || sessionIndexStarted) return;
    sessionIndexStarted = true;
    void run("Session identity index backfill", dependencies.deferred.ensureSessionIdentities);
  };

  // Claim the reload before initialization/grace can yield to the index timer.
  // The lifecycle caller releases this claim if recovery cannot be started.
  const prepareReload = () => {
    initialReloadPending = true;
    return () => {
      initialReloadPending = false;
      startSessionIndexWhenReady();
    };
  };

  const installDeferredWork = () => {
    // Keep the ordinary paint delay, but let reload recovery finish before
    // this optional read of the complete named-Session family begins.
    schedule(() => {
      sessionIndexDue = true;
      startSessionIndexWhenReady();
    }, 1_000);

    // Defer worker-spin guard recovery so runtime lifecycle claims can win
    // before any stale browser identity is considered.
    dependencies.deferred.scheduleGuardRecovery();
  };

  const start = ({
    recoveringReload = false,
    recoveryPreparation = null,
    recoverSuspendedTabs = true,
    captureStartupSnapshot = true
  } = {}) => {
    if (recoveringReload) initialReloadPending = true;
    let maintenanceStarted = false;
    const startOptionalMaintenance = () => {
      if (maintenanceStarted) return;
      maintenanceStarted = true;
      if (captureStartupSnapshot) {
        void run("automatic Snapshot startup capture", dependencies.snapshots.take);
      }
      // This sweep prunes old records and gives new browser ids fresh grace.
      void run("automatic Inbox sweep", dependencies.inbox.sweep);
      void run("Inbox expiry sweep", dependencies.inbox.expire);
      void run("unused Library favicon cleanup", collectAssetsWhenReady);
      if (recoveringReload) {
        initialReloadPending = false;
        startSessionIndexWhenReady();
      }
    };
    // Reload recovery owns the first heavy-work lane. Normal worker starts
    // retain their existing maintenance timing.
    if (!recoveringReload) startOptionalMaintenance();
    void run("device identity setup", dependencies.identity.ensure);
    void run("automatic Snapshot schedule repair", dependencies.schedules.snapshot);
    void run("automatic suspension schedule repair", dependencies.schedules.suspension);
    void run("Inbox schedule repair", dependencies.schedules.inbox);
    void run("scheme rotation schedule repair", dependencies.schedules.rotation);
    void dependencies.snooze.ready
      .then(dependencies.snooze.sweep)
      .catch((error) => reportFailure("overdue Snooze sweep", error, warn));

    void run("badge refresh", dependencies.badge.refresh);

    // Recovery reads the durable close-intent ledger itself before any browser
    // effect, so a slow retry of that same ledger must not delay tab repair.
    // Both paths remain independent and idempotent.
    void run("Close-the-day recovery", dependencies.closeDay.resume);
    if (recoverSuspendedTabs) {
      void run("suspended-tab recovery", async () => {
        try {
          const cycleId = await dependencies.suspension.startRecovery({
            recoveringReload,
            recoveryPreparation,
            onInitialPassSettled: startOptionalMaintenance
          });
          // Starting a cycle only schedules its passes. Do not release the
          // heavy work here unless no cycle could be started.
          if (!cycleId) startOptionalMaintenance();
        } catch (error) {
          startOptionalMaintenance();
          throw error;
        }
      });
    }
    void run("retained suspended close cleanup", dependencies.suspension.retryCloseCleanups);
  };

  return { installDeferredWork, prepareReload, start, collectAssetsWhenReady };
}
