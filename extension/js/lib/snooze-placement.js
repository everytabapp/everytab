// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Device-local placement for single-tab Snoozes. */
import { normalizeUrl } from "./url-key.js";
import { saveableTabRef } from "./tabs.js";

export const SNOOZE_PLACEMENT_KEY = "snoozePlacements";
const BROWSER_SESSION_KEY = "snoozeBrowserSessionId";

function plainMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function snoozePlacementMap(value) {
  return plainMap(value);
}

async function browserSessionId() {
  const area = chrome.storage?.session;
  if (!area?.get || !area?.set) return null;
  try {
    const stored = (await area.get(BROWSER_SESSION_KEY))?.[BROWSER_SESSION_KEY];
    if (typeof stored === "string" && stored) return stored;
    const created = crypto.randomUUID();
    await area.set({ [BROWSER_SESSION_KEY]: created });
    return created;
  } catch {
    return null;
  }
}

function normalWindow(win) {
  return Number.isInteger(win?.id) && win.incognito !== true &&
    (!win.type || win.type === "normal");
}

function peerUrlsOf(win, excludedTabId = null) {
  return (win?.tabs ?? [])
    .filter((tab) => tab.id !== excludedTabId)
    .map((tab) => saveableTabRef(tab)?.url ?? "")
    .filter(Boolean)
    .map(normalizeUrl);
}

function nearestPeerUrls(win, tab) {
  return (win?.tabs ?? [])
    .filter((peer) => peer.id !== tab.id)
    .map((peer) => ({
      url: saveableTabRef(peer)?.url ?? "",
      distance: Math.abs((Number.isInteger(peer.index) ? peer.index : 0) - tab.index)
    }))
    .filter((peer) => peer.url)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 24)
    .map((peer) => normalizeUrl(peer.url));
}

/**
 * Capture enough local context to find a restored source window after Chrome
 * assigns it a new id. This record never enters Export or Vault.
 * @param {chrome.tabs.Tab} tab
 */
export async function captureSnoozePlacement(tab) {
  if (!Number.isInteger(tab?.windowId) || !Number.isInteger(tab?.index)) return null;
  let source;
  try {
    source = await chrome.windows.get(tab.windowId, { populate: true });
  } catch {
    return null;
  }
  if (source.id !== tab.windowId || !normalWindow(source)) return null;
  return {
    sourceWindowId: tab.windowId,
    index: Math.max(0, tab.index),
    pinned: tab.pinned === true,
    peerUrls: nearestPeerUrls(source, tab),
    browserSessionId: await browserSessionId(),
    capturedAt: Date.now()
  };
}

/** Attach one placement to the occurrence it describes. */
export function placementForSnooze(snooze, placement) {
  if (!placement || !Number.isInteger(placement.sourceWindowId) ||
      !Number.isInteger(placement.index)) return null;
  return {
    snoozeId: snooze.id,
    occurrenceDueAt: snooze.dueAt,
    sourceWindowId: placement.sourceWindowId,
    index: Math.max(0, placement.index),
    pinned: placement.pinned === true,
    peerUrls: Array.isArray(placement.peerUrls)
      ? placement.peerUrls.filter((url) => typeof url === "string" && /^https?:/.test(url))
        .map(normalizeUrl)
      : [],
    ...(typeof placement.browserSessionId === "string" && placement.browserSessionId
      ? { browserSessionId: placement.browserSessionId }
      : {}),
    capturedAt: Number.isFinite(placement.capturedAt) ? placement.capturedAt : Date.now()
  };
}

function matchingPlacement(placement, snooze) {
  return placement?.snoozeId === snooze?.id &&
    placement?.occurrenceDueAt === snooze?.dueAt &&
    Number.isInteger(placement?.sourceWindowId) &&
    Number.isInteger(placement?.index);
}

function overlapCount(expected, actual) {
  const remaining = new Map();
  for (const url of actual) remaining.set(url, (remaining.get(url) ?? 0) + 1);
  let score = 0;
  for (const url of expected) {
    const count = remaining.get(url) ?? 0;
    if (count <= 0) continue;
    score += 1;
    remaining.set(url, count - 1);
  }
  return score;
}

async function resolveSourceWindow(placement, windows) {
  const currentSessionId = await browserSessionId();
  if (placement.browserSessionId && currentSessionId === placement.browserSessionId) {
    const exact = windows.find((win) => win.id === placement.sourceWindowId);
    if (exact) return exact;
  }

  const expected = placement.peerUrls ?? [];
  if (expected.length === 0) return null;
  const ranked = windows.map((win) => ({
    win,
    score: overlapCount(expected, peerUrlsOf(win))
  })).sort((a, b) => b.score - a.score);
  const minimum = Math.min(2, expected.length);
  if ((ranked[0]?.score ?? 0) < minimum) return null;
  if ((ranked[1]?.score ?? 0) === ranked[0].score) return null;
  return ranked[0].win;
}

/**
 * The only address a Snooze may reopen without a user gesture. Saved records
 * can arrive from a Restore file or a Vault peer, so every reopen path must
 * share this check rather than trust the stored string.
 * @param {unknown} url
 * @returns {string|null} normalized http(s) address, or null
 */
export function wakeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch { return null; }
}

async function pinCreatedWindowTab(win, pinned) {
  if (!pinned) return;
  const tabId = win?.tabs?.[0]?.id;
  if (!Number.isInteger(tabId) || typeof chrome.tabs.update !== "function") return;
  try { await chrome.tabs.update(tabId, { pinned: true }); }
  catch { /* pin restoration is best effort */ }
}

/**
 * Wake a single tab at its source placement. If the source cannot be identified
 * safely, create a replacement window instead of using an unrelated implicit
 * worker window.
 */
export async function openSnoozedTab(snooze, rawPlacement) {
  // Gate only; reopen the stored bytes exactly as the window path does.
  if (!wakeUrl(snooze?.url)) return { ok: false, opened: 0, sourceUnavailable: true };
  const url = snooze.url;
  const placement = matchingPlacement(rawPlacement, snooze) ? rawPlacement : null;
  if (!placement) {
    // Portable/legacy Snoozes have no device-local origin. Preserve their
    // established current-window behavior; only a captured but unresolved
    // origin must refuse an unrelated implicit destination.
    const tab = await chrome.tabs.create({ url, active: false });
    return { ok: true, opened: 1, destination: "current-window", windowId: tab?.windowId ?? null };
  }

  const windows = (await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }))
    .filter(normalWindow);
  const source = await resolveSourceWindow(placement, windows);
  if (source) {
    await chrome.tabs.create({
      url,
      active: false,
      windowId: source.id,
      index: Math.min(placement.index, source.tabs?.length ?? placement.index),
      pinned: placement.pinned === true
    });
    return { ok: true, opened: 1, destination: "source-window", windowId: source.id };
  }

  const win = await chrome.windows.create({ url, focused: false });
  await pinCreatedWindowTab(win, placement.pinned === true);
  return { ok: true, opened: 1, destination: "replacement-window", windowId: win?.id ?? null };
}
