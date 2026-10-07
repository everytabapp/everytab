// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * E3-4 — small, DOM-free refresh scheduling primitives shared by the dashboard
 * and side panel. They own timing only; existing renderers remain the execution
 * and visibility seams.
 */
import { ARCHIVE_OVERLAY_KEY, STORE_KEYS } from "../lib/types.js";
import {
  SESSION_IDENTITY_INDEX_KEY, NAMED_SESSION_RECORDS_KEY,
  SESSION_NAVIGATION_REVISION_KEY
} from "../lib/session-identity-index.js";
import { DUPLICATE_DOMAIN_RULES_KEY } from "../lib/duplicate-domain-rules.js";

/**
 * Every tab/window signal has the same dashboard dependency contract: the Open
 * list, the live-only Needs-you inputs, the Duplicates section and the live
 * navigation counts. Saved families (Inbox, Archive, Labels, Sessions) refresh
 * only through storage changes, so a tab burst never clones the saved library.
 */
export const TAB_REFRESH_TASKS = Object.freeze([
  "open", "attentionLive", "duplicates", "navOpen"
]);

/** Live-only tasks and the complete task that already covers each of them. */
export const LIVE_ONLY_REFRESH_TASKS = Object.freeze({
  attentionLive: "attention",
  navOpen: "nav"
});

/**
 * Drop a live-only task when the same refresh also runs its complete variant.
 * The complete task reads the same live snapshot, so running both would only
 * paint the same counts twice.
 * @param {string[]} tasks
 * @returns {string[]}
 */
export function withoutSupersededLiveTasks(tasks) {
  return tasks.filter((task) =>
    !(task in LIVE_ONLY_REFRESH_TASKS) || !tasks.includes(LIVE_ONLY_REFRESH_TASKS[task]));
}

const DATA_KEYS = new Set([
  "inbox", "archive", "sessions", "collections", "snoozes", "starred",
  "settings", STORE_KEYS.organizationGroups, STORE_KEYS.organizationMemberships,
  ARCHIVE_OVERLAY_KEY, NAMED_SESSION_RECORDS_KEY, SESSION_NAVIGATION_REVISION_KEY
]);

/**
 * Convert one dashboard storage change into its exact render dependencies.
 * Set insertion order is intentional: affected sections precede global counts.
 * @param {Record<string, unknown>} changes
 * @param {{statsVisible?: boolean}} options
 * @returns {string[]}
 */
