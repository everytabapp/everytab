import { normalizeUrl } from "./url-key.js";

export const CLOSE_DAY_ACTIONS = Object.freeze({
  close: "close",
  inbox: "inbox",
  addSession: "add-session",
  session: "session",
  newSession: "new-session",
  archiveLabel: "archive-label",
  stay: "stay",
  unfiled: "close-unfiled"
});

const ACTIONS = new Set(Object.values(CLOSE_DAY_ACTIONS));

const clean = (value) => String(value ?? "").trim();
const liveRecords = (map) => Object.values(map ?? {}).filter((record) => record && !record.deletedAt);
const PLAYBACK_QUERY_KEYS = new Set(["t", "start", "time_continue"]);

/** Treat playback position as state within one YouTube page, not a new saved page. */
export function closeDayUrlKey(value) {
  const source = String(value ?? "");
  try {
    const url = new URL(source);
    const host = url.hostname.toLocaleLowerCase();
    if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")) {
      for (const key of PLAYBACK_QUERY_KEYS) url.searchParams.delete(key);
    }
    return normalizeUrl(url.href);
  } catch {
    return normalizeUrl(source);
  }
}

const refKey = (ref) => closeDayUrlKey(ref?.url ?? "");

function portableLabels(...maps) {
  const labels = new Set();
  const take = (values) => {
    for (const value of values ?? []) {
      const label = clean(value);
      if (label) labels.add(label);
    }
  };
  for (const map of maps) {
    for (const record of liveRecords(map)) {
      take(record.labels);
      for (const ref of record.tabs ?? []) take(ref?.labels);
      for (const windowRefs of record.windows ?? []) {
        for (const ref of windowRefs ?? []) take(ref?.labels);
      }
    }
  }
  return [...labels].sort((a, b) => a.localeCompare(b));
}

function choiceLabels(value) {
  const source = Array.isArray(value?.labels) ? value.labels : [value?.label];
  return [...new Set(source.map(clean).filter(Boolean))].slice(0, 20).map((label) => label.slice(0, 80));
}

/** Stable, non-secret revision used only to detect a changed review input. */
export function closeDayMapRevision(map) {
  return liveRecords(map)
    .map((record) => `${record.id}:${Number(record.modifiedAt ?? 0)}:${Number(record.deletedAt ?? 0)}`)
    .sort()
    .join("|");
}

export function closeDayFingerprint(tab) {
  return {
    tabId: Number(tab?.id),
    windowId: Number(tab?.windowId),
    index: Number(tab?.index),
    pinned: tab?.pinned === true,
    audible: tab?.audible === true,
    rawUrl: String(tab?.rawUrl ?? tab?.url ?? ""),
    canonicalUrl: String(tab?.ref?.url ?? "")
  };
}

export function closeDayFingerprintKey(value) {
  const f = value?.fingerprint ?? value;
  return [
    Number(f?.tabId), Number(f?.windowId), Number(f?.index), f?.pinned ? 1 : 0,
    closeDayUrlKey(f?.rawUrl ?? ""), closeDayUrlKey(f?.canonicalUrl ?? "")
  ].join("\u001f");
}

export function closeDayFingerprintMatches(a, b, { includeAudible = true } = {}) {
  const left = a?.fingerprint ?? a;
  const right = b?.fingerprint ?? b;
  return closeDayFingerprintKey(left) === closeDayFingerprintKey(right) &&
    (!includeAudible || Boolean(left?.audible) === Boolean(right?.audible));
}

function coverageIndex(sessions, inbox, archive) {
  const named = new Map();
  const snapshots = new Set();
  const inboxUrls = new Set();
  const archiveUrls = new Map();

  for (const session of liveRecords(sessions)) {
    const target = session.auto ? snapshots : named;
    for (const windowRefs of session.windows ?? []) {
      for (const ref of windowRefs ?? []) {
        const key = refKey(ref);
        if (!key) continue;
        if (session.auto) snapshots.add(key);
        else if (!target.has(key)) target.set(key, { sessionId: session.id, name: session.name });
      }
    }
  }
  for (const item of liveRecords(inbox)) {
    for (const ref of item.tabs ?? []) {
      const key = refKey(ref);
      if (key) inboxUrls.add(key);
    }
  }
  for (const item of liveRecords(archive)) {
    for (const ref of item.tabs ?? []) {
      const key = refKey(ref);
      if (!key || archiveUrls.has(key)) continue;
      const labels = [...new Set([...(item.labels ?? []), ...(ref.labels ?? [])].map(clean).filter(Boolean))];
      archiveUrls.set(key, { labels });
    }
  }
  return { named, snapshots, inboxUrls, archiveUrls };
}

