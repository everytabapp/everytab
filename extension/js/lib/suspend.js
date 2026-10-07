// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "./failure-diagnostic.js";
import {
  getSettings, getFreshSettings, mutateStores, patchSettings, readFreshStoreMap,
  readStoreMap, readStoreValue
} from "./store.js";
import {
  exactAutomationPageRule, exactAutomationPageUrl, isHttpTab, urlOf,
  exactAutomationSiteHostname,
  canonicalUrlOf, matchesAutomationExclusion, matchesWhitelist, isOwnSuspendPage,
  ownSuspendedRef, TEMPORARY_AUTOMATION_EXEMPTIONS_KEY,
  isTemporarilyAutomationProtected
} from "./tabs.js";
import { bump } from "./counters.js";
import { sameLiveTabCloseIdentity } from "./live-close.js";
import { STORE_KEYS } from "./types.js";
import { recoveryNotificationStateAfterRecovery } from "./suspend-recovery-schedule.js";
import { ACTIVITY_KEY, tabActivity } from "./tab-activity.js";
import {
  protectionStatus, readTabProtections, TAB_PROTECTIONS_KEY,
  withAutomationProtectionEffect, withAutomationProtectionWrite
} from "./automation-protection.js";

export const SUSPEND_REGISTRY_KEY = "suspendedRegistry";
export const SUSPEND_RECOVERY_CYCLE_KEY = "suspendRecoveryCycle";
export const SUSPEND_CLOSE_CLEANUP_ALARM = "suspend-close-cleanup";
const SUSPEND_CLOSE_CLEANUP_KEY = "suspendCloseCleanup";
// Stable storage key retained for installed-profile compatibility. The alias
// remains exported because existing callers predate shared automation protection.
export const TEMPORARY_SUSPEND_EXEMPTIONS_KEY = TEMPORARY_AUTOMATION_EXEMPTIONS_KEY;
export const SUSPEND_EXEMPTION_DAY_MS = 24 * 60 * 60_000;

function placeholderSuspendTitle(title, originalUrl) {
  const value = String(title || "").trim();
  return !value || value === originalUrl || /^suspended(?:\s*·\s*suspended)?$/i.test(value);
}

function suspendPageUrl(base, info, recoveryAttempt = 0) {
  return `${base}?${new URLSearchParams({
    originalUrl: info.originalUrl,
    title: info.title || info.originalUrl,
    ...(info.favIconUrl ? { favIconUrl: info.favIconUrl } : {}),
    ...(info.recoveryOccurrenceId
      ? { recoveryOccurrenceId: info.recoveryOccurrenceId }
      : {}),
    ...(recoveryAttempt ? { recoveryAttempt: String(recoveryAttempt) } : {})
  })}`;
}

/** Stable logical identity embedded in a modern EveryTab suspend page. */
function suspendedPageOccurrenceId(tab) {
  const raw = tab?.url || tab?.pendingUrl || "";
  if (!raw.startsWith(chrome.runtime.getURL("suspend.html"))) return "";
  try {
    return new URL(raw).searchParams.get("recoveryOccurrenceId") || "";
  } catch {
    return "";
  }
}

const yieldMetadataScan = () => globalThis.scheduler?.yield
  ? globalThis.scheduler.yield()
  : new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A v0.8.405 self-adoption could persist the static extension-page title and no
 * favicon, then a later reload could bake that damaged metadata into the page
 * URL itself. Recover richer identity from local automatic Snapshots only when
 * such damage is present. This is a one-time, post-startup migration path; a
 * healthy registry performs no Session read.
 * @param {Record<string, SuspendEntry>} registry
 * @returns {Promise<Record<string, SuspendEntry>>}
 */
async function backfillSuspendMetadata(registry) {
  const needs = new Map();
  for (const info of Object.values(registry)) {
    if (!info?.originalUrl) continue;
    const needTitle = placeholderSuspendTitle(info.title, info.originalUrl);
    const needFavicon = !info.favIconUrl;
    if (!needTitle && !needFavicon) continue;
    const prior = needs.get(info.originalUrl) ?? { needTitle: false, needFavicon: false };
    prior.needTitle ||= needTitle;
    prior.needFavicon ||= needFavicon;
    needs.set(info.originalUrl, prior);
  }
  if (needs.size === 0) return registry;

  const stored = await readFreshStoreMap(STORE_KEYS.sessions);
  const snapshots = Object.values(stored ?? {})
    .filter((session) => session?.auto && !session.deletedAt && Array.isArray(session.windows))
    .sort((a, b) => (Number(b.modifiedAt) || 0) - (Number(a.modifiedAt) || 0));
  const found = new Map();
  let visited = 0;
  let unresolved = [...needs.values()].reduce((n, need) =>
    n + Number(need.needTitle) + Number(need.needFavicon), 0);

  for (const snapshot of snapshots) {
    for (const windowRefs of snapshot.windows) {
      if (!Array.isArray(windowRefs)) continue;
      for (const ref of windowRefs) {
        visited += 1;
        if (visited % 2048 === 0) await yieldMetadataScan();
        const need = needs.get(ref?.url);
        if (!need) continue;
        const current = found.get(ref.url) ?? {};
        if (need.needTitle && !current.title &&
            !placeholderSuspendTitle(ref.title, ref.url)) {
          current.title = ref.title;
          unresolved -= 1;
        }
        if (need.needFavicon && !current.favIconUrl && ref.favIconUrl) {
          current.favIconUrl = ref.favIconUrl;
          unresolved -= 1;
        }
        found.set(ref.url, current);
      }
    }
    if (unresolved <= 0) break;
  }
  if (found.size === 0) return registry;

  await mutateStores([SUSPEND_REGISTRY_KEY], (maps) => {
    const fresh = maps[SUSPEND_REGISTRY_KEY] ?? {};
    let changed = false;
    for (const [id, info] of Object.entries(fresh)) {
      const recovered = found.get(info?.originalUrl);
      if (!recovered) continue;
      const next = { ...info };
      if (recovered.title && placeholderSuspendTitle(next.title, next.originalUrl)) {
        next.title = recovered.title;
      }
      if (recovered.favIconUrl && !next.favIconUrl) {
        next.favIconUrl = recovered.favIconUrl;
      }
      if (next.title === info.title && next.favIconUrl === info.favIconUrl) continue;
      fresh[id] = next;
      changed = true;
    }
    return changed ? { [SUSPEND_REGISTRY_KEY]: fresh } : null;
  });
  return getSuspendRegistry();
}

/* ---------- N4: suspended-tab recovery registry ----------
 * Chrome closes every tab showing an extension page when the extension
 * reloads/updates — including our suspend.html tabs (the Great Suspender failure
 * mode). We persist a registry of the suspend.html tabs we create so the worker
 * can recreate them at boot. A user closing a suspended tab fires tabs.onRemoved
 * *while we're alive* → we drop that entry, so a close is never resurrected; a
 * reload kills us first, so those entries survive to be recovered.
 * @typedef {{originalUrl: string, title: string, favIconUrl?: string, windowId: number, index: number, pinned: boolean, recoveryOccurrenceId?: string, awayAt?: number}} SuspendEntry
 */

/** @returns {Promise<Record<string, SuspendEntry>>} */
export async function getSuspendRegistry() {
  return await readStoreMap(SUSPEND_REGISTRY_KEY) ?? {};
}

/**
 * Record a freshly-suspended tab.
 * @param {chrome.tabs.Tab} t
 * @param {string} originalUrl
 * @param {string} [recoveryOccurrenceId]
 * @returns {Promise<SuspendEntry|undefined>}
 */
export async function registerSuspended(t, originalUrl, recoveryOccurrenceId = "") {
  if (t.id === undefined) return;
  // Once the tab is already parked on suspend.html, Chrome exposes this
  // extension page's title and favicon on the Tab object. Its query parameters
  // are the authoritative identity of the original page. Reusing t.title or
  // t.favIconUrl here would gradually replace that identity with EveryTab's
  // own title/icon each time the page self-adopts after a restore.
  const suspendedRef = ownSuspendedRef(t);
  const sourceUrl = suspendedRef?.url || originalUrl;
  const sourceTitle = suspendedRef?.title || t.title || sourceUrl;
  const sourceFavicon = suspendedRef ? suspendedRef.favIconUrl : t.favIconUrl;
  const entry = {
    originalUrl: sourceUrl,
    title: sourceTitle,
    ...(sourceFavicon ? { favIconUrl: sourceFavicon } : {}),
    windowId: t.windowId,
    index: t.index,
    pinned: Boolean(t.pinned),
    recoveryOccurrenceId: recoveryOccurrenceId || crypto.randomUUID()
  };
  // E2-0e: atomic RMW under the store lock — the recovery registry is the
  // "never lose a suspended tab" data, so two concurrent registers must not
  // lose one another.
  await mutateStores([SUSPEND_REGISTRY_KEY, ACTIVITY_KEY], (maps) => {
    const reg = maps[SUSPEND_REGISTRY_KEY] ?? {};
    const previous = reg[t.id];
    const awayAt = maps[ACTIVITY_KEY]?.[t.id];
    if (!t.active && Number.isFinite(awayAt)) entry.awayAt = awayAt;
    if (previous?.originalUrl === entry.originalUrl) {
      if (placeholderSuspendTitle(entry.title, entry.originalUrl) &&
          !placeholderSuspendTitle(previous.title, previous.originalUrl)) {
        entry.title = previous.title;
      }
      if (!entry.favIconUrl && previous.favIconUrl) entry.favIconUrl = previous.favIconUrl;
      if (previous.recoveryOccurrenceId) {
        entry.recoveryOccurrenceId = previous.recoveryOccurrenceId;
      }
      if (!Number.isFinite(entry.awayAt) && Number.isFinite(previous.awayAt)) {
        entry.awayAt = previous.awayAt;
      }
    }
    reg[t.id] = entry;
    return { [SUSPEND_REGISTRY_KEY]: reg };
  });
  return entry;
}

