// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import {
  getDeviceId, getSettings, getFreshSettings, ensureSessionIdentityIndex,
  mutateStores, readStoreValue
} from "./lib/store.js";
import { dumpWindow, dumpTab, dumpTabs, openDashboard } from "./lib/actions.js";
import {
  takeSnapshot, saveWindowAsSession, saveTabsAsSession, addWindowToSession, addTabsToSession,
  unbindWindow, renameSession, restoreSessionById
} from "./lib/sessions.js";
import {
  undoActionResult, recoverInterruptedUndos, clearJournalSafely
} from "./lib/journal.js";
import {
  closeLiveTabsById, closeUnsaveableTabsById, finishPendingLiveClose,
  recoverPendingLiveCloses
} from "./lib/live-close.js";
import {
  createLiveSnoozeWithReceipt,
  fireSnooze,
  recoverInterruptedSnoozeDeliveries,
  sweepOverdueSnoozes
} from "./lib/snooze.js";
import { wakeSnoozeSelections } from "./lib/snooze-delivery.js";
import { updateDupBadge, closeDuplicates, findDuplicateGroups } from "./lib/dedup.js";
import { setDuplicateDomainRule } from "./lib/duplicate-domain-rules.js";
import {
  adoptSuspendedPage, suspendSweep, suspendOthers, suspendTab,
  wakeTab, exemptTabFromAutoSuspend, queueRecovery, queueSuspendMetadataRepair, markRecoveryGrace,
  queueSuspendedCloseCleanup, retrySuspendedCloseCleanups,
  unregisterSuspended
} from "./lib/suspend.js";
import { tabActivity } from "./lib/tab-activity.js";
import {
  beginTabProtectionBrowserSession, removeTemporaryTabProtectionOnClose
} from "./lib/automation-protection.js";
import {
  inspectRecentlyClosedSuspendedTabs, recoverRecentlyClosedSuspendedTabs
} from "./lib/suspend-recent-recovery.js";
import {
  inspectSnapshotRecovery, recoverMissingSnapshotTabs, reviewSnapshotRecovery
} from "./lib/snapshot-recovery.js";
import { archiveSweep, sweepInboxExpiry, setArchiveUndoRegistrar } from "./lib/archive.js";
import {
  handleFocusGuardMessage, handleGuardEndAlarm, handleAccessAlarm,
  onTabUpdated as focusGuardTabUpdated, onTabRemoved as focusGuardTabRemoved,
  onTabActivated as focusGuardTabActivated,
  onRulesChanged as focusRulesChanged, recoverGuard, recoverGuardTabs, markGuardGrace,
  claimGuardLifecycle, scheduleGuardWorkerRecovery, isAccessNotification,
  onAccessNotificationButton, onAccessNotificationClicked
} from "./lib/focus-guard.js";
import {
  ensureSchemeRotationAlarm, maybeRotateSchemeOnOpen, rotateScheme
} from "./lib/scheme-rotation.js";
import { SCHEMES } from "./lib/schemes.js";
import { sortWindowById, gatherDomainToNewWindow } from "./lib/organize.js";
import { moveSelectedOpenTabs } from "./lib/open-tab-move.js";
import { createSearchSession, bindSearchSnapshotInvalidation } from "./lib/search.js";
import { hasHistoryAccess } from "./lib/history-access.js";
import { closeWindowSafely } from "./lib/close-window.js";
import {
  applyCloseDayCloses, captureCloseDayReview, checkCloseDayReview, closeDayStatus, commitCloseDay,
  discardCloseDayDraft, resumeCloseDayTransactions, recoverInterruptedCloseDayUndos, undoCloseDayTransaction,
  updateCloseDayChoice, updateCloseDayChoices, updateCloseDayWindowMode
} from "./lib/close-day.js";
import { applyUiLanguage, msg as localeMessage } from "./lib/i18n.js";
import { createMessageListener } from "./lib/message-handler-registry.js";
import { captureSnoozePlacement } from "./lib/snooze-placement.js";
import { initializeStorageAuthority } from "./lib/storage/authority-runtime.js";
import { createNotificationOwner } from "./background/notification-owner.js";
import { createContextMenuOwner } from "./background/context-menu-owner.js";
import { installKeyboardCommandOwner } from "./background/keyboard-command-owner.js";
import { installSettingsChangeOwner } from "./background/settings-change-owner.js";
import {
  DEDUP_GRACE_PREFIX,
  installAlarmOwner
} from "./background/alarm-owner.js";
import { installTabLifecycleOwner } from "./background/tab-lifecycle-owner.js";
import { installWindowLifecycleOwner } from "./background/window-lifecycle-owner.js";
import { installOmniboxOwner } from "./background/omnibox-owner.js";
import { installRuntimeLifecycleOwner } from "./background/runtime-lifecycle-owner.js";
import { createSchemeRotationDiagnostics } from "./background/scheme-rotation-trace.js";
import { createNewTabMessageHandlers } from "./background/new-tab-message-handlers.js";
import { createNewTabRotationOwner } from "./background/new-tab-rotation-owner.js";
import { createNewTabSingletonOwner } from "./background/new-tab-singleton-owner.js";
import { createSuspendRecoveryOwner } from "./background/suspend-recovery-owner.js";
import { createRecoveryMessageHandlers } from "./background/recovery-message-handlers.js";
import { createSuspensionMessageHandlers } from "./background/suspension-message-handlers.js";
import { createSessionMessageHandlers } from "./background/session-message-handlers.js";
import { createInboxCaptureMessageHandlers } from "./background/inbox-capture-message-handlers.js";
import { createLiveCloseMessageHandlers } from "./background/live-close-message-handlers.js";
import { createOpenTabMessageHandlers } from "./background/open-tab-message-handlers.js";
import { createCloseDayMessageHandlers } from "./background/close-day-message-handlers.js";
import { createSnoozeMessageHandlers } from "./background/snooze-message-handlers.js";
import { createJournalMessageHandlers } from "./background/journal-message-handlers.js";
import { createDuplicateMessageHandlers } from "./background/duplicate-message-handlers.js";
import { createNavigationMessageHandlers } from "./background/navigation-message-handlers.js";
import { createSnoozeActions } from "./background/snooze-actions.js";
import { createNavigationActions } from "./background/navigation-actions.js";
import { createMaintenanceSchedule } from "./background/maintenance-schedule.js";
import { createWorkerStartupOwner } from "./background/worker-startup-owner.js";
import { reportFailure } from "./lib/failure-diagnostic.js";
import { collectUnusedLibraryAssets } from "./lib/storage/authority-runtime.js";


