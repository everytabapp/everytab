// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { STORE_KEYS } from "./types.js";
import {
  getDeviceId, mutateStores, newMeta, readStoreMap, readStoreValue
} from "./store.js";
import { canonicalRef, isSaveableTab } from "./tabs.js";
import { getSessionBindings } from "./sessions.js";
import { COUNTERS_KEY, bumpedCounters } from "./counters.js";
import { LABEL_META_KEY, touchedLabelMeta } from "./label-meta.js";
import {
  JOURNAL_KEY, appendedJournal, makeJournalEntry
} from "./journal.js";
import {
  CLOSE_DAY_ACTIONS,
  applyCloseDayChoice,
  applyCloseDayChoices,
  applyCloseDayWindowMode,
  buildCloseDayPlan,
  closeDayFingerprint,
  closeDayFingerprintMatches,
  closeDayMapRevision,
  mergeAddedSessionRefs,
  serializeCloseDayChoices,
  summarizeCloseDayPlan
} from "./close-day-planner.js";
import { applyOrganizationMemberPlan } from "./organization.js";
import { buildSnooze, SNOOZE_ALARM_PREFIX } from "./snooze.js";

export const CLOSE_DAY_DRAFT_KEY = "closeDayDraft";
export const CLOSE_DAY_RECEIPTS_KEY = "closeDayReceipts";
const RECEIPT_CAP = 30;

const clone = (value) => structuredClone(value);
const clean = (value) => String(value ?? "").trim();
const liveRecords = (map) => Object.values(map ?? {}).filter((record) => record && !record.deletedAt);

function cappedReceipts(map) {
  const entries = Object.entries(map ?? {});
  if (entries.length <= RECEIPT_CAP) return map ?? {};
  const pending = entries.filter(([, receipt]) => !["complete", "undone", "undo-incomplete"].includes(receipt?.phase));
  const settled = entries.filter(([, receipt]) => ["complete", "undone", "undo-incomplete"].includes(receipt?.phase))
    .sort((a, b) => Number(b[1]?.updatedAt ?? 0) - Number(a[1]?.updatedAt ?? 0));
  return Object.fromEntries([...pending, ...settled.slice(0, Math.max(0, RECEIPT_CAP - pending.length))]);
}

function rawUrlOf(tab) {
  return String(tab?.pendingUrl || tab?.url || "");
}

function browserTabInput(tab) {
  const ref = isSaveableTab(tab) ? canonicalRef(tab) : null;
  return {
    id: Number(tab.id), windowId: Number(tab.windowId), index: Number(tab.index),
    active: tab.active === true, pinned: tab.pinned === true, audible: tab.audible === true,
    incognito: tab.incognito === true, groupId: Number.isInteger(tab.groupId) ? tab.groupId : -1,
    rawUrl: rawUrlOf(tab), committedUrl: String(tab?.url ?? ""),
    pendingUrl: String(tab?.pendingUrl ?? ""),
    title: tab.title || ref?.title || rawUrlOf(tab) || "Untitled",
    favIconUrl: tab.favIconUrl || ref?.favIconUrl || "", ref
  };
}

async function readCloseDayInputs({ protectedTabId = null } = {}) {
  const [browserWindows, sessions, inbox, archive, bindings] = await Promise.all([
    chrome.windows.getAll({ populate: true }),
    readStoreMap(STORE_KEYS.sessions),
    readStoreMap(STORE_KEYS.inbox),
    readStoreMap(STORE_KEYS.archive),
    getSessionBindings()
  ]);
  const windows = [];
  let excludedWindowCount = 0;
  for (const win of browserWindows ?? []) {
    if (win?.type !== "normal" || win?.incognito) {
      excludedWindowCount += 1;
      continue;
    }
    windows.push({
      id: Number(win.id), type: win.type, incognito: false,
      tabs: (win.tabs ?? []).filter((tab) => !tab.incognito).map(browserTabInput)
    });
  }
  return {
    windows, sessions, inbox, archive, bindings,
    extensionOrigin: chrome.runtime.getURL(""), protectedTabId,
    excludedWindowCount
  };
}

async function currentDraft() {
  return await readStoreValue(CLOSE_DAY_DRAFT_KEY) ?? null;
}

/** Capture/revalidate a review. This writes only one device-local operational draft. */
export async function captureCloseDayReview({ protectedTabId = null, refresh = false } = {}) {
  const prior = refresh ? null : await currentDraft();
  const inputs = await readCloseDayInputs({ protectedTabId });
  const priorPlan = prior?.plan ?? null;
  const plan = buildCloseDayPlan(inputs, priorPlan);
  const draft = {
    id: refresh || !prior?.id ? crypto.randomUUID() : prior.id,
    createdAt: refresh || !prior?.createdAt ? Date.now() : prior.createdAt,
    updatedAt: Date.now(), protectedTabId, plan
  };
  await mutateStores([CLOSE_DAY_DRAFT_KEY], () => ({ [CLOSE_DAY_DRAFT_KEY]: draft }));
  return { ok: true, draftId: draft.id, plan };
}

