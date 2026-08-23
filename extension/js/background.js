import {
  getDeviceId, getSettings, getFreshSettings, ensureSessionIdentityIndex
} from "./lib/store.js";
import { dumpWindow, dumpTab, dumpTabs, openDashboard } from "./lib/actions.js";
import { migrateCollectionsToLabels } from "./lib/labels.js";
import {
  takeSnapshot, saveWindowAsSession, saveTabsAsSession, unbindWindow, renameSession,
  restoreSessionById
} from "./lib/sessions.js";
import {
  recordAction, listActions, undoActionResult, recoverInterruptedUndos, clearJournalSafely
} from "./lib/journal.js";
import { closeLiveTabsById, recoverPendingLiveCloses } from "./lib/live-close.js";
import {
  SNOOZE_ALARM_PREFIX,
  createSnooze,
  fireSnooze,
  recoverInterruptedSnoozeDeliveries,
  sweepOverdueSnoozes,
  presetDue
} from "./lib/snooze.js";
import { updateDupBadge, closeDuplicates, findDuplicateGroups } from "./lib/dedup.js";
import { touchTab, forgetTab, suspendSweep, suspendOthers, suspendTab, wakeTab, queueRecovery, markRecoveryGrace, unregisterSuspendedOnClose } from "./lib/suspend.js";
import { archiveSweep, sweepInboxExpiry, setArchiveUndoRegistrar } from "./lib/archive.js";
import { urlOf, isHttpTab, canonicalRef, isSaveableTab, saveableTabRef } from "./lib/tabs.js";
import {
  handleFocusAlarm, isFocusAlarm, onFocusWindowRemoved,
  drainLegacyFocus, retireFocusFullStart, claimFullStart, scheduleRetirementDrain
} from "./lib/focus-retirement.js";
import {
  handleFocusGuardMessage, isGuardAlarm, handleGuardEndAlarm, handleAccessAlarm,
  onTabUpdated as focusGuardTabUpdated, onTabRemoved as focusGuardTabRemoved,
  onTabActivated as focusGuardTabActivated,
  onRulesChanged as focusRulesChanged, recoverGuard, recoverGuardTabs, markGuardGrace,
  claimGuardLifecycle, scheduleGuardWorkerRecovery, isAccessNotification,
  onAccessNotificationButton, onAccessNotificationClicked
} from "./lib/focus-guard.js";
import {
  SCHEME_ROTATION_ALARM, ensureSchemeRotationAlarm, maybeRotateSchemeOnOpen, rotateScheme
} from "./lib/scheme-rotation.js";
import { SCHEMES } from "./lib/schemes.js";
import { sortWindowById, gatherDomainToNewWindow } from "./lib/organize.js";
import { moveSelectedOpenTabs } from "./lib/open-tab-move.js";
import { createSearchSession, bindSearchSnapshotInvalidation } from "./lib/search.js";
import { hasHistoryAccess } from "./lib/history-access.js";
import { canonicalStarUrl } from "./lib/starred.js";
import {
  OMNIBOX_DEFAULT_SUGGESTION,
  createOmniboxQueryController,
  omniboxTargetForInput,
  omniboxNavigationPlan,
  executeOmniboxPlan
} from "./lib/omnibox.js";
import { armSearchPopupMode, clearSearchPopupMode } from "./lib/search-popup.js";
import { closeWindowSafely } from "./lib/close-window.js";
import {
  applyCloseDayCloses, captureCloseDayReview, checkCloseDayReview, closeDayStatus, commitCloseDay,
  discardCloseDayDraft, resumeCloseDayTransactions, undoCloseDayTransaction,
  updateCloseDayChoice, updateCloseDayChoices, updateCloseDayWindowMode
} from "./lib/close-day.js";
import {
  isEveryTabNewTabUrl, planNewTabRetirement, shouldReconcileNewTabUpdate
} from "./lib/newtab-singleton.js";
import { formatNumber, msg as localeMessage } from "./lib/i18n.js";
import { createMessageListener } from "./lib/message-handler-registry.js";

const SNAPSHOT_ALARM = "auto-snapshot";
const SUSPEND_ALARM = "suspend-sweep";
const ARCHIVE_ALARM = "archive-sweep";
const RECOVERY_ALARM = "suspend-recovery"; // N4b: final post-reload recovery pass
const DEDUP_GRACE_PREFIX = "dedup-grace:";
const DEDUP_GRACE_MS = 30_000;
const NEW_TAB_ROTATION_MESSAGE = "scheme-rotation-new-tab-ready";
const NEW_TAB_MOUNTED_MESSAGE = "everytab-new-tab-mounted";
const SCHEME_ROTATION_DIAGNOSTICS_ARM_MESSAGE = "scheme-rotation-diagnostics-arm";
const SCHEME_ROTATION_DIAGNOSTICS_MESSAGE = "scheme-rotation-diagnostics";
const SCHEME_ROTATION_DIAGNOSTICS_PAINT_MESSAGE = "scheme-rotation-diagnostics-page-paint";
const SCHEME_ROTATION_DIAGNOSTICS_PROTOCOL = 1;

// Browser tab creation has no idempotency key. If MV3 stopped after an Undo
// claimed browser effects, a later worker marks that receipt incomplete instead
// of repeating the effect and possibly reopening a page twice.
const actionRecoveryReady = Promise.all([
  recoverInterruptedUndos(), recoverPendingLiveCloses()
]).catch(() => {
  console.warn("EveryTab: interrupted action recovery could not be completed");
});
const snoozeRecoveryReady = recoverInterruptedSnoozeDeliveries().catch(() => {
  console.warn("EveryTab: interrupted Snooze delivery recovery could not be completed");
});

/* scheme-rotation-diagnostics:test-seam:start */
function createSchemeRotationDiagnostics({
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
      const hasVaultMeta = Object.hasOwn(changes, "vaultMeta");
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
          old: safeVaultMeta(changes.vaultMeta?.oldValue),
          new: safeVaultMeta(changes.vaultMeta?.newValue)
        };
      }
      record("storage-change", detail);
    },
    report: response
  };
}
/* scheme-rotation-diagnostics:test-seam:end */

let schemeRotationVersion = "unknown";
try {
  schemeRotationVersion = chrome.runtime.getManifest().version;
} catch { /* unavailable only in incomplete test doubles */ }
const schemeRotationDiagnostics = createSchemeRotationDiagnostics({
  version: schemeRotationVersion,
  builtInSchemes: SCHEMES,
  protocol: SCHEME_ROTATION_DIAGNOSTICS_PROTOCOL
});