function availableActions({ locked, boundSessionId, coverage }) {
  if (locked) return [CLOSE_DAY_ACTIONS.stay];
  const actions = [CLOSE_DAY_ACTIONS.stay];
  if (coverage?.kind !== "unsaveable") {
    actions.unshift(
      CLOSE_DAY_ACTIONS.inbox,
      CLOSE_DAY_ACTIONS.archiveLabel,
      CLOSE_DAY_ACTIONS.session,
      CLOSE_DAY_ACTIONS.newSession,
      CLOSE_DAY_ACTIONS.unfiled
    );
    if (["bound-session", "session", "inbox", "archive"].includes(coverage?.kind)) {
      actions.unshift(CLOSE_DAY_ACTIONS.close);
    }
    if (boundSessionId) actions.splice(1, 0, CLOSE_DAY_ACTIONS.addSession);
  }
  return [...new Set(actions)];
}

function priorChoiceFor(prior, fingerprintKey) {
  const choice = prior?.choices?.[fingerprintKey];
  if (!choice || typeof choice !== "object") return null;
  return choice;
}

function sanitizedChoice(prior, defaults, available, sessionsById) {
  if (!prior || !available.includes(prior.action)) return defaults;
  const next = { ...defaults, action: prior.action };
  if (prior.action === CLOSE_DAY_ACTIONS.session) {
    const target = sessionsById.get(clean(prior.targetSessionId));
    if (!target || target.auto || target.deletedAt) return defaults;
    next.targetSessionId = target.id;
  }
  if (prior.action === CLOSE_DAY_ACTIONS.newSession) {
    const name = clean(prior.newSessionName);
    if (!name) return defaults;
    next.newSessionName = name.slice(0, 64);
  }
  if (prior.action === CLOSE_DAY_ACTIONS.archiveLabel) {
    const labels = choiceLabels(prior);
    if (!labels.length) return defaults;
    next.label = labels[0];
    next.labels = labels;
  }
  return next;
}

function coverageFor(ref, coverage) {
  const key = refKey(ref);
  if (!key) return { kind: "unsaveable", label: "Cannot be saved" };
  const session = coverage.named.get(key);
  if (session) return { kind: "session", label: `In Session “${session.name}”`, ...session };
  if (coverage.inboxUrls.has(key)) return { kind: "inbox", label: "In Inbox" };
  const archived = coverage.archiveUrls.get(key);
  if (archived) {
    const suffix = archived.labels.length ? ` · ${archived.labels[0]}${archived.labels.length > 1 ? ` +${archived.labels.length - 1}` : ""}` : "";
    return { kind: "archive", label: `In Archive${suffix}`, labels: archived.labels };
  }
  if (coverage.snapshots.has(key)) return { kind: "snapshot", label: "Snapshot only · will save to Inbox" };
  return { kind: "unsaved", label: "Unsaved" };
}

function occurrenceMatches(liveTabs, savedRefs) {
  const queues = new Map();
  for (let index = 0; index < savedRefs.length; index++) {
    const key = refKey(savedRefs[index]);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(index);
  }
  return liveTabs.map((tab) => {
    const key = refKey(tab.ref);
    const queue = queues.get(key);
    return queue?.length ? queue.shift() : null;
  });
}

function arrangementDrift(liveTabs, savedRefs, matches) {
  let priorSavedIndex = -1;
  let order = false;
  let pinned = false;
  let groups = false;
  for (let index = 0; index < liveTabs.length; index++) {
    const savedIndex = matches[index];
    if (savedIndex == null) continue;
    if (savedIndex < priorSavedIndex) order = true;
    priorSavedIndex = Math.max(priorSavedIndex, savedIndex);
    const saved = savedRefs[savedIndex] ?? {};
    const live = liveTabs[index] ?? {};
    if (Boolean(saved.pinned) !== Boolean(live.pinned)) pinned = true;
    const savedGrouped = Number.isInteger(saved.groupIndex);
    const liveGrouped = Number.isInteger(live.groupId) && live.groupId !== -1;
    if (savedGrouped !== liveGrouped) groups = true;
  }
  return { any: order || pinned || groups, order, pinned, groups };
}