/** Drop a tab from the registry (woken, or the user closed it). @param {number} tabId */
export async function unregisterSuspended(tabId) {
  readySuspendPageIds.delete(tabId);
  await mutateStores([SUSPEND_REGISTRY_KEY], (maps) => {
    const reg = maps[SUSPEND_REGISTRY_KEY] ?? {};
    if (!(tabId in reg)) return null; // nothing to remove — validated no-op
    delete reg[tabId];
    return { [SUSPEND_REGISTRY_KEY]: reg };
  });
}

/* ---------- N4b: the reload race ----------
 * In a real extension reload the new worker can boot while the old suspend.html
 * tabs are STILL OPEN — they die a beat later, when their renderer notices the
 * extension changed. Sequence that lost tabs in 0.8.8:
 *   boot → recovery sees them live → skips → Chrome closes them → onRemoved
 *   fires in the NEW worker → registry purged → nothing left to recover.
 * Fix: (1) onInstalled opens a GRACE WINDOW during which onRemoved never purges
 * the registry (a close in that window is assumed to be the reload, not the
 * user); (2) recovery re-runs after the dust settles (fast attempts, retained
 * 2s/8s retries, and a 30s alarm), serialized so passes can't double-create.
 */
const RECOVERY_GRACE_KEY = "suspendRecoveryGraceUntil";
const RECOVERY_GRACE_MS = 60_000;

// A chrome.tabs URL is not proof that the extension document rendered. During
// an unpacked-extension reload Chrome can retain suspend.html in the tab model
// while its renderer shows the internal “Can't open this page / Error code: 5”
// document. A healthy suspend page reasserts itself through
// adoptSuspendedPage() in this worker generation; an error document cannot.
const readySuspendPageIds = new Set();

function isReadyRecoveryOccurrence(tab, entry, initialIds) {
  if (!entry || !initialIds.has(entry.recoveryOccurrenceId) || tab.incognito ||
      tab.pendingUrl || !readySuspendPageIds.has(tab.id)) return false;
  const ref = ownSuspendedRef(tab);
  const occurrenceId = suspendedPageOccurrenceId(tab);
  return ref?.url === entry.originalUrl &&
    (!occurrenceId || occurrenceId === entry.recoveryOccurrenceId);
}

/**
 * Confirm retained pages separately from browser repairs. Only occurrences
 * present when this reload began can earn the ready summary; later manual
 * suspensions do not become recovery work. A fresh registry vetoes concurrent
 * wake/close decisions before the receipt is committed.
 */
export async function refreshAlreadyReadyRecoveryOccurrences(cycleId) {
  const cycle = await readStoreValue(SUSPEND_RECOVERY_CYCLE_KEY);
  if (cycle?.id !== cycleId || !cycle.initialOccurrenceIds?.length) return;
  const tabs = await chrome.tabs.query({});
  await mutateStores([SUSPEND_RECOVERY_CYCLE_KEY, SUSPEND_REGISTRY_KEY], (maps) => {
    const current = maps[SUSPEND_RECOVERY_CYCLE_KEY];
    if (current?.id !== cycleId) return null;
    const initial = new Set(current.initialOccurrenceIds ?? []);
    const repaired = new Set(current.recoveredOccurrenceIds ?? []);
    const registry = maps[SUSPEND_REGISTRY_KEY] ?? {};
    const ready = new Set();
    const liveRepaired = new Set();
    for (const tab of tabs) {
      const entry = registry[tab.id];
      if (!entry || tab.incognito || tab.pendingUrl ||
          hasPendingOccurrenceClose(tab.id, entry, registry)) continue;
      if (repaired.has(entry.recoveryOccurrenceId) &&
          ownSuspendedRef(tab)?.url === entry.originalUrl &&
          suspendedPageOccurrenceId(tab) === entry.recoveryOccurrenceId) {
        liveRepaired.add(entry.recoveryOccurrenceId);
      }
      if (isReadyRecoveryOccurrence(tab, entry, initial) &&
          !repaired.has(entry.recoveryOccurrenceId)) {
        ready.add(entry.recoveryOccurrenceId);
      }
    }
    const prior = new Set(current.alreadyReadyOccurrenceIds ?? []);
    const changed = ready.size !== prior.size || [...ready].some(id => !prior.has(id));
    // Repaired-only copy reports a historical recovery effect. Mixed copy is
    // present tense, so a repaired member must still exist to be called ready.
    const summaryTotal = ready.size > 0 ? new Set([...liveRepaired, ...ready]).size : repaired.size;
    return { [SUSPEND_RECOVERY_CYCLE_KEY]: {
      ...current,
      alreadyReadyOccurrenceIds: [...ready],
      summaryTotal,
      ...(current.complete && (changed || current.summaryTotal !== summaryTotal) ? {
        notificationState: summaryTotal > 0
          ? recoveryNotificationStateAfterRecovery(current) : "none"
      } : {})
    } };
  });
}

/** Open the grace window. Call FIRST in onInstalled, before any async work. */
export async function markRecoveryGrace() {
  await mutateStores([RECOVERY_GRACE_KEY], () => ({
    [RECOVERY_GRACE_KEY]: Date.now() + RECOVERY_GRACE_MS
  }));
}

/** @returns {Promise<boolean>} true while the post-reload grace window is open */
export async function inRecoveryGrace() {
  return Date.now() < (await readStoreValue(RECOVERY_GRACE_KEY) ?? 0);
}

/**
 * onRemoved handler for the registry: purge on a genuine user close, but keep
 * the entry during the post-reload grace window so recovery can resurrect it.
 * (Cost of the trade-off: a tab the user closes within ~30s of an extension
 * update may come back once. Wrong direction is losing tabs; this errs safe.)
 * @param {number} tabId
 * @param {SuspendEntry|null} [expectedOccurrence] captured identity, if known
 */
export async function unregisterSuspendedOnClose(tabId, expectedOccurrence = null) {
  readySuspendPageIds.delete(tabId);
  // The grace marker and the removal decision must share one lock. During an
  // extension reload, tabs.onRemoved can run while markRecoveryGrace() is still
  // awaiting its storage write. Reading the marker before taking the lock lets
  // that removal queue behind the marker and then delete the entry anyway.
  // Re-read both values only after this mutation owns the lock.
  let outcome = "absent";
  await mutateStores([RECOVERY_GRACE_KEY, SUSPEND_REGISTRY_KEY], (maps) => {
    if (Date.now() < (maps[RECOVERY_GRACE_KEY] ?? 0)) {
      outcome = "preserved";
      return null;
    }
    const reg = maps[SUSPEND_REGISTRY_KEY] ?? {};
    const sourceId = String(tabId);
    const occurrence = expectedOccurrence ?? reg[sourceId];
    // Browser restart can leave old and adopted numeric IDs for one occurrence.
    // The user's close retires that occurrence, including every stale alias.
    const removalIds = occurrence?.recoveryOccurrenceId
      ? Object.keys(reg).filter((id) => sameSuspendOccurrence(reg[id], occurrence))
      : sourceId in reg && (!occurrence || sameSuspendOccurrence(reg[sourceId], occurrence))
        ? [sourceId] : [];
    if (!removalIds.length) {
      if (sourceId in reg && expectedOccurrence) outcome = "stale";
      return null;
    }
    for (const id of removalIds) {
      readySuspendPageIds.delete(Number(id));
      delete reg[id];
    }
    outcome = "removed";
    return { [SUSPEND_REGISTRY_KEY]: reg };
  });
  return outcome;
}

// A rejected registry mutation must never become an unhandled event-listener
// promise or let a deliberately closed suspended page return at next startup.
// This tiny direct-local ledger is device-only and independent of the Library;
// recovery drains it before recreating any suspended tabs.
let closeCleanupLedgerChain = Promise.resolve();
const closeCleanupIdsInFlight = new Set();
/** Pending close identity survives failed ledger/registry writes in this worker.
 * @type {Map<number, SuspendEntry|null>} */
const retainedCloseCleanups = new Map();

function mutateCloseCleanupLedger(mutate) {
  closeCleanupLedgerChain = closeCleanupLedgerChain.then(async () => {
    const stored = await chrome.storage.local.get(SUSPEND_CLOSE_CLEANUP_KEY);
    const current = stored[SUSPEND_CLOSE_CLEANUP_KEY] ?? {};
    const next = mutate(structuredClone(current));
    await chrome.storage.local.set({ [SUSPEND_CLOSE_CLEANUP_KEY]: next });
    return next;
  }, async () => {
    const stored = await chrome.storage.local.get(SUSPEND_CLOSE_CLEANUP_KEY);
    const next = mutate(structuredClone(stored[SUSPEND_CLOSE_CLEANUP_KEY] ?? {}));
    await chrome.storage.local.set({ [SUSPEND_CLOSE_CLEANUP_KEY]: next });
    return next;
  });
  return closeCleanupLedgerChain;
}

/** Match the logical suspended occurrence, not merely Chrome's reusable tab id. */
function sameSuspendOccurrence(current, expected) {
  if (!current || !expected) return false;
  if (current.recoveryOccurrenceId && expected.recoveryOccurrenceId) {
    return current.recoveryOccurrenceId === expected.recoveryOccurrenceId;
  }
  if (current.recoveryOccurrenceId || expected.recoveryOccurrenceId) return false;
  return current.originalUrl === expected.originalUrl &&
    current.title === expected.title &&
    current.windowId === expected.windowId &&
    current.index === expected.index &&
    Boolean(current.pinned) === Boolean(expected.pinned);
}

async function rememberCloseCleanup(tabId, occurrence) {
  // Protect recovery immediately, including while the durable receipt is
  // waiting for chrome.storage. The id remains retained if that write fails.
  retainedCloseCleanups.set(Number(tabId), occurrence ?? null);
  await mutateCloseCleanupLedger((ledger) => ({
    ...ledger,
    [tabId]: {
      tabId,
      recordedAt: Date.now(),
      recoveryOccurrenceId: occurrence?.recoveryOccurrenceId || "",
      originalUrl: occurrence?.originalUrl || "",
      title: occurrence?.title || "",
      windowId: occurrence?.windowId,
      index: occurrence?.index,
      pinned: Boolean(occurrence?.pinned)
    }
  }));
  // alarm-fallback: the in-memory retained id already protects recovery and
  // worker start retries the ledger. Packed builds clamp this to 30 s, which
  // only delays the durable retry of an already-recorded close intent.
  await chrome.alarms?.create?.(SUSPEND_CLOSE_CLEANUP_ALARM, {
    when: Date.now() + 2_000
  });
}

