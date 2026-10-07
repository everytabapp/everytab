// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { registerSuspended } from "./suspend.js";

const MAX_RECENT_SESSIONS = 25;
const MAX_SELECTION = 25;

function webUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function suspendedPageIdentity(tab) {
  if (!tab) return null;
  const raw = tab.url || tab.pendingUrl || "";
  try {
    const candidate = new URL(raw);
    const own = new URL(chrome.runtime.getURL("suspend.html"));
    // URL.origin is the string "null" for chrome-extension: URLs, so compare
    // the actual scheme/host/path identity instead of treating every extension
    // as the same origin.
    if (candidate.protocol !== own.protocol || candidate.host !== own.host ||
        candidate.pathname !== own.pathname) return null;
    const original = webUrl(candidate.searchParams.get("originalUrl") || "");
    if (!original) return null;
    const title = (candidate.searchParams.get("title") || tab.title || original.href)
      .replace(/\s*·\s*suspended\s*$/i, "").trim().slice(0, 500) || original.href;
    return {
      title,
      originalUrl: original.href,
      domain: original.hostname,
      recoveryOccurrenceId: candidate.searchParams.get("recoveryOccurrenceId") || ""
    };
  } catch {
    return null;
  }
}

function suspendedPageInfo(tab, closedAt) {
  if (!tab || typeof tab.sessionId !== "string" || !tab.sessionId) return null;
  const identity = suspendedPageIdentity(tab);
  if (!identity) return null;
  return {
    sessionId: tab.sessionId,
    ...identity,
    closedAt: Number.isFinite(closedAt) ? Math.round(closedAt * 1000) : 0
  };
}

function candidatesFromSessions(sessions, liveTabs = []) {
  const out = [];
  const seenSessionIds = new Set();
  const seenOccurrenceIds = new Set();
  const liveOccurrenceIds = new Set((liveTabs ?? [])
    .map(suspendedPageIdentity)
    .map((identity) => identity?.recoveryOccurrenceId)
    .filter(Boolean));
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const tabs = session?.tab ? [session.tab] : (session?.window?.tabs ?? []);
    for (const tab of tabs) {
      const candidate = suspendedPageInfo(tab, session?.lastModified);
      if (!candidate || seenSessionIds.has(candidate.sessionId)) continue;
      if (candidate.recoveryOccurrenceId && (
        liveOccurrenceIds.has(candidate.recoveryOccurrenceId) ||
        seenOccurrenceIds.has(candidate.recoveryOccurrenceId)
      )) continue;
      seenSessionIds.add(candidate.sessionId);
      if (candidate.recoveryOccurrenceId) {
        seenOccurrenceIds.add(candidate.recoveryOccurrenceId);
      }
      out.push(candidate);
    }
  }
  return out;
}

/**
 * Inspect only recently closed pages that are exactly this installation's
 * suspend.html and contain a valid http(s) original URL. No tabs are opened.
 */
export async function inspectRecentlyClosedSuspendedTabs() {
  try {
    const [recent, liveTabs] = await Promise.all([
      chrome.sessions.getRecentlyClosed({ maxResults: MAX_RECENT_SESSIONS }),
      chrome.tabs.query({})
    ]);
    return { ok: true, candidates: candidatesFromSessions(recent, liveTabs) };
  } catch {
    return { ok: false, candidates: [] };
  }
}

function restoredTabs(session) {
  if (session?.tab) return [session.tab];
  return Array.isArray(session?.window?.tabs) ? session.window.tabs : [];
}

async function adoptRestoredCandidate(session, candidate) {
  const tabs = restoredTabs(session);
  const restored = tabs.find((tab) => tab?.sessionId === candidate.sessionId) ?? tabs[0];
  if (!Number.isInteger(restored?.id)) return false;
  const current = suspendedPageInfo({ ...restored, sessionId: candidate.sessionId }, 0);
  if (current?.originalUrl === candidate.originalUrl) {
    await registerSuspended(
      restored,
      candidate.originalUrl,
      candidate.recoveryOccurrenceId
    );
  }
  // Chrome may choose to reopen the underlying page instead of the extension
  // page. That still recovers the user's tab and correctly needs no registry.
  return true;
}

let recoveryChain = Promise.resolve(null);

/**
 * Restore an explicit bounded selection. Candidates are re-read immediately
 * before each effect so arbitrary/stale session ids never reach Chrome restore.
 * @param {string[]} sessionIds
 */
export function recoverRecentlyClosedSuspendedTabs(sessionIds) {
  const requestedIds = [...new Set((Array.isArray(sessionIds) ? sessionIds : [])
    .filter((id) => typeof id === "string" && id).slice(0, MAX_SELECTION))];
  const run = async () => {
    const audit = await inspectRecentlyClosedSuspendedTabs();
    if (!audit.ok) {
      return { ok: false, requested: requestedIds.length, restored: 0, failed: 0,
        unavailable: requestedIds.length };
    }
    const fresh = new Map(audit.candidates.map((candidate) => [candidate.sessionId, candidate]));
    let restored = 0;
    let failed = 0;
    let unavailable = 0;
    for (const sessionId of requestedIds) {
      const candidate = fresh.get(sessionId);
      if (!candidate) {
        unavailable += 1;
        continue;
      }
      try {
        const session = await chrome.sessions.restore(sessionId);
        if (await adoptRestoredCandidate(session, candidate)) restored += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    return {
      ok: failed === 0 && unavailable === 0,
      requested: requestedIds.length,
      restored,
      failed,
      unavailable
    };
  };
  recoveryChain = recoveryChain.then(run, run);
  return recoveryChain;
}

export const __test = { candidatesFromSessions, suspendedPageInfo };
