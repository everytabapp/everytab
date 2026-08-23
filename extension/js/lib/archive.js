/**
 * M4 — Auto-archive (PRD §3.3).
 * Idle tabs close and land in the Inbox (source "auto-archive"); old Inbox
 * items expire to the long-term Archive store. Both sweeps are alarm-driven
 * and run in the background worker only (hard rule: all tab mutations there).
 *
 * Idle tracking is activation-only in M4 (shared tabActivity map with
 * suspension). The PRD's scroll/input tracking and form-input exemption need
 * a content script — deferred, which is why the feature ships off by default.
 */

import { STORE_KEYS } from "./types.js";
import { getSettings, newMeta, upsertItem, mutateStores } from "./store.js";
import { canonicalRef, matchesWhitelist } from "./tabs.js";
import { getActivityMap, saveActivityMap } from "./suspend.js";
import { openDashboard, restoreTabsFromItems } from "./actions.js";
import { bump, COUNTERS_KEY, bumpedCounters } from "./counters.js";
import { JOURNAL_KEY, makeJournalEntry, appendedJournal } from "./journal.js";
import { msg as localeMessage } from "./i18n.js";

const DAY_MS = 86_400_000;

// `matchesWhitelist` moved to tabs.js (shared with F9's never-suspend list); it
// is re-exported here so existing importers (and tests) keep working unchanged.
export { matchesWhitelist };

/**
 * Exempt from auto-archive: pinned, audible, in any tab group, whitelisted,
 * or no archivable URL (PRD §3.3). NOTE: `active` is deliberately not here —
 * it's a tab-level concern only; a fully idle unfocused window may archive
 * as a bundle including its active tab. No form-input exemption in M4.
 * @param {chrome.tabs.Tab} t @param {string[]} [whitelist]
 */
export function isArchiveExempt(t, whitelist) {
  if (t.pinned || t.audible || t.incognito) return true; // never auto-dump incognito
  if (t.groupId !== undefined && t.groupId !== -1) return true;
  const ref = canonicalRef(t);
  if (!ref) return true;
  return matchesWhitelist(ref.url, whitelist);
}

/**
 * F46: the sweep already announced itself with a badge flash and a system
 * notification. Now that it journals an inverse, that notification carries the
 * same Undo button the manual commands use, so the announcement is actionable
 * instead of only informative. The registrar is injected because the
 * notification-button router lives in the worker, not in this module.
 * @type {((notificationId: string, entryId: string) => void)|null}
 */
let registerUndoButton = null;

/** Wire the worker's notification-button map (background.js owns the router). */
export function setArchiveUndoRegistrar(fn) {
  registerUndoButton = typeof fn === "function" ? fn : null;
}

/** Badge flash + notification — same always-visible pattern as snooze wakes. */
async function notifyArchived(count, undoId) {
  try {
    await chrome.action.setBadgeText({ text: "📥" });
    await chrome.action.setBadgeBackgroundColor({ color: "#4a7a4a" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 6000);
  } catch {
    /* ignore */
  }
  try {
    const id = `auto-archived-${Date.now()}`;
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: localeMessage("archive_notification_saved_title"),
      message: localeMessage(count === 1
        ? "archive_notification_saved_one"
        : "archive_notification_saved_other", [String(count)]),
      ...(undoId && registerUndoButton
        ? { buttons: [{ title: localeMessage("action_undo") }] }
        : {})
    });
    if (undoId && registerUndoButton) registerUndoButton(id, undoId);
  } catch (e) {
    console.warn("EveryTab: archive notification failed", e);
  }
}

/**
 * Sweep: apply both independent Auto-save policies.
 *
 * 1. Timer: archive tabs idle beyond settings.autoDumpAfterMinutes.
 * 2. Hard cap: if settings.autoSaveMaxTabs is positive, save the longest-idle
 *    eligible surplus tabs until the open-tab count fits as far as protected
 *    tabs allow. The cap works even when the idle timer is Off.
 *
 * Per window:
 * - Window bundle: ≥2 tabs, ALL archivable (none exempt), ALL past threshold
 *   (including the active tab), window not focused → one kind:"window" item.
 * - Otherwise tab-level: each non-exempt, non-active tab past threshold;
 *   same-window tabs group into one item (dumpWindow convention).
 *
 * Never-seen tabs are stamped now and skipped (full grace period — after a
 * restart all tab IDs are new, so no mass archive right after enabling,
 * installing, or restarting). Stale activity entries are pruned.
 * Concurrent worker triggers share one run, so a tab can never be captured
 * twice by overlapping alarm, Settings, and tab-created sweeps.
 * @param {number} [now] injectable for tests
 * @returns {Promise<number>} tabs archived
 */