async function forgetCloseCleanup(tabId) {
  await mutateCloseCleanupLedger((ledger) => {
    delete ledger[tabId];
    return ledger;
  });
  retainedCloseCleanups.delete(Number(tabId));
}

/** Own tabs.onRemoved cleanup and retain a durable retry after a transient failure. */
export async function queueSuspendedCloseCleanup(tabId) {
  closeCleanupIdsInFlight.add(tabId);
  let grace = false;
  let intentWritten = false;
  let expectedOccurrence = null;
  try {
    // Outside reload grace, publish the close intent before touching the
    // registry. Recovery can therefore never pass between a rejected registry
    // commit and its durable retry receipt. The in-memory set covers this same
    // ordering inside the current worker.
    try { grace = await inRecoveryGrace(); } catch { /* fail closed below */ }
    if (!grace) {
      expectedOccurrence = (await getSuspendRegistry())[tabId] ?? null;
      await rememberCloseCleanup(tabId, expectedOccurrence);
      intentWritten = true;
    }
    const outcome = await unregisterSuspendedOnClose(tabId, expectedOccurrence);
    if (outcome === "removed" || outcome === "absent" || outcome === "stale") {
      await forgetCloseCleanup(tabId);
    } else if (outcome === "preserved" && intentWritten) {
      // markRecoveryGrace may have won its locked write after the preliminary
      // read. The authoritative decision is reload teardown, not user intent.
      await forgetCloseCleanup(tabId);
    }
    return outcome;
  } catch (error) {
    try {
      // Chrome itself removes extension pages during reload grace. Retaining
      // those removals as user-close intents would delete the very recovery
      // records the grace window exists to protect. Outside grace, however, a
      // failed cleanup must be durable so recovery cannot resurrect a tab the
      // user deliberately closed.
      if (!grace && !intentWritten && !await inRecoveryGrace()) {
        expectedOccurrence ??= (await getSuspendRegistry())[tabId] ?? null;
        await rememberCloseCleanup(tabId, expectedOccurrence);
      }
    } catch (ledgerError) {
      reportFailure("suspended-close-retry", ledgerError);
    }
    throw error;
  } finally {
    closeCleanupIdsInFlight.delete(tabId);
  }
}

/** Drain retained close intents before any recovery pass can recreate a page. */
export async function retrySuspendedCloseCleanups() {
  const stored = await chrome.storage.local.get(SUSPEND_CLOSE_CLEANUP_KEY);
  const ledger = stored[SUSPEND_CLOSE_CLEANUP_KEY] ?? {};
  const tabIds = Object.keys(ledger)
    .map(Number).filter(Number.isInteger);
  for (const tabId of tabIds) retainedCloseCleanups.set(tabId, ledger[tabId]);
  let failed = 0;
  let pending = 0;
  for (const tabId of tabIds) {
    try {
      const outcome = await unregisterSuspendedOnClose(tabId, ledger[tabId]);
      if (outcome === "preserved") {
        pending += 1;
      } else {
        // Both removed and absent are complete, idempotent outcomes. A stale
        // receipt must not keep waking the worker after its registry work is
        // already gone.
        await forgetCloseCleanup(tabId);
      }
    } catch {
      failed += 1;
    }
  }
  if (failed > 0 || pending > 0) {
    // alarm-fallback: a preserved entry waits for the 60 s reload grace to
    // end anyway; a 30 s packed-build minimum keeps that outcome unchanged.
    await chrome.alarms?.create?.(SUSPEND_CLOSE_CLEANUP_ALARM, {
      when: Date.now() + 5_000
    });
  }
  return { attempted: tabIds.length, failed, pending };
}

/** Close ownership follows a stable occurrence across old and adopted tab IDs. */
function hasPendingOccurrenceClose(sourceId, occurrence, registry) {
  const tabId = Number(sourceId);
  if (closeCleanupIdsInFlight.has(tabId) || retainedCloseCleanups.has(tabId)) return true;
  for (const pending of retainedCloseCleanups.values()) {
    if (sameSuspendOccurrence(pending, occurrence)) return true;
  }
  // A close can be waiting for its first registry read, before it captures the
  // durable receipt. Its known registry alias already identifies the occurrence.
  for (const pendingId of closeCleanupIdsInFlight) {
    if (sameSuspendOccurrence(registry[pendingId], occurrence)) return true;
  }
  return false;
}

/** Recheck a recovery source immediately before or after changing Chrome. */
async function recoverySourceIsCurrent(sourceId, expectedOccurrence) {
  if (hasPendingOccurrenceClose(sourceId, expectedOccurrence, {})) return false;
  const registry = await getSuspendRegistry();
  if (hasPendingOccurrenceClose(sourceId, expectedOccurrence, registry)) return false;
  return sameSuspendOccurrence(registry[sourceId], expectedOccurrence);
}

/** Remove a recovery-created page that lost ownership during an async effect. */
async function discardStaleRecoveredTab(tabId) {
  const expected = (await getSuspendRegistry())[tabId] ?? null;
  try { await chrome.tabs.remove?.(tabId); } catch { /* already gone */ }
  readySuspendPageIds.delete(tabId);
  if (!expected) return;
  await mutateStores([SUSPEND_REGISTRY_KEY], (maps) => {
    const registry = maps[SUSPEND_REGISTRY_KEY] ?? {};
    if (!sameSuspendOccurrence(registry[tabId], expected)) return null;
    delete registry[tabId];
    return { [SUSPEND_REGISTRY_KEY]: registry };
  });
}

/** Serialize recovery passes — overlapping passes could double-create. */
let recoveryChain = Promise.resolve(0);
/** @returns {Promise<number>} tabs recovered in this pass */
export function queueRecovery(options = {}) {
  const run = () => recoverSuspendedTabs(options);
  recoveryChain = recoveryChain.then(
    run,
    run
  );
  return recoveryChain;
}

/**
 * Delayed metadata repair for an install, update, or unpacked reload. Keep the
 * potentially large historical Session read off ordinary worker startup and
 * Open/New Tab recovery. The subsequent pass remains part of the active
 * reload-recovery cycle, so it cannot repeat an occurrence already repaired by
 * an earlier pass and can extend that cycle's one notification when necessary.
 * @param {{allowReloadRepair?: boolean, recoveryCycleId?: string|null}} [options]
 * @returns {Promise<number>} tabs recreated by the recovery pass
 */
export function queueSuspendMetadataRepair(options = {}) {
  recoveryChain = recoveryChain.then(async () => {
    await backfillSuspendMetadata(await getSuspendRegistry());
    return recoverSuspendedTabs(options);
  }, async () => {
    await backfillSuspendMetadata(await getSuspendRegistry());
    return recoverSuspendedTabs(options);
  });
  return recoveryChain;
}

/** Keep the last known placement when a partial Chrome test double or a race
 * omits one field; real live values always win. */
function withLivePlacement(info, tab) {
  return {
    ...info,
    windowId: Number.isInteger(tab?.windowId) ? tab.windowId : info.windowId,
    index: Number.isInteger(tab?.index) ? tab.index : info.index,
    pinned: typeof tab?.pinned === "boolean" ? tab.pinned : Boolean(info.pinned)
  };
}

/**
 * After an extension reload: recreate any registered suspend tab that's no
 * longer live. Ordinary Chrome startup never calls this path.
 * Present tabs (matched by tabId, or by a live suspend page with the same
 * originalUrl — a browser restart's own session-restore) are skipped, not
 * duplicated. The registry is re-keyed to the surviving/created tab ids (stale
 * entries pruned). The worker startup owner launches this through its bounded
 * recovery coordinator.
 * @param {(total:number, state?:{deferSummary:boolean}) => void} [options.onBrowserRecoveryComplete] called after the
 *   browser effects are visible, before durable reconciliation can wait on
 *   unrelated Store writers
 * @returns {Promise<number>} tabs recovered
 */
