// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "./failure-diagnostic.js";
import { msg as localeMessage } from "./i18n.js";
/** Single-owner, restart-honest delivery for due Snoozes. */
import { STORE_KEYS } from "./types.js";
import { getDeviceId, getFreshItem, mutateStores } from "./store.js";
import { COUNTERS_KEY, bumpedCounters } from "./counters.js";
import { JOURNAL_KEY, appendedJournal, makeJournalEntry } from "./journal.js";
import { nextOccurrence } from "./snooze-schedule.js";
import {
  SNOOZE_PLACEMENT_KEY, openSnoozedTab, snoozePlacementMap, wakeUrl
} from "./snooze-placement.js";
import {
  isWindowSnooze, normalizedSnoozeSelections, sameSnoozeRecord,
  snoozeRefs, snoozeWithoutIndexes
} from "./snooze-record.js";

export const SNOOZE_DELIVERY_KEY = "snoozeDeliveryReceipts";
export const SNOOZE_ALARM_PREFIX = "snooze:";
const RECEIPT_CAP = 200;
const workerInstanceId = crypto.randomUUID();
const activeDeliveries = new Map();

function receiptMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sameOccurrence(receipt, snooze) {
  if (receipt?.snoozeId !== snooze?.id || receipt?.occurrenceDueAt !== snooze?.dueAt) {
    return false;
  }
  // A saved-record edit must not authorize replay of an uncertain occurrence.
  // Exact source equality is checked separately before claim and settlement.
  return true;
}

/**
 * Classify ownership for the same id + due occurrence.
 * @param {import("./types.js").SnoozeDeliveryReceipt|undefined} receipt
 * @param {import("./types.js").Snooze} snooze
 * @returns {""|"busy"|"uncertain"|"already-delivered"}
 */
export function snoozeDeliveryConflict(receipt, snooze) {
  if (!sameOccurrence(receipt, snooze)) return "";
  if (receipt.phase === "effects") return "busy";
  if (receipt.phase === "incomplete") return "uncertain";
  if (receipt.phase === "complete") return "already-delivered";
  return "";
}

function cappedReceipts(receipts) {
  const entries = Object.entries(receipts);
  if (entries.length <= RECEIPT_CAP) return receipts;
  const unsettled = entries.filter(([, receipt]) =>
    ["effects", "incomplete"].includes(receipt?.phase));
  const complete = entries
    .filter(([, receipt]) => receipt?.phase === "complete")
    .sort((a, b) => (b[1]?.completedAt ?? 0) - (a[1]?.completedAt ?? 0));
  // Never prune ownership/recovery evidence merely to satisfy a history cap.
  // Complete receipts are the only disposable entries.
  const historyRoom = Math.max(0, RECEIPT_CAP - unsettled.length);
  return Object.fromEntries([...unsettled, ...complete.slice(0, historyRoom)]);
}