/** Persist one choice without touching browser tabs or portable saved data. */
export async function updateCloseDayChoice(draftId, fingerprintKey, patch) {
  let result = { ok: false, reason: "missing" };
  await mutateStores([CLOSE_DAY_DRAFT_KEY], (maps) => {
    const draft = maps[CLOSE_DAY_DRAFT_KEY];
    if (!draft?.plan || draft.id !== draftId) return null;
    const plan = clone(draft.plan);
    if (!applyCloseDayChoice(plan, fingerprintKey, patch)) {
      result = { ok: false, reason: "invalid" };
      return null;
    }
    result = { ok: true, plan };
    return { [CLOSE_DAY_DRAFT_KEY]: { ...draft, updatedAt: Date.now(), plan } };
  });
  return result;
}

/** Persist one validated choice for a selected set in one draft write. */
export async function updateCloseDayChoices(draftId, fingerprintKeys, patch) {
  let result = { ok: false, reason: "missing" };
  await mutateStores([CLOSE_DAY_DRAFT_KEY], (maps) => {
    const draft = maps[CLOSE_DAY_DRAFT_KEY];
    if (!draft?.plan || draft.id !== draftId) return null;
    const plan = clone(draft.plan);
    if (!applyCloseDayChoices(plan, fingerprintKeys, patch)) {
      result = { ok: false, reason: "invalid" };
      return null;
    }
    result = { ok: true, plan };
    return { [CLOSE_DAY_DRAFT_KEY]: { ...draft, updatedAt: Date.now(), plan } };
  });
  return result;
}

/** Persist the explicit P4 arrangement choice for one restored Session window. */
export async function updateCloseDayWindowMode(draftId, windowId, mode) {
  let result = { ok: false, reason: "missing" };
  await mutateStores([CLOSE_DAY_DRAFT_KEY], (maps) => {
    const draft = maps[CLOSE_DAY_DRAFT_KEY];
    if (!draft?.plan || draft.id !== draftId) return null;
    const plan = clone(draft.plan);
    if (!applyCloseDayWindowMode(plan, windowId, mode)) {
      result = { ok: false, reason: "invalid" };
      return null;
    }
    result = { ok: true, plan };
    return { [CLOSE_DAY_DRAFT_KEY]: { ...draft, updatedAt: Date.now(), plan } };
  });
  return result;
}

export async function discardCloseDayDraft(draftId) {
  let discarded = false;
  await mutateStores([CLOSE_DAY_DRAFT_KEY], (maps) => {
    if (!maps[CLOSE_DAY_DRAFT_KEY] || (draftId && maps[CLOSE_DAY_DRAFT_KEY].id !== draftId)) return null;
    discarded = true;
    return { [CLOSE_DAY_DRAFT_KEY]: null };
  });
  return discarded;
}

/**
 * Read-only freshness check for event-heavy Dashboard contexts. Chrome emits
 * focus, activation, title, and completion signals that do not necessarily
 * change the captured review. Only the exact browser/store fingerprints may
 * stale it.
 */
export async function checkCloseDayReview(draftId) {
  const draft = await currentDraft();
  if (!draft?.plan || draft.id !== draftId) {
    return { ok: false, fresh: false, browserChanged: false, savedChanged: false };
  }
  const inputs = await readCloseDayInputs({ protectedTabId: draft.plan.protectedTabId });
  const browserChanged = !browserPlanMatches(draft.plan, inputs);
  const savedChanged = !storePlanMatches(draft.plan, {
    [STORE_KEYS.sessions]: inputs.sessions,
    [STORE_KEYS.inbox]: inputs.inbox,
    [STORE_KEYS.archive]: inputs.archive
  });
  return { ok: true, fresh: !browserChanged && !savedChanged, browserChanged, savedChanged };
}

function browserPlanMatches(plan, inputs) {
  const plannedWindows = new Map((plan.groups ?? []).map((group) => [group.windowId, group]));
  const freshWindows = new Map((inputs.windows ?? []).map((win) => [win.id, win]));
  if (plannedWindows.size !== freshWindows.size) return false;
  for (const [windowId, group] of plannedWindows) {
    const fresh = freshWindows.get(windowId);
    if (!fresh || fresh.tabs.length !== group.rows.length) return false;
    const byId = new Map(fresh.tabs.map((tab) => [tab.id, tab]));
    for (const row of group.rows) {
      const tab = byId.get(row.tabId);
      if (!tab || !closeDayFingerprintMatches(row.fingerprint, closeDayFingerprint(tab))) return false;
    }
  }
  return true;
}

function storePlanMatches(plan, maps) {
  return plan.storeRevisions?.sessions === closeDayMapRevision(maps[STORE_KEYS.sessions]) &&
    plan.storeRevisions?.inbox === closeDayMapRevision(maps[STORE_KEYS.inbox]) &&
    plan.storeRevisions?.archive === closeDayMapRevision(maps[STORE_KEYS.archive]);
}