// One Chrome tab owns exactly one On-open draw. The override document starts the
// worker task only after its synchronous boot script has consumed the prepared
// first-paint cache. Starting at tabs.onCreated is too early: another live
// EveryTab page can observe that commit and replace the origin-wide localStorage
// cache with the following reservation before the new document reads it.
const newTabRotationTasks = new Map();
const handledNewTabRotations = new Set();

function rotateNewTabOnce(tabId) {
  if (!Number.isInteger(tabId)) {
    schemeRotationDiagnostics.record("task-missing-tab", { tabId: null });
    const diagnosticsCapture = schemeRotationDiagnostics.capture();
    return Promise.resolve(diagnosticsCapture
      ? { ok: false, reason: "missing-tab", diagnosticsCapture }
      : { ok: false, reason: "missing-tab" });
  }
  const active = newTabRotationTasks.get(tabId);
  if (active) {
    schemeRotationDiagnostics.record("task-coalesced", { tabId });
    return active;
  }
  if (handledNewTabRotations.has(tabId)) {
    schemeRotationDiagnostics.record("task-already-handled", { tabId });
    const diagnosticsCapture = schemeRotationDiagnostics.capture();
    if (!diagnosticsCapture) {
      return Promise.resolve({ ok: true, alreadyHandled: true });
    }
    return Promise.resolve({ ok: true, alreadyHandled: true, diagnosticsCapture });
  }
  handledNewTabRotations.add(tabId);
  schemeRotationDiagnostics.record("task-start", { tabId });
  const task = maybeRotateSchemeOnOpen()
    .then((result) => {
      schemeRotationDiagnostics.record("task-complete", {
        tabId,
        changed: typeof result?.changed === "boolean" ? result.changed : null,
        scheme: schemeRotationDiagnostics.safeScheme(result?.scheme),
        nextScheme: schemeRotationDiagnostics.safeScheme(result?.nextScheme)
      });
      const diagnosticsCapture = schemeRotationDiagnostics.capture();
      if (!diagnosticsCapture) return { ok: true, result };
      return { ok: true, result, diagnosticsCapture };
    })
    .catch((error) => {
      handledNewTabRotations.delete(tabId);
      schemeRotationDiagnostics.record("task-failure", { tabId, reason: "rotation-failed" });
      console.warn("EveryTab: New Tab scheme rotation failed", error);
      const diagnosticsCapture = schemeRotationDiagnostics.capture();
      return diagnosticsCapture
        ? { ok: false, reason: "rotation-failed", diagnosticsCapture }
        : { ok: false, reason: "rotation-failed" };
    })
    .finally(() => newTabRotationTasks.delete(tabId));
  newTabRotationTasks.set(tabId, task);
  return task;
}

// Creation rank is session-memory only and orders rapid New Tabs. An active
// mounted override remains a safe keeper if Chrome startup or a cold MV3 wake
// missed its creation event; inactive restored pages cannot initiate cleanup.
const newTabCreationRanks = new Map();
let newTabCreationRank = 0;

function resetNewTabCreationRanks() {
  newTabCreationRanks.clear();
}

function recordNewTabCreation(tab) {
  if (!Number.isInteger(tab?.id)) return;
  newTabCreationRanks.set(tab.id, ++newTabCreationRank);
}

async function retireOlderEveryTabNewTabs(senderTab) {
  if (!Number.isInteger(senderTab?.id) || !Number.isInteger(senderTab?.windowId)) {
    return { ok: false, reason: "missing-tab" };
  }
  const settings = await getFreshSettings();
  if (settings.oneNewTabPerWindow !== true) return { ok: true, reason: "disabled" };

  let win;
  try {
    win = await chrome.windows.get(senderTab.windowId, { populate: true });
  } catch {
    return { ok: true, reason: "window-gone" };
  }
  const plan = planNewTabRetirement({
    enabled: true,
    readyTabId: senderTab.id,
    windowType: win.type,
    extensionBaseUrl: chrome.runtime.getURL(""),
    creationRanks: newTabCreationRanks,
    tabs: win.tabs ?? []
  });
  if (!plan) return { ok: true, reason: "no-change" };

  // Re-read every target immediately before removal. A pin, navigation, move,
  // or deliberate activation that happened during planning wins over cleanup.
  const retireTabIds = [];
  for (const tabId of plan.retireTabIds) {
    try {
      const live = await chrome.tabs.get(tabId);
      if (live.windowId === senderTab.windowId && !live.pinned && !live.incognito && !live.active &&
          isEveryTabNewTabUrl(live.pendingUrl || live.url, chrome.runtime.getURL(""))) {
        retireTabIds.push(tabId);
      }
    } catch { /* already closed */ }
  }
  const removals = await Promise.allSettled(
    retireTabIds.map((tabId) => chrome.tabs.remove(tabId))
  );
  const retired = removals.filter((result) => result.status === "fulfilled").length;
  return { ok: true, reason: retired ? "retired" : "no-change", retired };
}

// N46: old profiles may have years of automatic snapshots in the physical
// Session map. Give any just-opened surface its first useful paint before the
// one-time additive backfill reads that legacy map. Open treats a missing index
// as generic Window names, then its storage listener applies the names and
// restored-window drift membership when the index lands. Every later Session
// commit maintains it atomically.
setTimeout(() => {
  void ensureSessionIdentityIndex().catch((error) => {
    console.warn("EveryTab: Session identity index backfill failed", error);
  });
}, 1_000);

// F8-R1: Workspace Focus is retired. A pre-v0.2 install may still hold a legacy
// `focusState` whose recovery ledger records windows this device minimized. On
// worker spin-up, drain it safely (restore only) — DEFERRED so a real full browser
// start (runtime.onStartup) claims boot recovery first and no stale stored window
// ID is ever driven through windows.update.
scheduleRetirementDrain();

// F8-R2 / F8-R2r C5: on an ORDINARY worker spin-up, recover the site-guard run/alarms +
// prune stale records — but DEFERRED, so `onInstalled`/`onStartup` (reload / full browser
// start) can claim recovery first and open guard grace before any prune/recreate decision.
// If a lifecycle claim fires, this deferred pass yields entirely.
scheduleGuardWorkerRecovery();

