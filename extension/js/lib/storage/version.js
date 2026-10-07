// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Deterministic hybrid logical versions for whole-record conflict resolution. */

function finiteInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function normalizeVersion(value, fallbackDeviceId = "") {
  return {
    wallTime: finiteInteger(value?.wallTime),
    logicalCounter: finiteInteger(value?.logicalCounter),
    deviceId: typeof value?.deviceId === "string" && value.deviceId
      ? value.deviceId : fallbackDeviceId
  };
}

export function compareVersions(left, right) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (a.wallTime !== b.wallTime) return a.wallTime < b.wallTime ? -1 : 1;
  if (a.logicalCounter !== b.logicalCounter) {
    return a.logicalCounter < b.logicalCounter ? -1 : 1;
  }
  return a.deviceId.localeCompare(b.deviceId);
}

/**
 * Advance after both the last locally issued version and one observed version.
 * A backwards wall clock cannot make a later local mutation compare older.
 */
export function nextVersion(previous, observed, deviceId, wallTime = Date.now()) {
  if (typeof deviceId !== "string" || !deviceId) throw new Error("A device id is required");
  const local = normalizeVersion(previous, deviceId);
  const remote = normalizeVersion(observed);
  const now = finiteInteger(wallTime);
  const greatestWall = Math.max(now, local.wallTime, remote.wallTime);
  const counters = [];
  if (local.wallTime === greatestWall) counters.push(local.logicalCounter);
  if (remote.wallTime === greatestWall) counters.push(remote.logicalCounter);
  return {
    wallTime: greatestWall,
    logicalCounter: counters.length ? Math.max(...counters) + 1 : 0,
    deviceId
  };
}

export function greatestVersion(...versions) {
  return versions.filter(Boolean).reduce(
    (greatest, candidate) => compareVersions(candidate, greatest) > 0 ? candidate : greatest,
    normalizeVersion(null)
  );
}