async function claimDelivery(id, { manual = true, expected = null } = {}) {
  const reviewed = expected ? structuredClone(expected) : null;
  const deviceId = await getDeviceId();
  const candidate = reviewed ??
    await getFreshItem(STORE_KEYS.snoozes, id);
  if (!candidate || candidate.deletedAt) {
    return { status: "missing", snooze: null, claimId: null };
  }
  const claimId = crypto.randomUUID();
  const claimedAt = Date.now();
  let result = { status: "missing", snooze: null, claimId: null };
  await mutateStores(
    [STORE_KEYS.snoozes, SNOOZE_DELIVERY_KEY, SNOOZE_PLACEMENT_KEY],
    (maps) => {
    const snooze = maps[STORE_KEYS.snoozes]?.[id];
    if (!snooze || snooze.deletedAt) return null;
    if (!sameSnoozeRecord(snooze, candidate)) {
      result = { status: "stale", snooze: null, claimId: null };
      return null;
    }
    if (!manual && snooze.deviceId && snooze.deviceId !== deviceId) {
      result = { status: "other-device", snooze: null, claimId: null };
      return null;
    }
    if (!manual && Number(snooze.dueAt) > claimedAt) {
      result = { status: "not-due", snooze: null, claimId: null };
      return null;
    }

    const receipts = { ...receiptMap(maps[SNOOZE_DELIVERY_KEY]) };
    const existing = receipts[id];
    if (sameOccurrence(existing, snooze)) {
      if (existing.phase === "effects") {
        result = { status: "busy", snooze: null, claimId: null };
        return null;
      }
      if (existing.phase === "complete") {
        result = { status: "already-delivered", snooze: null, claimId: null };
        return null;
      }
      if (existing.phase === "incomplete") {
        result = { status: "interrupted", snooze: null, claimId: null };
        return null;
      }
    }

    receipts[id] = {
      snoozeId: id,
      claimId,
      ownerDeviceId: deviceId,
      ownerInstanceId: workerInstanceId,
      occurrenceDueAt: snooze.dueAt,
      sourceModifiedAt: snooze.modifiedAt,
      claimedAt,
      phase: "effects"
    };
    const placement = snoozePlacementMap(maps[SNOOZE_PLACEMENT_KEY])[id];
    result = {
      status: "claimed",
      snooze: structuredClone(snooze),
      placement: placement ? structuredClone(placement) : null,
      claimId
    };
    return { [SNOOZE_DELIVERY_KEY]: cappedReceipts(receipts) };
    }
  );
  return result;
}

async function performBrowserEffect(snooze, placement) {
  let opened = 0;
  try {
    const refs = snoozeRefs(snooze);
    const isWindow = isWindowSnooze(snooze);
    if (snooze.sessionId) {
      const session = await getFreshItem(STORE_KEYS.sessions, snooze.sessionId);
      const windows = session && !session.deletedAt && Array.isArray(session.windows)
        ? session.windows.filter(Array.isArray).map((refs) => refs
          .map((tab) => tab?.url).filter((url) => wakeUrl(url))).filter((urls) => urls.length)
        : [];
      if (windows.length === 0) return { ok: false, opened: 0, sourceUnavailable: true };
      for (const urls of windows) {
        const created = await chrome.windows.create({ url: urls });
        const confirmed = await confirmedCreatedWindowUrls(created, urls);
        opened += confirmed;
        if (confirmed !== urls.length) return { ok: false, opened, uncertain: true };
      }
    } else if (isWindow) {
      const urls = refs.map((tab) => tab.url).filter((url) => /^https?:/.test(url ?? ""));
      if (urls.length > 0) {
        const created = await chrome.windows.create({ url: urls });
        const confirmed = await confirmedCreatedWindowUrls(created, urls);
        opened += confirmed;
        if (confirmed !== urls.length) return { ok: false, opened, uncertain: true };
      }
    } else {
      return await openSnoozedTab(snooze, placement);
    }
    return { ok: true, opened };
  } catch {
    return { ok: false, opened, uncertain: true };
  }
}