async function ensureSnapshotAlarm() {
  const s = await getSettings();
  const period = Math.max(5, Number(s.snapshotEveryMinutes) || 15);
  await chrome.alarms.create(SNAPSHOT_ALARM, { periodInMinutes: period });
}

async function ensureSuspendAlarm() {
  await chrome.alarms.create(SUSPEND_ALARM, { periodInMinutes: 5 });
}

async function ensureArchiveAlarm() {
  // N3: the auto-dump threshold is now minute-granular (down to 1h), so sweep
  // every 15 min instead of hourly so sub-day values actually fire on time.
  await chrome.alarms.create(ARCHIVE_ALARM, { periodInMinutes: 15 });
}

// A tab-count cap must feel like a cap, not like a rule that may run fifteen
// minutes later. Rapid tab creation is consolidated into one sweep; the alarm
// remains the durable fallback if MV3 stops this worker before the timer fires.
let autoSaveCapTimer = 0;
function scheduleAutoSaveCapSweep() {
  clearTimeout(autoSaveCapTimer);
  autoSaveCapTimer = setTimeout(async () => {
    autoSaveCapTimer = 0;
    try {
      const settings = await getFreshSettings();
      if ((Number(settings.autoSaveMaxTabs) || 0) > 0) await archiveSweep();
    } catch (error) {
      console.warn("EveryTab: maximum-open-tabs Auto-save failed", error);
    }
  }, 900);
}

async function refreshBadge() {
  await updateDupBadge();
}

function startup() {
  getDeviceId();
  ensureSnapshotAlarm();
  ensureSuspendAlarm();
  ensureArchiveAlarm();
  ensureSchemeRotationAlarm();
  takeSnapshot();
  migrateCollectionsToLabels(); // M6: collections → labeled archive bundles (idempotent)
  snoozeRecoveryReady.then(() => sweepOverdueSnoozes()).catch((error) =>
    console.warn("EveryTab: overdue Snooze sweep failed", error));
  // archiveSweep at startup is safe: restart gives every tab a new id, so all
  // get stamped with a fresh grace period — it only prunes + stamps here.
  archiveSweep();
  sweepInboxExpiry();
  refreshBadge();
  // P11-15: a worker stop after the atomic keep commit can never strand a
  // half-finished end-of-day close. Receipts make this idempotent.
  resumeCloseDayTransactions().catch((error) =>
    console.warn("EveryTab: Close-the-day recovery failed", error));
  // N4/N4b: after an extension reload/update Chrome closes our suspend.html
  // tabs — but possibly AFTER this worker boots (the reload race). Run recovery
  // now and again once the dust settles; passes are serialized and idempotent
  // (live tabs are skipped), and onRemoved won't purge the registry during the
  // post-install grace window. The 30s alarm is the belt-and-braces final pass.
  scheduleRecoveryPasses();
}

/** N4b: recovery passes at boot, +2s, +8s (in-worker) and +30s (alarm). */
function scheduleRecoveryPasses() {
  const pass = () => queueRecovery().then((n) => { if (n > 0) notifyRecovered(n); });
  pass();
  setTimeout(pass, 2_000);
  setTimeout(pass, 8_000);
  chrome.alarms.create(RECOVERY_ALARM, { when: Date.now() + 31_000 });
}