function rowsForAction(plan, action) {
  return (plan.groups ?? []).flatMap((group) => group.rows ?? [])
    .filter((row) => row.choice?.action === action);
}

function groupedBy(rows, keyOf) {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

async function preparedRecords(plan) {
  const inbox = [];
  for (const [windowId, rows] of groupedBy(rowsForAction(plan, CLOSE_DAY_ACTIONS.inbox),
    (row) => row.windowId)) {
    const refs = rows.sort((a, b) => a.index - b.index).map((row) => row.ref).filter(Boolean);
    if (!refs.length) continue;
    const group = plan.groups.find((candidate) => candidate.windowId === Number(windowId));
    inbox.push({
      ...(await newMeta()), kind: refs.length > 1 ? "window" : "tab", refs,
      source: "manual", labels: [], windowTitle: group?.title || undefined
    });
  }

  const archive = [];
  for (const row of rowsForAction(plan, CLOSE_DAY_ACTIONS.archiveLabel)) {
    const labels = [...new Set((Array.isArray(row.choice?.labels)
      ? row.choice.labels : [row.choice?.label]).map(clean).filter(Boolean))];
    if (!row.ref || !labels.length) continue;
    archive.push({
      ...(await newMeta()), kind: "tab", refs: [row.ref], source: "manual",
      labels, archivedAt: Date.now()
    });
  }

  const newSessions = [];
  const newRows = groupedBy(rowsForAction(plan, CLOSE_DAY_ACTIONS.newSession),
    (row) => clean(row.choice?.newSessionName).toLocaleLowerCase());
  for (const rows of newRows.values()) {
    const name = clean(rows[0]?.choice?.newSessionName);
    if (!name) continue;
    const windows = [...groupedBy(rows, (row) => row.windowId).values()]
      .map((windowRows) => windowRows.sort((a, b) => a.index - b.index)
        .map((row) => row.ref).filter(Boolean))
      .filter((refs) => refs.length);
    if (!windows.length) continue;
    newSessions.push({ ...(await newMeta()), name, auto: false, windows, labels: [] });
  }

  const snoozes = [];
  const snoozeRows = groupedBy(rowsForAction(plan, CLOSE_DAY_ACTIONS.snooze), (row) =>
    JSON.stringify([row.windowId, Number(row.choice?.dueAt), clean(row.choice?.recurrence)]));
  for (const rows of snoozeRows.values()) {
    const dueAt = Number(rows[0]?.choice?.dueAt);
    const recurrence = clean(rows[0]?.choice?.recurrence);
    const refs = rows.sort((a, b) => a.index - b.index).map((row) => row.ref).filter(Boolean);
    if (!Number.isFinite(dueAt) || dueAt <= Date.now() || !refs.length) continue;
    snoozes.push(buildSnooze(await newMeta(), refs.length > 1
      ? { title: `Window (${refs.length} tabs)`, dueAt, tabs: refs,
          ...(recurrence ? { recurrence } : {}) }
      : { url: refs[0].url, title: refs[0].title || refs[0].url, dueAt,
          ...(refs[0].favIconUrl ? { favIconUrl: refs[0].favIconUrl } : {}),
          ...(recurrence ? { recurrence } : {}) }));
  }
  return { inbox, archive, newSessions, snoozes };
}

function preparedOrganizationPlans(plan, prepared) {
  const newSessionIds = new Map(prepared.newSessions.map((session) => [
    clean(session.name).toLocaleLowerCase(), session.id
  ]));
  const entries = [];
  const seen = new Set();
  for (const row of (plan.groups ?? []).flatMap((group) => group.rows ?? [])) {
    const raw = row.choice?.organizationPlan;
    if (!raw) continue;
    let kind = null;
    let organizationPlan = clone(raw);
    if (row.choice.action === CLOSE_DAY_ACTIONS.archiveLabel) {
      kind = "label";
    } else if (row.choice.action === CLOSE_DAY_ACTIONS.session) {
      kind = "session";
    } else if (row.choice.action === CLOSE_DAY_ACTIONS.newSession) {
      kind = "session";
      const name = clean(row.choice.newSessionName);
      const sessionId = newSessionIds.get(name.toLocaleLowerCase());
      if (!sessionId) continue;
      const temporaryKey = `new:${name}`;
      if (organizationPlan.mode === "add") {
        organizationPlan.memberKeys = organizationPlan.memberKeys
          .map((key) => key === temporaryKey ? sessionId : key);
      } else {
        organizationPlan.members = organizationPlan.members.map((member) => ({
          ...member, memberKey: member.memberKey === temporaryKey ? sessionId : member.memberKey
        }));
      }
    }
    if (!kind) continue;
    const key = JSON.stringify([kind, organizationPlan]);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind, plan: organizationPlan, status: "pending" });
  }
  return entries;
}