async function finalizeDelivery(claim, effect) {
  const completedAt = Date.now();
  let result = { status: "unavailable", snooze: claim.snooze, nextDueAt: 0 };
  await mutateStores(
    [STORE_KEYS.snoozes, SNOOZE_DELIVERY_KEY, SNOOZE_PLACEMENT_KEY, COUNTERS_KEY],
    (maps) => {
      const receipts = { ...receiptMap(maps[SNOOZE_DELIVERY_KEY]) };
      const placements = { ...snoozePlacementMap(maps[SNOOZE_PLACEMENT_KEY]) };
      const hadPlacement = Boolean(placements[claim.snooze.id]);
      const receipt = receipts[claim.snooze.id];
      if (receipt?.claimId !== claim.claimId || receipt.phase !== "effects") return null;

      const snoozes = { ...(maps[STORE_KEYS.snoozes] ?? {}) };
      const current = snoozes[claim.snooze.id];
      let nextDueAt = 0;
      if (current && !current.deletedAt && sameSnoozeRecord(current, claim.snooze)) {
        if (current.recurrence) {
          nextDueAt = nextOccurrence(current.dueAt, current.recurrence, completedAt);
          snoozes[current.id] = {
            ...current,
            firedAt: completedAt,
            dueAt: nextDueAt,
            modifiedAt: completedAt
          };
          if (placements[current.id]) {
            placements[current.id] = {
              ...placements[current.id],
              occurrenceDueAt: nextDueAt
            };
          }
        } else {
          snoozes[current.id] = {
            ...current,
            firedAt: completedAt,
            deletedAt: completedAt,
            modifiedAt: completedAt
          };
          delete placements[current.id];
        }
      }
      if (!current || current.deletedAt || !sameSnoozeRecord(current, claim.snooze)) {
        receipts[claim.snooze.id] = {
          ...receipt,
          phase: "incomplete",
          completedAt,
          opened: effect.opened,
          reason: "source-changed"
        };
        result = { status: "interrupted", snooze: claim.snooze, nextDueAt: 0 };
        return { [SNOOZE_DELIVERY_KEY]: cappedReceipts(receipts) };
      }
      receipts[claim.snooze.id] = {
        ...receipt,
        phase: "complete",
        completedAt,
        opened: effect.opened
      };
      result = { status: "delivered", snooze: claim.snooze, nextDueAt };
      return {
        [STORE_KEYS.snoozes]: snoozes,
        [SNOOZE_DELIVERY_KEY]: cappedReceipts(receipts),
        ...(hadPlacement ? { [SNOOZE_PLACEMENT_KEY]: placements } : {}),
        [COUNTERS_KEY]: bumpedCounters(maps[COUNTERS_KEY], "snoozesFired")
      };
    }
  );
  return result;
}

async function failDelivery(claim, effect) {
  if (effect.sourceUnavailable) {
    // Nothing reached Chrome. Release only this claim, leaving the schedule
    // available for a deliberate retry after the linked Session is repaired.
    await mutateStores([SNOOZE_DELIVERY_KEY], (maps) => {
      const receipts = { ...receiptMap(maps[SNOOZE_DELIVERY_KEY]) };
      const receipt = receipts[claim.snooze.id];
      if (receipt?.claimId !== claim.claimId || receipt.phase !== "effects") return null;
      delete receipts[claim.snooze.id];
      return { [SNOOZE_DELIVERY_KEY]: receipts };
    });
    return { status: "unavailable", reason: "session-unavailable", snooze: claim.snooze, nextDueAt: 0 };
  }
  let status = "interrupted";
  await mutateStores([SNOOZE_DELIVERY_KEY], (maps) => {
    const receipts = { ...receiptMap(maps[SNOOZE_DELIVERY_KEY]) };
    const receipt = receipts[claim.snooze.id];
    if (receipt?.claimId !== claim.claimId || receipt.phase !== "effects") {
      status = "unavailable";
      return null;
    }
    receipts[claim.snooze.id] = {
      ...receipt,
      phase: "incomplete",
      completedAt: Date.now(),
      opened: effect.opened,
      reason: effect.opened > 0 ? "partial-browser-effect" : "ambiguous-browser-effect"
    };
    return { [SNOOZE_DELIVERY_KEY]: cappedReceipts(receipts) };
  });
  return { status, snooze: claim.snooze, nextDueAt: 0 };
}

