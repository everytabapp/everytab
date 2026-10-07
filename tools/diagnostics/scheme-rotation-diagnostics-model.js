import {
  customSchemeCatalogue,
  customSchemeIdFromRef,
  customSchemeRef,
  resolveSchemeSelection
} from "../../extension/js/lib/custom-schemes.js";
import { rotationPool } from "../../extension/js/lib/scheme-rotation.js";
import { SCHEMES } from "../../extension/js/lib/schemes.js";
import { DEFAULT_SETTINGS } from "../../extension/js/lib/types.js";

export const SCHEME_ROTATION_DIAGNOSTIC_TRACE_LIMIT = 24;
const CUSTOM_MASKED = "custom:*";
const BUILT_INS = new Set(SCHEMES);
const BUILT_IN_ALIASES = Object.freeze({
  everforest: "matcha", catppuccin: "dracula", rosepine: "dracula"
});
const ROTATION_MODES = new Set(["off", "open", "hourly", "daily"]);
const TRACE_EVENTS = new Set([
  "page-handshake-sent", "worker-handshake-received", "worker-result",
  "settings-change", "page-paint", "cache-write",
  "worker-start", "readiness-received", "task-missing-tab", "task-coalesced",
  "task-already-handled", "task-start", "task-complete", "task-failure",
  "storage-change"
]);
const TRACE_OUTCOMES = new Set([
  "changed", "no-op", "already-handled", "failed", "pending"
]);
const TRACE_SOURCES = new Set([
  "rotation", "vault", "picker", "storage", "page", "worker", "unknown"
]);
const TRACE_REASONS = new Set([
  "missing-tab", "rotation-failed", "rotation-disabled", "already-handled", "unknown"
]);
const TAB_SCOPED_TRACE_EVENTS = new Set([
  "page-handshake-sent", "worker-handshake-received", "worker-result", "page-paint",
  "cache-write", "readiness-received", "task-missing-tab", "task-coalesced",
  "task-already-handled", "task-start", "task-complete", "task-failure"
]);
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const canonicalBuiltIn = (value) => {
  const candidate = BUILT_IN_ALIASES[value] ?? value;
  return BUILT_INS.has(candidate) ? candidate : null;
};
const isCustomSelection = (value) => value === CUSTOM_MASKED ||
  Boolean(customSchemeIdFromRef(value));
const selectionsEqual = (left, right) => left === right ||
  (left === CUSTOM_MASKED && isCustomSelection(right)) ||
  (right === CUSTOM_MASKED && isCustomSelection(left));

function canonicalSelection(value) {
  if (isObject(value)) {
    if (value.kind === "custom") return CUSTOM_MASKED;
    if (value.kind === "built-in") return canonicalBuiltIn(value.id);
    return null;
  }
  const customId = customSchemeIdFromRef(value);
  if (customId) return customSchemeRef(customId);
  if (value === CUSTOM_MASKED) return CUSTOM_MASKED;
  return typeof value === "string" ? canonicalBuiltIn(value) : null;
}

function selectionView(value) {
  const canonical = canonicalSelection(value);
  if (isCustomSelection(canonical)) return { kind: "custom" };
  if (canonical && BUILT_INS.has(canonical)) return { kind: "built-in", id: canonical };
  if (value == null || value === "") return { kind: "missing" };
  return { kind: "unknown" };
}

function customRecordSnapshot(customRecords) {
  const all = Array.isArray(customRecords)
    ? customRecords
    : isObject(customRecords) ? Object.values(customRecords) : [];
  // Diagnose the same full catalogue as runtime; only counts leave this module.
  const live = customSchemeCatalogue(all);
  const tombstoneCount = all.filter((record) => Boolean(record?.deletedAt)).length;
  return {
    records: all,
    report: {
      inputCount: all.length,
      liveCount: live.length,
      tombstoneCount,
      invalidCount: Math.max(0, all.length - live.length - tombstoneCount)
    }
  };
}

