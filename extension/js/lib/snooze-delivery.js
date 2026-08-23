/** Single-owner, restart-honest delivery for due Snoozes. */
import { STORE_KEYS } from "./types.js";
import { getDeviceId, getFreshItem, mutateStores } from "./store.js";
import { COUNTERS_KEY, bumpedCounters } from "./counters.js";
import { nextOccurrence } from "./snooze-schedule.js";

export const SNOOZE_DELIVERY_KEY = "snoozeDeliveryReceipts";
export const SNOOZE_ALARM_PREFIX = "snooze:";
const RECEIPT_CAP = 200;
const workerInstanceId = crypto.randomUUID();
const activeDeliveries = new Map();

function receiptMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sameOccurrence(receipt, snooze) {
  return receipt?.snoozeId === snooze?.id &&
    receipt?.occurrenceDueAt === snooze?.dueAt;
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

async function claimDelivery(id, { manual = true } = {}) {
  const deviceId = await getDeviceId();
  const claimId = crypto.randomUUID();
  const claimedAt = Date.now();
  let result = { status: "missing", snooze: null, claimId: null };
  await mutateStores([STORE_KEYS.snoozes, SNOOZE_DELIVERY_KEY], (maps) => {
    const snooze = maps[STORE_KEYS.snoozes]?.[id];
    if (!snooze || snooze.deletedAt) return null;
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
      if (existing.phase === "incomplete" && !manual) {
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
    result = { status: "claimed", snooze: structuredClone(snooze), claimId };
    return { [SNOOZE_DELIVERY_KEY]: cappedReceipts(receipts) };
  });
  return result;
}

async function performBrowserEffect(snooze) {
  let opened = 0;
  try {
    const isWindow = Array.isArray(snooze.tabs) && snooze.tabs.length > 0;
    if (snooze.sessionId) {
      const session = await getFreshItem(STORE_KEYS.sessions, snooze.sessionId);
      if (session && !session.deletedAt) {
        for (const refs of session.windows ?? []) {
          const urls = refs.map((tab) => tab.url).filter((url) => /^https?:/.test(url ?? ""));
          if (urls.length === 0) continue;
          await chrome.windows.create({ url: urls });
          opened += urls.length;
        }
      }
    } else if (isWindow) {
      const urls = snooze.tabs.map((tab) => tab.url).filter((url) => /^https?:/.test(url ?? ""));
      if (urls.length > 0) {
        await chrome.windows.create({ url: urls });
        opened += urls.length;
      }
    } else {
      await chrome.tabs.create({ url: snooze.url, active: false });
      opened = 1;
    }
    return { ok: true, opened };
  } catch {
    return { ok: false, opened };
  }
}

async function finalizeDelivery(claim, effect) {
  const completedAt = Date.now();
  let result = { status: "unavailable", snooze: claim.snooze, nextDueAt: 0 };
  await mutateStores(
    [STORE_KEYS.snoozes, SNOOZE_DELIVERY_KEY, COUNTERS_KEY],
    (maps) => {
      const receipts = { ...receiptMap(maps[SNOOZE_DELIVERY_KEY]) };
      const receipt = receipts[claim.snooze.id];
      if (receipt?.claimId !== claim.claimId || receipt.phase !== "effects") return null;

      const snoozes = { ...(maps[STORE_KEYS.snoozes] ?? {}) };
      const current = snoozes[claim.snooze.id];
      let nextDueAt = 0;
      if (current && !current.deletedAt && current.dueAt === receipt.occurrenceDueAt) {
        if (current.recurrence) {
          nextDueAt = nextOccurrence(current.dueAt, current.recurrence, completedAt);
          snoozes[current.id] = {
            ...current,
            firedAt: completedAt,
            dueAt: nextDueAt,
            modifiedAt: completedAt
          };
        } else {
          snoozes[current.id] = {
            ...current,
            firedAt: completedAt,
            deletedAt: completedAt,
            modifiedAt: completedAt
          };
        }
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
        [COUNTERS_KEY]: bumpedCounters(maps[COUNTERS_KEY], "snoozesFired")
      };
    }
  );
  return result;
}

async function failDelivery(claim, effect) {
  let status = effect.opened > 0 ? "interrupted" : "failed";
  await mutateStores([SNOOZE_DELIVERY_KEY], (maps) => {
    const receipts = { ...receiptMap(maps[SNOOZE_DELIVERY_KEY]) };
    const receipt = receipts[claim.snooze.id];
    if (receipt?.claimId !== claim.claimId || receipt.phase !== "effects") {
      status = "unavailable";
      return null;
    }
    if (effect.opened > 0) {
      receipts[claim.snooze.id] = {
        ...receipt,
        phase: "incomplete",
        completedAt: Date.now(),
        opened: effect.opened,
        reason: "partial-browser-effect"
      };
    } else {
      delete receipts[claim.snooze.id];
    }
    return { [SNOOZE_DELIVERY_KEY]: cappedReceipts(receipts) };
  });
  if (status === "failed") {
    try {
      await chrome.alarms.create(SNOOZE_ALARM_PREFIX + claim.snooze.id, {
        when: Date.now() + 60_000
      });
    } catch {
      // The overdue startup sweep is the durable fallback if Alarm repair fails.
    }
  }
  return { status, snooze: claim.snooze, nextDueAt: 0 };
}

async function showDeliveredFeedback(snooze) {
  const isWindow = Array.isArray(snooze.tabs) && snooze.tabs.length > 0;
  try {
    await chrome.action.setBadgeText({ text: "↑" });
    await chrome.action.setBadgeBackgroundColor({ color: "#4a4aaa" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 6000);
  } catch { /* badge support is optional */ }
  try {
    await chrome.notifications.create(`snooze-fired-${snooze.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: snooze.sessionId ? "Session woke up" : isWindow ? "Window woke up" : "Tab woke up",
      message: snooze.title || snooze.url
    });
  } catch (error) {
    console.warn("[EveryTab] snooze notification failed:", error?.message ?? error);
  }
}

async function deliverOnce(id, options) {
  const claim = await claimDelivery(id, options);
  if (claim.status !== "claimed") return { status: claim.status };
  const effect = await performBrowserEffect(claim.snooze);
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
 * @param {{manual?:boolean}} [options]
 */
export function fireSnooze(id, options = {}) {
  const active = activeDeliveries.get(id);
  if (active) return active;
  const task = deliverOnce(id, options).finally(() => {
    if (activeDeliveries.get(id) === task) activeDeliveries.delete(id);
  });
  activeDeliveries.set(id, task);
  return task;
}

/**
 * A claim left in the browser-effect phase by an older worker is never replayed
 * automatically. The Snooze remains visible and an explicit Wake can retry it.
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