async function claimWakeSelections(rawSelections) {
  const selections = normalizedSnoozeSelections(structuredClone(rawSelections));
  if (!selections?.length) return { status: "invalid", claims: [] };
  const prepared = selections;
  const deviceId = await getDeviceId();
  const claimId = crypto.randomUUID();
  const claimedAt = Date.now();
  let result = { status: "invalid", claims: [] };
  await mutateStores([STORE_KEYS.snoozes, SNOOZE_DELIVERY_KEY], (maps) => {
    const snoozes = maps[STORE_KEYS.snoozes] ?? {};
    const receipts = { ...receiptMap(maps[SNOOZE_DELIVERY_KEY]) };
    for (const selection of prepared) {
      const current = snoozes[selection.snooze.id];
      if (!current || current.deletedAt) {
        result = { status: "missing", claims: [] };
        return null;
      }
      if (!sameSnoozeRecord(current, selection.snooze)) {
        result = { status: "stale", claims: [] };
        return null;
      }
      const refs = snoozeRefs(current);
      if (selection.indexes.some((index) => !refs[index] ||
          !/^https?:/.test(refs[index].url ?? ""))) {
        result = { status: "invalid", claims: [] };
        return null;
      }
      const conflict = snoozeDeliveryConflict(receipts[current.id], current);
      if (conflict) {
        result = { status: conflict, claims: [] };
        return null;
      }
    }
    const claims = prepared.map((selection) => {
      const current = snoozes[selection.snooze.id];
      receipts[current.id] = {
        snoozeId: current.id,
        claimId,
        ownerDeviceId: deviceId,
        ownerInstanceId: workerInstanceId,
        occurrenceDueAt: current.dueAt,
        sourceModifiedAt: current.modifiedAt,
        selectionIndexes: [...selection.indexes],
        claimedAt,
        phase: "effects"
      };
      return {
        snooze: structuredClone(current),
        indexes: [...selection.indexes],
        claimId
      };
    });
    result = { status: "claimed", claims };
    return { [SNOOZE_DELIVERY_KEY]: cappedReceipts(receipts) };
  });
  return result;
}

function confirmedWindowIndexes(indexes, refs, tabs, windowId) {
  const actual = new Map();
  const seenIds = new Set();
  for (const tab of tabs ?? []) {
    if (!Number.isInteger(tab?.id) || tab.id < 0 || seenIds.has(tab.id) ||
        tab.windowId !== windowId) continue;
    seenIds.add(tab.id);
    const url = wakeUrl(tab.pendingUrl || tab.url);
    if (url) actual.set(url, (actual.get(url) ?? 0) + 1);
  }
  const expected = new Map();
  for (const index of indexes) {
    const url = wakeUrl(refs[index].url);
    const group = expected.get(url) ?? [];
    group.push(index);
    expected.set(url, group);
  }
  const confirmed = [];
  for (const [url, occurrences] of expected) {
    const count = actual.get(url) ?? 0;
    if (occurrences.length === 1 && count >= 1) confirmed.push(occurrences[0]);
    else if (count >= occurrences.length) confirmed.push(...occurrences);
  }
  return confirmed.sort((a, b) => a - b);
}

async function confirmedCreatedWindowUrls(created, urls) {
  if (!Number.isInteger(created?.id) || created.id < 0) return 0;
  let tabs = created.tabs;
  if (typeof chrome.tabs.query === "function") {
    try { tabs = await chrome.tabs.query({ windowId: created.id }); }
    catch { return 0; }
  }
  const refs = urls.map((url) => ({ url }));
  return confirmedWindowIndexes(urls.map((_, index) => index), refs, tabs, created.id).length;
}

async function performWakeSelectionEffects(claims) {
  const outcomes = [];
  for (const claim of claims) {
    const refs = snoozeRefs(claim.snooze);
    const urls = claim.indexes.map((index) => refs[index].url);
    try {
      if (urls.length > 1) {
        const created = await chrome.windows.create({ url: urls });
        let tabs = created?.tabs;
        if (Number.isInteger(created?.id) && typeof chrome.windows.get === "function") {
          try { tabs = (await chrome.windows.get(created.id, { populate: true }))?.tabs ?? tabs; }
          catch { /* the fulfilled create result remains the only confirmation */ }
        }
        const confirmed = Number.isInteger(created?.id) && created.id >= 0
          ? confirmedWindowIndexes(claim.indexes, refs, tabs, created.id) : [];
        outcomes.push({ claim, confirmed, uncertain: confirmed.length < claim.indexes.length });
      } else {
        const index = claim.indexes[0];
        const created = await chrome.tabs.create({ url: refs[index].url, active: false });
        const confirmed = Number.isInteger(created?.id) && created.id >= 0 &&
          wakeUrl(created?.pendingUrl || created?.url) === wakeUrl(refs[index].url) ? [index] : [];
        outcomes.push({ claim, confirmed, uncertain: confirmed.length === 0 });
      }
    } catch {
      outcomes.push({ claim, confirmed: [], uncertain: true });
    }
  }
  return outcomes;
}