function favoriteSnapshot(favorites, pool, customRecords) {
  const values = Array.isArray(favorites) ? favorites : [];
  const available = new Set(rotationPool([], customRecords));
  const builtInIds = [];
  const seenBuiltIns = new Set();
  const seenCustom = new Set();
  let validCount = 0;
  let unknownCount = 0;

  for (const value of values) {
    const canonical = canonicalSelection(value);
    if (!canonical || !available.has(canonical)) {
      unknownCount += 1;
      continue;
    }
    validCount += 1;
    if (customSchemeIdFromRef(canonical)) seenCustom.add(canonical);
    else if (!seenBuiltIns.has(canonical)) {
      seenBuiltIns.add(canonical);
      builtInIds.push(canonical);
    }
  }
  return {
    malformed: !Array.isArray(favorites),
    requestedCount: values.length,
    validCount,
    builtInIds,
    customCount: seenCustom.size,
    unknownCount,
    usesAllAvailable: validCount === 0 && pool.length === available.size
  };
}

function poolSnapshot(pool, current) {
  const builtInIds = pool.filter((id) => BUILT_INS.has(id));
  return {
    size: pool.length,
    builtInIds,
    customCount: pool.length - builtInIds.length,
    currentIncluded: pool.some((id) => selectionsEqual(id, current))
  };
}

function bagSnapshot(state, pool, current, expectedPoolKey) {
  const missing = {
    health: "missing", present: false, poolKeyMatches: null, remainingCount: 0,
    remainingBuiltInIds: [], remainingCustomCount: 0, unavailableCount: 0,
    duplicateCount: 0, currentPending: false
  };
  if (state == null) return missing;
  if (!isObject(state) || typeof state.poolKey !== "string" ||
      !Array.isArray(state.remaining) || state.remaining.some((id) => typeof id !== "string")) {
    return {
      ...missing, health: "malformed", present: true, poolKeyMatches: false,
      remainingCount: Array.isArray(state?.remaining) ? state.remaining.length : 0
    };
  }

  const canonicalRemaining = state.remaining.map(canonicalSelection);
  const known = canonicalRemaining.filter(Boolean);
  const remainingBuiltInIds = known.filter((id) => BUILT_INS.has(id));
  const unique = new Set(known);
  const unavailableCount = canonicalRemaining.filter((id) =>
    !id || !pool.some((candidate) => selectionsEqual(candidate, id))).length;
  const duplicateCount = known.length - unique.size;
  const currentPending = known.some((id) => selectionsEqual(id, current));
  const poolKeyMatches = state.poolKey === expectedPoolKey;
  const health = poolKeyMatches && unavailableCount === 0 && duplicateCount === 0 &&
    !currentPending ? "valid" : "stale";
  return {
    health, present: true, poolKeyMatches, remainingCount: state.remaining.length,
    remainingBuiltInIds,
    remainingCustomCount: known.length - remainingBuiltInIds.length,
    unavailableCount, duplicateCount, currentPending
  };
}

function reservationSnapshot(prepared, pool, current, expectedPoolKey) {
  const missing = {
    health: "missing", present: false, from: { kind: "missing" },
    next: { kind: "missing" }, poolKeyMatches: null, fromMatchesCurrent: null,
    nextInPool: null, nextDiffers: null, commitTokenPresent: false
  };
  if (prepared == null) return missing;
  const shaped = isObject(prepared) && typeof prepared.from === "string" &&
    typeof prepared.next === "string" && typeof prepared.poolKey === "string";
  if (!shaped) {
    return {
      ...missing, health: "malformed", present: true,
      from: selectionView(prepared?.from), next: selectionView(prepared?.next),
      poolKeyMatches: false, fromMatchesCurrent: false, nextInPool: false,
      nextDiffers: false,
      commitTokenPresent: typeof prepared?.commitToken === "string" && Boolean(prepared.commitToken)
    };
  }

  const from = canonicalSelection(prepared.from);
  const next = canonicalSelection(prepared.next);
  const poolKeyMatches = prepared.poolKey === expectedPoolKey;
  const fromMatchesCurrent = selectionsEqual(from, current);
  const nextInPool = Boolean(next) && pool.some((id) => selectionsEqual(id, next));
  const nextDiffers = Boolean(next) && !selectionsEqual(next, current);
  return {
    health: poolKeyMatches && fromMatchesCurrent && nextInPool && nextDiffers
      ? "valid" : "stale",
    present: true,
    from: selectionView(prepared.from),
    next: selectionView(prepared.next),
    poolKeyMatches, fromMatchesCurrent, nextInPool, nextDiffers,
    commitTokenPresent: typeof prepared.commitToken === "string" && Boolean(prepared.commitToken)
  };
}

