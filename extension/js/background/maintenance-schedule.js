// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
import { ARCHIVE_ALARM, SUSPEND_ALARM } from "./alarm-owner.js";
import { reconcileSnapshotAlarm } from "../lib/snapshot-schedule.js";

/**
 * Own recurring maintenance schedules and the short Auto-save cap debounce.
 * Product work remains in its domain modules; this owner only establishes when
 * that work becomes due.
 *
 * @param {{
 *   alarms: {
 *     get: (name:string) => Promise<object|undefined>,
 *     create: (name:string,options:object) => Promise<unknown>
 *   },
 *   readSettings: () => Promise<object>,
 *   archiveSweep: () => Promise<unknown>,
 *   schedule?: (callback:Function,delay:number) => unknown,
 *   cancel?: (handle:unknown) => void,
 *   warn?: (message:string) => void
 * }} dependencies
 */
export function createMaintenanceSchedule(dependencies) {
  const schedule = dependencies.schedule ?? setTimeout;
  const cancel = dependencies.cancel ?? clearTimeout;
  const warn = dependencies.warn ?? console.warn;
  let autoSaveCapTimer = null;

  const ensureSnapshotAlarm = () => reconcileSnapshotAlarm({
    alarms: dependencies.alarms,
    readSettings: dependencies.readSettings
  });

  const ensureSuspendAlarm = () => dependencies.alarms.create(
    SUSPEND_ALARM,
    { periodInMinutes: 5 }
  );

  // Auto-save thresholds are minute-granular, so a 15-minute sweep keeps
  // sub-day values useful while avoiding constant background work.
  const ensureArchiveAlarm = () => dependencies.alarms.create(
    ARCHIVE_ALARM,
    { periodInMinutes: 15 }
  );

  // The durable alarm remains the fallback if MV3 stops this worker. While the
  // worker is alive, bursty tab creation collapses into one prompt cap sweep.
  const scheduleAutoSaveCapSweep = () => {
    if (autoSaveCapTimer !== null) cancel(autoSaveCapTimer);
    autoSaveCapTimer = schedule(async () => {
      autoSaveCapTimer = null;
      try {
        const settings = await dependencies.readSettings();
        if ((Number(settings.autoSaveMaxTabs) || 0) > 0) {
          await dependencies.archiveSweep();
        }
      } catch (error) {
        reportFailure("maximum-open-tabs Auto-save", error, warn);
      }
    }, 900);
  };

  return {
    ensureSnapshotAlarm,
    ensureSuspendAlarm,
    ensureArchiveAlarm,
    scheduleAutoSaveCapSweep
  };
}
