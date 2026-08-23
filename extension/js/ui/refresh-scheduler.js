/**
 * E3-4 — small, DOM-free refresh scheduling primitives shared by the dashboard
 * and side panel. They own timing only; existing renderers remain the execution
 * and visibility seams.
 */
import { ARCHIVE_OVERLAY_KEY, STORE_KEYS } from "../lib/types.js";
import { SESSION_IDENTITY_INDEX_KEY } from "../lib/session-identity-index.js";

/** Every tab/window signal has the same dashboard dependency contract. */
export const TAB_REFRESH_TASKS = Object.freeze([
  "open", "attention", "duplicates", "nav"
]);

const DATA_KEYS = new Set([
  "inbox", "archive", "sessions", "collections", "snoozes", "smartviews", "starred",
  "settings", STORE_KEYS.organizationGroups, STORE_KEYS.organizationMemberships,
  ARCHIVE_OVERLAY_KEY
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
  if (changes.inbox) {
    tasks.add("inbox");
    tasks.add("labels");
  }
  if (archiveChanged) {
    tasks.add("archive");
    tasks.add("labels");
  }
  if (changes.sessions) {
    tasks.add("sessions");
    tasks.add("snapshots");
  }
  if (changes[STORE_KEYS.organizationGroups] || changes[STORE_KEYS.organizationMemberships]) {
    tasks.add("labels");
    tasks.add("sessions");
  }
  if (changes.smartviews) tasks.add("smartviews");
  if (changes.starred) tasks.add("starred");
  if (changes.snoozes) {
    tasks.add("snoozes");
    tasks.add("sessions");
  }
  if (changes.vaultMeta) {
    tasks.add("vault");
    tasks.add("nav");
    tasks.add("attention");
  }
  if (changes.journal) {
    tasks.add("activity");
    tasks.add("attention");
  }
  if (changes.focusGuardState || changes.focusTemporaryAccess || changes.settings) {
    tasks.add("focus");
  }
  if (changes.settings) tasks.add("settings");
  if (changes.customSchemes) {
    tasks.add("settings");
    tasks.add("nav");
  }

  const dataChanged = Object.keys(changes).some((key) => DATA_KEYS.has(key));
  const fullNavChanged = [
    "inbox", "sessions", "collections", "snoozes", "settings", "customSchemes"
  ]
    .some((key) => changes[key]);
  if (fullNavChanged) tasks.add("nav");
  else if (!tasks.has("nav") && (archiveChanged || changes.smartviews || changes.labelMeta)) {
    tasks.add("navLibrary");
  }
  // F35: page utilities split their dependencies. Starred reads only the
  // starred store; Needs you depends on live tabs, Inbox/Snoozed counts, and
  // the duplicate-normalization setting. Archive/Session/Smart-view/Collection
  // writes cannot change what it says, so do not query and re-deduplicate every
  // live tab after those commits. `starred` is deliberately NOT a tab-refresh
  // task: the launcher reads no live tabs at all.
  if (changes.inbox || changes.snoozes || changes.settings) {
    tasks.add("attention");
  }
  if (changes.sessions || changes.sessionWindows || changes[SESSION_IDENTITY_INDEX_KEY]) {
    tasks.add("attention");
  }
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
 * @param {{requestFrame?: (callback: FrameRequestCallback) => unknown}} options
 */
export function createFrameRefreshScheduler(
  run,
  { requestFrame = globalThis.requestAnimationFrame.bind(globalThis) } = {}
) {
  const dirty = new Set();
  let framePending = false;
  let flushing = false;

  const schedule = () => {
    if (framePending || flushing || dirty.size === 0) return;
    framePending = true;
    requestFrame(async () => {
      framePending = false;
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
    }
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
