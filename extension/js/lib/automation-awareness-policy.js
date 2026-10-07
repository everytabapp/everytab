// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Language-free automation awareness projection.
 *
 * This module deliberately reuses the predicates that guard the real effects.
 * It never schedules or performs an action. One coherent settings/activity read
 * is projected for every live tab or saved Inbox item in memory.
 */
import { isArchiveExempt } from "./archive.js";
import {
  isSuspendExempt, recentSuspendFloorIds, TEMPORARY_SUSPEND_EXEMPTIONS_KEY
} from "./suspend.js";
import { ACTIVITY_KEY } from "./tab-activity.js";
import {
  canonicalUrlOf, isHttpTab, isOwnSuspendPage, isTemporarilyAutomationProtected,
  matchesAutomationExclusion, unifiedAutomationExclusions
} from "./tabs.js";
import { readFreshStoreMaps, settingsFromStored } from "./store.js";
import { readTabProtections, protectionStatus } from "./automation-protection.js";

const SETTINGS_KEY = "settings";
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const finite = (value) => Number.isFinite(value) ? value : null;
const positiveInt = (value) => Math.max(0, Math.floor(Number(value) || 0));

/** Read the one joined, generation-scoped input needed by both surfaces. */
export async function readAutomationAwarenessSnapshot(now = Date.now()) {
  const [maps, tabProtections] = await Promise.all([readFreshStoreMaps([
    SETTINGS_KEY, ACTIVITY_KEY, TEMPORARY_SUSPEND_EXEMPTIONS_KEY
  ]), readTabProtections()]);
  return Object.freeze({
    now,
    tabProtections,
    settings: settingsFromStored(maps[SETTINGS_KEY] ?? {}),
    activityByTabId: Object.freeze({ ...(maps[ACTIVITY_KEY] ?? {}) }),
    temporarySuspendExemptions: Object.freeze({
      ...(maps[TEMPORARY_SUSPEND_EXEMPTIONS_KEY] ?? {})
    })
  });
}

function sharedReason(tab) {
  if (tab.pinned) return "pinned";
  if (tab.audible) return "audible";
  if (tab.groupId !== undefined && tab.groupId !== -1) return "grouped";
  if (tab.incognito || (!isHttpTab(tab) && !isOwnSuspendPage(tab))) return "unsupported";
  return null;
}

function timeView(action, awayAt, afterMs, now) {
  const awayMs = Math.max(0, now - awayAt);
  return {
    display: "timed",
    action,
    state: awayMs >= afterMs ? "due" : "running",
    reason: null,
    awayAt,
    awayMs,
    afterMs,
    progress: Math.max(0, Math.min(1, awayMs / afterMs)),
    settingsGroup: action === "suspend" ? "suspension" : "autosave"
  };
}

function stateView(action, state, reason = null, limit = null) {
  return {
    display: "state", action, state, reason, limit,
    awayAt: null, awayMs: null, afterMs: null, progress: null,
    settingsGroup: action === "suspend" || action === "awake-cap"
      ? "suspension"
      : "autosave"
  };
}

const noView = () => ({
  display: "none", action: null, state: "off", reason: null,
  awayAt: null, awayMs: null, afterMs: null, progress: null,
  settingsGroup: null
});

/**
 * Project one Open row with the counts used by the corresponding effects.
 * Time comes only from the device-local activity map.
 */
export function projectOpenTabAwareness(tab, snapshot, counts) {
  const protection = protectionStatus(tab, snapshot.settings,
    snapshot.temporarySuspendExemptions, snapshot.tabProtections ?? {}, snapshot.now);
  // Expiring tab/URL layers may reveal a permanent website or page rule.
  // Carry only their compact display states, not the settings or tab records.
  let layer = protection;
  while (layer.protected && layer.expiresAt) {
    layer.afterExpiry = protectionStatus(tab, snapshot.settings,
      snapshot.temporarySuspendExemptions, snapshot.tabProtections ?? {}, layer.expiresAt);
    layer = layer.afterExpiry;
  }
  const view = projectOpenPolicy(tab, snapshot, counts);
  if (!protection.protected && protection.kind !== "expired") return view;
  // Protection is a separate fact from being active, pinned, or having timers off.
  return {
    ...(["active", "excluded"].includes(view.state) && view.display !== "none"
      ? view : tab.active ? stateView("suspend", "active")
        : stateView("suspend", "excluded", "automation-protected")),
    protection, settingsGroup: "protection"
  };
}