export async function archiveSweep(now = Date.now()) {
  if (archiveSweepInFlight) return archiveSweepInFlight;
  archiveSweepInFlight = runArchiveSweep(now);
  try {
    return await archiveSweepInFlight;
  } finally {
    archiveSweepInFlight = null;
  }
}

/** @type {Promise<number>|null} */
let archiveSweepInFlight = null;

/** @param {number} now @returns {Promise<number>} */
async function runArchiveSweep(now) {
  const settings = await getSettings();
  const timerEnabled = settings.autoArchiveEnabled === true;
  const maxTabs = Math.max(0, Math.floor(Number(settings.autoSaveMaxTabs) || 0));
  if (!timerEnabled && maxTabs <= 0) return 0;
  // N3: minute-granular threshold (getSettings derives it from autoArchiveDays for
  // old installs), so sub-day values like 6h work; fall back to the legacy day value.
  const mins = Math.max(1, Number(settings.autoDumpAfterMinutes) ||
    (Math.max(1, Number(settings.autoArchiveDays) || 7) * 1440));
  const cutoff = now - mins * 60_000;

  const map = await getActivityMap();
  let mapChanged = false;
  const windows = await chrome.windows.getAll({ populate: true });
  const liveIds = new Set();

  /** @type {{windowId: number, tabs: chrome.tabs.Tab[], bundle: boolean}[]} */
  const plans = [];
  /** @type {{windowId: number, window: chrome.windows.Window, tab: chrome.tabs.Tab}[]} */
  const openTabs = [];

  for (const win of windows) {
    if (win.type && win.type !== "normal") continue;
    const tabs = win.tabs ?? [];
    for (const t of tabs) {
      liveIds.add(t.id);
      openTabs.push({ windowId: win.id, window: win, tab: t });
    }

    if (!timerEnabled) continue;

    let allIdle = tabs.length >= 2;
    let allArchivable = tabs.length >= 2;
    /** @type {chrome.tabs.Tab[]} */
    const loose = [];

    for (const t of tabs) {
      const exempt = isArchiveExempt(t, settings.archiveWhitelist);
      if (exempt) allArchivable = false;
      const last = map[t.id];
      if (last === undefined) {
        map[t.id] = now; // first sighting: start the clock
        mapChanged = true;
        allIdle = false;
        continue;
      }
      if (last >= cutoff) {
        allIdle = false;
        continue;
      }
      if (!exempt && !t.active) loose.push(t);
    }

    if (allIdle && allArchivable && !win.focused) {
      plans.push({ windowId: win.id, tabs, bundle: true }); // PRD: window archives as a unit
    } else if (loose.length > 0) {
      plans.push({ windowId: win.id, tabs: loose, bundle: false });
    }
  }

  // The count policy deliberately counts every tab in normal windows, while
  // choosing only safe candidates. Active, pinned, audible, grouped,
  // incognito, unsaveable, and whitelisted tabs can therefore keep the total
  // above a very small cap; they are never sacrificed to hit a number.
  if (maxTabs > 0) {
    const plannedIds = new Set(plans.flatMap((plan) =>
      plan.tabs.map((tab) => tab.id).filter((id) => id !== undefined)));
    const surplus = openTabs.length - maxTabs - plannedIds.size;
    if (surplus > 0) {
      const lastUsed = (tab) => map[tab.id] ?? tab.lastAccessed ?? now;
      const candidates = openTabs
        .filter(({ tab }) => tab.id !== undefined && !plannedIds.has(tab.id) &&
          !tab.active && !isArchiveExempt(tab, settings.archiveWhitelist))
        .sort((a, b) => lastUsed(a.tab) - lastUsed(b.tab) ||
          a.windowId - b.windowId || (a.tab.index ?? 0) - (b.tab.index ?? 0) ||
          a.tab.id - b.tab.id)
        .slice(0, surplus);
      /** @type {Map<number, chrome.tabs.Tab[]>} */
      const byWindow = new Map();
      for (const { windowId, tab } of candidates) {
        if (!byWindow.has(windowId)) byWindow.set(windowId, []);
        byWindow.get(windowId).push(tab);
      }
      for (const win of windows) {
        const extra = byWindow.get(win.id);
        if (!extra?.length) continue;
        const existing = plans.find((plan) => plan.windowId === win.id);
        if (existing) {
          existing.tabs = [...existing.tabs, ...extra]
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
          existing.bundle = existing.tabs.length === (win.tabs?.length ?? 0);
        } else {
          plans.push({
            windowId: win.id,
            tabs: extra.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
            bundle: extra.length === (win.tabs?.length ?? 0)
          });
        }
      }
    }
  }

  // Prune activity entries for tabs that no longer exist (restart leftovers).
  for (const id of Object.keys(map)) {
    if (!liveIds.has(Number(id))) {
      delete map[id];
      mapChanged = true;
    }
  }

  let archived = 0;
  /** The last sweep entry, so one notification can offer to undo it. */
  let lastEntryId = null;
  for (const plan of plans) {
    const liveTabs = [];
    for (const planned of plan.tabs) {
      if (planned.id === undefined) continue;
      try {
        const live = await chrome.tabs.get(planned.id);
        const plannedRef = canonicalRef(planned);
        const liveRef = canonicalRef(live);
        const sameTab = live.windowId === plan.windowId && plannedRef && liveRef &&
          plannedRef.url === liveRef.url;
        if (!sameTab || (!plan.bundle && live.active) ||
            isArchiveExempt(live, settings.archiveWhitelist)) continue;
        liveTabs.push(live);
      } catch {
        /* closed between planning and commit */
      }
    }
    // A whole-window plan is one indivisible bundle. If any tab moved, changed,
    // or became protected, leave the entire window alone and reconsider it on
    // a later sweep instead of silently turning it into a partial capture.
    if (plan.bundle && liveTabs.length !== plan.tabs.length) continue;
    const refs = liveTabs.map(canonicalRef).filter(Boolean);
    if (refs.length === 0) continue;

    /** @type {import("./types.js").InboxItem} */
    const item = {
      ...(await newMeta()),
      kind: plan.bundle || refs.length > 1 ? "window" : "tab",
      tabs: refs,
      source: "auto-archive",
      labels: []
    };
    /* F46: the sweep CLOSES tabs on its own, and it was the one operation with
     * no record and no way back. It now journals exactly what the manual save
     * does — remove the item it created, reopen the tabs it closed — in the
     * SAME atomic commit as the item, still before any tab closes, and marked
     * `auto` so Activity can separate what EveryTab did by itself. */
    const entry = makeJournalEntry(
      `Auto-saved ${refs.length} tab${refs.length === 1 ? "" : "s"} to the Inbox`,
      { dels: [{ store: STORE_KEYS.inbox, id: item.id }], reopen: [refs] },
      { auto: true }
    );
    lastEntryId = entry?.id ?? lastEntryId;
    const stamp = Date.now();
    await mutateStores([STORE_KEYS.inbox, JOURNAL_KEY], (maps) => ({
      [STORE_KEYS.inbox]: { ...(maps[STORE_KEYS.inbox] ?? {}), [item.id]: { ...item, modifiedAt: stamp } },
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    }));

    // A whole-window bundle can kill the last window — open the dashboard
    // first so the browser (and this operation) survives. (M0 lesson.)
    if (plan.bundle) {
      const remaining = await chrome.windows.getAll({});
      if (remaining.length <= 1) await openDashboard();
    }
    const ids = liveTabs.map((t) => t.id).filter((id) => id !== undefined);
    try {
      await chrome.tabs.remove(ids);
    } catch {
      /* a tab may already be gone — the Inbox item stays, nothing is lost */
    }
    for (const id of ids) delete map[id];
    mapChanged = true;
    archived += refs.length;
  }

  if (mapChanged) await saveActivityMap(map);
  if (archived > 0) {
    bump("tabsAutoArchived", archived);
    await notifyArchived(archived, lastEntryId);
  }
  return archived;
}

