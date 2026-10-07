// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Durable scheduling rules for automatic recovery Snapshots. */
export const SNAPSHOT_ALARM = "auto-snapshot";

const MINIMUM_MINUTES = 5;
const DEFAULT_MINUTES = 15;

export function snapshotPeriodMinutes(settings = {}) {
  return Math.max(MINIMUM_MINUTES,
    Number(settings.snapshotEveryMinutes) || DEFAULT_MINUTES);
}

/**
 * A Settings commit can change color, layout, Focus, or another unrelated
 * preference. Only a real cadence change may restart the Snapshot countdown.
 * A revision pulse without values is treated as uncertain and repaired.
 */
export function snapshotCadenceChanged(change = {}) {
  const hasOld = Object.hasOwn(change, "oldValue");
  const hasNew = Object.hasOwn(change, "newValue");
  if (!hasOld || !hasNew) return true;
  return snapshotPeriodMinutes(change.oldValue) !==
    snapshotPeriodMinutes(change.newValue);
}

/**
 * Create or repair the periodic alarm without postponing an already-correct
 * schedule. Dependencies are explicit so the exact MV3 contract is testable.
 */
export async function reconcileSnapshotAlarm({ alarms, readSettings }) {
  const periodInMinutes = snapshotPeriodMinutes(await readSettings());
  const existing = typeof alarms.get === "function"
    ? await alarms.get(SNAPSHOT_ALARM)
    : null;
  if (existing?.periodInMinutes === periodInMinutes) return false;
  await alarms.create(SNAPSHOT_ALARM, { periodInMinutes });
  return true;
}