/** N4: one always-visible toast after suspend-tab recovery. */
async function notifyRecovered(n) {
  try {
    await chrome.notifications.create(`suspend-recovered-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: localeMessage("notification_recovered_suspended_title"),
      message: n === 1
        ? localeMessage("notification_recovered_suspended_one")
        : localeMessage("notification_recovered_suspended_other", [formatNumber(n)])
    });
  } catch (e) {
    console.warn("EveryTab: recovery notification failed", e);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  // N4b FIRST: open the grace window before anything async — from this moment,
  // suspend-tab closures are treated as reload fallout, not user intent.
  markRecoveryGrace().then(startup);
  // F8-R1: extension reload/update — a reload keeps live window IDs, so drain any
  // legacy Focus run by restoring its recorded windows (never touches the suspend
  // registry, which markRecoveryGrace/startup handle separately).
  void drainLegacyFocus();
  // F8-R2 / F8-R2r C5: a reload can close our focus.html guard tabs. Claim recovery FIRST
  // (so the deferred worker-spin pass yields), open a SEPARATE guard-recovery grace (never
  // the suspend registry), recover the run/alarms, then recreate lost guard tabs in a few
  // serialized, idempotent passes once the dust settles.
  claimGuardLifecycle();
  markGuardGrace().then(() => {
    void recoverGuard();
    void recoverGuardTabs();
    setTimeout(() => void recoverGuardTabs(), 2_000);
    setTimeout(() => void recoverGuardTabs(), 8_000);
  });
  // First install: open the dashboard so the onboarding overlay greets the user.
  if (details?.reason === "install") openDashboard();
  // removeAll first: onInstalled also fires on reload, and duplicate ids throw.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "dump-tab", title: localeMessage("context_save_tab_inbox"), contexts: ["page"] });
    chrome.contextMenus.create({ id: "dump-window", title: localeMessage("context_save_window_inbox"), contexts: ["page"] });
    chrome.contextMenus.create({ id: "snooze-tomorrow", title: localeMessage("context_snooze_tomorrow"), contexts: ["page"] });
    chrome.contextMenus.create({ id: "snooze-next-week", title: localeMessage("context_snooze_monday"), contexts: ["page"] });
  });
});

chrome.runtime.onStartup.addListener(() => {
  resetNewTabCreationRanks();
  // F8-2r C4: claim boot recovery SYNCHRONOUSLY so the deferred generic worker
  // recovery yields and never restores a stale pre-restart window ID.
  claimFullStart();
  startup();
  // F8-R1: full browser startup — pre-restart window IDs are stale, so retirement
  // clears any legacy Focus run WITHOUT driving windows.update (focus-mode.md §9).
  void retireFocusFullStart();
  // F8-R2 / F8-R2r C5: a timed site-only run survives a browser restart only if its stored
  // end is still in the future; an overdue run ends. Claim recovery + open grace so restored
  // focus.html tabs (new tab ids) rebind by opaque id before any prune; recover alarms.
  claimGuardLifecycle();
  markGuardGrace().then(() => void recoverGuard());
});

/**
 * Snooze a live tab: store the URL (not the tab), then close it.
 * If it's the window's last tab, open the dashboard first (M0 lesson:
 * never let the window die mid-operation).
 * @param {chrome.tabs.Tab} tab @param {number} dueAt @param {string} [recurrence]
 */
async function snoozeTab(tab, dueAt, recurrence) {
  // Recheck provenance here, not only in popup presentation: context-menu and
  // keyboard callers reach this boundary directly. A suspended normal tab is
  // captured under its underlying page; an incognito tab is never persisted.
  const ref = saveableTabRef(tab);
  if (!ref) return null;
  const url = ref.url;
  const snooze = await createSnooze({
    url,
    title: ref.title || url,
    dueAt,
    ...(recurrence ? { recurrence } : {})
  });
  if (tab.id !== undefined) {
    const windowTabs = await chrome.tabs.query({ windowId: tab.windowId });
    if (windowTabs.length <= 1) await openDashboard();
    await chrome.tabs.remove(tab.id);
  }
  // await so callers (the popup's Undo) can read this entry as the journal head.
  await recordAction(`Snoozed “${snooze.title}”`, {
    dels: [{ store: "snoozes", id: snooze.id }],
    reopen: [[{ url: snooze.url, title: snooze.title }]]
  });
  return snooze;
}

/**
 * Snooze a whole window (P2b-1): capture its saveable tabs (canonicalRef — sees
 * through our suspend page), store ONE snooze carrying them, then close them.
 * Opens the dashboard first if this is the only window (M0: never let it die
 * mid-operation). Journal-backed so the popup's Undo reopens the whole window.
 * @param {number} [windowId] @param {number} dueAt @param {string} [recurrence]
 */
async function snoozeWindow(windowId, dueAt, recurrence) {
  const tabs = await chrome.tabs.query(
    windowId !== undefined ? { windowId } : { currentWindow: true }
  );
  const saveable = tabs.filter(isSaveableTab);
  const refs = saveable.map(canonicalRef);
  if (refs.length === 0) return null;
  const title = `Window (${refs.length} tab${refs.length === 1 ? "" : "s"})`;
  const snooze = await createSnooze({
    title,
    dueAt,
    tabs: refs,
    ...(recurrence ? { recurrence } : {})
  });
  const ids = saveable.map((t) => t.id).filter((id) => id !== undefined);
  const wins = await chrome.windows.getAll({});
  if (wins.length <= 1) await openDashboard();
  try {
    await chrome.tabs.remove(ids);
  } catch {
    /* some tabs may already be gone — the snooze still holds them */
  }
  await recordAction(`Snoozed a window (${refs.length} tab${refs.length === 1 ? "" : "s"})`, {
    dels: [{ store: "snoozes", id: snooze.id }],
    reopen: [refs]
  });
  return snooze;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === "dump-tab" && tab.id !== undefined) dumpTab(tab.id);
  if (info.menuItemId === "dump-window" && tab.windowId !== undefined) dumpWindow(tab.windowId);
  if (info.menuItemId === "snooze-tomorrow") snoozeTab(tab, presetDue("tomorrow"));
  if (info.menuItemId === "snooze-next-week") snoozeTab(tab, presetDue("next-week"));
});

/**
 * N18 — per-action keyboard commands. `dump-tab`, `snooze-tab`, `suspend-tab`
 * ship with NO suggested keys (manifest), so they stay inert until the user
 * binds them at chrome://extensions/shortcuts — opt-in for free. Each acts on
 * the active tab of the current window and reuses the same worker paths the
 * popup/context-menu use, so they're journaled and undoable like everything
 * else. Because a keyboard command gives no on-screen feedback (and dump/snooze
 * make the active tab vanish), the two vanishing actions confirm with a
 * notification carrying a one-tap Undo.
 */
const cmdUndo = new Map(); // notificationId -> journal entry id
// F46: the auto-save notification offers the same Undo as a manual command.
setArchiveUndoRegistrar((notificationId, entryId) => cmdUndo.set(notificationId, entryId));

async function notifyCommand(id, title, message, undoId) {
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title,
      message,
      ...(undoId ? { buttons: [{ title: localeMessage("action_undo") }] } : {})
    });
    if (undoId) cmdUndo.set(id, undoId);
  } catch (e) {
    console.warn("EveryTab: command notification failed", e);
  }
}

chrome.notifications.onButtonClicked.addListener((id, idx) => {
  if (isAccessNotification(id)) {
    void onAccessNotificationButton(id, idx).catch((e) => {
      console.warn("EveryTab: Focus access extension failed", e);
    });
    return;
  }
  const undoId = cmdUndo.get(id);
  if (undoId && idx === 0) {
    void actionRecoveryReady.then(() => undoActionResult(undoId)).catch(() => {});
    cmdUndo.delete(id);
    chrome.notifications.clear(id);
  }
});
chrome.notifications.onClicked.addListener((id) => {
  if (!isAccessNotification(id)) return;
  void onAccessNotificationClicked(id).catch((e) => {
    console.warn("EveryTab: Focus access notification click failed", e);
  });
});
chrome.notifications.onClosed.addListener((id) => cmdUndo.delete(id));

/**
 * P11-05: the named command is the only popup entry that requests Search mode.
 * `_execute_action` could open the popup but never reached onCommand, so it could
 * not distinguish a keyboard invocation from an ordinary toolbar click.
 */
async function openKeyboardSearchPopup() {
  if (!(await armSearchPopupMode())) {
    await openDashboard("search");
    return;
  }
  try {
    if (typeof chrome.action?.openPopup !== "function") throw new Error("openPopup unavailable");
    const win = await chrome.windows.getLastFocused();
    if (Number.isInteger(win?.id) && win.type === "normal" && !win.incognito) {
      await chrome.action.openPopup({ windowId: win.id });
    } else {
      await chrome.action.openPopup();
    }
  } catch {
    await clearSearchPopupMode();
    await openDashboard("search");
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "open-search-popup") {
    await openKeyboardSearchPopup();
    return;
  }
  if (command === "open-dashboard") return void openDashboard();
  if (command === "open-side-panel") {
    // F14: open the global side panel in the last-focused NORMAL (non-incognito)
    // window, from the command's user gesture. Never a toolbar takeover.
    try {
      let win = await chrome.windows.getLastFocused();
      if (!win || win.type !== "normal" || win.incognito) {
        const wins = await chrome.windows.getAll();
        win = wins.find((w) => w.type === "normal" && !w.incognito) || win;
      }
      if (win) await chrome.sidePanel.open({ windowId: win.id });
    } catch { /* sidePanel API / user gesture unavailable */ }
    return;
  }
  if (command === "dump-window") return void dumpWindow();
  // N18: the per-tab commands act on the active tab of the current window.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === "dump-tab") {
    const n = await dumpTab(tab.id);
    if (n > 0) {
      const undoId = (await listActions())[0]?.id ?? null;
      notifyCommand(`cmd-dump-${Date.now()}`, localeMessage("notification_saved_inbox_title"),
        localeMessage("notification_saved_inbox_body"), undoId);
    }
  } else if (command === "snooze-tab") {
    const s = await snoozeTab(tab, presetDue("tomorrow"));
    if (s) {
      const undoId = (await listActions())[0]?.id ?? null;
      notifyCommand(`cmd-snooze-${Date.now()}`, localeMessage("notification_snoozed_tomorrow_title"),
        localeMessage("notification_snoozed_tomorrow_body", [s.title]), undoId);
    }
  } else if (command === "suspend-tab") {
    // Visible result (the tab becomes the suspend page), so no notification.
    await suspendTab(tab.id);
  }
});

/* ---------- alarms ---------- */

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SNAPSHOT_ALARM) takeSnapshot();
  if (alarm.name === SUSPEND_ALARM) suspendSweep();
  // F8-R1: the legacy Focus alarm now only drives the restoration-only retirement
  // drain. AWAIT it so the MV3 worker stays alive until the restore/clear completes;
  // an unexpected rejection is logged, never left unhandled.
  if (isFocusAlarm(alarm.name)) {
    try {
      await handleFocusAlarm();
    } catch (e) {
      console.warn("EveryTab: Focus retirement drain failed", e);
    }
  }
  // F8-R2: the site-guard run-end and access-expiry alarms (distinct names).
  if (isGuardAlarm(alarm.name)) {
    try {
      await (alarm.name === "focus-guard-end" ? handleGuardEndAlarm() : handleAccessAlarm());
    } catch (e) {
      console.warn("EveryTab: Focus guard alarm failed", e);
    }
  }
  // N4b: final recovery pass — survives even if the worker died since install.
  if (alarm.name === RECOVERY_ALARM) {
    queueRecovery().then((n) => { if (n > 0) notifyRecovered(n); });
  }
  if (alarm.name === ARCHIVE_ALARM) {
    archiveSweep();
    sweepInboxExpiry();
  }
  if (alarm.name === SCHEME_ROTATION_ALARM) await rotateScheme();
  if (alarm.name.startsWith(SNOOZE_ALARM_PREFIX)) {
    await snoozeRecoveryReady;
    await fireSnooze(alarm.name.slice(SNOOZE_ALARM_PREFIX.length), { manual: false });
  }
  if (alarm.name.startsWith(DEDUP_GRACE_PREFIX)) {
    // auto-close after grace: tab must still exist and still be a duplicate
    const tabId = Number(alarm.name.slice(DEDUP_GRACE_PREFIX.length));
    const settings = await getSettings();
    if (!settings.dedupAutoClose) return;
    // Reuse the same stale-guarded close path as manual cleanup. It records the
    // closed page for Undo and marks the entry automatic, so Activity and Needs
    // you can truthfully say what EveryTab just did.
    await actionRecoveryReady;
    await closeDuplicates({ tabId, auto: true });
    refreshBadge();
  }
});

// Re-create alarms when settings change.
chrome.storage.onChanged.addListener((changes, area) => {
  schemeRotationDiagnostics.recordStorageChange(changes, area);
  if (area === "local" && changes.settings) {
    ensureSnapshotAlarm();
    ensureSchemeRotationAlarm();
    refreshBadge();
    const oldAutoSaveCap = Number(changes.settings.oldValue?.autoSaveMaxTabs) || 0;
    const newAutoSaveCap = Number(changes.settings.newValue?.autoSaveMaxTabs) || 0;
    if (oldAutoSaveCap !== newAutoSaveCap) scheduleAutoSaveCapSweep();
    // F8-R1: no Focus alarm repair here anymore — the retirement drain owns its own
    // one-shot retry alarm, and Focus settings no longer schedule a run.
    // F8-R2: a blocked-site rule/scope change sweeps newly-applicable open tabs (a
    // removed rule just stops future guarding). Idempotent + serialized in the guard.
    void focusRulesChanged();
  }
});

/* ---------- tab events: activity tracking + dedup badge ---------- */

let badgeTimer = 0;
function badgeSoon() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(refreshBadge, 500);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  touchTab(tabId);
  // P11-17: an expiry-deferred site is guarded only when the person deliberately
  // activates that tab again. Expiry itself never navigates over active typing.
  void focusGuardTabActivated(tabId);
  badgeSoon();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Browser-level invariant: enforce the opt-in even if the override page's
  // runtime message was lost during a cold worker/page transition. This event
  // wakes MV3 independently of Dashboard, Minimal, or Vault loading.
  if (shouldReconcileNewTabUpdate(changeInfo, tab, chrome.runtime.getURL(""))) {
    void retireOlderEveryTabNewTabs(tab);
  }
  if (changeInfo.url || changeInfo.status === "complete") {
    touchTab(tabId);
    badgeSoon();
  }
  // F8-R2: reactive site guarding — react to committed URL metadata only (no new
  // permission, no page content). The guard revalidates the live tab before redirect.
  if (changeInfo.url) void focusGuardTabUpdated(tabId, changeInfo, tab);
  // opt-in auto-close: a tab that just became a duplicate gets a grace period
  if (changeInfo.url && isHttpTab(tab)) {
    const settings = await getSettings();
    if (!settings.dedupAutoClose) return;
    const groups = await findDuplicateGroups();
    if (groups.some((g) => g.close.some((t) => t.id === tabId))) {
      chrome.alarms.create(DEDUP_GRACE_PREFIX + tabId, { when: Date.now() + DEDUP_GRACE_MS });
    }
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  recordNewTabCreation(tab);
  badgeSoon();
  scheduleAutoSaveCapSweep();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  newTabCreationRanks.delete(tabId);
  handledNewTabRotations.delete(tabId);
  newTabRotationTasks.delete(tabId);
  forgetTab(tabId);
  // N4/N4b: a user closing a suspended tab drops its registry entry — but NOT
  // during the post-reload grace window, when closures are Chrome tearing down
  // the old extension's pages and recovery still needs those entries.
  unregisterSuspendedOnClose(tabId);
  // F8-R2: drop this tab's guard attempt/return-url/registry (kept during the guard
  // grace so reload recovery can recreate it); its own grace is separate from suspend.
  void focusGuardTabRemoved(tabId);
  badgeSoon();
});

// M6 drift suggestions: window gone → binding gone.
// F8-R1: also let the Focus retirement drain prune a closed window from any legacy
// recovery ledger. The two run independently and compose — neither races the
// other's storage.
chrome.windows.onRemoved.addListener((windowId) => {
  // Retain BOTH composed transactions and surface (never silently drop) a rejection,
  // so binding cleanup or ledger pruning is not an unhandled promise.
  void Promise.allSettled([unbindWindow(windowId), onFocusWindowRemoved(windowId)])
    .then((results) => {
      for (const r of results) {
        if (r.status === "rejected") console.warn("EveryTab: window-removed handler failed", r.reason);
      }
    });
});

/**
 * Wake and focus one live search result. Dashboard search and the omnibox both use
 * this worker-owned path so suspended tabs and cross-window focus behave identically.
 * @param {{tabId:number, windowId?:number}} target
 */
async function focusSearchTarget(target) {
  await wakeTab(target.tabId).catch(() => {});
  await chrome.tabs.update(target.tabId, { active: true });
  if (target.windowId !== undefined) {
    await chrome.windows.update(target.windowId, { focused: true });
  }
}

async function activateStarredUrl(url) {
  const target = canonicalStarUrl(url);
  if (!target) return false;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => canonicalStarUrl(urlOf(tab)) === target);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: target });
  }
  return true;
}

/** P11-19: one stale-entity outcome shared by Search and the `et` omnibox. */
async function restoreSearchSession(sessionId) {
  const restored = await restoreSessionById(sessionId);
  if (restored) return true;
  const id = `session-missing-${Date.now()}`;
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: localeMessage("notification_session_missing_title"),
      message: localeMessage("notification_session_missing_body")
    });
    setTimeout(() => {
      try { Promise.resolve(chrome.notifications.clear(id)).catch(() => {}); }
      catch { /* notification already gone */ }
    }, 5_000);
  } catch (e) {
    console.warn("EveryTab: missing Session notification failed", e);
  }
  return false;
}

/** Open one organization lens without ever executing its members. */
async function openOrganizationGroup(organizationKind, groupId) {
  if (!["label", "session"].includes(organizationKind) ||
      typeof groupId !== "string" || !groupId.trim()) return false;
  await openDashboard(`${organizationKind}-group:${encodeURIComponent(groupId)}`);
  return true;
}

/* ---------- F20 omnibox ---------- */

const omniboxHasHistory = hasHistoryAccess;
const omniboxSearch = createSearchSession();
bindSearchSnapshotInvalidation(omniboxSearch);
const searchFromOmniboxSnapshot = (query, opts) => omniboxSearch.search(query, opts);
const omniboxQueries = createOmniboxQueryController({
  search: searchFromOmniboxSnapshot,
  hasHistory: omniboxHasHistory,
  scopeNames: (kind) => omniboxSearch.scopeNames(kind)
});

try {
  Promise.resolve(chrome.omnibox.setDefaultSuggestion({
    description: OMNIBOX_DEFAULT_SUGGESTION
  })).catch(() => {});
} catch { /* fail quiet if the omnibox surface is unavailable */ }

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  omniboxQueries.run(text).then(({ accepted, suggestions }) => {
    if (!accepted) return;
    try { suggest(suggestions); } catch { /* omnibox closed */ }
  });
});

chrome.omnibox.onInputCancelled.addListener(() => omniboxQueries.cancel());

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  (async () => {
    const target = await omniboxTargetForInput(text, {
      search: searchFromOmniboxSnapshot,
      hasHistory: omniboxHasHistory
    });
    const plan = omniboxNavigationPlan(target, disposition);
    await executeOmniboxPlan(plan, {
      focus: focusSearchTarget,
      restoreSession: restoreSearchSession,
      openOrganizationGroup,
      activateStarred: activateStarredUrl,
      searchWeb: (queryInfo) => chrome.search.query(queryInfo),
      getLastFocusedWindow: () => chrome.windows.getLastFocused({ populate: true }),
      updateTab: (tabId, properties) => chrome.tabs.update(tabId, properties),
      createTab: (properties) => chrome.tabs.create(properties),
      removeTab: (tabId) => chrome.tabs.remove(tabId)
    });
  })().catch(() => {});
});

/* ---------- end F20 omnibox ---------- */

/* ---------- messages ----------
 * RULE (M0 lesson): every tab-mutating operation runs HERE, not in the popup —
 * the popup's JS context is destroyed the moment another tab takes focus. */

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isId = (value) => Number.isInteger(value) && value >= 0;
const isIdList = (value) => Array.isArray(value) && value.every(isId);
const isText = (value) => typeof value === "string";
const isNonEmptyText = (value) => isText(value) && value.trim().length > 0;
const isOptionalText = (value) => value === undefined || isText(value);
const isOptionalId = (value) => value === undefined || isId(value);
const isOptionalIdList = (value) => value === undefined || isIdList(value);
const isWebUrl = (value) => {
  if (!isText(value)) return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
};
const isSenderTab = (_msg, sender) => isRecord(sender.tab) && isId(sender.tab.id);
const noPayload = () => true;
const handler = (type, mode, validate, handle, failure) => ({
  type, mode, validate, handle, failure
});

/**
 * The worker's complete public command surface. Each entry owns its validation,
 * effect, success response, and safe failure response; the registry owns Chrome's
 * synchronous/asynchronous response-channel mechanics.
 */
const workerMessageHandlers = [
  handler(SCHEME_ROTATION_DIAGNOSTICS_ARM_MESSAGE, "sync", noPayload, () =>
    schemeRotationDiagnostics.arm(newTabRotationTasks.size, handledNewTabRotations.size),
  { ok: false }),
  handler(SCHEME_ROTATION_DIAGNOSTICS_MESSAGE, "sync", noPayload, () =>
    schemeRotationDiagnostics.report(newTabRotationTasks.size, handledNewTabRotations.size),
  { ok: false }),
  handler(SCHEME_ROTATION_DIAGNOSTICS_PAINT_MESSAGE, "sync", noPayload, (msg, sender) => ({
    ok: true,
    recorded: schemeRotationDiagnostics.record("page-paint", {
      tabId: isId(sender.tab?.id) ? sender.tab.id : null,
      source: "page",
      before: schemeRotationDiagnostics.safeScheme(msg.bootSelection),
      after: schemeRotationDiagnostics.safeScheme(msg.finalSelection)
    })
  }), { ok: false, recorded: false }),
  handler(NEW_TAB_ROTATION_MESSAGE, "async", isSenderTab, (_msg, sender) => {
    schemeRotationDiagnostics.record("readiness-received", { tabId: sender.tab.id });
    return rotateNewTabOnce(sender.tab.id);
  }, { ok: false, reason: "rotation-failed" }),
  handler(NEW_TAB_MOUNTED_MESSAGE, "async", isSenderTab,
    (_msg, sender) => retireOlderEveryTabNewTabs(sender.tab),
    { ok: false, reason: "unavailable" }),

  handler("dump-window", "async", (msg) => isId(msg.windowId), async (msg) => {
    const n = await dumpWindow(msg.windowId);
    const undoId = n > 0 ? (await listActions())[0]?.id ?? null : null;
    return { n, undoId };
  }, { n: 0, undoId: null }),
  handler("dump-tab", "async", (msg) => isId(msg.tabId), async (msg) => {
    const n = await dumpTab(msg.tabId);
    const undoId = n > 0 ? (await listActions())[0]?.id ?? null : null;
    return { n, undoId };
  }, { n: 0, undoId: null }),
  handler("dump-tabs", "async", (msg) => isIdList(msg.tabIds) && isOptionalText(msg.label),
    async (msg) => ({ n: await dumpTabs(msg.tabIds, msg.label) }), { n: 0 }),
  handler("save-tabs-session", "async",
    (msg) => isIdList(msg.tabIds) && isOptionalText(msg.name),
    async (msg) => ({ name: (await saveTabsAsSession(msg.tabIds, msg.name))?.name ?? null }),
    { name: null }),
  // Compatibility for older live EveryTab documents; current drag and bulk move
  // use the set-based route below.
  handler("move-tab", "async",
    (msg) => isId(msg.tabId) && isId(msg.windowId) && Number.isInteger(msg.index),
    async (msg) => {
      await chrome.tabs.move(msg.tabId, { windowId: msg.windowId, index: msg.index });
      return { ok: true };
    }, { ok: false }),
  handler("move-tabs", "async", (msg) => isIdList(msg.tabIds) && isRecord(msg.destination),
    (msg) => moveSelectedOpenTabs(msg.tabIds, msg.destination),
    { ok: false, reason: "error", moved: 0 }),
  handler("sort-window", "async",
    (msg) => isId(msg.windowId) && ["domain", "title", "recent"].includes(msg.mode),
    (msg) => sortWindowById(msg.windowId, msg.mode),
    { ok: false, reason: "error", moved: 0 }),
  handler("gather-domain", "async", (msg) => isNonEmptyText(msg.domain),
    (msg) => gatherDomainToNewWindow(msg.domain),
    { ok: false, reason: "error", moved: 0 }),
  handler("new-window-with-tab", "async", (msg) => isId(msg.tabId),
    (msg) => moveSelectedOpenTabs([msg.tabId], { kind: "new-window" }),
    { ok: false, reason: "error", moved: 0 }),
  handler("close-tabs", "async", (msg) => isIdList(msg.tabIds),
    (msg) => actionRecoveryReady.then(() => closeLiveTabsById(msg.tabIds)),
    { ok: false, reason: "error", closed: 0 }),
  handler("close-window", "async", (msg) => isId(msg.windowId) &&
    Number.isInteger(msg.expectedTabCount) && isOptionalIdList(msg.expectedTabIds) &&
    isOptionalIdList(msg.expectedPinnedTabIds),
  (msg) => actionRecoveryReady.then(() => closeWindowSafely(msg.windowId, {
    tabCount: msg.expectedTabCount,
    tabIds: msg.expectedTabIds,
    pinnedTabIds: msg.expectedPinnedTabIds
  })), { ok: false, reason: "error" }),

  handler("close-day-capture", "async", (msg) =>
    msg.refresh === undefined || typeof msg.refresh === "boolean",
  (msg, sender) => captureCloseDayReview({
    protectedTabId: isId(sender.tab?.id) ? sender.tab.id : null,
    refresh: msg.refresh === true
  }), { ok: false, reason: "capture-failed" }),
  handler("close-day-choice", "async", (msg) =>
    isNonEmptyText(msg.draftId) && isNonEmptyText(msg.fingerprintKey) && isRecord(msg.patch),
  (msg) => updateCloseDayChoice(msg.draftId, msg.fingerprintKey, msg.patch),
  { ok: false, reason: "update-failed" }),
  handler("close-day-bulk-choice", "async", (msg) =>
    isNonEmptyText(msg.draftId) && Array.isArray(msg.fingerprintKeys) &&
    msg.fingerprintKeys.every(isNonEmptyText) && isRecord(msg.patch),
  (msg) => updateCloseDayChoices(msg.draftId, msg.fingerprintKeys, msg.patch),
  { ok: false, reason: "update-failed" }),
  handler("close-day-check", "async", (msg) => isNonEmptyText(msg.draftId),
    (msg) => checkCloseDayReview(msg.draftId), { ok: false, fresh: false }),
  handler("close-day-window-mode", "async", (msg) =>
    isNonEmptyText(msg.draftId) && isId(msg.windowId) && isNonEmptyText(msg.mode),
  (msg) => updateCloseDayWindowMode(msg.draftId, msg.windowId, msg.mode),
  { ok: false, reason: "update-failed" }),
  handler("close-day-discard", "async", (msg) => isOptionalText(msg.draftId),
    async (msg) => ({ ok: await discardCloseDayDraft(msg.draftId) }), { ok: false }),
  handler("close-day-commit", "async", (msg) => isNonEmptyText(msg.draftId),
    (msg) => commitCloseDay(msg.draftId), { ok: false, status: "failed" }),
  handler("close-day-resume", "async", (msg) => isNonEmptyText(msg.transactionId),
    async (msg) => {
      const receipt = await applyCloseDayCloses(msg.transactionId);
      return { ok: receipt.phase !== "missing", receipt };
    }, { ok: false }),
  handler("close-day-undo", "async", (msg) => isNonEmptyText(msg.transactionId),
    async (msg) => {
      const result = await undoCloseDayTransaction(msg.transactionId);
      return { ok: result.status === "undone", ...result };
    }, { ok: false, status: "failed" }),
  handler("close-day-status", "async", noPayload, () => closeDayStatus(),
    { draft: null, pending: null, latest: null }),

  handler("snooze-tab", "async", (msg) =>
    isId(msg.tabId) && Number.isFinite(msg.dueAt) && isOptionalText(msg.recurrence),
  async (msg) => {
    const tab = await chrome.tabs.get(msg.tabId);
    const snooze = await snoozeTab(tab, msg.dueAt, msg.recurrence);
    const undoId = snooze ? (await listActions())[0]?.id ?? null : null;
    return { ok: !!snooze, undoId };
  }, { ok: false, undoId: null }),
  handler("snooze-window", "async", (msg) =>
    isId(msg.windowId) && Number.isFinite(msg.dueAt) && isOptionalText(msg.recurrence),
  async (msg) => {
    const snooze = await snoozeWindow(msg.windowId, msg.dueAt, msg.recurrence);
    const undoId = snooze ? (await listActions())[0]?.id ?? null : null;
    return { ok: !!snooze, undoId, n: snooze?.tabs?.length ?? 0 };
  }, { ok: false, undoId: null, n: 0 }),
  handler("undo-last", "async", (msg) => isOptionalText(msg.id), async (msg) => {
    const result = await actionRecoveryReady.then(() => undoActionResult(msg.id));
    return { ok: result.status === "undone", status: result.status, entry: result.entry };
  }, { ok: false, status: "unavailable", entry: null }),
  handler("clear-journal", "async", noPayload,
    () => actionRecoveryReady.then(() => clearJournalSafely()), { ok: false }),
  handler("wake-tab", "async", (msg) => isId(msg.tabId),
    async (msg) => ({ ok: await wakeTab(msg.tabId) }), { ok: false }),
  handler("rename-session", "async", (msg) => isNonEmptyText(msg.id) && isText(msg.name),
    async (msg) => {
      const session = await renameSession(msg.id, msg.name);
      return { ok: !!session, name: session?.name ?? null };
    }, { ok: false, name: null }),
  handler("wake-snooze", "async", (msg) => isNonEmptyText(msg.id), async (msg) => {
    const result = await snoozeRecoveryReady.then(() => fireSnooze(msg.id, { manual: true }));
    return { ok: result.status === "delivered", status: result.status };
  }, { ok: false, status: "failed" }),
  handler("close-duplicates", "async", (msg) =>
    (msg.key === undefined || isText(msg.key)) && isOptionalId(msg.tabId),
  async (msg) => {
    const n = await actionRecoveryReady.then(() => closeDuplicates({ key: msg.key, tabId: msg.tabId }));
    await refreshBadge();
    return { n };
  }, { n: 0 }),
  handler("suspend-tab", "async", (msg) => isId(msg.tabId),
    async (msg) => ({ ok: await suspendTab(msg.tabId) }), { ok: false }),
  handler("suspend-others", "async", (msg) => isId(msg.windowId),
    async (msg) => ({ n: await suspendOthers(msg.windowId) }), { n: 0 }),
  handler("focus-tab", "async", (msg) => isId(msg.tabId) && isId(msg.windowId),
    async (msg) => { await focusSearchTarget(msg); return { ok: true }; }, { ok: false }),
  handler("restore-session", "async", (msg) => isNonEmptyText(msg.sessionId),
    async (msg) => ({ ok: await restoreSearchSession(msg.sessionId) }), { ok: false }),
  handler("open-organization-group", "async", (msg) =>
    ["label", "session"].includes(msg.organizationKind) && isNonEmptyText(msg.groupId),
  async (msg) => ({ ok: await openOrganizationGroup(msg.organizationKind, msg.groupId) }),
  { ok: false }),
  handler("open-url", "async", (msg) => isWebUrl(msg.url),
    async (msg) => { await chrome.tabs.create({ url: msg.url }); return { ok: true }; }, { ok: false }),
  handler("search-web", "async", (msg) => isNonEmptyText(msg.text), async (msg, sender) => {
    const text = msg.text.trim();
    const queryInfo = msg.disposition === "CURRENT_TAB" && isId(sender.tab?.id)
      ? { text, tabId: sender.tab.id }
      : { text, disposition: "NEW_TAB" };
    await chrome.search.query(queryInfo);
    return { ok: true };
  }, { ok: false }),
  handler("activate-starred", "async", (msg) => isWebUrl(msg.url),
    async (msg) => ({ ok: await activateStarredUrl(msg.url) }), { ok: false }),
  handler("switch-to-existing", "async", (msg) =>
    isId(msg.tabId) && isOptionalId(msg.windowId) && isOptionalId(msg.closeTabId),
  async (msg) => {
    await wakeTab(msg.tabId).catch(() => {});
    await chrome.tabs.update(msg.tabId, { active: true });
    if (msg.windowId !== undefined) await chrome.windows.update(msg.windowId, { focused: true });
    if (msg.closeTabId !== undefined) {
      try { await chrome.tabs.remove(msg.closeTabId); } catch { /* already gone */ }
    }
    await refreshBadge();
    return { ok: true };
  }, { ok: false }),
  handler("save-window-session", "async",
    (msg) => isId(msg.windowId) && isOptionalText(msg.name),
  async (msg) => {
    const session = await saveWindowAsSession(msg.windowId, msg.name);
    return { id: session?.id ?? null, name: session?.name ?? null };
  }, { id: null, name: null })
];

// F8-R1: retired Workspace Focus messages are deliberately absent. The only
// fallback is the site guard, which validates sender.tab.id inside its own
// coordinator and returns true exactly when it owns the response channel.
chrome.runtime.onMessage.addListener(createMessageListener(workerMessageHandlers, {
  fallback: (msg, sender, sendResponse) =>
    handleFocusGuardMessage(msg, sender, sendResponse),
  onError: (_error, type) => console.warn(`EveryTab: ${type} message failed`)
}));