/**
 * F46r: expiry announces itself exactly like the auto-save. MH's call, and the
 * reasoning holds: the user did not ask for it either, and "my Inbox emptied
 * itself" is just as surprising as "my tabs closed" even though nothing is
 * lost. Same badge flash, same Undo button.
 */
async function notifyExpired(count, undoId) {
  try {
    await chrome.action.setBadgeText({ text: "📦" });
    await chrome.action.setBadgeBackgroundColor({ color: "#4a7a4a" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 6000);
  } catch {
    /* ignore */
  }
  try {
    const id = `auto-expired-${Date.now()}`;
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: localeMessage("archive_notification_expired_title"),
      message: localeMessage(count === 1
        ? "archive_notification_expired_one"
        : "archive_notification_expired_other", [String(count)]),
      ...(undoId && registerUndoButton
        ? { buttons: [{ title: localeMessage("action_undo") }] }
        : {})
    });
    if (undoId && registerUndoButton) registerUndoButton(id, undoId);
  } catch (e) {
    console.warn("EveryTab: expiry notification failed", e);
  }
}

/**
 * Inbox expiry (PRD §3.3): items untouched for settings.inboxExpiryDays move
 * to the Archive store — same record, same id, archivedAt stamped; tombstoned
 * in the Inbox. Any triage activity resets modifiedAt and keeps the item.
 * Runs regardless of autoArchiveEnabled (0 = never disables it).
 * @param {number} [now] injectable for tests
 * @returns {Promise<number>} items moved
 */
