// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Create the worker's bounded, privacy-safe operational trace for New Tab
 * scheme rotation. The trace stays in memory and records only allow-listed
 * product state while an explicit diagnostic lease is active.
 *
 * @param {{
 *   version: string,
 *   builtInSchemes: string[],
 *   now?: () => number,
 *   limit?: number,
 *   preparedKey?: string,
 *   armForMs?: number,
 *   protocol?: number
 * }} options
 */
export function createSchemeRotationDiagnostics({
  version,
  builtInSchemes,
  now = Date.now,
  limit = 24,
  preparedKey = "schemeRotationPrepared",
  armForMs = 8_000,
  protocol = 1
}) {
  const trace = [];
  const builtIns = new Set(builtInSchemes);
  const startedAt = now();
  const safeVersion = typeof version === "string" ? version : "unknown";
  let armedUntil = 0;
  const safeScheme = (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (value.kind === "built-in") return builtIns.has(value.id)
        ? { kind: "built-in", id: value.id }
        : { kind: "unknown" };
      if (value.kind === "custom") return { kind: "custom" };
      return { kind: value.kind === "none" ? "none" : "unknown" };
    }
    if (builtIns.has(value)) return { kind: "built-in", id: value };
    if (value === "custom" ||
        (typeof value === "string" && value.startsWith("custom:"))) {
      return { kind: "custom" };
    }
    return { kind: value == null ? "none" : "unknown" };
  };
  const safeCadence = (value) => ["off", "open", "hourly", "daily"].includes(value)
    ? value
    : value == null ? null : "unknown";
  const safeTimestamp = (value) => Number.isFinite(value) ? value : null;
  const safeCount = (value) => Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
  const safeVaultMeta = (value) => ({
    lastSyncAt: safeTimestamp(value?.lastSyncAt),
    ok: typeof value?.ok === "boolean" ? value.ok : null,
    pulled: safeCount(value?.pulled),
    pushed: safeCount(value?.pushed),
    conflicts: safeCount(value?.conflictCopies)
  });
  const record = (event, detail = {}) => {
    const at = now();
    if (!armedUntil || at > armedUntil) return false;
    trace.push({ ...detail, at, event });
    if (trace.length > limit) trace.splice(0, trace.length - limit);
    return true;
  };
  const resetTrace = () => {
    trace.splice(0, trace.length, {
      at: startedAt,
      event: "worker-start",
      version: safeVersion
    });
  };
  const response = (activeCount, handledCount) => ({
    ok: true,
    protocol,
    worker: { startedAt, version: safeVersion },
    armed: Boolean(armedUntil && now() <= armedUntil),
    armedUntil,
    activeCount,
    handledCount,
    trace: structuredClone(trace)
  });

  resetTrace();

  return {
    record,
    safeScheme,
    capture() {
      if (!armedUntil || now() > armedUntil) return null;
      return { protocol, armedUntil };
    },
    arm(activeCount, handledCount) {
      armedUntil = now() + armForMs;
      resetTrace();
      return response(activeCount, handledCount);
    },
    recordStorageChange(changes, area) {
      if (area !== "local" || !changes || typeof changes !== "object") return;
      const hasSettings = Object.hasOwn(changes, "settings");
      const hasModifiedAt = Object.hasOwn(changes, "settingsModifiedAt");
      const vaultMetaChange = changes.vaultMetaV2;
      const hasVaultMeta = Boolean(vaultMetaChange);
      if (!hasSettings && !hasModifiedAt && !hasVaultMeta) return;
      const detail = {
        preparedInChange: Object.hasOwn(changes, preparedKey)
      };
      if (hasSettings) {
        const oldSettings = changes.settings?.oldValue;
        const newSettings = changes.settings?.newValue;
        detail.settings = {
          old: {
            uiScheme: safeScheme(oldSettings?.uiScheme),
            schemeRotate: safeCadence(oldSettings?.schemeRotate)
          },
          new: {
            uiScheme: safeScheme(newSettings?.uiScheme),
            schemeRotate: safeCadence(newSettings?.schemeRotate)
          }
        };
      }
      if (hasModifiedAt) {
        detail.settingsModifiedAt = {
          old: safeTimestamp(changes.settingsModifiedAt?.oldValue),
          new: safeTimestamp(changes.settingsModifiedAt?.newValue)
        };
      }
      if (hasVaultMeta) {
        detail.vaultMeta = {
          old: safeVaultMeta(vaultMetaChange?.oldValue),
          new: safeVaultMeta(vaultMetaChange?.newValue)
        };
      }
      record("storage-change", detail);
    },
    report: response
  };
}