export async function recoverSuspendedTabs({
  allowReloadRepair = false,
  recoveryCycleId = null,
  onBrowserRecoveryComplete = () => {}
} = {}) {
  // A retained close intent wins over recovery. This is the narrow failure
  // path where the browser tab is already gone but its registry deletion did
  // not commit. Skipping only those exact ids lets unrelated reload recovery
  // continue without recreating something the user closed.
  const [reg, cleanupState, recoveryCycle] = await Promise.all([
    getSuspendRegistry(),
    chrome.storage.local.get(SUSPEND_CLOSE_CLEANUP_KEY),
    recoveryCycleId ? readStoreValue(SUSPEND_RECOVERY_CYCLE_KEY) : null
  ]);
  for (const [id, receipt] of Object.entries(cleanupState[SUSPEND_CLOSE_CLEANUP_KEY] ?? {})) {
    retainedCloseCleanups.set(Number(id), receipt);
  }
  const pendingCloseIds = new Set(Object.entries(reg)
    .filter(([id, entry]) => hasPendingOccurrenceClose(id, entry, reg))
    .map(([id]) => id));
  const recoveredBeforePass = new Set(
    recoveryCycle?.id === recoveryCycleId ? recoveryCycle.recoveredOccurrenceIds ?? [] : []
  );
  // Upgrade legacy records once before any asynchronous browser effect. Chrome
  // may reuse a numeric tab id after restart; the stable occurrence id keeps a
  // late close receipt from deleting a different page that inherited that id.
  if (Object.entries(reg).some(([id, entry]) =>
    entry && !entry.recoveryOccurrenceId && !pendingCloseIds.has(id))) {
    await mutateStores([SUSPEND_REGISTRY_KEY], (maps) => {
      const current = maps[SUSPEND_REGISTRY_KEY] ?? {};
      let changed = false;
      for (const [id, entry] of Object.entries(current)) {
        if (!entry || entry.recoveryOccurrenceId || pendingCloseIds.has(id)) continue;
        entry.recoveryOccurrenceId = crypto.randomUUID();
        changed = true;
      }
      return changed ? { [SUSPEND_REGISTRY_KEY]: current } : null;
    });
    return recoverSuspendedTabs({
      allowReloadRepair, recoveryCycleId, onBrowserRecoveryComplete
    });
  }
  // Several vanished suspend pages in one live window must be recreated from
  // left to right. Registry object order follows old numeric tab ids, not the
  // visual order; inserting a later slot first lets Chrome clamp it against the
  // compressed survivor list and leaves the page one position too far right.
  const entries = Object.entries(reg).filter(([id]) => !pendingCloseIds.has(id))
    .map(([id, info]) => [id, {
    ...info,
    // Keep one logical identity when recovery re-keys a record to a new tab id.
    recoveryOccurrenceId: info?.recoveryOccurrenceId || `${id}:${info?.originalUrl || ""}`
  }]).sort(([idA, a], [idB, b]) => {
    const windowA = Number.isInteger(a?.windowId) ? a.windowId : Number.MAX_SAFE_INTEGER;
    const windowB = Number.isInteger(b?.windowId) ? b.windowId : Number.MAX_SAFE_INTEGER;
    if (windowA !== windowB) return windowA - windowB;
    const indexA = Number.isInteger(a?.index) ? a.index : Number.MAX_SAFE_INTEGER;
    const indexB = Number.isInteger(b?.index) ? b.index : Number.MAX_SAFE_INTEGER;
    if (indexA !== indexB) return indexA - indexB;
    return idA.localeCompare(idB);
  });

  const base = chrome.runtime.getURL("suspend.html");
  const tabs = await chrome.tabs.query({});
  /* N4c: the liveness test must ask "is our suspend PAGE still there", not "does
   * a tab with this id still exist". Chrome does not always CLOSE an extension
   * page when the extension reloads — it can leave the tab open and navigate it
   * to the New Tab page (which renders Chrome's own default, because our
   * override is unregistered at that instant). The old test saw the surviving
   * tab id, concluded "still there", and skipped it on that pass and every pass
   * after it: the user's page was silently replaced by a blank new tab, with the
   * registry still pointing at it. */
  const liveById = new Map();
  /** @type {Map<number, {tab: chrome.tabs.Tab, originalUrl: string, occurrenceId: string, ref: import("./types.js").TabRef}>} */
  const liveSuspendById = new Map();
  /** @type {Map<string, chrome.tabs.Tab[]>} */
  const liveSuspendByOriginal = new Map();
  for (const t of tabs) {
    if (t.id !== undefined) liveById.set(t.id, t);
    const ref = ownSuspendedRef(t);
    if (!ref || t.id === undefined) continue;
    liveSuspendById.set(t.id, {
      tab: t,
      originalUrl: ref.url,
      occurrenceId: suspendedPageOccurrenceId(t),
      ref
    });
    if (!liveSuspendByOriginal.has(ref.url)) liveSuspendByOriginal.set(ref.url, []);
    liveSuspendByOriginal.get(ref.url).push(t);
  }
  const grace = allowReloadRepair || await inRecoveryGrace();
  let liveWindowIds;

  // A modern page carries one stable occurrence id across a reload. Chrome can
  // reveal the old page after its replacement has mounted; older builds let
  // both pages self-register under different tab ids. Collapse that completed
  // race before ordinary matching. Equal URLs with different occurrence ids
  // remain intentional, independent suspended tabs.
  if (grace) {
    const registryIdsByOccurrence = new Map();
    for (const [idStr, info] of entries) {
      const occurrenceId = info?.recoveryOccurrenceId || "";
      if (!occurrenceId) continue;
      if (!registryIdsByOccurrence.has(occurrenceId)) {
        registryIdsByOccurrence.set(occurrenceId, []);
      }
      registryIdsByOccurrence.get(occurrenceId).push(idStr);
    }
    const duplicateGroups = [...registryIdsByOccurrence]
      .filter(([, ids]) => ids.length > 1);
    if (duplicateGroups.length > 0) {
      liveWindowIds = new Set((await chrome.windows.getAll({})).map(window => window.id));
      const duplicateLiveIds = new Set();
      let registryChanged = false;
      await mutateStores([SUSPEND_REGISTRY_KEY], (maps) => {
        const fresh = maps[SUSPEND_REGISTRY_KEY] ?? {};
        const nextRegistry = { ...fresh };
        let changed = false;
        for (const [occurrenceId, candidateIds] of duplicateGroups) {
          const freshIds = candidateIds.filter((id) =>
            fresh[id]?.recoveryOccurrenceId === occurrenceId);
          if (freshIds.length < 2) continue;
          const exactLiveIds = freshIds.filter((id) =>
            liveSuspendById.get(Number(id))?.occurrenceId === occurrenceId);
          // After browser restart, adoption retains the current placement beside
          // an old tab ID. Reload can remove both pages before this pass. Keep
          // the record in a surviving window rather than its obsolete sibling.
          const canonicalRegistryId = exactLiveIds.find((id) =>
            readySuspendPageIds.has(Number(id))) ?? exactLiveIds[0] ??
            freshIds.find((id) => liveWindowIds.has(fresh[id]?.windowId)) ?? freshIds[0];
          const liveOccurrenceIds = [...liveSuspendById]
            .filter(([, live]) => live.occurrenceId === occurrenceId)
            .map(([tabId]) => tabId);
          const canonicalLiveId = liveOccurrenceIds.includes(Number(canonicalRegistryId))
            ? Number(canonicalRegistryId)
            : liveOccurrenceIds[0];
          for (const id of freshIds) {
            if (id === canonicalRegistryId) continue;
            delete nextRegistry[id];
            changed = true;
          }
          for (const tabId of liveOccurrenceIds) {
            if (tabId !== canonicalLiveId) duplicateLiveIds.add(tabId);
          }
        }
        registryChanged = changed;
        return changed ? { [SUSPEND_REGISTRY_KEY]: nextRegistry } : null;
      });
      for (const tabId of duplicateLiveIds) {
        try { await chrome.tabs.remove?.(tabId); } catch { /* a later safety pass retries */ }
        readySuspendPageIds.delete(tabId);
      }
      if (registryChanged) {
        return recoverSuspendedTabs({
          allowReloadRepair, recoveryCycleId, onBrowserRecoveryComplete
        });
      }
    }
  }

  // A browser restart can restore an extension page in the right place under
  // completely new tab and window ids. Match each registry occurrence to one
  // live page, preferring an exact surviving id before URL fallback. The old
  // Set-of-URLs check proved only that *some* copy survived, then retained its
  // stale placement forever; a later extension reload recreated it in Chrome's
  // current window. One-to-one matching also preserves duplicate occurrences.
  const liveMatchByRegistryId = new Map();
  const claimedLiveIds = new Set();
  for (const [idStr, info] of entries) {
    const exact = liveSuspendById.get(Number(idStr));
    if (!exact || exact.originalUrl !== info.originalUrl) continue;
    liveMatchByRegistryId.set(idStr, exact.tab);
    claimedLiveIds.add(exact.tab.id);
  }
  for (const [idStr, info] of entries) {
    if (liveMatchByRegistryId.has(idStr)) continue;
    const candidates = liveSuspendByOriginal.get(info.originalUrl) ?? [];
    const fallback = candidates.find((tab) => !claimedLiveIds.has(tab.id));
    if (!fallback) continue;
    liveMatchByRegistryId.set(idStr, fallback);
    claimedLiveIds.add(fallback.id);
  }
  // Chrome can reveal an old extension tab after a previous recovery pass has
  // already recreated and registered that occurrence. URL fallback above has
  // claimed every live page needed by the registry, so any remaining live page
  // with an already-represented original URL is a delayed browser copy. Remove
  // that copy instead of adopting it as a new occurrence.
  const representedUrls = new Set(entries
    .filter(([idStr]) => liveMatchByRegistryId.has(idStr))
    .map(([, info]) => info.originalUrl));
  if (grace) {
    for (const [tabId, live] of liveSuspendById) {
      if (claimedLiveIds.has(tabId) || !representedUrls.has(live.originalUrl)) continue;
      try { await chrome.tabs.remove?.(tabId); } catch { /* retry on the next safety pass */ }
      readySuspendPageIds.delete(tabId);
      claimedLiveIds.add(tabId);
    }
  }

  /* v0.8.405 migration repair: an old profile can have mounted suspend pages
   * whose registry entries were already lost by an earlier reload. The first
   * upgraded worker can still see those pages briefly, before Chrome tears the
   * old extension renderers down. A page cannot send the new self-adoption
   * message until after that teardown, so trusting the old registry here loses
   * every unregistered occurrence during the very reload that installs the
   * repair.
   *
   * During the explicit post-install grace only, capture each unclaimed live
   * occurrence under its exact tab id. Commit this BEFORE any recovery effects;
   * even if Chrome removes the page immediately after tabs.query(), the next
   * serialized pass now has a durable entry to recreate. URL matching above
   * claims browser-restored occurrences first, so this never duplicates a
   * stale-id registry entry that already represents the same live page. */
  if (grace) {
    /** @type {Record<string, SuspendEntry>} */
    const discovered = {};
    for (const [tabId, live] of liveSuspendById) {
      if (claimedLiveIds.has(tabId)) continue;
      if (hasPendingOccurrenceClose(tabId, { recoveryOccurrenceId: live.occurrenceId }, reg)) continue;
      const { tab, ref } = live;
      discovered[tabId] = {
        originalUrl: ref.url,
        title: ref.title || ref.url,
        ...(ref.favIconUrl ? { favIconUrl: ref.favIconUrl } : {}),
        windowId: tab.windowId,
        index: tab.index,
        pinned: Boolean(tab.pinned),
        recoveryOccurrenceId: crypto.randomUUID()
      };
    }
    if (Object.keys(discovered).length > 0) {
      await mutateStores([SUSPEND_REGISTRY_KEY], (maps) => {
        const fresh = maps[SUSPEND_REGISTRY_KEY] ?? {};
        const merged = { ...fresh };
        let changed = false;
        for (const [tabId, entry] of Object.entries(discovered)) {
          // A page's own adoption may have won the race while this pass waited.
          if (Object.hasOwn(merged, tabId)) continue;
          merged[tabId] = entry;
          changed = true;
        }
        return changed ? { [SUSPEND_REGISTRY_KEY]: merged } : null;
      });
      // Re-read and rematch the authoritative registry so occurrence matching,
      // re-keying, and concurrent mutation semantics remain in one code path.
      return recoverSuspendedTabs({
        allowReloadRepair, recoveryCycleId, onBrowserRecoveryComplete
      });
    }
  }
  if (entries.length === 0) return 0;

  liveWindowIds ??= new Set((await chrome.windows.getAll({})).map(window => window.id));
  // Repairing a surviving tab in place is only safe while we know its page was
  // taken by the reload. Outside that window, a registered tab showing anything
  // else is the user having moved on, and must be left alone.
  /** @type {Record<string, SuspendEntry>} */
  const next = {};
  /** @type {Map<string, string>} source registry id -> surviving/created id */
  const nextIdBySource = new Map();
  /** @type {Map<string, number>} source registry id -> recovery-created tab id */
  const createdIdBySource = new Map();
  /** @type {Map<string, string>} source registry id -> recovered occurrence id */
  const recoveredOccurrenceBySource = new Map();
  /** Start missing-tab creations in visual order, then settle them together.
   * Chrome receives the placement requests left-to-right while one slow tab
   * renderer no longer blocks every later recovery request. */
  const pendingCreations = [];
  for (const [idStr, info] of entries) {
    const liveMatch = liveMatchByRegistryId.get(idStr);
    if (liveMatch && grace && !readySuspendPageIds.has(liveMatch.id)) {
      // Chrome may still report the exact suspend URL for its internal Error 5
      // document. Change the URL so this is a real navigation, not a same-URL
      // no-op, and keep the tab/window/index identity intact.
      if (!await recoverySourceIsCurrent(idStr, info)) continue;
      if (recoveredBeforePass.has(info.recoveryOccurrenceId)) {
        next[liveMatch.id] = withLivePlacement(info, liveMatch);
        nextIdBySource.set(idStr, String(liveMatch.id));
        continue;
      }
      try {
        await chrome.tabs.update(liveMatch.id, {
          url: suspendPageUrl(base, info, Date.now())
        });
        if (!await recoverySourceIsCurrent(idStr, info)) {
          continue;
        }
        recoveredOccurrenceBySource.set(idStr, info.recoveryOccurrenceId);
        next[liveMatch.id] = withLivePlacement(info, liveMatch);
        nextIdBySource.set(idStr, String(liveMatch.id));
      } catch {
        // Keep the durable occurrence when Chrome rejects this navigation.
        // A later serialized pass can repair or recreate it; dropping the
        // source here would turn a transient browser failure into data loss.
        next[liveMatch.id] = withLivePlacement(info, liveMatch);
        nextIdBySource.set(idStr, String(liveMatch.id));
      }
      continue;
    }
    if (liveMatch) {
      // The mounted suspend URL retains the original page identity even when a
      // previous build stored the extension page's rendered title/favicon.
      // Repair that durable metadata while it is still observable, before an
      // extension reload removes the page and recovery has only the registry.
      const liveRef = ownSuspendedRef(liveMatch);
      const liveIdentity = liveRef ? {
        ...info,
        originalUrl: liveRef.url,
        title: placeholderSuspendTitle(liveRef.title, liveRef.url) &&
          !placeholderSuspendTitle(info.title, info.originalUrl)
          ? info.title
          : (liveRef.title || info.title || liveRef.url),
        ...(liveRef.favIconUrl
          ? { favIconUrl: liveRef.favIconUrl }
          : (info.favIconUrl ? { favIconUrl: info.favIconUrl } : {}))
      } : info;
      const liveNeedsRepair = liveRef && (
        (placeholderSuspendTitle(liveRef.title, liveRef.url) &&
          !placeholderSuspendTitle(liveIdentity.title, liveIdentity.originalUrl)) ||
        (!liveRef.favIconUrl && Boolean(liveIdentity.favIconUrl))
      );
      if (liveNeedsRepair) {
        try {
          if (await recoverySourceIsCurrent(idStr, info)) {
            await chrome.tabs.update(liveMatch.id, {
              url: suspendPageUrl(base, liveIdentity)
            });
          }
        } catch { /* the durable repaired registry still protects the next pass */ }
      }
      next[liveMatch.id] = withLivePlacement(liveIdentity, liveMatch);
      nextIdBySource.set(idStr, String(liveMatch.id));
      // Our page is still there — refresh its current identity and placement.
      continue;
    }
    const suspendUrl = suspendPageUrl(base, info);

    const survivor = liveById.get(Number(idStr));
    if (survivor) {
      /* The tab outlived its page. Repair THAT tab rather than creating a second
       * one, so the page comes back in its own window at its own position.
       *
       * Two guards, and both matter more than the repair does. Only inside the
       * grace window do we know a lost page is the reload's doing. And only when
       * the tab is NOT showing a real page: the fingerprint of the teardown is
       * the New Tab page, about:blank, or nothing at all. If a live http page is
       * there, the user is reading something — never navigate that away, whatever
       * the registry believes. */
      const rawUrl = survivor.url || survivor.pendingUrl || "";
      if (!grace || /^https?:/i.test(rawUrl)) continue; // not ours to touch → drop the entry
      if (!await recoverySourceIsCurrent(idStr, info)) continue;
      try {
        await chrome.tabs.update(Number(idStr), { url: suspendUrl });
        if (!await recoverySourceIsCurrent(idStr, info)) {
          continue;
        }
        recoveredOccurrenceBySource.set(idStr, info.recoveryOccurrenceId);
        next[idStr] = withLivePlacement(info, survivor);
        nextIdBySource.set(idStr, idStr);
      } catch {
        // Gone between query and update. Retain the source occurrence so the
        // next pass can recreate it after Chrome's transient failure clears.
        next[idStr] = withLivePlacement(info, survivor);
        nextIdBySource.set(idStr, idStr);
      }
      continue;
    }

    const props = { url: suspendUrl, active: false, pinned: Boolean(info.pinned) };
    if (info.windowId != null && liveWindowIds.has(info.windowId)) {
      props.windowId = info.windowId;
      if (typeof info.index === "number") props.index = info.index;
    } // else: window gone → current window, appended at the end
    if (!await recoverySourceIsCurrent(idStr, info)) continue;
    const creation = Promise.resolve(chrome.tabs.create(props)).then(
      (created) => ({ created }),
      () => ({ failed: true })
    );
    pendingCreations.push({ idStr, info, creation });
  }
  await Promise.all(pendingCreations.map(async ({ idStr, info, creation }) => {
    const { created, failed } = await creation;
    if (failed) {
      // Creation can fail while Chrome is still restoring its windows. Keep
      // this exact occurrence registered so a later pass can retry safely.
      next[idStr] = info;
      nextIdBySource.set(idStr, idStr);
      return;
    }
    if (created && created.id !== undefined) {
      if (!await recoverySourceIsCurrent(idStr, info)) {
        await discardStaleRecoveredTab(created.id);
        return;
      }
      recoveredOccurrenceBySource.set(idStr, info.recoveryOccurrenceId);
      next[created.id] = withLivePlacement(info, created);
      nextIdBySource.set(idStr, String(created.id));
      createdIdBySource.set(idStr, created.id);
    }
  }));
  if (recoveredOccurrenceBySource.size > 0) {
    const visibleTotal = new Set([
      ...recoveredBeforePass,
      ...recoveredOccurrenceBySource.values()
    ]).size;
    try {
      // A mixed pass needs one truthful aggregate after retained pages have
      // been revalidated, rather than an early repairs-only banner followed
      // immediately by a second ready banner.
      const initial = new Set(recoveryCycle?.initialOccurrenceIds ?? []);
      const repaired = new Set([...recoveredBeforePass, ...recoveredOccurrenceBySource.values()]);
      // Unrepaired starting occurrences may self-adopt while reconciliation is
      // pending. Wait for their final check even if they were not ready in the
      // earlier Chrome snapshot, avoiding two different completion banners.
      const deferSummary = [...initial].some(id => !repaired.has(id));
      onBrowserRecoveryComplete(visibleTotal, { deferSummary });
    } catch (error) {
      reportFailure("suspended-recovery-notification", error);
    }
  }
  try {
    // A full browser-start reset clears reusable tab-id clocks. Let that reset
    // commit before the existing registry reconciliation transfers an exact
    // occurrence's awayAt into its surviving or recreated tab id. The visible
    // recovery callback above stays prompt and does not wait on this clock.
    await tabActivity.whenReady();
  } catch {
    // Activity initialization reports at its lifecycle owner. Registry rekeying
    // is essential recovery work and must still complete with a fresh grace.
  }
  // Reconcile against the FRESH registry under the lock. Recovery owns only
  // entries from its starting snapshot. A tab can be suspended, woken, or
  // closed while Chrome effects above are in flight; replacing the whole map
  // here used to erase a newly registered tab or resurrect a concurrent wake.
  const baseline = reg;
  const sameEntry = (a, b) => !!a && !!b &&
    sameSuspendOccurrence(a, b) && a.favIconUrl === b.favIconUrl &&
    a.awayAt === b.awayAt;
  const staleCreatedIds = new Set();
  await withAutomationProtectionWrite(() => mutateStores([
    SUSPEND_REGISTRY_KEY, ACTIVITY_KEY, TAB_PROTECTIONS_KEY
  ], (maps) => {
    const fresh = maps[SUSPEND_REGISTRY_KEY] ?? {};
    const merged = { ...fresh };
    const activity = maps[ACTIVITY_KEY] ?? {};
    const protections = maps[TAB_PROTECTIONS_KEY] ?? {};
    let activityChanged = false;
    let protectionsChanged = false;
    for (const [sourceId, baselineEntry] of Object.entries(baseline)) {
      if (hasPendingOccurrenceClose(sourceId, baselineEntry, fresh)) {
        const createdId = createdIdBySource.get(sourceId);
        if (createdId !== undefined) staleCreatedIds.add(createdId);
        recoveredOccurrenceBySource.delete(sourceId);
        continue; // retain close evidence until the cleanup owner commits it
      }
      // Missing or changed means another operation made a newer decision.
      if (!sameEntry(fresh[sourceId], baselineEntry)) {
        const createdId = createdIdBySource.get(sourceId);
        if (createdId !== undefined) staleCreatedIds.add(createdId);
        recoveredOccurrenceBySource.delete(sourceId);
        continue;
      }
      delete merged[sourceId];
      const targetId = nextIdBySource.get(sourceId);
      if (targetId && next[targetId]) {
        merged[targetId] = next[targetId];
        if (Number.isFinite(next[targetId].awayAt) && activity[targetId] === undefined) {
          activity[targetId] = next[targetId].awayAt;
          activityChanged = true;
        }
        if (targetId !== sourceId && protections[sourceId]) {
          const sourceProtection = protections[sourceId];
          const targetProtection = protections[targetId];
          const protectionExpiryRank = (record) => (
            record?.permanent === true || record?.duration === "always"
              ? Number.POSITIVE_INFINITY
              : Number(record?.expiresAt) || 0
          );
          const sourceRank = [
            protectionExpiryRank(sourceProtection),
            Number(sourceProtection.createdAt) || 0
          ];
          const targetRank = [
            protectionExpiryRank(targetProtection),
            Number(targetProtection?.createdAt) || 0
          ];
          const preserveTarget = targetProtection && (
            targetRank[0] > sourceRank[0] ||
            (targetRank[0] === sourceRank[0] && targetRank[1] >= sourceRank[1])
          );
          protections[targetId] = {
            ...(preserveTarget ? targetProtection : sourceProtection),
            tabId: Number(targetId)
          };
          delete protections[sourceId];
          protectionsChanged = true;
        }
      }
    }
    return {
      [SUSPEND_REGISTRY_KEY]: merged,
      ...(activityChanged ? { [ACTIVITY_KEY]: activity } : {}),
      ...(protectionsChanged ? { [TAB_PROTECTIONS_KEY]: protections } : {})
    };
  }));
  for (const tabId of staleCreatedIds) await discardStaleRecoveredTab(tabId);
  return recordRecoveredOccurrences(
    recoveryCycleId, [...new Set(recoveredOccurrenceBySource.values())]
  );
}

