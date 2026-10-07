// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { STORE_KEYS } from "./types.js";
import { recoverableTabRef } from "./tabs.js";
import { restoreWindowRefsWithReceipt } from "./sessions.js";
import { readFreshStoreMap } from "./store.js";

const MAX_SNAPSHOT_CHOICES = 50;
const MAX_RECOVERY_TABS = 1000;
const PICK_KEY = /^(0|[1-9]\d*):(0|[1-9]\d*)$/;

function recoveryRef(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  if (typeof ref.url !== "string" || !/^(https?|file):/i.test(ref.url)) return null;
  return ref;
}

function domainOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function liveUrlCounts(tabs) {
  const counts = new Map();
  for (const tab of tabs ?? []) {
    const ref = recoverableTabRef(tab);
    if (!ref) continue;
    counts.set(ref.url, (counts.get(ref.url) ?? 0) + 1);
  }
  return counts;
}

/**
 * Compare one immutable automatic Snapshot with a live-browser snapshot.
 * Occurrences, not merely unique URLs, are conserved: if the Snapshot held the
 * same URL twice and Chrome still has one copy, exactly one is recoverable.
 * @param {import("./types.js").Session} snapshot @param {chrome.tabs.Tab[]} liveTabs
 */
export function planMissingSnapshotTabs(snapshot, liveTabs) {
  if (!snapshot?.auto || snapshot.deletedAt || !Array.isArray(snapshot.windows)) {
    return { tabCount: 0, windowCount: 0, candidates: [] };
  }
  const available = liveUrlCounts(liveTabs);
  const candidates = [];
  let tabCount = 0;
  for (let wi = 0; wi < snapshot.windows.length; wi += 1) {
    const refs = Array.isArray(snapshot.windows[wi]) ? snapshot.windows[wi] : [];
    for (let ti = 0; ti < refs.length; ti += 1) {
      const ref = recoveryRef(refs[ti]);
      if (!ref) continue;
      tabCount += 1;
      const remaining = available.get(ref.url) ?? 0;
      if (remaining > 0) {
        available.set(ref.url, remaining - 1);
        continue;
      }
      candidates.push({
        key: `${wi}:${ti}`,
        windowIndex: wi,
        tabIndex: ti,
        title: ref.title || ref.url,
        domain: domainOf(ref.url),
        ref
      });
    }
  }
  return {
    tabCount,
    windowCount: snapshot.windows.filter(Array.isArray).length,
    candidates
  };
}

function liveSnapshots(sessionMap) {
  return Object.values(sessionMap ?? {})
    .filter((session) => session?.auto && !session.deletedAt && Array.isArray(session.windows))
    .sort((a, b) => (Number(b.modifiedAt) || 0) - (Number(a.modifiedAt) || 0));
}

async function recoveryInput() {
  const [stored, tabs] = await Promise.all([
    readFreshStoreMap(STORE_KEYS.sessions),
    chrome.tabs.query({})
  ]);
  return { sessions: stored ?? {}, tabs };
}

/** Read-only summary. It opens nothing and returns no saved URLs. */
export async function inspectSnapshotRecovery() {
  const { sessions, tabs } = await recoveryInput();
  const snapshots = liveSnapshots(sessions).slice(0, MAX_SNAPSHOT_CHOICES).map((snapshot) => {
    const plan = planMissingSnapshotTabs(snapshot, tabs);
    return {
      snapshotId: snapshot.id,
      name: snapshot.name || "Automatic snapshot",
      createdAt: Number(snapshot.createdAt) || Number(snapshot.modifiedAt) || 0,
      modifiedAt: Number(snapshot.modifiedAt) || 0,
      tabCount: plan.tabCount,
      windowCount: plan.windowCount,
      missingCount: plan.candidates.length
    };
  });
  return { ok: true, snapshots };
}

/** Read-only exact missing-occurrence review for one still-live Snapshot. */
export async function reviewSnapshotRecovery(snapshotId) {
  if (typeof snapshotId !== "string" || !snapshotId) {
    return { ok: false, reason: "invalid-snapshot", snapshot: null, candidates: [] };
  }
  const { sessions, tabs } = await recoveryInput();
  const snapshot = sessions[snapshotId];
  if (!snapshot?.auto || snapshot.deletedAt) {
    return { ok: false, reason: "snapshot-unavailable", snapshot: null, candidates: [] };
  }
  const plan = planMissingSnapshotTabs(snapshot, tabs);
  return {
    ok: true,
    snapshot: {
      snapshotId: snapshot.id,
      name: snapshot.name || "Automatic snapshot",
      createdAt: Number(snapshot.createdAt) || Number(snapshot.modifiedAt) || 0,
      modifiedAt: Number(snapshot.modifiedAt) || 0,
      tabCount: plan.tabCount,
      windowCount: plan.windowCount,
      missingCount: plan.candidates.length
    },
    candidates: plan.candidates.map(({ ref: _ref, ...candidate }) => candidate)
  };
}