function sessionMapAfter(plan, original, prepared, now) {
  const map = { ...(original ?? {}) };
  const beforeById = new Map();
  const remember = (session) => {
    if (!beforeById.has(session.id)) beforeById.set(session.id, session);
  };

  for (const group of plan.groups ?? []) {
    if (!group.session) continue;
    const current = map[group.session.id];
    if (!current || current.deletedAt || current.auto) throw new Error("stale-session");
    if (Number(current.modifiedAt ?? 0) !== Number(group.session.modifiedAt ?? 0)) throw new Error("stale-session");
    if (group.session.mode === "replace") {
      remember(current);
      const refs = group.rows.map((row) => row.ref).filter(Boolean);
      const windows = current.windows.map((windowRefs, index) =>
        index === group.session.windowIndex ? refs : windowRefs);
      map[current.id] = { ...current, windows, modifiedAt: now };
      continue;
    }
    const added = group.rows.some((row) => row.choice?.action === CLOSE_DAY_ACTIONS.addSession);
    if (!added) continue;
    remember(current);
    const windows = current.windows.map((windowRefs, index) => index === group.session.windowIndex
      ? mergeAddedSessionRefs(windowRefs, group.rows)
      : windowRefs);
    map[current.id] = { ...current, windows, modifiedAt: now };
  }

  const targetRows = groupedBy(rowsForAction(plan, CLOSE_DAY_ACTIONS.session),
    (row) => row.choice?.targetSessionId);
  for (const [sessionId, rows] of targetRows) {
    const current = map[sessionId];
    if (!current || current.deletedAt || current.auto) throw new Error("stale-session");
    remember(current);
    const additions = [...groupedBy(rows, (row) => row.windowId).values()]
      .map((windowRows) => windowRows.sort((a, b) => a.index - b.index)
        .map((row) => row.ref).filter(Boolean))
      .filter((refs) => refs.length);
    map[sessionId] = { ...current, windows: [...current.windows, ...additions], modifiedAt: now };
  }

  for (const session of prepared.newSessions) map[session.id] = { ...session, modifiedAt: now };
  return { map, beforeById };
}

function recordChanges(beforeMap, afterMap, ids, store) {
  return [...ids].map((id) => ({
    store, id, before: beforeMap?.[id] ?? null, after: afterMap?.[id] ?? null
  }));
}

function closeTargets(plan) {
  return (plan.groups ?? []).map((group) => ({
    windowId: group.windowId, title: group.title,
    tabs: (group.rows ?? []).filter((row) => !row.locked && row.choice?.action !== CLOSE_DAY_ACTIONS.stay)
      .map((row) => ({
        tabId: row.tabId, fingerprint: row.fingerprint, ref: row.ref,
        pinned: row.pinned, status: "planned", action: row.choice.action
      }))
  })).filter((window) => window.tabs.length);
}