const DEDUP_GRACE_MS = 30_000;
const SCHEME_ROTATION_DIAGNOSTICS_PROTOCOL = 1;

// Seed or reconcile the device-local foreground identity before a timer sweep
// can interpret any retained tab id. Recovery and other independent startup
// work do not wait for this clock-only boundary.
void tabActivity.initialize().catch((error) => {
  reportFailure("tab activity initialization", error);
});

// Browser tab creation has no idempotency key. If MV3 stopped after an Undo
// claimed browser effects, a later worker marks that receipt incomplete instead
// of repeating the effect and possibly reopening a page twice.
// On first install this module runs before onInstalled creates the authority.
// There is no action history to repair yet; all other read failures stay fatal
// to the command gate. Actual commands still require the installed authority.
const actionRecoveryReady = Promise.allSettled([
  recoverInterruptedCloseDayUndos().catch((error) => {
    if (error?.code === "storage-authority-not-initialized") return;
    reportFailure("interrupted Undo recovery", error);
    throw error;
  }),
  recoverInterruptedUndos().catch((error) => {
    if (error?.code === "storage-authority-not-initialized") return;
    reportFailure("interrupted Undo recovery", error);
    throw error;
  }),
  recoverPendingLiveCloses().catch((error) => {
    if (error?.code === "storage-authority-not-initialized") return;
    reportFailure("pending live-close recovery", error);
    throw error;
  })
]).then((outcomes) => {
  // An early failure must not release commands while another recovery is
  // still classifying old claims. Failed recovery keeps commands unavailable.
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;
});
// Each owner reported its failure above. Observe startup rejection even when
// no command arrives; callers still receive the original rejected gate.
void actionRecoveryReady.catch(() => {});
const snoozeRecoveryReady = recoverInterruptedSnoozeDeliveries().catch((error) => {
  reportFailure("interrupted Snooze delivery recovery", error);
});
const snoozeActions = createSnoozeActions({
  createWithCloseReceipt: createLiveSnoozeWithReceipt,
  finishCloseReceipt: finishPendingLiveClose,
  capturePlacement: captureSnoozePlacement,
  openDashboard,
  tabs: {
    get: (tabId) => chrome.tabs.get(tabId),
    query: (query) => chrome.tabs.query(query),
    remove: (ids) => chrome.tabs.remove(ids)
  },
  windows: { getAll: (query) => chrome.windows.getAll(query) }
});
const navigationActions = createNavigationActions({
  wakeTab,
  restoreSessionById,
  openDashboard,
  message: localeMessage,
  runtime: { getURL: (path) => chrome.runtime.getURL(path) },
  tabs: {
    query: (query) => chrome.tabs.query(query),
    update: (tabId, properties) => chrome.tabs.update(tabId, properties),
    create: (properties) => chrome.tabs.create(properties)
  },
  windows: {
    update: (windowId, properties) => chrome.windows.update(windowId, properties)
  },
  notifications: {
    create: (id, options) => chrome.notifications.create(id, options),
    clear: (id) => chrome.notifications.clear(id)
  }
});
const maintenance = createMaintenanceSchedule({
  alarms: chrome.alarms,
  readSettings: getFreshSettings,
  archiveSweep
});
const contextMenus = createContextMenuOwner({
  saveTab: dumpTab,
  saveWindow: dumpWindow,
  snoozeTab: snoozeActions.tab
});
const suspendRecovery = createSuspendRecoveryOwner({
  mutateStore: mutateStores,
  readStore: readStoreValue,
  recover: queueRecovery,
  repairMetadata: queueSuspendMetadataRepair
});