async function settleWakeSelections(outcomes) {
  const settledAt = Date.now();
  const prepared = outcomes.map((outcome) => {
    const split = outcome.confirmed.length > 0
      ? snoozeWithoutIndexes(outcome.claim.snooze, outcome.confirmed, settledAt)
      : { snooze: outcome.claim.snooze, emptied: false };
    return { ...outcome, split };
  });
  const emptied = [];
  let opened = 0;
  let consumed = 0;
  let incomplete = false;
  await mutateStores(
    [STORE_KEYS.snoozes, SNOOZE_DELIVERY_KEY, COUNTERS_KEY, JOURNAL_KEY],
    (maps) => {
      const snoozes = { ...(maps[STORE_KEYS.snoozes] ?? {}) };
      const receipts = { ...receiptMap(maps[SNOOZE_DELIVERY_KEY]) };
      const puts = [];
      for (const outcome of prepared) {
        const { claim } = outcome;
        const receipt = receipts[claim.snooze.id];
        if (receipt?.claimId !== claim.claimId || receipt.phase !== "effects") {
          opened += outcome.confirmed.length;
          incomplete = true;
          continue;
        }
        const current = snoozes[claim.snooze.id];
        if (!current || current.deletedAt || !sameSnoozeRecord(current, claim.snooze)) {
          receipts[claim.snooze.id] = {
            ...receipt, phase: "incomplete", completedAt: settledAt,
            opened: outcome.confirmed.length, reason: "source-changed"
          };
          opened += outcome.confirmed.length;
          incomplete = true;
          continue;
        }
        const confirmed = outcome.confirmed;
        if (confirmed.length > 0) {
          puts.push({ store: STORE_KEYS.snoozes, item: structuredClone(current) });
          snoozes[current.id] = outcome.split.snooze;
          opened += confirmed.length;
          consumed += confirmed.length;
          if (outcome.split.emptied) emptied.push(current.id);
        }
        const complete = confirmed.length === claim.indexes.length && !outcome.uncertain;
        if (complete) delete receipts[current.id];
        else receipts[current.id] = {
          ...receipt,
          phase: "incomplete",
          completedAt: settledAt,
          opened: confirmed.length,
          reason: "ambiguous-browser-effect"
        };
        if (!complete) incomplete = true;
      }
      const entry = makeJournalEntry(
        `Woke ${consumed} snoozed tab${consumed === 1 ? "" : "s"}`, { puts });
      return {
        [STORE_KEYS.snoozes]: snoozes,
        [SNOOZE_DELIVERY_KEY]: cappedReceipts(receipts),
        ...(consumed > 0 ? {
          [COUNTERS_KEY]: bumpedCounters(maps[COUNTERS_KEY], "snoozesFired"),
          [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
        } : {})
      };
    }
  );
  for (const id of emptied) {
    try { await chrome.alarms.clear(SNOOZE_ALARM_PREFIX + id); }
    catch { /* startup removes an orphan alarm after the durable tombstone */ }
  }
  return { status: incomplete ? "interrupted" : "delivered", opened };
}

/**
 * Claim and wake exact tab occurrences through the persisted Snooze delivery
 * owner. The result counts only browser-confirmed occurrences.
 * @param {{snooze:import("./types.js").Snooze,indexes:number[]}[]} selections
 * @returns {Promise<{status:string,opened:number}>}
 */
export async function wakeSnoozeSelections(selections) {
  const claim = await claimWakeSelections(selections);
  if (claim.status !== "claimed") return { status: claim.status, opened: 0 };
  const outcomes = await performWakeSelectionEffects(claim.claims);
  try {
    return await settleWakeSelections(outcomes);
  } catch (error) {
    error.opened = outcomes.reduce((count, outcome) => count + outcome.confirmed.length, 0);
    error.reason = "uncertain";
    throw error;
  }
}

async function showDeliveredFeedback(snooze) {
  const isWindow = isWindowSnooze(snooze);
  try {
    await chrome.action.setBadgeText({ text: "↑" });
    await chrome.action.setBadgeBackgroundColor({ color: "#4a4aaa" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 6000);
  } catch { /* badge support is optional */ }
  try {
    await chrome.notifications.create(`snooze-fired-${snooze.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: snooze.sessionId ? localeMessage("notification_snooze_woke_session_title")
        : isWindow ? localeMessage("notification_snooze_woke_window_title")
          : localeMessage("notification_snooze_woke_tab_title"),
      message: snooze.title || snooze.url
    });
  } catch (error) {
    reportFailure("snooze-notification", error);
  }
}

async function deliverOnce(id, options) {
  const claim = await claimDelivery(id, options);
  if (claim.status !== "claimed") return { status: claim.status };
  const effect = await performBrowserEffect(claim.snooze, claim.placement);
  if (!effect.ok) return failDelivery(claim, effect);
  const result = await finalizeDelivery(claim, effect);
  if (result.status !== "delivered") return result;
  if (result.nextDueAt > 0) {
    try {
      await chrome.alarms.create(SNOOZE_ALARM_PREFIX + id, { when: result.nextDueAt });
    } catch {
      // The recurring due time is already durable; startup reasserts the alarm.
    }
  }
  await showDeliveredFeedback(claim.snooze);
  return result;
}

/**
 * Deliver one Snooze. The in-memory owner coalesces same-worker calls; the
 * persisted claim arbitrates every extension context and survives worker stop.
 * `manual:false` enforces due time and originating-device ownership.
 * @param {string} id
 * @param {{manual?:boolean,expected?:import("./types.js").Snooze|null}} [options]
 * @returns {Promise<{status:string,reason?:"session-unavailable",snooze?:import("./types.js").Snooze,nextDueAt?:number}>}
 */
export function fireSnooze(id, options = {}) {
  const active = activeDeliveries.get(id);
  // Expected-bearing UI requests must arbitrate their own exact snapshot at
  // the persisted claim. Joining an id-only task could report another
  // occurrence's success; replacing it in this map could lose its owner.
  if (options.expected) return deliverOnce(id, options);
  if (active) return active;
  const task = deliverOnce(id, options).finally(() => {
    if (activeDeliveries.get(id) === task) activeDeliveries.delete(id);
  });
  activeDeliveries.set(id, task);
  return task;
}

/**
 * A claim left in the browser-effect phase by an older worker is never replayed.
 * The Snooze remains visible until the user reschedules or cancels it.
 * @returns {Promise<number>} recovered receipt count
 */
export async function recoverInterruptedSnoozeDeliveries() {
  let recovered = 0;
  await mutateStores([SNOOZE_DELIVERY_KEY], (maps) => {
    const receipts = { ...receiptMap(maps[SNOOZE_DELIVERY_KEY]) };
    for (const [id, receipt] of Object.entries(receipts)) {
      if (receipt?.phase !== "effects" || receipt.ownerInstanceId === workerInstanceId) continue;
      receipts[id] = {
        ...receipt,
        phase: "incomplete",
        completedAt: Date.now(),
        reason: "worker-stopped"
      };
      recovered += 1;
    }
    return recovered > 0 ? { [SNOOZE_DELIVERY_KEY]: cappedReceipts(receipts) } : null;
  });
  return recovered;
}