function cacheSelection(cache, prepared = false) {
  const source = prepared ? cache?.preparedTheme : cache;
  if (!isObject(source)) return null;
  if (typeof source.selection === "string" || isObject(source.selection)) {
    return canonicalSelection(source.selection);
  }
  if (source.scheme === "custom" && typeof source.customScheme === "string") {
    return canonicalSelection(customSchemeRef(source.customScheme));
  }
  return canonicalSelection(source.scheme);
}

function cacheSnapshot(cache, current, preparedRaw, reservation, expectedPoolKey, mode) {
  const missing = {
    health: "missing", present: false, mode: "missing",
    current: { kind: "missing" }, prepared: { kind: "missing" },
    modeMatches: null, poolKeyMatches: null, currentMatches: null, preparedMatches: null
  };
  if (cache == null) return missing;
  if (!isObject(cache)) {
    return {
      ...missing, health: "malformed", present: true, mode: "invalid",
      modeMatches: false, poolKeyMatches: false,
      currentMatches: false, preparedMatches: false
    };
  }

  const cachedCurrent = cacheSelection(cache);
  const cachedPrepared = cacheSelection(cache, true);
  const authoritativePrepared = reservation.health === "valid"
    ? canonicalSelection(preparedRaw?.next) : null;
  const modeMatches = cache.schemeRotate === mode;
  const storedPoolKey = cache.schemeRotationPoolKey ?? cache.rotationPoolKey;
  const poolKeyMatches = storedPoolKey === expectedPoolKey;
  const currentMatches = Boolean(cachedCurrent) && selectionsEqual(cachedCurrent, current);
  const preparedMatches = reservation.health === "valid"
    ? Boolean(cachedPrepared) && selectionsEqual(cachedPrepared, authoritativePrepared)
    : cachedPrepared == null;
  return {
    health: modeMatches && poolKeyMatches && currentMatches && preparedMatches
      ? "valid" : "stale",
    present: true,
    mode: ROTATION_MODES.has(cache.schemeRotate) ? cache.schemeRotate : "invalid",
    current: selectionView(cachedCurrent),
    prepared: selectionView(cachedPrepared),
    modeMatches, poolKeyMatches, currentMatches, preparedMatches
  };
}

function normalizePainted(painted, current) {
  const source = typeof painted === "string"
    ? { currentSelection: painted }
    : isObject(painted) ? painted : {};
  const bootRaw = canonicalSelection(source.bootSelection ?? source.boot ?? null);
  const currentRaw = canonicalSelection(source.currentSelection ?? source.current ??
    source.finalSelection ?? source.selection ?? null);
  return {
    boot: selectionView(bootRaw),
    current: selectionView(currentRaw),
    currentMatchesSettings: currentRaw ? selectionsEqual(currentRaw, current) : null,
    _currentRaw: currentRaw
  };
}

function changedVaultMeta(vaultMeta) {
  if (!isObject(vaultMeta) || !("old" in vaultMeta) || !("new" in vaultMeta)) return false;
  if (vaultMeta.old == null || vaultMeta.new == null) return vaultMeta.old !== vaultMeta.new;
  if (!isObject(vaultMeta.old) || !isObject(vaultMeta.new)) return vaultMeta.old !== vaultMeta.new;
  const keys = [
    "lastSyncAt", "ok", "pulled", "pushed", "conflicts",
    "modifiedAt", "pulledAt", "version", "revision", "present"
  ];
  for (const key of keys) {
    if (vaultMeta.old[key] !== vaultMeta.new[key]) return true;
  }
  return false;
}