function lockedReason(tab, extensionOrigin, protectedTabId) {
  if (tab.incognito) return "Incognito tabs are excluded and never stored.";
  if (Number(tab.id) === Number(protectedTabId)) return "This review stays open so the workflow can finish safely.";
  const raw = String(tab.rawUrl ?? tab.url ?? "");
  // EveryTab's suspend page is an extension URL, but browserTabInput has
  // already resolved it to the original saveable page. Only a true extension
  // page (no canonical ref) is protected here.
  if (extensionOrigin && raw.startsWith(extensionOrigin) && !tab.ref) {
    return "EveryTab and extension pages stay open.";
  }
  if (tab.audible) return "Audible tabs stay open.";
  if (!tab.ref) return "Browser, internal, file, blank, and other unsaveable pages stay open.";
  return "";
}

function rowFromTab(tab, context) {
  const fingerprint = closeDayFingerprint(tab);
  const fingerprintKey = closeDayFingerprintKey(fingerprint);
  const reason = lockedReason(tab, context.extensionOrigin, context.protectedTabId);
  const coverage = context.coverage ?? coverageFor(tab.ref, context.coverageIndex);
  const locked = Boolean(reason);
  const available = availableActions({ locked, boundSessionId: context.boundSessionId, coverage });
  let action = CLOSE_DAY_ACTIONS.close;
  if (locked || tab.pinned) action = CLOSE_DAY_ACTIONS.stay;
  else if (context.boundSessionId && context.matchSavedIndex == null) action = CLOSE_DAY_ACTIONS.addSession;
  else if (["unsaved", "snapshot"].includes(coverage.kind)) action = CLOSE_DAY_ACTIONS.inbox;
  const defaults = {
    action,
    ...(action === CLOSE_DAY_ACTIONS.addSession ? { targetSessionId: context.boundSessionId } : {})
  };
  const choice = sanitizedChoice(
    priorChoiceFor(context.prior, fingerprintKey), defaults, available, context.sessionsById
  );
  return {
    id: String(tab.id), tabId: Number(tab.id), windowId: Number(tab.windowId),
    index: Number(tab.index), title: tab.title || tab.ref?.title || tab.rawUrl || "Untitled",
    favIconUrl: tab.favIconUrl || tab.ref?.favIconUrl || "", ref: tab.ref ?? null,
    pinned: Boolean(tab.pinned), audible: Boolean(tab.audible), active: Boolean(tab.active),
    fingerprint, fingerprintKey, locked, lockedReason: reason, coverage,
    boundSessionId: context.boundSessionId ?? null,
    matchSavedIndex: context.matchSavedIndex ?? null,
    availableActions: available,
    choice
  };
}

function windowTitle(win, ordinal) {
  return `Window ${ordinal + 1}`;
}

/**
 * Pure review planner. Inputs have already been privacy-filtered: incognito
 * windows are represented only in `excludedWindowCount`, never with their URLs.
 */