let schemeRotationVersion = "unknown";
try {
  schemeRotationVersion = chrome.runtime.getManifest().version;
} catch { /* unavailable only in incomplete test doubles */ }
const schemeRotationDiagnostics = createSchemeRotationDiagnostics({
  version: schemeRotationVersion,
  builtInSchemes: SCHEMES,
  protocol: SCHEME_ROTATION_DIAGNOSTICS_PROTOCOL
});

// The override document starts its draw only after the synchronous boot script
// consumes the prepared first-paint cache. Starting at tabs.onCreated is too
// early because another EveryTab page could replace that shared reservation.
const newTabRotation = createNewTabRotationOwner({
  rotate: maybeRotateSchemeOnOpen,
  diagnostics: schemeRotationDiagnostics
});

const newTabSingleton = createNewTabSingletonOwner({ readSettings: getFreshSettings });

function forgetNewTabLifecycle(tabId) {
  newTabSingleton.forget(tabId);
  newTabRotation.forget(tabId);
}

const workerStartup = createWorkerStartupOwner({
  assets: { collect: collectUnusedLibraryAssets },
  identity: { ensure: getDeviceId },
  schedules: {
    snapshot: maintenance.ensureSnapshotAlarm,
    suspension: maintenance.ensureSuspendAlarm,
    inbox: maintenance.ensureArchiveAlarm,
    rotation: ensureSchemeRotationAlarm
  },
  snapshots: { take: takeSnapshot },
  snooze: { ready: snoozeRecoveryReady, sweep: sweepOverdueSnoozes },
  inbox: { sweep: archiveSweep, expire: sweepInboxExpiry },
  badge: { refresh: updateDupBadge },
  closeDay: { resume: resumeCloseDayTransactions },
  suspension: {
    retryCloseCleanups: retrySuspendedCloseCleanups,
    startRecovery: suspendRecovery.start
  },
  deferred: {
    ensureSessionIdentities: ensureSessionIdentityIndex,
    scheduleGuardRecovery: scheduleGuardWorkerRecovery
  }
});
workerStartup.installDeferredWork();