export async function sweepInboxExpiry(now = Date.now()) {
  const settings = await getSettings();
  const days = Number(settings.inboxExpiryDays) || 0;
  if (days <= 0) return 0;
  const cutoff = now - days * DAY_MS;

  // E2-0c: the move is ONE atomic commit. Expiry is re-derived from the FRESH
  // inbox map under the store lock (an item triaged after the sweep started is
  // seen and kept — the old listItems pre-read could act on a stale view), and
  // every expired item's Archive copy, Inbox tombstone, and the itemsExpired
  // counter land in the same single set: a crash or context death commits all
  // or nothing — no more torn "in both stores" state (§2.3 R2).
  let moved = 0;
  let entryId = null;
  await mutateStores([STORE_KEYS.inbox, STORE_KEYS.archive, COUNTERS_KEY, JOURNAL_KEY], (maps) => {
    const inbox = maps[STORE_KEYS.inbox] ?? {};
    /** @type {import("./types.js").InboxItem[]} */
    const expired = Object.values(inbox).filter((i) => !i.deletedAt && i.modifiedAt < cutoff);
    if (expired.length === 0) return null; // validated no-op — nothing past the age
    const newInbox = { ...inbox };
    const newArchive = { ...(maps[STORE_KEYS.archive] ?? {}) };
    for (const item of expired) {
      newArchive[item.id] = { ...item, archivedAt: now, modifiedAt: now };
      newInbox[item.id] = { ...item, deletedAt: now, modifiedAt: now };
    }
    moved = expired.length;
    /* F46: journal the automatic move too, in the same atomic set. Undo puts
     * every item back in the Inbox exactly as it was; nothing was closed, so
     * there is nothing to reopen. */
    const entry = makeJournalEntry(
      `Auto-archived ${expired.length} Inbox item${expired.length === 1 ? "" : "s"}`,
      { puts: expired.map((item) => ({ store: STORE_KEYS.inbox, item })) },
      { auto: true }
    );
    entryId = entry?.id ?? null;
    return {
      [STORE_KEYS.inbox]: newInbox,
      [STORE_KEYS.archive]: newArchive,
      [COUNTERS_KEY]: bumpedCounters(maps[COUNTERS_KEY], "itemsExpired", expired.length),
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
  if (moved > 0) await notifyExpired(moved, entryId);
  return moved;
}

/**
 * Restore an Archive item: window bundle → new window; tab(s) → current
 * window. Removes it from the Archive (tombstone).
 * @param {import("./types.js").InboxItem} item
 */
export async function restoreArchiveItem(item) {
  return restoreTabsFromItems([
    { item, indexes: item.tabs.map((_, index) => index) }
  ], STORE_KEYS.archive);
}