/** Record one complete pass in a single durable receipt. */
async function recordRecoveredOccurrences(cycleId, occurrenceIds) {
  if (occurrenceIds.length === 0) return 0;
  if (!cycleId) return occurrenceIds.length;
  let added = 0;
  await mutateStores([SUSPEND_RECOVERY_CYCLE_KEY], (maps) => {
    const cycle = maps[SUSPEND_RECOVERY_CYCLE_KEY];
    if (!cycle || cycle.id !== cycleId) return null;
    const recovered = new Set(cycle.recoveredOccurrenceIds ?? []);
    for (const occurrenceId of occurrenceIds) {
      if (recovered.has(occurrenceId)) continue;
      recovered.add(occurrenceId);
      added += 1;
    }
    if (added === 0) return null;
    return {
      [SUSPEND_RECOVERY_CYCLE_KEY]: {
        ...cycle,
        attemptedOccurrenceIds: [],
        recoveredOccurrenceIds: [...recovered],
        ...(cycle.initialOccurrenceIds ? {
          summaryTotal: new Set([...recovered, ...(cycle.alreadyReadyOccurrenceIds ?? [])]).size
        } : {}),
        ...(cycle.complete
          ? {
              total: recovered.size,
              notificationState: recoveryNotificationStateAfterRecovery(cycle)
            }
          : {})
      }
    };
  });
  return added;
}