/** One local atomic keep commit, followed by recoverable live closes. */
export async function commitCloseDay(draftId) {
  const draft = await currentDraft();
  if (!draft?.plan || draft.id !== draftId) return { ok: false, status: "missing" };
  const plan = clone(draft.plan);
  plan.summary = summarizeCloseDayPlan(plan);
  if (!plan.summary.closeCount) return { ok: false, status: "nothing-to-close", plan };

  const freshInputs = await readCloseDayInputs({ protectedTabId: plan.protectedTabId });
  if (!browserPlanMatches(plan, freshInputs)) return { ok: false, status: "stale-browser" };

  const prepared = await preparedRecords(plan);
  const organizationPlans = preparedOrganizationPlans(plan, prepared);
  const transactionId = crypto.randomUUID();
  const now = Date.now();
  const touchedLabels = [...new Set(prepared.archive.flatMap((item) => item.labels))];
  const entry = makeJournalEntry(
    `Closed the day: ${plan.summary.closeCount} tab${plan.summary.closeCount === 1 ? "" : "s"}`,
    { closeDayTransactionId: transactionId },
    { category: "close-day" }
  );
  let committedReceipt = null;
  let stale = false;
  const keys = [
    STORE_KEYS.inbox, STORE_KEYS.archive, STORE_KEYS.sessions, STORE_KEYS.snoozes,
    LABEL_META_KEY, COUNTERS_KEY, JOURNAL_KEY,
    CLOSE_DAY_DRAFT_KEY, CLOSE_DAY_RECEIPTS_KEY
  ];
  const committed = await mutateStores(keys, (maps) => {
    if (maps[CLOSE_DAY_DRAFT_KEY]?.id !== draftId || !storePlanMatches(plan, maps)) {
      stale = true;
      return null;
    }
    const inboxBefore = maps[STORE_KEYS.inbox] ?? {};
    const archiveBefore = maps[STORE_KEYS.archive] ?? {};
    const sessionsBefore = maps[STORE_KEYS.sessions] ?? {};
    const snoozesBefore = maps[STORE_KEYS.snoozes] ?? {};
    const inboxAfter = { ...inboxBefore };
    const archiveAfter = { ...archiveBefore };
    for (const item of prepared.inbox) {
      inboxAfter[item.id] = {
        ...item, tabs: item.refs, modifiedAt: now,
        ...(item.windowTitle ? { windowTitle: item.windowTitle } : {})
      };
      delete inboxAfter[item.id].refs;
    }
    for (const item of prepared.archive) {
      archiveAfter[item.id] = { ...item, tabs: item.refs, modifiedAt: now };
      delete archiveAfter[item.id].refs;
    }
    const snoozesAfter = { ...snoozesBefore };
    for (const snooze of prepared.snoozes) {
      snoozesAfter[snooze.id] = { ...snooze, modifiedAt: now };
    }
    let sessionResult;
    try {
      sessionResult = sessionMapAfter(plan, sessionsBefore, prepared, now);
    } catch {
      stale = true;
      return null;
    }
    const sessionIds = new Set([
      ...sessionResult.beforeById.keys(), ...prepared.newSessions.map((session) => session.id)
    ]);
    const labelMetaBefore = maps[LABEL_META_KEY] ?? {};
    const labelMetaAfter = touchedLabels.length
      ? touchedLabelMeta(labelMetaBefore, touchedLabels, now)
      : labelMetaBefore;
    const labelMetaChanges = touchedLabels.map((label) => ({
      label, before: labelMetaBefore[label] ?? null, after: labelMetaAfter[label] ?? null
    }));
    const storeChanges = [
      ...recordChanges(inboxBefore, inboxAfter, prepared.inbox.map((item) => item.id), STORE_KEYS.inbox),
      ...recordChanges(archiveBefore, archiveAfter, prepared.archive.map((item) => item.id), STORE_KEYS.archive),
      ...recordChanges(sessionsBefore, sessionResult.map, sessionIds, STORE_KEYS.sessions),
      ...recordChanges(snoozesBefore, snoozesAfter,
        prepared.snoozes.map((snooze) => snooze.id), STORE_KEYS.snoozes)
    ];
    const receipt = {
      id: transactionId, formatVersion: 1, phase: "saved",
      createdAt: now, updatedAt: now, journalId: entry.id,
      planId: draftId, summary: plan.summary,
      storeChanges, labelMetaChanges, windows: closeTargets(plan),
      choices: serializeCloseDayChoices(plan), organizationPlans
    };
    committedReceipt = receipt;
    const receipts = cappedReceipts({ ...(maps[CLOSE_DAY_RECEIPTS_KEY] ?? {}), [transactionId]: receipt });
    return {
      ...(prepared.inbox.length ? { [STORE_KEYS.inbox]: inboxAfter } : {}),
      ...(prepared.archive.length ? { [STORE_KEYS.archive]: archiveAfter } : {}),
      ...(sessionIds.size ? { [STORE_KEYS.sessions]: sessionResult.map } : {}),
      ...(prepared.snoozes.length ? { [STORE_KEYS.snoozes]: snoozesAfter } : {}),
      ...(touchedLabels.length ? { [LABEL_META_KEY]: labelMetaAfter } : {}),
      ...(prepared.inbox.length ? {
        [COUNTERS_KEY]: bumpedCounters(maps[COUNTERS_KEY], "tabsDumped",
          prepared.inbox.reduce((count, item) => count + item.refs.length, 0))
      } : {}),
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry),
      [CLOSE_DAY_RECEIPTS_KEY]: receipts,
      [CLOSE_DAY_DRAFT_KEY]: null
    };
  });
  if (!committed || !committedReceipt) {
    return { ok: false, status: stale ? "stale-store" : "not-committed" };
  }
  for (const snooze of prepared.snoozes) {
    try { await chrome.alarms.create(SNOOZE_ALARM_PREFIX + snooze.id, { when: snooze.dueAt }); }
    catch { /* startup reasserts alarms from the committed Snooze map */ }
  }
  const result = await applyCloseDayCloses(transactionId);
  return { ok: true, status: result.phase, transactionId, receipt: result };
}

async function readReceipt(transactionId) {
  const receipts = await readStoreMap(CLOSE_DAY_RECEIPTS_KEY);
  return receipts?.[transactionId] ?? null;
}

async function replaceReceipt(transactionId, update) {
  let result = null;
  await mutateStores([CLOSE_DAY_RECEIPTS_KEY], (maps) => {
    const receipts = maps[CLOSE_DAY_RECEIPTS_KEY] ?? {};
    const current = receipts[transactionId];
    if (!current) return null;
    result = update(clone(current));
    if (!result) return null;
    result.updatedAt = Date.now();
    return { [CLOSE_DAY_RECEIPTS_KEY]: cappedReceipts({ ...receipts, [transactionId]: result }) };
  });
  return result;
}

async function tabStillMatches(target) {
  try {
    const tab = browserTabInput(await chrome.tabs.get(target.tabId));
    return !tab.audible && closeDayFingerprintMatches(target.fingerprint, closeDayFingerprint(tab));
  } catch {
    return false;
  }
}