export function dashboardTasksForStorage(changes, { statsVisible = false } = {}) {
  const tasks = new Set();
  const archiveChanged = changes.archive || changes[ARCHIVE_OVERLAY_KEY];
  const settingsChange = changes.settings;
  const changedSettingKeys = settingsChange
    ? [...new Set([
        ...Object.keys(settingsChange.oldValue ?? {}),
        ...Object.keys(settingsChange.newValue ?? {})
      ])].filter((key) =>
        JSON.stringify(settingsChange.oldValue?.[key]) !==
          JSON.stringify(settingsChange.newValue?.[key]))
    : [];
  // On-open rotation changes only the selected scheme and writes its successor
  // reservation atomically. theme.js already paints that transaction in every
  // live context; treating it as an ordinary Settings edit would rebuild
  // navigation, Needs you, Focus, and Settings in every retained Dashboard.
  const rotationOnlySettings = changedSettingKeys.length === 1 &&
    changedSettingKeys[0] === "uiScheme" && "schemeRotationPrepared" in changes;
  const settingsChanged = Boolean(settingsChange) && !rotationOnlySettings;
  const automationChanged = settingsChanged && (changedSettingKeys.length === 0 ||
    changedSettingKeys.some((key) => key.startsWith("suspend") ||
      ["autoArchiveEnabled", "autoArchiveDays", "autoDumpAfterMinutes",
        "autoSaveMaxTabs", "archiveWhitelist", "inboxExpiryDays"].includes(key)));
  const duplicateRulesChanged = settingsChanged && (changedSettingKeys.length === 0 ||
    changedSettingKeys.includes("duplicateDomainRules"));
  if (changes.tabActivity || changes.suspendTemporaryExemptions || changes.automationTabProtections || automationChanged) {
    tasks.add("open");
  }
  if (changes.automationTabProtections) tasks.add("settings");
  if (automationChanged) tasks.add("inbox");
  if (changes.inbox) {
    tasks.add("inbox");
    tasks.add("labels");
  }
  if (archiveChanged) {
    tasks.add("archive");
    tasks.add("labels");
  }
  if (changes.sessions || changes[NAMED_SESSION_RECORDS_KEY] ||
      changes[SESSION_NAVIGATION_REVISION_KEY]) {
    tasks.add("sessions");
    tasks.add("snapshots");
    // Linked Snoozes project the current Session name and pages, including
    // source repair or deletion while the Snoozed list is already visible.
    tasks.add("snoozes");
    // A Session write changes only the Session branch and Snapshot count in
    // the global navigation. Routing it through `nav` used to rebuild the
    // complete Inbox/Archive/Label library and clone every automatic Snapshot,
    // freezing mature profiles immediately after create/rename.
    tasks.add("navSessions");
  }
  if (changes[STORE_KEYS.organizationGroups] || changes[STORE_KEYS.organizationMemberships]) {
    tasks.add("labels");
    tasks.add("sessions");
  }
  if (changes.starred) tasks.add("starred");
  if (changes.snoozes) {
    tasks.add("snoozes");
    tasks.add("sessions");
  }
  if (changes[DUPLICATE_DOMAIN_RULES_KEY] || duplicateRulesChanged) {
    tasks.add("duplicates");
    tasks.add("attention");
    tasks.add("nav");
    if (statsVisible) tasks.add("stats");
  }
  if (changes.vaultMetaV2) {
    tasks.add("vault");
    // Vault status changes only the Vault surface, its sidebar pill, and Needs
    // you. They do not change any navigation count or route. Sending this
    // through `nav` redundantly cloned and scanned the complete saved library
    // after every sync, producing a second mature-profile freeze several
    // seconds after an otherwise responsive Session edit.
    tasks.add("vaultPill");
    tasks.add("attention");
  }
  if (changes.journal) {
    tasks.add("activity");
    tasks.add("attention");
  }
  if (changes.focusGuardState || changes.focusTemporaryAccess || settingsChanged) {
    tasks.add("focus");
  }
  if (settingsChanged) tasks.add("settings");
  if (changes.customSchemes) {
    tasks.add("settings");
    tasks.add("nav");
  }

  const dataChanged = Object.keys(changes)
    .some((key) => DATA_KEYS.has(key) && (key !== "settings" || settingsChanged));
  const fullNavChanged = settingsChanged || [
    "inbox", "collections", "snoozes", "customSchemes"
  ]
    .some((key) => changes[key]);
  if (fullNavChanged) tasks.add("nav");
  else if (!tasks.has("nav") && (archiveChanged || changes.labelMeta)) {
    tasks.add("navLibrary");
  }
  // F35: page utilities split their dependencies. Starred reads only the
  // starred store; Needs you depends on live tabs, Inbox/Snoozed counts, and
  // the duplicate-normalization setting. Archive, Session, and legacy
  // collection writes cannot change what it says, so do not query and
  // re-deduplicate every
  // live tab after those commits. `starred` is deliberately NOT a tab-refresh
  // task: the launcher reads no live tabs at all.
  if (changes.inbox || changes.snoozes || settingsChanged) {
    tasks.add("attention");
  }
  if (changes.sessions || changes[NAMED_SESSION_RECORDS_KEY] ||
      changes[SESSION_NAVIGATION_REVISION_KEY] ||
      changes.sessionWindows || changes[SESSION_IDENTITY_INDEX_KEY]) {
    tasks.add("attention");
    tasks.add("openWarm");
  }
  if (changes[SESSION_IDENTITY_INDEX_KEY]) tasks.add("open");
  if (dataChanged && statsVisible) tasks.add("stats");
  if (changes.counters && statsVisible) tasks.add("stats");
  return [...tasks];
}

/**
 * One dirty-set scheduler. Requests before a frame are deduplicated into one
 * snapshot. Requests made while that snapshot is running wait for exactly one
 * follow-up frame.
 *
 * @param {(tasks: string[]) => Promise<unknown>|unknown} run
 * @param {{requestFrame?: (callback: FrameRequestCallback) => unknown,
 *   canRun?: () => boolean}} options
 */