export function buildCloseDayPlan({
  windows = [], sessions = {}, inbox = {}, archive = {}, bindings = {},
  extensionOrigin = "", protectedTabId = null, excludedWindowCount = 0
}, prior = null) {
  const sessionsById = new Map(liveRecords(sessions).map((session) => [session.id, session]));
  const coverageIndexValue = coverageIndex(sessions, inbox, archive);
  const groups = [];
  let tabCount = 0;

  for (const [ordinal, win] of windows.entries()) {
    const tabs = [...(win.tabs ?? [])].sort((a, b) => Number(a.index) - Number(b.index));
    const binding = bindings?.[win.id] ?? bindings?.[String(win.id)] ?? null;
    const session = binding ? sessionsById.get(binding.sessionId) : null;
    const savedRefs = session && !session.auto && Array.isArray(session.windows?.[binding.windowIndex])
      ? session.windows[binding.windowIndex]
      : null;
    let rows;
    let drift = { any: false, order: false, pinned: false, groups: false };
    if (savedRefs) {
      const saveable = tabs.filter((tab) => tab.ref);
      const matches = occurrenceMatches(saveable, savedRefs);
      const matchByTabId = new Map(saveable.map((tab, index) => [tab.id, matches[index]]));
      drift = arrangementDrift(saveable, savedRefs, matches);
      rows = tabs.map((tab) => rowFromTab(tab, {
        extensionOrigin, protectedTabId, coverageIndex: coverageIndexValue,
        coverage: matchByTabId.get(tab.id) == null
          ? coverageFor(tab.ref, coverageIndexValue)
          : { kind: "bound-session", label: `In Session “${session.name}”`, sessionId: session.id, name: session.name },
        boundSessionId: session.id, matchSavedIndex: matchByTabId.get(tab.id),
        sessionsById, prior
      }));
    } else {
      rows = tabs.map((tab) => rowFromTab(tab, {
        extensionOrigin, protectedTabId, coverageIndex: coverageIndexValue,
        boundSessionId: null, matchSavedIndex: null, sessionsById, prior
      }));
    }
    tabCount += rows.length;
    const savedAbsentCount = savedRefs
      ? Math.max(0, savedRefs.length - rows.filter((row) => row.matchSavedIndex != null).length)
      : 0;
    const priorMode = prior?.windowModes?.[String(win.id)];
    groups.push({
      id: String(win.id), windowId: Number(win.id), ordinal,
      title: windowTitle(win, ordinal), session: savedRefs ? {
        id: session.id, name: session.name, windowIndex: Number(binding.windowIndex),
        modifiedAt: Number(session.modifiedAt ?? 0), savedTabCount: savedRefs.length,
        absentCount: savedAbsentCount, drift,
        mode: priorMode === "replace" ? "replace" : "keep"
      } : null,
      rows
    });
  }

  const rows = groups.flatMap((group) => group.rows);
  const summary = summarizeCloseDayPlan({ groups });
  return {
    formatVersion: 1,
    createdAt: Number(prior?.createdAt ?? Date.now()), updatedAt: Date.now(),
    protectedTabId: Number.isInteger(protectedTabId) ? protectedTabId : null,
    groups, labels: portableLabels(sessions, inbox, archive),
    sessions: liveRecords(sessions).filter((session) => !session.auto)
      .map((session) => ({ id: session.id, name: session.name, modifiedAt: session.modifiedAt }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    tabCount, windowCount: groups.length, excludedWindowCount,
    storeRevisions: {
      sessions: closeDayMapRevision(sessions), inbox: closeDayMapRevision(inbox), archive: closeDayMapRevision(archive)
    },
    summary,
    choices: Object.fromEntries(rows.map((row) => [row.fingerprintKey, row.choice])),
    windowModes: Object.fromEntries(groups.filter((group) => group.session)
      .map((group) => [String(group.windowId), group.session.mode]))
  };
}

export function summarizeCloseDayPlan(plan) {
  const rows = (plan?.groups ?? []).flatMap((group) => group.rows ?? []);
  const count = (action) => rows.filter((row) => row.choice?.action === action).length;
  const closeRows = rows.filter((row) => row.choice?.action !== CLOSE_DAY_ACTIONS.stay && !row.locked);
  const inboxWindows = new Set(rows.filter((row) => row.choice?.action === CLOSE_DAY_ACTIONS.inbox)
    .map((row) => row.windowId));
  const affectedSessions = new Set(rows.filter((row) => [CLOSE_DAY_ACTIONS.addSession, CLOSE_DAY_ACTIONS.session]
    .includes(row.choice?.action)).map((row) => row.choice?.targetSessionId || row.boundSessionId));
  for (const group of plan?.groups ?? []) if (group.session?.mode === "replace") affectedSessions.add(group.session.id);
  return {
    closeCount: closeRows.length,
    closeWindowCount: new Set(closeRows.map((row) => row.windowId)).size,
    stayOpenCount: rows.length - closeRows.length,
    inboxCount: count(CLOSE_DAY_ACTIONS.inbox), inboxBundleCount: inboxWindows.size,
    archiveCount: count(CLOSE_DAY_ACTIONS.archiveLabel),
    sessionCount: count(CLOSE_DAY_ACTIONS.addSession) + count(CLOSE_DAY_ACTIONS.session) + count(CLOSE_DAY_ACTIONS.newSession),
    affectedSessionCount: [...affectedSessions].filter(Boolean).length,
    unfiledCount: count(CLOSE_DAY_ACTIONS.unfiled),
    exceptionCount: rows.filter((row) => row.locked).length
  };
}

export function serializeCloseDayChoices(plan) {
  const choices = {};
  const windowModes = {};
  for (const group of plan?.groups ?? []) {
    if (group.session) windowModes[String(group.windowId)] = group.session.mode === "replace" ? "replace" : "keep";
    for (const row of group.rows ?? []) choices[row.fingerprintKey] = { ...row.choice };
  }
  return { choices, windowModes };
}

function choiceFromPatch(plan, row, patch) {
  if (!row || row.locked) return null;
  const action = clean(patch?.action || row.choice?.action);
  if (!ACTIONS.has(action) || !row.availableActions.includes(action)) return null;
  const next = { action };
  if (action === CLOSE_DAY_ACTIONS.addSession) next.targetSessionId = row.boundSessionId;
  if (action === CLOSE_DAY_ACTIONS.session) {
    const target = (plan.sessions ?? []).find((session) => session.id === clean(patch?.targetSessionId));
    if (!target) return null;
    next.targetSessionId = target.id;
  }
  if (action === CLOSE_DAY_ACTIONS.newSession) {
    const name = clean(patch?.newSessionName);
    if (!name) return null;
    next.newSessionName = name.slice(0, 64);
  }
  if (action === CLOSE_DAY_ACTIONS.archiveLabel) {
    const labels = choiceLabels(patch);
    if (!labels.length) return null;
    next.label = labels[0];
    next.labels = labels;
  }
  return next;
}

function commitChoices(plan, entries) {
  for (const [row, next] of entries) {
    row.choice = next;
    plan.choices[row.fingerprintKey] = { ...next };
  }
  plan.summary = summarizeCloseDayPlan(plan);
  plan.updatedAt = Date.now();
}

export function applyCloseDayChoice(plan, fingerprintKey, patch) {
  const row = (plan?.groups ?? []).flatMap((group) => group.rows ?? [])
    .find((candidate) => candidate.fingerprintKey === fingerprintKey);
  const next = choiceFromPatch(plan, row, patch);
  if (!next) return false;
  commitChoices(plan, [[row, next]]);
  return true;
}

/** Apply one validated choice to a selected set without partial mutation. */
export function applyCloseDayChoices(plan, fingerprintKeys, patch) {
  const requested = [...new Set((fingerprintKeys ?? []).map(clean).filter(Boolean))];
  if (!requested.length) return false;
  const byKey = new Map((plan?.groups ?? []).flatMap((group) => group.rows ?? [])
    .map((row) => [row.fingerprintKey, row]));
  const entries = [];
  for (const key of requested) {
    const row = byKey.get(key);
    const next = choiceFromPatch(plan, row, patch);
    if (!next) return false;
    entries.push([row, next]);
  }
  commitChoices(plan, entries);
  return true;
}

export function applyCloseDayWindowMode(plan, windowId, mode) {
  const group = (plan?.groups ?? []).find((candidate) => candidate.windowId === Number(windowId));
  if (!group?.session || !["keep", "replace"].includes(mode)) return false;
  group.session.mode = mode;
  plan.windowModes[String(group.windowId)] = mode;
  plan.summary = summarizeCloseDayPlan(plan);
  plan.updatedAt = Date.now();
  return true;
}

/** Add-only merge: unmatched live refs are inserted beside matched neighbours. */
export function mergeAddedSessionRefs(savedRefs, liveRows) {
  const before = new Map();
  const after = new Map();
  const trailing = [];
  for (let index = 0; index < liveRows.length; index++) {
    const row = liveRows[index];
    if (row.matchSavedIndex != null || row.choice?.action !== CLOSE_DAY_ACTIONS.addSession || !row.ref) continue;
    let previous = null;
    let next = null;
    for (let i = index - 1; i >= 0; i--) {
      if (liveRows[i].matchSavedIndex != null) { previous = liveRows[i].matchSavedIndex; break; }
    }
    if (previous == null) {
      for (let i = index + 1; i < liveRows.length; i++) {
        if (liveRows[i].matchSavedIndex != null) { next = liveRows[i].matchSavedIndex; break; }
      }
    }
    if (previous != null) {
      if (!after.has(previous)) after.set(previous, []);
      after.get(previous).push(row.ref);
    } else if (next != null) {
      if (!before.has(next)) before.set(next, []);
      before.get(next).push(row.ref);
    } else trailing.push(row.ref);
  }
  const merged = [];
  for (let index = 0; index < savedRefs.length; index++) {
    merged.push(...(before.get(index) ?? []), savedRefs[index], ...(after.get(index) ?? []));
  }
  merged.push(...trailing);
  return merged;
}