/**
 * @typedef {Object} SnapshotRecoveryReceipt
 * @property {boolean} ok Valid source/request with no failed or uncertain tabs and no degraded windows
 * @property {number} requested Unique valid occurrence keys, or zero when the request is rejected
 * @property {number} restored Browser-confirmed opened tab occurrences
 * @property {number} windows Windows whose creation returned a valid ID, even with uncertain tabs
 * @property {number} unavailable Selected occurrences no longer missing or unavailable in the source
 * @property {number} failed Invalid references or tab occurrences confirmed absent after creation
 * @property {number} [uncertain] Tab occurrences without browser confirmation; omitted at zero
 * @property {number} [degraded] Windows with incomplete binding/pin setup; omitted at zero
 *
 * For a valid source, unavailable picks are safe no-ops and do not make `ok`
 * false. Degraded counts windows, so it is separate from the occurrence totals.
 */

/** @type {Promise<SnapshotRecoveryReceipt>} */
let snapshotRecoveryChain = Promise.resolve({
  ok: true, requested: 0, restored: 0, windows: 0, unavailable: 0, failed: 0
});

/** @returns {Promise<SnapshotRecoveryReceipt>} */
async function recoverMissingSnapshotTabsNow(snapshotId, pickKeys) {
  const requestedOccurrenceKeys = [...new Set(pickKeys)].filter((key) => PICK_KEY.test(key));
  if (!snapshotId || requestedOccurrenceKeys.length === 0 || requestedOccurrenceKeys.length > MAX_RECOVERY_TABS) {
    return { ok: false, requested: 0, restored: 0, windows: 0, unavailable: 0, failed: 0 };
  }
  // Replan against the live browser immediately before effects. A tab restored
  // since review is no longer missing and cannot be opened twice.
  const { sessions, tabs } = await recoveryInput();
  const snapshot = sessions[snapshotId];
  if (!snapshot?.auto || snapshot.deletedAt) {
    return {
      ok: false, requested: requestedOccurrenceKeys.length, restored: 0, windows: 0,
      unavailable: requestedOccurrenceKeys.length, failed: 0
    };
  }
  const missingByOccurrenceKey = new Map(planMissingSnapshotTabs(snapshot, tabs).candidates
    .map((candidate) => [candidate.key, candidate]));
  const candidatesByWindowIndex = new Map();
  let unavailableOccurrenceCount = 0;
  for (const key of requestedOccurrenceKeys) {
    const candidate = missingByOccurrenceKey.get(key);
    if (!candidate) {
      unavailableOccurrenceCount += 1;
      continue;
    }
    if (!candidatesByWindowIndex.has(candidate.windowIndex)) candidatesByWindowIndex.set(candidate.windowIndex, []);
    candidatesByWindowIndex.get(candidate.windowIndex).push(candidate);
  }
  let confirmedOccurrenceCount = 0;
  let acknowledgedWindowCount = 0;
  let failedOccurrenceCount = 0;
  let uncertainOccurrenceCount = 0;
  let degradedWindowCount = 0;
  for (const [windowIndex, candidates] of [...candidatesByWindowIndex].sort((a, b) => a[0] - b[0])) {
    const refs = candidates.sort((a, b) => a.tabIndex - b.tabIndex).map((item) => item.ref);
    try {
      const windowReceipt = await restoreWindowRefsWithReceipt(refs, undefined, snapshot.groups?.[windowIndex]);
      if (windowReceipt.windowId !== null) acknowledgedWindowCount += 1;
      confirmedOccurrenceCount += windowReceipt.restored;
      failedOccurrenceCount += windowReceipt.failed;
      uncertainOccurrenceCount += windowReceipt.uncertain;
      if (windowReceipt.degraded) degradedWindowCount += 1;
    } catch {
      // Without a receipt, a rejection cannot prove that no browser effect occurred.
      uncertainOccurrenceCount += refs.length;
    }
  }
  return {
    ok: failedOccurrenceCount === 0 && uncertainOccurrenceCount === 0 && degradedWindowCount === 0,
    requested: requestedOccurrenceKeys.length,
    restored: confirmedOccurrenceCount,
    windows: acknowledgedWindowCount,
    unavailable: unavailableOccurrenceCount,
    failed: failedOccurrenceCount,
    ...(uncertainOccurrenceCount ? { uncertain: uncertainOccurrenceCount } : {}),
    ...(degradedWindowCount ? { degraded: degradedWindowCount } : {})
  };
}

/**
 * Explicit, selected recovery. Concurrent clicks serialize and replan fresh.
 * @param {string} snapshotId
 * @param {string[]} pickKeys Saved window/tab occurrence keys from the review
 * @returns {Promise<SnapshotRecoveryReceipt>}
 */
export function recoverMissingSnapshotTabs(snapshotId, pickKeys) {
  snapshotRecoveryChain = snapshotRecoveryChain.then(
    () => recoverMissingSnapshotTabsNow(snapshotId, pickKeys),
    () => recoverMissingSnapshotTabsNow(snapshotId, pickKeys)
  );
  return snapshotRecoveryChain;
}

export const snapshotRecoveryLimits = Object.freeze({
  snapshots: MAX_SNAPSHOT_CHOICES,
  tabs: MAX_RECOVERY_TABS
});