export function createFrameRefreshScheduler(
  run,
  {
    requestFrame = globalThis.requestAnimationFrame.bind(globalThis),
    canRun = () => true
  } = {}
) {
  const dirty = new Set();
  let framePending = false;
  let flushing = false;

  const schedule = () => {
    if (framePending || flushing || dirty.size === 0 || !canRun()) return;
    framePending = true;
    requestFrame(async () => {
      framePending = false;
      // Visibility can change after scheduling. Retain the whole batch until
      // the owner signals foreground again, without scheduling hidden frames.
      if (!canRun()) return;
      flushing = true;
      const snapshot = [...dirty];
      dirty.clear();
      try {
        await run(snapshot);
      } finally {
        flushing = false;
        schedule();
      }
    });
  };

  return {
    /** @param {string|string[]} tasks */
    request(tasks) {
      for (const task of Array.isArray(tasks) ? tasks : [tasks]) {
        if (task) dirty.add(task);
      }
      schedule();
    },
    foreground: schedule
  };
}

/**
 * Run the first event in a burst immediately, then reconcile once after a
 * short quiet window. The caller normally queues each refresh into the frame
 * scheduler, so "immediate" still means the next paint boundary.
 *
 * @param {() => void} refresh
 * @param {{delay?: number, setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout}} options
 */
export function createLeadingTrailingRefresh(
  refresh,
  {
    delay = 120,
    setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimer = globalThis.clearTimeout.bind(globalThis)
  } = {}
) {
  let timer = null;
  return () => {
    if (timer === null) refresh();
    else clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      refresh();
    }, delay);
  };
}

/**
 * Keep a DOM refresh pending while an interaction owns nodes that refresh would
 * replace. Signals received during the hold collapse into one reconciliation;
 * a signal arriving during that reconciliation earns one trailing pass.
 *
 * `subscribe` reports hold-state changes. Keeping that source injectable makes
 * this scheduler independent from any particular picker implementation.
 *
 * @param {() => unknown|Promise<unknown>} refresh
 * @param {{isHeld:()=>boolean,subscribe?:(listener:()=>void)=>(()=>void)|void}} options
 */
export function createInteractionRefreshGate(
  refresh,
  { isHeld, subscribe = () => () => {} }
) {
  let dirty = false;
  let running = null;
  let disposed = false;

  const drain = () => {
    if (disposed || running) return running ?? Promise.resolve(false);
    if (!dirty || isHeld()) return Promise.resolve(false);
    dirty = false;
    const task = Promise.resolve().then(refresh).then(() => true);
    let wrapped;
    wrapped = task.finally(() => {
      if (running !== wrapped) return;
      running = null;
      if (dirty && !isHeld() && !disposed) void drain();
    });
    running = wrapped;
    return running;
  };

  const onHoldChange = () => {
    if (!isHeld()) void drain();
  };
  const unsubscribe = subscribe(onHoldChange) ?? (() => {});

  return {
    request() {
      dirty = true;
      return drain();
    },
    defer() { dirty = true; },
    isHeld,
    dispose() {
      disposed = true;
      dirty = false;
      unsubscribe();
    }
  };
}

/**
 * Keep expensive live-browser refreshes off an inactive document's main
 * thread. Signals collapse into one trailing attempt; if the document is not
 * foreground then, the dirty bit survives until `foreground()` is called.
 *
 * @param {() => void} refresh
 * @param {{delay?:number,isForeground?:() => boolean,setTimer?:typeof setTimeout,
 *   clearTimer?:typeof clearTimeout}} options
 */
export function createForegroundTrailingRefresh(
  refresh,
  {
    delay = 180,
    isForeground = () => globalThis.document?.hasFocus?.() === true,
    setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimer = globalThis.clearTimeout.bind(globalThis)
  } = {}
) {
  let dirty = false;
  let timer = null;

  const schedule = (wait) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      if (!dirty || !isForeground()) return;
      dirty = false;
      refresh();
    }, wait);
  };

  return {
    request() {
      dirty = true;
      schedule(delay);
    },
    foreground() {
      if (dirty) schedule(0);
    }
  };
}

/**
 * Deduplicate UI tasks while a document is inactive, then hand one complete
 * batch back to its normal frame scheduler when that document is foreground.
 * @param {(tasks:string[]) => void} run
 * @param {{isForeground?:() => boolean}} options
 */
export function createForegroundTaskQueue(
  run,
  { isForeground = () => globalThis.document?.hasFocus?.() === true } = {}
) {
  const dirty = new Set();
  const flush = () => {
    if (!isForeground() || dirty.size === 0) return;
    const tasks = [...dirty];
    dirty.clear();
    run(tasks);
  };
  return {
    request(tasks) {
      for (const task of Array.isArray(tasks) ? tasks : [tasks]) {
        if (task) dirty.add(task);
      }
      flush();
    },
    foreground: flush
  };
}