const safeTimestamp = (value) => Number.isFinite(value) ? value : null;
const safeCount = (value) => Number.isFinite(value) && value >= 0
  ? Math.min(1_000_000, Math.trunc(value)) : null;
const safeVaultSnapshot = (value) => ({
  lastSyncAt: safeTimestamp(value?.lastSyncAt),
  ok: typeof value?.ok === "boolean" ? value.ok : null,
  pulled: safeCount(value?.pulled),
  pushed: safeCount(value?.pushed),
  conflicts: safeCount(value?.conflicts)
});

function traceEnvelope(workerTrace) {
  if (Array.isArray(workerTrace)) {
    return { entries: workerTrace, malformed: false, response: null };
  }
  if (!isObject(workerTrace)) {
    return { entries: [], malformed: workerTrace != null, response: null };
  }
  const version = typeof workerTrace.worker?.version === "string" &&
    /^\d+(?:\.\d+){1,3}$/.test(workerTrace.worker.version)
    ? workerTrace.worker.version : null;
  const protocol = (typeof workerTrace.protocol === "number" &&
    Number.isSafeInteger(workerTrace.protocol)) ||
    (typeof workerTrace.protocol === "string" && /^[a-z0-9._-]{1,64}$/i.test(workerTrace.protocol))
    ? workerTrace.protocol : null;
  const boundedCount = (value) => Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000) : null;
  return {
    entries: Array.isArray(workerTrace.trace) ? workerTrace.trace : [],
    malformed: !Array.isArray(workerTrace.trace),
    response: {
      ok: typeof workerTrace.ok === "boolean" ? workerTrace.ok : null,
      protocol,
      workerVersion: version,
      armed: typeof workerTrace.armed === "boolean" ? workerTrace.armed : null,
      activeCount: boundedCount(workerTrace.activeCount),
      handledCount: boundedCount(workerTrace.handledCount)
    }
  };
}