async function applyCloseDayOrganizationPlans(transactionId) {
  let receipt = await readReceipt(transactionId);
  for (let index = 0; index < (receipt?.organizationPlans ?? []).length; index += 1) {
    const item = receipt.organizationPlans[index];
    if (item?.status !== "pending") continue;
    let result;
    try {
      result = await applyOrganizationMemberPlan(item.kind, item.plan);
    } catch {
      result = { ok: false, reason: "unavailable" };
    }
    receipt = await replaceReceipt(transactionId, (next) => {
      const current = next.organizationPlans?.[index];
      if (!current || current.status !== "pending") return next;
      next.organizationPlans[index] = {
        ...current,
        status: result?.ok === false ? "failed" : "complete",
        ...(result?.ok === false ? { reason: clean(result.reason) || "unavailable" } : {}),
        completedAt: Date.now()
      };
      return next;
    });
  }
  return receipt;
}

/** Idempotent side-effect phase; safe after worker interruption. */
export async function applyCloseDayCloses(transactionId) {
  let receipt = await readReceipt(transactionId);
  if (!receipt) return { phase: "missing" };
  if (!["saved", "closing"].includes(receipt.phase)) return receipt;
  receipt = await applyCloseDayOrganizationPlans(transactionId) ?? receipt;

  for (const windowPlan of receipt.windows ?? []) {
    receipt = await readReceipt(transactionId);
    const currentWindow = receipt?.windows?.find((window) => window.windowId === windowPlan.windowId);
    if (!currentWindow) continue;
    const valid = [];
    const skipped = [];
    const closedFromAttempt = [];
    for (const target of currentWindow.tabs ?? []) {
      if (["closed", "skipped"].includes(target.status)) continue;
      if (target.status === "attempted") {
        try { await chrome.tabs.get(target.tabId); }
        catch { closedFromAttempt.push(target.tabId); continue; }
      }
      if (await tabStillMatches(target)) valid.push(target.tabId);
      else skipped.push(target.tabId);
    }
    if (closedFromAttempt.length || skipped.length) {
      await replaceReceipt(transactionId, (next) => {
        next.phase = "closing";
        const window = next.windows.find((candidate) => candidate.windowId === windowPlan.windowId);
        for (const target of window.tabs) {
          if (closedFromAttempt.includes(target.tabId)) target.status = "closed";
          if (skipped.includes(target.tabId)) target.status = "skipped";
        }
        return next;
      });
    }
    if (!valid.length) continue;
    await replaceReceipt(transactionId, (next) => {
      next.phase = "closing";
      const window = next.windows.find((candidate) => candidate.windowId === windowPlan.windowId);
      for (const target of window.tabs) {
        if (valid.includes(target.tabId)) {
          target.status = "attempted";
          target.attemptedAt = Date.now();
        }
      }
      return next;
    });
    // Receipt persistence is an asynchronous boundary. Re-read after it so a
    // tab that navigated while the durable "attempted" state was written is
    // skipped, not closed or later represented as Undoable by this action.
    const finalValid = [];
    const changedDuringReceipt = [];
    for (const tabId of valid) {
      const target = currentWindow.tabs.find((candidate) => candidate.tabId === tabId);
      if (target && await tabStillMatches(target)) finalValid.push(tabId);
      else changedDuringReceipt.push(tabId);
    }
    const closed = [];
    const survived = [];
    if (finalValid.length) {
      try { await chrome.tabs.remove(finalValid); }
      catch { /* reconcile exact survivors below */ }
      for (const tabId of finalValid) {
        try { await chrome.tabs.get(tabId); survived.push(tabId); }
        catch { closed.push(tabId); }
      }
    }
    const settleExactCloseOutcome = () => replaceReceipt(transactionId, (next) => {
      const window = next.windows.find((candidate) => candidate.windowId === windowPlan.windowId);
      for (const target of window.tabs) {
        if (changedDuringReceipt.includes(target.tabId)) target.status = "skipped";
        if (closed.includes(target.tabId)) target.status = "closed";
        if (survived.includes(target.tabId)) target.status = "skipped";
      }
      return next;
    });
    try { await settleExactCloseOutcome(); }
    catch { await settleExactCloseOutcome(); }
  }

  receipt = await replaceReceipt(transactionId, (next) => {
    next.phase = "complete";
    next.completedAt = Date.now();
    const tabs = next.windows.flatMap((window) => window.tabs);
    next.result = {
      closed: tabs.filter((tab) => tab.status === "closed").length,
      skipped: tabs.filter((tab) => tab.status === "skipped").length
    };
    return next;
  });
  return receipt ?? { phase: "missing" };
}

export async function resumeCloseDayTransactions() {
  const stored = await readStoreMap(CLOSE_DAY_RECEIPTS_KEY);
  const pending = Object.values(stored ?? {})
    .filter((receipt) => ["saved", "closing"].includes(receipt?.phase));
  const results = [];
  for (const receipt of pending) results.push(await applyCloseDayCloses(receipt.id));
  return results;
}

function recordVersionMatches(current, expected) {
  return Boolean(current && expected &&
    Number(current.modifiedAt ?? 0) === Number(expected.modifiedAt ?? 0) &&
    Number(current.deletedAt ?? 0) === Number(expected.deletedAt ?? 0));
}