installRuntimeLifecycleOwner({
  storage: { initialize: initializeStorageAuthority },
  menus: contextMenus,
  worker: { prepareReload: workerStartup.prepareReload, start: workerStartup.start },
  newTabs: { resetCreationOrder: newTabSingleton.resetCreationOrder },
  activity: { beginBrowserSession: tabActivity.beginBrowserSession },
  protection: { beginBrowserSession: beginTabProtectionBrowserSession },
  suspension: {
    prepareReload: suspendRecovery.prepareReload,
    cancelPreparedReload: suspendRecovery.cancelPreparedReload,
    markReloadGrace: markRecoveryGrace,
    repairRecoveryMetadata: suspendRecovery.repairLateMetadata
  },
  focus: {
    claimGuardLifecycle,
    markGuardGrace,
    recoverGuard,
    recoverGuardTabs
  },
  openDashboard
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
const notifications = createNotificationOwner({
  actionRecoveryReady,
  undoAction: undoActionResult,
  access: {
    owns: isAccessNotification,
    handleButton: onAccessNotificationButton,
    handleClick: onAccessNotificationClicked
  }
});
setArchiveUndoRegistrar(notifications.registerUndo);

installKeyboardCommandOwner({
  openDashboard,
  saveWindow: dumpWindow,
  saveTab: dumpTab,
  snoozeTab: snoozeActions.tab,
  suspendTab,
  notify: notifications.notify
});

/* ---------- alarms ---------- */

installAlarmOwner({
  assets: { collect: workerStartup.collectAssetsWhenReady },
  snapshots: { take: takeSnapshot },
  suspension: {
    sweep: suspendSweep,
    finishRecovery: suspendRecovery.finishInterrupted,
    repairRecoveryMetadata: suspendRecovery.repairLateMetadata,
    retryCloseCleanups: retrySuspendedCloseCleanups
  },
  focus: {
    endGuard: handleGuardEndAlarm,
    expireAccess: handleAccessAlarm
  },
  archive: { sweep: archiveSweep, expireInbox: sweepInboxExpiry },
  rotation: { rotate: rotateScheme },
  snooze: { ready: snoozeRecoveryReady, fire: fireSnooze },
  duplicates: {
    ready: actionRecoveryReady,
    readSettings: getSettings,
    close: closeDuplicates,
    refreshBadge: updateDupBadge
  }
});

/**
 * Notification copy resolves through the worker's own message lookup, so the
 * worker installs the chosen interface language from Settings at each start
 * and again when the setting changes. This does not block startup recovery;
 * a notification raised before the catalogue arrives follows the browser.
 */
const installUiLanguage = () => getFreshSettings()
  .then((settings) => applyUiLanguage(settings.uiLanguage))
  .catch((error) => reportFailure("interface language install", error));
void installUiLanguage();

installSettingsChangeOwner({
  recordStorageChange: schemeRotationDiagnostics.recordStorageChange,
  ensureSnapshotAlarm: maintenance.ensureSnapshotAlarm,
  ensureArchiveAlarm: maintenance.ensureArchiveAlarm,
  ensureSchemeRotationAlarm,
  refreshBadge: updateDupBadge,
  scheduleAutoSaveCapSweep: maintenance.scheduleAutoSaveCapSweep,
  sweepInboxExpiry,
  focusRulesChanged,
  uiLanguageChanged: installUiLanguage
});

/* ---------- tab events ---------- */

installTabLifecycleOwner({
  activity: {
    recordActivation: tabActivity.recordActivation,
    forgetTab: tabActivity.forgetTab
  },
  newTabs: {
    recordCreation: newTabSingleton.recordCreation,
    forget: forgetNewTabLifecycle,
    retireOlder: newTabSingleton.retireOlder
  },
  suspension: {
    unregister: unregisterSuspended,
    queueCloseCleanup: queueSuspendedCloseCleanup
  },
  focus: {
    activate: focusGuardTabActivated,
    update: focusGuardTabUpdated,
    remove: focusGuardTabRemoved
  },
  duplicates: {
    alarmPrefix: DEDUP_GRACE_PREFIX,
    graceMs: DEDUP_GRACE_MS,
    readSettings: getSettings,
    findGroups: findDuplicateGroups
  },
  badge: { refresh: updateDupBadge },
  protection: { removeTemporary: removeTemporaryTabProtectionOnClose },
  scheduleAutoSaveCapSweep: maintenance.scheduleAutoSaveCapSweep
});

installWindowLifecycleOwner({
  activity: {
    recordWindowFocus: tabActivity.recordWindowFocus,
    forgetWindow: tabActivity.forgetWindow
  },
  sessions: { unbind: unbindWindow }
});

/* ---------- F20 omnibox ---------- */

const omniboxHasHistory = hasHistoryAccess;
const omniboxSearch = createSearchSession();
bindSearchSnapshotInvalidation(omniboxSearch);
installOmniboxOwner({
  searchSession: omniboxSearch,
  hasHistory: omniboxHasHistory,
  actions: {
    focus: navigationActions.focus,
    restoreSession: navigationActions.restoreSession,
    openOrganizationGroup: navigationActions.openGroup,
    activateStarred: navigationActions.activateStarred
  }
});

/* ---------- end F20 omnibox ---------- */

/* ---------- messages ----------
 * RULE (M0 lesson): every tab-mutating operation runs HERE, not in the popup —
 * the popup's JS context is destroyed the moment another tab takes focus. */

/**
 * The worker's complete public command surface. Each entry owns its validation,
 * effect, success response, and safe failure response; the registry owns Chrome's
 * synchronous/asynchronous response-channel mechanics.
 */
const workerMessageHandlers = [
  ...createNewTabMessageHandlers({
    diagnostics: schemeRotationDiagnostics,
    rotation: newTabRotation,
    retireMounted: newTabSingleton.retireOlder
  }),
  ...createRecoveryMessageHandlers({
    recentlyClosed: {
      inspect: inspectRecentlyClosedSuspendedTabs,
      recover: recoverRecentlyClosedSuspendedTabs
    },
    snapshots: {
      inspect: inspectSnapshotRecovery,
      review: reviewSnapshotRecovery,
      recover: recoverMissingSnapshotTabs
    }
  }),
  ...createSuspensionMessageHandlers({
    wake: wakeTab,
    adopt: adoptSuspendedPage,
    suspend: suspendTab,
    exempt: exemptTabFromAutoSuspend,
    suspendOthers
  }),
  ...createSessionMessageHandlers({
    tabs: { create: saveTabsAsSession, add: addTabsToSession },
    windows: { create: saveWindowAsSession, add: addWindowToSession },
    rename: renameSession
  }),
  ...createInboxCaptureMessageHandlers({
    capture: { window: dumpWindow, tab: dumpTab, tabs: dumpTabs }
  }),
  ...createLiveCloseMessageHandlers({
    ready: actionRecoveryReady,
    tabs: closeLiveTabsById,
    unsaveableTabs: closeUnsaveableTabsById,
    window: closeWindowSafely
  }),
  ...createOpenTabMessageHandlers({
    moveOne: (tabId, destination) => chrome.tabs.move(tabId, destination),
    moveSet: moveSelectedOpenTabs,
    sortWindow: sortWindowById,
    gatherDomain: gatherDomainToNewWindow
  }),
  ...createCloseDayMessageHandlers({
    ready: actionRecoveryReady,
    capture: captureCloseDayReview,
    updateChoice: updateCloseDayChoice,
    updateChoices: updateCloseDayChoices,
    check: checkCloseDayReview,
    updateWindowMode: updateCloseDayWindowMode,
    discard: discardCloseDayDraft,
    commit: commitCloseDay,
    resume: applyCloseDayCloses,
    undo: undoCloseDayTransaction,
    status: closeDayStatus
  }),
  ...createSnoozeMessageHandlers({
    deliveryReady: snoozeRecoveryReady,
    getTab: (tabId) => chrome.tabs.get(tabId),
    createTab: snoozeActions.tab,
    createWindow: snoozeActions.window,
    deliver: fireSnooze,
    deliverSelections: wakeSnoozeSelections
  }),
  ...createJournalMessageHandlers({
    ready: actionRecoveryReady,
    undo: undoActionResult,
    clear: clearJournalSafely
  }),
  ...createDuplicateMessageHandlers({
    ready: actionRecoveryReady,
    close: closeDuplicates,
    setRule: setDuplicateDomainRule,
    refreshBadge: updateDupBadge
  }),
  ...createNavigationMessageHandlers({
    focus: navigationActions.focus,
    restoreSession: navigationActions.restoreSession,
    openGroup: navigationActions.openGroup,
    openUrl: (url) => chrome.tabs.create({ url }),
    search: (query) => chrome.search.query(query),
    activateStarred: navigationActions.activateStarred,
    closeTab: (tabId) => chrome.tabs.remove(tabId),
    refreshBadge: updateDupBadge
  }),
];

// The Focus guard fallback validates sender.tab.id inside its own coordinator
// and returns true exactly when it owns the response channel.
chrome.runtime.onMessage.addListener(createMessageListener(workerMessageHandlers, {
  fallback: (msg, sender, sendResponse) =>
    handleFocusGuardMessage(msg, sender, sendResponse),
  onError: (error) => reportFailure("runtime message", error)
}));