function normalizeTraceEvent(entry) {
  const source = isObject(entry) ? entry : {};
  const event = TRACE_EVENTS.has(source.event) ? source.event : "unknown";
  const nested = isObject(source.result) ? source.result : {};
  const settings = isObject(source.settings) ? source.settings : {};
  const oldSettings = isObject(settings.old) ? settings.old : {};
  const newSettings = isObject(settings.new) ? settings.new : {};
  const changed = typeof source.changed === "boolean" ? source.changed
    : typeof nested.changed === "boolean" ? nested.changed : null;
  let outcome = TRACE_OUTCOMES.has(source.outcome) ? source.outcome : null;
  if (event === "task-complete") outcome = changed ? "changed" : "no-op";
  if (event === "task-already-handled" || source.alreadyHandled === true) {
    outcome = "already-handled";
  }
  if (event === "task-failure" || event === "task-missing-tab") outcome = "failed";
  if (event === "task-coalesced") outcome = "pending";
  if (!outcome && changed === true) outcome = "changed";
  if (!outcome && changed === false) outcome = "no-op";

  const beforeValue = source.before ?? nested.before ?? oldSettings.uiScheme ?? null;
  const afterValue = source.after ?? source.scheme ?? nested.scheme ?? newSettings.uiScheme ?? null;
  const vaultChanged = changedVaultMeta(source.vaultMeta);
  const oldPulled = safeCount(source.vaultMeta?.old?.pulled);
  const newPulled = safeCount(source.vaultMeta?.new?.pulled);
  const vaultPullObserved = oldPulled != null && newPulled != null && newPulled > oldPulled;
  const namedSource = vaultChanged ? "vault"
    : source.preparedInChange === true ? "rotation"
    : TRACE_SOURCES.has(source.source) ? source.source
      : event === "storage-change" ? "storage" : "unknown";
  const reason = TRACE_REASONS.has(source.reason) ? source.reason
    : event === "task-missing-tab" ? "missing-tab"
      : event === "task-failure" ? "rotation-failed" : null;
  const kind = ["readiness-received", "worker-handshake-received"].includes(event)
    ? "handshake-received"
    : ["task-complete", "task-failure", "task-missing-tab", "task-already-handled",
        "worker-result"].includes(event) ? "result"
      : ["settings-change", "storage-change"].includes(event) ? "state-change"
        : event === "page-paint" ? "paint" : event;
  const report = {
    event,
    ...(outcome ? { outcome } : {}),
    ...(kind === "state-change" ? { source: namedSource } : {}),
    ...(reason ? { reason } : {}),
    ...(beforeValue != null ? { before: selectionView(beforeValue) } : {}),
    ...(afterValue != null ? { after: selectionView(afterValue) } : {})
  };
  if (kind === "state-change") {
    report.beforeMode = ROTATION_MODES.has(oldSettings.schemeRotate)
      ? oldSettings.schemeRotate : null;
    report.afterMode = ROTATION_MODES.has(newSettings.schemeRotate)
      ? newSettings.schemeRotate : null;
    report.preparedInChange = source.preparedInChange === true;
    report.vaultMetaChanged = vaultChanged;
    report.vaultPullObserved = vaultPullObserved;
    if (isObject(source.settingsModifiedAt)) {
      report.settingsModifiedAt = {
        old: safeTimestamp(source.settingsModifiedAt.old),
        new: safeTimestamp(source.settingsModifiedAt.new)
      };
    }
    if (isObject(source.vaultMeta)) {
      report.vaultMeta = {
        old: safeVaultSnapshot(source.vaultMeta.old),
        new: safeVaultSnapshot(source.vaultMeta.new)
      };
    }
  }
  return {
    kind, outcome, beforeRaw: canonicalSelection(beforeValue),
    afterRaw: canonicalSelection(afterValue), source: namedSource,
    vaultPullObserved, report
  };
}