/**
 * @typedef {Object} CloseDayReopenResult
 * @property {number} reopened Confirmed matching page occurrences.
 * @property {number} expected Closed occurrences requested by Undo.
 * @property {number} [failed] Occurrences confirmed not reopened.
 * @property {number} [uncertain] Occurrences whose browser outcome is unknown.
 */
function reopenTargets(receipt) {
  return (receipt.windows ?? []).flatMap((window) => window.tabs ?? [])
    .filter((tab) => tab.status === "closed");
}

/** @returns {Promise<CloseDayReopenResult>} */
async function reopenReceiptWindows(receipt) {
  let reopened = 0;
  let failed = 0;
  let uncertain = 0;
  for (const window of receipt.windows ?? []) {
    const closed = (window.tabs ?? []).filter((tab) => tab.status === "closed");
    const targets = closed.filter((tab) => /^https?:/.test(tab.ref?.url ?? ""));
    failed += closed.length - targets.length;
    if (!targets.length) continue;
    let created;
    try {
      created = await chrome.windows.create({ url: targets.map((tab) => tab.ref.url) });
    } catch {
      // Chrome can reject after an effect has happened. Without a confirmed
      // created-tab list, a fallback would risk reopening the same pages twice.
      uncertain += targets.length;
      continue;
    }
    // A successfully created window must never be replayed because its later
    // observation or pin update failed: those tabs may already be open.
    let tabs;
    try {
      tabs = Array.isArray(created?.tabs) ? created.tabs
        : created?.id != null ? await chrome.tabs.query({ windowId: created.id }) : null;
    } catch { tabs = null; }
    if (!Array.isArray(tabs)) { uncertain += targets.length; continue; }
    const unique = [...new Map(tabs.filter((tab) => Number.isInteger(tab?.id))
      .map((tab) => [tab.id, tab])).values()].sort((a, b) => a.index - b.index);
    for (const url of new Set(targets.map((target) => target.ref.url))) {
      const requested = targets.filter((target) => target.ref.url === url);
      const observed = unique.filter((tab) => rawUrlOf(tab) === url);
      reopened += Math.min(requested.length, observed.length);
      failed += Math.max(0, requested.length - observed.length);
      // Missing or extra same-URL occurrences make pin identity ambiguous.
      if (observed.length !== requested.length) continue;
      for (let index = 0; index < requested.length; index++) {
        if (!requested[index].pinned) continue;
        try { await chrome.tabs.update(observed[index].id, { pinned: true }); }
        catch { /* pin restoration remains best-effort; the page was reopened */ }
      }
    }
  }
  return { reopened, expected: reopenTargets(receipt).length,
    ...(failed ? { failed } : {}), ...(uncertain ? { uncertain } : {}) };
}

/** Settle abandoned effects honestly; browser creation has no replay identity. */
export async function recoverInterruptedCloseDayUndos() {
  const observed = await readStoreMap(CLOSE_DAY_RECEIPTS_KEY);
  if (!Object.values(observed ?? {}).some((receipt) => receipt?.phase === "undoing")) return 0;
  let recovered = 0;
  await mutateStores([CLOSE_DAY_RECEIPTS_KEY, JOURNAL_KEY], (maps) => {
    const receipts = clone(maps[CLOSE_DAY_RECEIPTS_KEY] ?? {});
    const journal = clone(maps[JOURNAL_KEY] ?? []);
    for (const receipt of Object.values(receipts)) {
      if (receipt?.phase !== "undoing") continue;
      const expected = reopenTargets(receipt).length;
      receipt.phase = "undo-incomplete";
      receipt.updatedAt = Date.now();
      receipt.reopenResult = { reopened: 0, expected, ...(expected ? { uncertain: expected } : {}) };
      delete receipt.undoClaim;
      const entry = journal.find((candidate) => candidate.id === receipt.journalId);
      if (entry) {
        delete entry.undone;
        delete entry.undoClaim;
        entry.undoStatus = "incomplete";
        entry.undoEffectResult = { ...receipt.reopenResult, moved: 0 };
      }
      recovered += 1;
    }
    return recovered ? { [CLOSE_DAY_RECEIPTS_KEY]: cappedReceipts(receipts), [JOURNAL_KEY]: journal } : null;
  });
  return recovered;
}