function projectOpenPolicy(tab, snapshot, counts) {
  const { settings, activityByTabId, temporarySuspendExemptions, now } = snapshot;
  const openTabCount = typeof counts === "number" ? counts : positiveInt(counts?.open);
  const suspendTabCount = typeof counts === "number" ? counts : positiveInt(counts?.suspendOpen);
  const awakeTabCount = typeof counts === "number" ? counts : positiveInt(counts?.awake);
  const suspendTimerOn = settings.suspendEnabled === true;
  const autoSaveTimerOn = settings.autoArchiveEnabled === true;
  const awakeCap = positiveInt(settings.suspendMaxTabs);
  const openCap = positiveInt(settings.autoSaveMaxTabs);
  if (!suspendTimerOn && !autoSaveTimerOn && awakeCap <= 0 && openCap <= 0) return noView();

  const reason = sharedReason(tab);
  if (reason) {
    const action = suspendTimerOn || awakeCap > 0 ? "suspend" : "save";
    return stateView(action, "excluded", reason);
  }

  // Both real effects exclude a selected tab at tab grain. An unfocused
  // window's selected tab can only Auto-save as part of an all-safe/all-old
  // whole-window commit, so a row-level timer would misstate that contract.
  if (tab.active) {
    const action = suspendTimerOn || awakeCap > 0 ? "suspend" : "save";
    return stateView(action, "active");
  }

  const url = canonicalUrlOf(tab);
  const automationExclusions = unifiedAutomationExclusions(settings);
  const automationProtected = matchesAutomationExclusion(url, automationExclusions) ||
    isTemporarilyAutomationProtected(url, temporarySuspendExemptions, now);
  const suspended = isOwnSuspendPage(tab) || tab.discarded;
  const minTabs = positiveInt(settings.suspendMinTabs);
  const recentFloor = counts?.suspendRecentFloorIds;
  const suspendCountAllowsTime = recentFloor instanceof Set
    ? !recentFloor.has(tab.id)
    : minTabs <= 0 || suspendTabCount > minTabs;
  const suspendSafe = !suspended && !isSuspendExempt(
    tab, automationExclusions, temporarySuspendExemptions, now
  );
  const autoSaveSafe = !isArchiveExempt(
    tab, automationExclusions, temporarySuspendExemptions, now);
  const awayAt = finite(activityByTabId?.[tab.id]);

  // A breached count rule can act before the time rule and therefore becomes
  // the one relevant next rule. It remains a state with no invented track.
  if (awakeCap > 0 && awakeTabCount > awakeCap && suspendSafe) {
    return stateView("awake-cap", "count", null, awakeCap);
  }
  if (openCap > 0 && openTabCount > openCap && autoSaveSafe) {
    return stateView("open-cap", "count", null, openCap);
  }

  const candidates = [];
  if (suspendTimerOn && suspendCountAllowsTime && suspendSafe) {
    candidates.push({ action: "suspend", afterMs:
      Math.max(1, Number(settings.suspendAfterMinutes) || 1) * MINUTE_MS });
  }
  if (autoSaveTimerOn && autoSaveSafe) {
    const afterMinutes = Math.max(1, Number(settings.autoDumpAfterMinutes) ||
      Math.max(1, Number(settings.autoArchiveDays) || 7) * 1440);
    candidates.push({ action: "save", afterMs: afterMinutes * MINUTE_MS });
  }

  if (candidates.length) {
    candidates.sort((a, b) => a.afterMs - b.afterMs ||
      (a.action === "suspend" ? -1 : 1));
    const next = candidates[0];
    return awayAt === null
      ? stateView(next.action, "unknown")
      : timeView(next.action, awayAt, next.afterMs, now);
  }

  // Explain a rule-specific exception only when no other timed policy can act.
  if (automationProtected &&
      (suspendTimerOn || awakeCap > 0 || autoSaveTimerOn || openCap > 0)) {
    const action = suspendTimerOn || awakeCap > 0 ? "suspend" : "save";
    return stateView(action, "excluded", "automation-protected");
  }
  if (suspendTimerOn && !suspendCountAllowsTime && !suspended) {
    return stateView("suspend", "minimum-count", null, minTabs);
  }
  if (awakeCap > 0 && suspendSafe) return stateView("awake-cap", "count", null, awakeCap);
  if (openCap > 0 && autoSaveSafe) return stateView("open-cap", "count", null, openCap);
  return noView();
}

/** Bulk-project all Open tabs without performing a read per row. */
export function projectOpenAutomationAwareness(windows, snapshot) {
  const allTabs = (windows ?? []).flatMap((window) => window.tabs ?? []);
  const normal = (windows ?? []).filter((window) => !window.type || window.type === "normal");
  const tabs = normal.filter((window) => !window.incognito).flatMap((window) => window.tabs ?? []);
  const counts = {
    open: normal.reduce((total, window) => total + (window.tabs?.length ?? 0), 0),
    suspendOpen: allTabs.length,
    awake: allTabs.filter((tab) => isHttpTab(tab) && !isOwnSuspendPage(tab) && !tab.discarded).length,
    suspendRecentFloorIds: recentSuspendFloorIds(
      allTabs, snapshot.activityByTabId, snapshot.settings.suspendMinTabs)
  };
  const byTabId = new Map();
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    byTabId.set(tab.id, projectOpenTabAwareness(tab, snapshot, counts));
  }
  return byTabId;
}

/** Project the one card-header rule for each Inbox item. */
export function projectInboxAutomationAwareness(items, snapshot) {
  const afterDays = positiveInt(snapshot.settings.inboxExpiryDays);
  const byItemId = new Map();
  for (const item of items ?? []) {
    if (!item?.id) continue;
    if (afterDays <= 0) {
      byItemId.set(item.id, {
        display: "age-only", savedAt: finite(item.createdAt) ?? finite(item.modifiedAt),
        afterDays: null, settingsGroup: null
      });
      continue;
    }
    const savedAt = finite(item.createdAt) ?? finite(item.modifiedAt);
    byItemId.set(item.id, savedAt === null
      ? { display: "unknown", savedAt: null, afterDays,
          settingsGroup: "autosave" }
      : { display: "rule", savedAt, afterDays, afterMs: afterDays * DAY_MS,
          settingsGroup: "autosave" });
  }
  return byItemId;
}