function traceSnapshot(workerTrace, current, expectedCommit, paintedCurrent,
  expectedHandshake, expectedTabId) {
  const envelope = traceEnvelope(workerTrace);
  const hasExpectedTab = Number.isInteger(expectedTabId);
  let ignoredTabEventCount = 0;
  const relevant = envelope.entries.filter((entry) => {
    if (!hasExpectedTab || !TAB_SCOPED_TRACE_EVENTS.has(entry?.event)) return true;
    const keep = entry?.tabId === expectedTabId;
    if (!keep) ignoredTabEventCount += 1;
    return keep;
  });
  const retained = relevant.slice(-SCHEME_ROTATION_DIAGNOSTIC_TRACE_LIMIT)
    .map(normalizeTraceEvent);
  const pageSent = retained.some(({ kind }) => kind === "page-handshake-sent");
  const results = retained.filter(({ kind }) => kind === "result");
  const workerSaw = retained.some(({ kind }) => kind === "handshake-received") ||
    retained.some(({ kind }) => ["task-start", "task-coalesced", "result"].includes(kind));
  const lastResult = results.at(-1) ?? null;
  const successIndex = retained.findLastIndex(({ kind, outcome }) =>
    kind === "result" && outcome === "changed");
  const success = successIndex >= 0 ? retained[successIndex] : null;
  // Preflight restores the exact private identity hidden by the worker's custom mask.
  const committed = success?.afterRaw === CUSTOM_MASKED && isCustomSelection(expectedCommit)
    ? expectedCommit : success?.afterRaw ?? null;
  const afterSuccess = successIndex >= 0 ? retained.slice(successIndex + 1) : [];
  const revertedEvent = committed ? afterSuccess.find((entry) =>
    ["state-change", "paint"].includes(entry.kind) && entry.source !== "rotation" &&
    entry.afterRaw &&
    !selectionsEqual(entry.afterRaw, committed)) : null;
  // Vault writes Settings first and its pull metadata in a later storage event.
  const laterVaultPull = afterSuccess.find((entry) => entry.vaultPullObserved);
  const laterRotationChange = committed ? afterSuccess.find((entry) =>
    entry.kind === "state-change" && entry.source === "rotation" && entry.afterRaw && (
      !selectionsEqual(entry.afterRaw, committed) ||
      (entry.afterRaw === CUSTOM_MASKED && isCustomSelection(current) &&
        !selectionsEqual(current, committed))
    )) : null;
  const settingsMismatch = Boolean(committed && current &&
    !selectionsEqual(current, committed) && !laterRotationChange);
  const paintMismatch = Boolean(committed && paintedCurrent &&
    !selectionsEqual(paintedCurrent, committed) && !laterRotationChange);
  const reverted = Boolean(revertedEvent || settingsMismatch || paintMismatch);
  const revertSource = revertedEvent?.source === "vault" || (reverted && laterVaultPull)
    ? "vault"
    : revertedEvent?.kind === "paint" || paintMismatch ? "paint"
      : revertedEvent ? revertedEvent.source : settingsMismatch ? "settings" : null;
  const responseFailure = envelope.response?.ok === false;
  const lastOutcome = lastResult?.outcome ?? (responseFailure ? "failed" :
    envelope.response?.activeCount > 0 ? "pending" : "missing");

  return {
    pageSent,
    // Armed means capture-ready; the caller confirms successful tab creation.
    handshakeExpected: expectedHandshake || pageSent,
    workerSaw,
    lastOutcome,
    lastChangedTo: selectionView(lastResult?.afterRaw),
    committed: Boolean(committed),
    committedSelection: selectionView(committed),
    reverted, revertSource, settingsMismatch, paintMismatch,
    report: {
      retainedCount: retained.length,
      droppedCount: Math.min(9_999, Math.max(0, relevant.length - retained.length)),
      ignoredTabEventCount: Math.min(9_999, ignoredTabEventCount),
      malformedInput: envelope.malformed,
      response: envelope.response,
      events: retained.map(({ report }) => report)
    }
  };
}

/** Inspect explicit state without returning any raw custom identity. */
export function inspectSchemeRotationDiagnosticInput(input = {}) {
  const settingsPresent = isObject(input.settings);
  const settings = { ...DEFAULT_SETTINGS, ...(settingsPresent ? input.settings : {}) };
  const mode = ROTATION_MODES.has(settings.schemeRotate) ? settings.schemeRotate : "invalid";
  const custom = customRecordSnapshot(input.customRecords);
  const resolved = resolveSchemeSelection(settings.uiScheme, custom.records);
  const currentRaw = resolved.selection;
  const poolIds = rotationPool(settings.schemeFavorites, custom.records);
  const expectedPoolKey = poolIds.join("|");
  const reservation = reservationSnapshot(input.prepared, poolIds, currentRaw, expectedPoolKey);
  const painted = normalizePainted(input.painted, currentRaw);
  const expectedCommit = canonicalSelection(input.expectedCommitSelection);
  const trace = traceSnapshot(input.workerTrace, settingsPresent ? currentRaw : null,
    expectedCommit, painted._currentRaw, input.expectedHandshake === true,
    input.expectedTabId);
  delete painted._currentRaw;
  return {
    mode,
    settingsPresent,
    requested: selectionView(settings.uiScheme),
    current: selectionView(currentRaw),
    missingCustomSelection: Boolean(resolved.missingCustomRef),
    favorites: favoriteSnapshot(settings.schemeFavorites, poolIds, custom.records),
    pool: poolSnapshot(poolIds, currentRaw),
    customSchemes: custom.report,
    bag: bagSnapshot(input.state, poolIds, currentRaw, expectedPoolKey),
    reservation,
    cache: cacheSnapshot(
      input.cache, currentRaw, input.prepared, reservation, expectedPoolKey, mode
    ),
    painted,
    trace
  };
}