/** Exact store rollback where unchanged; then best-effort URL reopen. */
export async function undoCloseDayTransaction(transactionId) {
  let receipt = await readReceipt(transactionId);
  if (!receipt || receipt.phase === "undone") return { status: "unavailable" };
  if (receipt.phase === "undoing") return { status: "busy", receipt };
  if (receipt.phase === "undo-incomplete") return { status: "incomplete", receipt };
  if (!["complete", "saved", "closing"].includes(receipt.phase)) return { status: "unavailable" };
  if (receipt.phase !== "complete") receipt = await applyCloseDayCloses(transactionId);
  if (receipt?.phase !== "complete") return { status: "unavailable" };

  const stores = [...new Set((receipt.storeChanges ?? []).map((change) => change.store))];
  const keys = [...stores, LABEL_META_KEY, JOURNAL_KEY, CLOSE_DAY_RECEIPTS_KEY];
  let conflicts = 0;
  let rolledBack = 0;
  let claimed = false;
  const claimId = crypto.randomUUID();
  await mutateStores(keys, (maps) => {
    // Resuming closes can change pending/attempted targets to closed/skipped.
    // Claim the latest settled ledger alongside the saved-data inverse so an
    // earlier read cannot overwrite those outcomes or claim a second Undo.
    const currentReceipt = maps[CLOSE_DAY_RECEIPTS_KEY]?.[transactionId];
    if (currentReceipt?.phase !== "complete") return null;
    receipt = clone(currentReceipt);
    const sets = {};
    const now = Date.now();
    for (const store of stores) {
      const map = { ...(maps[store] ?? {}) };
      let changed = false;
      for (const change of (receipt.storeChanges ?? []).filter((candidate) => candidate.store === store)) {
        const current = map[change.id];
        if (!recordVersionMatches(current, change.after)) {
          conflicts += 1;
          continue;
        }
        if (change.before) map[change.id] = { ...change.before, modifiedAt: now };
        else map[change.id] = { ...current, deletedAt: now, modifiedAt: now };
        rolledBack += 1;
        changed = true;
      }
      if (changed) sets[store] = map;
    }
    if ((receipt.labelMetaChanges ?? []).length) {
      const meta = { ...(maps[LABEL_META_KEY] ?? {}) };
      let changed = false;
      for (const change of receipt.labelMetaChanges) {
        const current = meta[change.label] ?? null;
        if (current !== change.after) { conflicts += 1; continue; }
        if (change.before == null) delete meta[change.label];
        else meta[change.label] = change.before;
        rolledBack += 1;
        changed = true;
      }
      if (changed) sets[LABEL_META_KEY] = meta;
    }
    const journal = clone(maps[JOURNAL_KEY] ?? []);
    const entry = journal.find((candidate) => candidate.id === receipt.journalId);
    const undoClaim = { id: claimId, at: now, phase: "effects" };
    if (entry) entry.undoClaim = undoClaim;
    const receipts = { ...(maps[CLOSE_DAY_RECEIPTS_KEY] ?? {}) };
    receipts[transactionId] = {
      ...receipt, phase: "undoing", updatedAt: now, undoClaim,
      storeUndo: { rolledBack, conflicts }
    };
    sets[JOURNAL_KEY] = journal;
    sets[CLOSE_DAY_RECEIPTS_KEY] = receipts;
    claimed = true;
    return sets;
  });
  if (!claimed) {
    const current = await readReceipt(transactionId);
    return { status: current?.phase === "undoing" ? "busy"
      : current?.phase === "undo-incomplete" ? "incomplete" : "unavailable", receipt: current };
  }
  for (const change of (receipt.storeChanges ?? []).filter((candidate) =>
    candidate.store === STORE_KEYS.snoozes && !candidate.before && candidate.after?.id)) {
    try { await chrome.alarms.clear(SNOOZE_ALARM_PREFIX + change.after.id); }
    catch { /* tombstoned Snoozes cannot fire even if Chrome retains an alarm */ }
  }
  const reopenResult = await reopenReceiptWindows(receipt);
  let result = { status: "unavailable", receipt: null };
  await mutateStores([CLOSE_DAY_RECEIPTS_KEY, JOURNAL_KEY], (maps) => {
    const current = maps[CLOSE_DAY_RECEIPTS_KEY]?.[transactionId];
    if (current?.phase !== "undoing" || current.undoClaim?.id !== claimId) {
      result = { status: current?.phase === "undo-incomplete" ? "incomplete" : "unavailable", receipt: current };
      return null;
    }
    const incomplete = Boolean(reopenResult.failed || reopenResult.uncertain);
    const settled = { ...current, phase: incomplete ? "undo-incomplete" : "undone",
      updatedAt: Date.now(), reopenResult };
    delete settled.undoClaim;
    if (!incomplete) settled.undoneAt = Date.now();
    const journal = clone(maps[JOURNAL_KEY] ?? []);
    const entry = journal.find((candidate) => candidate.id === settled.journalId);
    if (entry) {
      delete entry.undoClaim;
      entry.undoEffectResult = { ...reopenResult, moved: 0 };
      if (incomplete) entry.undoStatus = "incomplete";
      else entry.undone = true;
    }
    result = { status: incomplete ? "incomplete" : "undone", receipt: settled,
      conflicts, reopened: reopenResult.reopened };
    return { [CLOSE_DAY_RECEIPTS_KEY]: cappedReceipts({ ...maps[CLOSE_DAY_RECEIPTS_KEY], [transactionId]: settled }),
      [JOURNAL_KEY]: journal };
  });
  return result;
}

export async function closeDayStatus() {
  const [draft, stored] = await Promise.all([
    currentDraft(), readStoreMap(CLOSE_DAY_RECEIPTS_KEY)
  ]);
  const receipts = Object.values(stored ?? {})
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
  return { draft, pending: receipts.find((receipt) => ["saved", "closing"].includes(receipt.phase)) ?? null,
    latest: receipts[0] ?? null };
}