/**
 * Adopt a live EveryTab suspend page into the recovery registry. This closes
 * the small restore/create-to-register gap: every suspend page reasserts its
 * own durable recovery entry when it mounts.
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<boolean>}
 */
export async function adoptSuspendedPage(tab) {
  if (!Number.isInteger(tab?.id) || tab.incognito) return false;
  const raw = tab.url || tab.pendingUrl || "";
  const base = chrome.runtime.getURL("suspend.html");
  if (!raw.startsWith(base)) return false;
  try {
    const params = new URL(raw).searchParams;
    const originalUrl = params.get("originalUrl") || "";
    if (!/^https?:/i.test(originalUrl)) return false;
    const occurrenceId = params.get("recoveryOccurrenceId") || "";
    if (occurrenceId && await inRecoveryGrace()) {
      const registry = await getSuspendRegistry();
      const representedElsewhere = Object.entries(registry).some(([id, entry]) =>
        Number(id) !== tab.id && entry?.recoveryOccurrenceId === occurrenceId);
      if (representedElsewhere) {
        let liveSibling = false;
        try {
          const liveTabs = await chrome.tabs.query({});
          liveSibling = liveTabs.some((candidate) =>
            candidate.id !== tab.id &&
            suspendedPageOccurrenceId(candidate) === occurrenceId);
        } catch { /* retain the page when sibling liveness cannot be proved */ }
        if (liveSibling) {
          let removed = false;
          try {
            await chrome.tabs.remove?.(tab.id);
            removed = true;
          } catch { /* a safety pass retries */ }
          readySuspendPageIds.delete(tab.id);
          if (removed && sameSuspendOccurrence(registry[tab.id], {
            recoveryOccurrenceId: occurrenceId
          })) {
            await unregisterSuspended(tab.id);
          }
          return false;
        }
      }
    }
    if (!occurrenceId && await inRecoveryGrace()) {
      const registry = await getSuspendRegistry();
      const exact = registry[tab.id];
      const representedElsewhere = Object.entries(registry).some(([id, entry]) =>
        Number(id) !== tab.id && entry?.originalUrl === originalUrl);
      if (!exact && representedElsewhere) {
        try { await chrome.tabs.remove?.(tab.id); } catch { /* a safety pass retries */ }
        readySuspendPageIds.delete(tab.id);
        return false;
      }
    }
    await registerSuspended(tab, originalUrl, occurrenceId);
    readySuspendPageIds.add(tab.id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this tab exempt from automatic suspension?
 * Active, pinned, audible, grouped, discarded, non-http (including our own
 * suspend page), or matching the never-suspend whitelist (F9).
 * @param {chrome.tabs.Tab} t
 * @param {string[]} [whitelist] settings.suspendWhitelist (F9); omitted = no list
 */
export function isSuspendExempt(
  t, whitelist, temporaryExemptions, now = Date.now(), tabProtections = {}
) {
  const url = canonicalUrlOf(t);
  return (
    t.active ||
    t.pinned ||
    t.audible ||
    t.incognito || // never suspend incognito (would write its URL to the registry)
    (t.groupId !== undefined && t.groupId !== -1) ||
    t.discarded ||
    !isHttpTab(t) || // also excludes chrome-extension://…/suspend.html tabs
    protectionStatus(t, {}, {}, tabProtections, now).protected ||
    matchesSuspendWhitelist(url, whitelist) ||
    isTemporarilyAutomationProtected(url, temporaryExemptions, now)
  );
}

/**
 * Tabs reserved by the time-based Suspension recent floor. The floor is taken
 * from awake web tabs before action-specific exemptions: an active or pinned
 * tab is still one of the user's recent tabs, while older protected tabs may
 * leave more than the requested minimum awake.
 * @param {chrome.tabs.Tab[]} tabs
 * @param {Record<string,number>} activityByTabId
 * @param {number} minimum
 * @returns {Set<number>}
 */
export function recentSuspendFloorIds(tabs, activityByTabId, minimum) {
  const count = Math.max(0, Math.floor(Number(minimum) || 0));
  if (count <= 0) return new Set();
  const lastUsed = (tab) => {
    const activity = Number(activityByTabId?.[tab.id]);
    if (Number.isFinite(activity)) return activity;
    const browserTime = Number(tab.lastAccessed);
    return Number.isFinite(browserTime) ? browserTime : 0;
  };
  return new Set((tabs ?? [])
    .filter((tab) => !tab.incognito && isHttpTab(tab) &&
      !isOwnSuspendPage(tab) && !tab.discarded && Number.isInteger(tab.id))
    .sort((a, b) => lastUsed(b) - lastUsed(a) || b.id - a.id)
    .slice(0, count)
    .map((tab) => tab.id));
}

/**
 * Existing settings entries keep their documented domain/substring semantics,
 * including entries that happen to be complete URLs. Popup-created exact-page
 * rules use an explicit prefix so an upgrade cannot narrow an older rule.
 */
export function matchesSuspendWhitelist(url, patterns) {
  return matchesAutomationExclusion(url, patterns);
}

/** @returns {string} portable representation of one exact-page exemption */
export function exactSuspendPageRule(url) {
  return exactAutomationPageRule(url);
}

/** Return the canonical page URL encoded by a popup-created exact rule. */
export function exactSuspendPageUrl(rule) {
  return exactAutomationPageUrl(rule);
}

/**
 * One shared view of a page's automatic-suspension protection. Exact popup
 * rules and device-local timers are removable page exceptions. A broad domain
 * or fragment rule is reported separately because removing it can affect many
 * pages and therefore belongs in Settings.
 */
export function autoSuspendPageStatus(url, patterns = [], temporaryExemptions = {}, now = Date.now()) {
  let pageUrl;
  try {
    const parsed = new URL(String(url || ""));
    if (!/^https?:$/.test(parsed.protocol)) return { kind: "none", url: null };
    pageUrl = parsed.href;
  } catch {
    return { kind: "none", url: null };
  }

  const rules = Array.isArray(patterns)
    ? patterns.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  if (rules.some((rule) => exactSuspendPageUrl(rule) === pageUrl)) {
    return { kind: "permanent", url: pageUrl };
  }
  const hostname = new URL(pageUrl).hostname.toLowerCase();
  const siteRule = rules.find((rule) => {
    const site = exactAutomationSiteHostname(rule);
    return site && (hostname === site || hostname.endsWith(`.${site}`));
  });
  if (siteRule) return {
    kind: "site", scope: "site", url: pageUrl,
    hostname: exactAutomationSiteHostname(siteRule), rule: siteRule, permanent: true
  };
  const broadRule = rules.find((rule) =>
    !exactSuspendPageUrl(rule) && !exactAutomationSiteHostname(rule) &&
    matchesWhitelist(pageUrl, [rule]));
  if (broadRule) return { kind: "rule", url: pageUrl, rule: broadRule };

  const expiresAt = Number(temporaryExemptions?.[pageUrl]);
  if (Number.isFinite(expiresAt) && expiresAt > now) {
    return { kind: "temporary", url: pageUrl, expiresAt };
  }
  const temporarySite = Object.entries(temporaryExemptions ?? {})
    .find(([rule, expiry]) => {
      const site = exactAutomationSiteHostname(rule);
      return Number.isFinite(Number(expiry)) && Number(expiry) > now && site &&
        (hostname === site || hostname.endsWith(`.${site}`));
    });
  if (temporarySite) return {
    kind: "temporary-site", scope: "site", url: pageUrl,
    hostname: exactAutomationSiteHostname(temporarySite[0]),
    rule: temporarySite[0], expiresAt: Number(temporarySite[1])
  };
  return { kind: "none", url: pageUrl };
}

/** Exact page exceptions shown in Settings, coalesced by URL. */
export function listAutoSuspendPageExceptions(patterns = [], temporaryExemptions = {}, now = Date.now()) {
  const byUrl = new Map();
  for (const rule of Array.isArray(patterns) ? patterns : []) {
    const url = exactSuspendPageUrl(rule);
    if (url) byUrl.set(url, { scope: "page", url, permanent: true, expiresAt: null });
    const hostname = exactAutomationSiteHostname(rule);
    if (hostname) byUrl.set(rule, {
      scope: "site", hostname, rule, url: rule, permanent: true, expiresAt: null
    });
  }
  for (const [rawUrl, rawExpiry] of Object.entries(temporaryExemptions ?? {})) {
    const expiresAt = Number(rawExpiry);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
    const hostname = exactAutomationSiteHostname(rawUrl);
    if (hostname) {
      const current = byUrl.get(rawUrl);
      if (!current?.permanent) byUrl.set(rawUrl, {
        scope: "site", hostname, rule: rawUrl, url: rawUrl,
        permanent: false, expiresAt
      });
      continue;
    }
    let url;
    try {
      const parsed = new URL(rawUrl);
      if (!/^https?:$/.test(parsed.protocol)) continue;
      url = parsed.href;
    } catch {
      continue;
    }
    const current = byUrl.get(url);
    if (current?.permanent) continue;
    byUrl.set(url, { scope: "page", url, permanent: false, expiresAt });
  }
  return [...byUrl.values()].sort((a, b) =>
    String(a.url ?? a.rule ?? "").localeCompare(String(b.url ?? b.rule ?? "")));
}

/** Remove one exact page or explicit site protection from Settings/local state. */
export async function removeAutoSuspendPageException(url) {
  const siteHostname = exactAutomationSiteHostname(url);
  let pageUrl = null;
  if (!siteHostname) {
    try { pageUrl = new URL(url).href; } catch { return false; }
  }
  const storageKey = siteHostname ? String(url).trim() : pageUrl;
  await withAutomationProtectionWrite(async () => {
    await patchSettings((current) => {
      const patterns = Array.isArray(current.suspendWhitelist) ? current.suspendWhitelist : [];
      const next = patterns.filter((rule) => siteHostname
        ? String(rule).trim() !== storageKey
        : exactSuspendPageUrl(rule) !== pageUrl);
      return next.length === patterns.length ? null : {
        archiveWhitelist: next,
        suspendWhitelist: next
      };
    });
    await mutateStores([TEMPORARY_SUSPEND_EXEMPTIONS_KEY], (maps) => {
      const current = maps[TEMPORARY_SUSPEND_EXEMPTIONS_KEY] ?? {};
      if (!(storageKey in current)) return null;
      const next = { ...current };
      delete next[storageKey];
      return { [TEMPORARY_SUSPEND_EXEMPTIONS_KEY]: next };
    });
  });
  return true;
}

/**
 * Protect one exact page from automatic suspension. A 24-hour exemption is
 * device-local operational state; an indefinite exemption joins the user's
 * portable Never suspend list. Manual Suspend remains available in both cases.
 * @param {number} tabId
 * @param {"day"|"always"} duration
 * @returns {Promise<{ok:boolean,duration?:"day"|"always",expiresAt?:number,already?:boolean}>}
 */
export async function exemptTabFromAutoSuspend(tabId, duration) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return { ok: false }; }
  const url = canonicalUrlOf(tab);
  if (tab.incognito || !/^https?:/.test(url) || !["day", "always"].includes(duration)) {
    return { ok: false };
  }
  const settings = await getSettings();
  if (matchesSuspendWhitelist(url, settings.suspendWhitelist)) {
    return { ok: true, duration: "always", already: true };
  }

  if (duration === "always") {
    return withAutomationProtectionWrite(async () => {
      let already = false;
      const exactRule = exactSuspendPageRule(url);
      await patchSettings((current) => {
        const patterns = Array.isArray(current.suspendWhitelist)
          ? current.suspendWhitelist.map((value) => String(value).trim()).filter(Boolean)
          : [];
        if (matchesSuspendWhitelist(url, patterns)) {
          already = true;
          return null;
        }
        const next = [...patterns, exactRule];
        return { archiveWhitelist: next, suspendWhitelist: next };
      });
      // A permanent rule supersedes a shorter device-only timer. Removing the
      // stale timer keeps Settings and popup status one-to-one.
      await mutateStores([TEMPORARY_SUSPEND_EXEMPTIONS_KEY], (maps) => {
        const current = maps[TEMPORARY_SUSPEND_EXEMPTIONS_KEY] ?? {};
        if (!(url in current)) return null;
        const next = { ...current };
        delete next[url];
        return { [TEMPORARY_SUSPEND_EXEMPTIONS_KEY]: next };
      });
      return { ok: true, duration, already };
    });
  }

  const now = Date.now();
  const expiresAt = now + SUSPEND_EXEMPTION_DAY_MS;
  await withAutomationProtectionWrite(() => (
    mutateStores([TEMPORARY_SUSPEND_EXEMPTIONS_KEY], (maps) => {
      const current = maps[TEMPORARY_SUSPEND_EXEMPTIONS_KEY] ?? {};
      const next = Object.fromEntries(Object.entries(current)
        .filter(([, expiry]) => Number(expiry) > now));
      next[url] = Math.max(Number(next[url]) || 0, expiresAt);
      return { [TEMPORARY_SUSPEND_EXEMPTIONS_KEY]: next };
    })
  ));
  return { ok: true, duration, expiresAt };
}

/** Read the active device-only exemptions and opportunistically prune expiry. */
async function activeTemporarySuspendExemptions(now = Date.now()) {
  let active = {};
  await mutateStores([TEMPORARY_SUSPEND_EXEMPTIONS_KEY], (maps) => {
    const current = maps[TEMPORARY_SUSPEND_EXEMPTIONS_KEY] ?? {};
    active = Object.fromEntries(Object.entries(current)
      .filter(([, expiry]) => Number(expiry) > now));
    return Object.keys(active).length === Object.keys(current).length
      ? null
      : { [TEMPORARY_SUSPEND_EXEMPTIONS_KEY]: active };
  });
  return active;
}

/** Recheck mutable tab and exemption state immediately before an automatic effect. */
async function currentAutomaticSuspendCandidate(tabId, {
  requireIdle = false,
  isWithinRecentFloor = async () => false
} = {}) {
  try {
    let [settings, temporaryExemptions, tabProtections] = await Promise.all([
      getFreshSettings(),
      readStoreValue(TEMPORARY_SUSPEND_EXEMPTIONS_KEY),
      readTabProtections()
    ]);
    let tab = await chrome.tabs.get(tabId);
    if (isSuspendExempt(
      tab, settings.suspendWhitelist, temporaryExemptions, Date.now(), tabProtections)) return null;
    if (requireIdle) {
      if (!settings.suspendEnabled) return null;
      const suspendAfterMinutes = Number(settings.suspendAfterMinutes) || 0;
      const cutoff = Date.now() - suspendAfterMinutes * 60_000;
      if (!await tabActivity.isOlderThan(tabId, cutoff)) return null;

      // The queued clock read may wait behind another storage transition. The
      // tab and its protection can change while it waits, so the effect must
      // use a new Chrome snapshot taken after the age decision.
      [settings, temporaryExemptions, tabProtections] = await Promise.all([
        getFreshSettings(),
        readStoreValue(TEMPORARY_SUSPEND_EXEMPTIONS_KEY),
        readTabProtections()
      ]);
      const freshMinTabs = Number(settings.suspendMinTabs) || 0;
      if (!settings.suspendEnabled ||
          (Number(settings.suspendAfterMinutes) || 0) !== suspendAfterMinutes ||
          (freshMinTabs > 0 && await isWithinRecentFloor(tabId, freshMinTabs))) return null;
      tab = await chrome.tabs.get(tabId);
      if (isSuspendExempt(
        tab, settings.suspendWhitelist, temporaryExemptions, Date.now(), tabProtections)) return null;
    }
    return { tab, settings };
  } catch {
    return null;
  }
}

/**
 * Internal: suspend one tab using the method set in settings.
 *   suspendLazyReload=true (default) → redirect to suspend.html; user clicks to reload.
 *   suspendLazyReload=false          → chrome.tabs.discard(); browser reloads on switch.
 * @param {chrome.tabs.Tab} t
 * @param {import("./types.js").Settings} settings
 * @param {()=>Promise<chrome.tabs.Tab|null>} [revalidate] final live eligibility check
 * @returns {Promise<boolean>} whether a browser suspension actually completed
 */
async function doSuspend(t, settings, revalidate = async () => {
  const current = await chrome.tabs.get(t.id);
  return current.pinned || current.incognito || !isHttpTab(current) ? null : current;
}) {
  // Keep registration, browser effects and refusal cleanup under one tab
  // owner. Otherwise one request can retire an occurrence while another
  // request's already-issued Chrome update is still parking that occurrence.
  return navigator.locks.request(`everytab-suspend-tab:${t.id}`, async () => {
    const current = await revalidate();
    if (!sameLiveTabCloseIdentity(t, current)) return false;
    return suspendCurrentTab(t, settings, revalidate);
  });
}

async function suspendCurrentTab(t, settings, revalidate) {
  // Capturing the committed page must not cancel a different destination that
  // was already loading when this request began.
  if (t.url && t.pendingUrl && t.pendingUrl !== t.url) return false;
  if (!settings.suspendLazyReload) {
    // Discarded tabs are ordinary tabs (they survive an extension reload), so
    // they need no recovery registry entry.
    const current = await revalidate();
    if (!sameLiveTabCloseIdentity(t, current)) return false;
    await chrome.tabs.discard(t.id);
    bump("tabsSuspended");
    return true;
  }
  const base = chrome.runtime.getURL("suspend.html");
  const original = urlOf(t);
  // Persist recovery before navigating, then revalidate after that write.
  // A rejected Chrome update retains recovery evidence because its browser
  // outcome can be ambiguous; a known identity refusal retires only our entry.
  const entry = await registerSuspended(t, original);
  let current = null;
  try { current = await revalidate(); } catch { /* gone or no longer verifiable */ }
  if (!sameLiveTabCloseIdentity(t, current)) {
    await retireUnappliedSuspension(t.id, entry);
    return false;
  }
  await chrome.tabs.update(t.id, { url: suspendPageUrl(base, entry) });
  bump("tabsSuspended");
  return true;
}

/** Retire only this unapplied occurrence, preserving a newer suspension. */
async function retireUnappliedSuspension(tabId, expected) {
  // Another request may already have parked this same logical occurrence.
  // It still needs its recovery record even though this request was refused.
  try {
    const current = await chrome.tabs.get(tabId);
    if (isOwnSuspendPage(current) &&
        new URL(current.url || current.pendingUrl).searchParams.get("recoveryOccurrenceId") ===
          expected?.recoveryOccurrenceId) return;
  } catch { /* a missing tab cannot own a live suspended page */ }
  await mutateStores([SUSPEND_REGISTRY_KEY], (maps) => {
    const registry = maps[SUSPEND_REGISTRY_KEY] ?? {};
    if (!sameSuspendOccurrence(registry[tabId], expected)) return null;
    delete registry[tabId];
    return { [SUSPEND_REGISTRY_KEY]: registry };
  });
}

/**
 * Manually suspend a specific tab. Unlike the auto-sweep, this ignores the
 * "active" exemption (the user asked for it) but still refuses pinned and
 * non-http tabs.
 * @param {number} tabId
 * @returns {Promise<boolean>} true if the tab was suspended
 */
export async function suspendTab(tabId) {
  let t;
  try { t = await chrome.tabs.get(tabId); } catch { return false; }
  if (t.pinned || t.incognito || !isHttpTab(t)) return false; // never suspend incognito
  const settings = await getSettings();
  try {
    return await doSuspend(t, settings);
  } catch { return false; }
}

/**
 * Wake a tab parked on OUR suspend page: navigate it back to its originalUrl.
 * No-op (returns false) for any tab not on our suspend page. Runs in the worker
 * (navigation is a tab mutation; the popup messages `wake-tab`).
 * @param {number} tabId
 * @returns {Promise<boolean>} true if the tab was woken
 */
export async function wakeTab(tabId) {
  let t;
  try { t = await chrome.tabs.get(tabId); } catch { return false; }
  const base = chrome.runtime.getURL("suspend.html");
  const raw = t.url || t.pendingUrl || "";
  if (!raw.startsWith(base)) return false;
  try {
    const original = new URL(raw).searchParams.get("originalUrl") || "";
    if (!/^https?:/.test(original)) return false;
    await chrome.tabs.update(tabId, { url: original });
    await unregisterSuspended(tabId); // N4: woken → no longer needs recovery
    return true;
  } catch {
    return false;
  }
}

/**
 * The periodic sweep. Two independent passes:
 *   1. time-based (the slider): suspend tabs idle past suspendAfterMinutes,
 *      while keeping suspendMinTabs recent tabs awake; only runs when enabled.
 *   2. hard cap (suspendMaxTabs): keep at most N tabs awake, suspending the
 *      longest-idled beyond the cap — regardless of the idle timer, so it works
 *      even with the slider Off.
 * @returns {Promise<number>} tabs suspended
 */
export async function suspendSweep() {
  const settings = await getSettings();
  const maxTabs = Number(settings.suspendMaxTabs) || 0;
  if (!settings.suspendEnabled && maxTabs <= 0) return 0;
  const [temporaryExemptions, tabProtections] = await Promise.all([
    activeTemporarySuspendExemptions(), readTabProtections()
  ]);
  let suspended = 0;
  if (settings.suspendEnabled) {
    suspended += await suspendIdleSweep(settings, temporaryExemptions, tabProtections);
  }
  if (maxTabs > 0) suspended += await capAwakeTabs(
    settings, maxTabs, temporaryExemptions, tabProtections);
  return suspended;
}

/**
 * Pass 1 — time-based suspension. Tabs never seen before are stamped now (full
 * grace period, no instant discard right after install/restart).
 * @param {import("./types.js").Settings} settings
 * @returns {Promise<number>}
 */
async function suspendIdleSweep(settings, temporaryExemptions, tabProtections) {
  await tabActivity.whenReady();
  const sweepNow = Date.now();
  const cutoff = sweepNow - settings.suspendAfterMinutes * 60_000;
  const map = await tabActivity.getMap();
  const tabs = await chrome.tabs.query({});
  // Keep the N most recently used awake web tabs out of the timer candidate
  // set. Older protected tabs can remain awake in addition to this floor.
  const minTabs = Number(settings.suspendMinTabs) || 0;
  const recentFloor = recentSuspendFloorIds(tabs, map, minTabs);
  let suspended = 0;
  const firstSeenIds = new Set();
  const liveIds = new Set(tabs.map((tab) => tab.id).filter(Number.isInteger));
  const isWithinRecentFloor = async (tabId, floorCount) => {
    const [currentTabs, currentActivity] = await Promise.all([
      chrome.tabs.query({}), tabActivity.getMap({ waitForContext: false })
    ]);
    return recentSuspendFloorIds(currentTabs, currentActivity, floorCount).has(tabId);
  };
  for (const t of tabs) {
    if (isSuspendExempt(
      t, settings.suspendWhitelist, temporaryExemptions, sweepNow, tabProtections)) continue;
    const last = map[t.id];
    if (last === undefined) {
      firstSeenIds.add(t.id);
      continue;
    }
    if (recentFloor.has(t.id)) continue;
    if (last < cutoff) {
      try {
        const committed = await withAutomationProtectionEffect(async () => {
          const current = await currentAutomaticSuspendCandidate(t.id, {
            requireIdle: true,
            isWithinRecentFloor
          });
          if (!current) return false;
          return doSuspend(current.tab, current.settings, async () => (
            (await currentAutomaticSuspendCandidate(t.id, {
              requireIdle: true, isWithinRecentFloor
            }))?.tab ?? null
          ));
        });
        if (committed) suspended++;
      } catch {
        /* tab may be gone or non-suspendable — skip */
      }
    }
  }
  await tabActivity.reconcileSweep({
    snapshot: map,
    liveIds,
    firstSeenIds,
    forgetIds: new Set(),
    at: sweepNow
  });
  return suspended;
}

/**
 * Pass 2 — the hard cap: keep at most `maxTabs` tabs awake, suspending the
 * longest-idled ones beyond the cap (by our activity map, falling back to
 * Chrome's `lastAccessed`). "Awake" = a live page still holding memory (not
 * already suspended/discarded). The active/pinned/audible/grouped/whitelisted
 * tabs are never touched (via `isSuspendExempt`), so a cap smaller than the
 * protected set is enforced as far as it can be. Independent of the idle timer.
 * @param {import("./types.js").Settings} settings @param {number} maxTabs
 * @returns {Promise<number>}
 */
async function capAwakeTabs(settings, maxTabs, temporaryExemptions, tabProtections) {
  const tabs = await chrome.tabs.query({});
  const awake = tabs.filter((t) => isHttpTab(t) && !isOwnSuspendPage(t) && !t.discarded);
  const over = awake.length - maxTabs;
  if (over <= 0) return 0;
  const map = await tabActivity.getMap({ waitForContext: false });
  const lastUsed = (t) => map[t.id] ?? t.lastAccessed ?? 0;
  const candidates = awake
    .filter((t) => !isSuspendExempt(
      t, settings.suspendWhitelist, temporaryExemptions, Date.now(), tabProtections))
    .sort((a, b) => lastUsed(a) - lastUsed(b)); // longest-idled first
  let suspended = 0;
  for (const t of candidates.slice(0, over)) {
    try {
      const committed = await withAutomationProtectionEffect(async () => {
        const current = await currentAutomaticSuspendCandidate(t.id);
        if (!current) return false;
        return doSuspend(current.tab, current.settings, async () => (
          (await currentAutomaticSuspendCandidate(t.id))?.tab ?? null
        ));
      });
      if (committed) suspended++;
    } catch {
      /* skip */
    }
  }
  return suspended;
}

/**
 * Manual: suspend all eligible tabs in a window except the active one.
 * @param {number} windowId
 * @returns {Promise<number>}
 */
export async function suspendOthers(windowId) {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({ windowId });
  let suspended = 0;
  for (const t of tabs) {
    if (isSuspendExempt(t)) continue;
    try {
      const committed = await doSuspend(t, settings, async () => {
        const current = await chrome.tabs.get(t.id);
        return isSuspendExempt(current) ? null : current;
      });
      if (committed) suspended++;
    } catch {
      /* skip */
    }
  }
  return suspended;
}
