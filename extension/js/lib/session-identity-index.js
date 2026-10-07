// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Small read model used by Open tabs. Automatic snapshots deliberately share
 * the full `sessions` store for data compatibility, but Open only needs the id,
 * name, and normalized URL membership of live named Sessions to label restored
 * windows and detect drift. Keeping that compact projection separately prevents
 * years of automatic snapshots from joining the first-paint path.
 */
import { normalizeUrl } from "./url-key.js";

export const SESSION_IDENTITY_INDEX_KEY = "sessionIdentityIndex";
export const NAMED_SESSION_RECORDS_KEY = "namedSessionRecords";
export const SESSION_NAVIGATION_REVISION_KEY = "sessionNavigationRevision";
const SESSION_IDENTITY_INDEX_VERSION = 2;

/**
 * Full named-Session records kept apart from the combined Session/Snapshot
 * compatibility view. This lossless write model lets named-Session edits avoid
 * serializing years of automatic Snapshots. Tombstones remain part of the
 * merge contract.
 * @param {Record<string, import("./types.js").Session>} sessionMap
 */
export function buildNamedSessionRecords(sessionMap = {}) {
  const records = {};
  for (const [id, session] of Object.entries(sessionMap ?? {})) {
    if (!session || session.auto || !session.id || session.id !== id) continue;
    records[id] = session;
  }
  return records;
}

/** @param {unknown} value */
export function isNamedSessionRecords(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([id, session]) =>
    session && typeof session === "object" && !session.auto &&
    typeof session.id === "string" && session.id === id
  );
}

/**
 * Small navigation projection from a Session storage-change payload. It scans
 * records only: automatic Snapshot tab payloads are never traversed or cloned.
 * The records are already private structured clones delivered by Chrome, so
 * callers may retain this projection until the next navigation paint.
 * @param {Record<string, import("./types.js").Session>} sessionMap
 */
export function sessionNavigationSnapshot(sessionMap = {}) {
  const namedSessions = [];
  let snapshotCount = 0;
  for (const session of Object.values(sessionMap ?? {})) {
    if (!session || session.deletedAt) continue;
    if (session.auto) snapshotCount += 1;
    else namedSessions.push(session);
  }
  namedSessions.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  return { namedSessions, snapshotCount };
}

/**
 * Bounded Session projection carried by storage revision pulses. Full
 * Session records, tab arrays, and favicons never enter chrome.storage events.
 * The Dashboard fetches a Session by id only when Restore is requested.
 */
export function buildSessionNavigationRevision(sessionMap = {}, {
  includeSnapshotCount = false
} = {}) {
  const namedSessions = [];
  let snapshotCount = 0;
  for (const session of Object.values(sessionMap ?? {})) {
    if (!session || session.deletedAt) continue;
    if (session.auto) {
      snapshotCount += 1;
      continue;
    }
    namedSessions.push({
      id: session.id,
      name: String(session.name ?? "Session"),
      tabCount: (session.windows ?? []).reduce((total, refs) =>
        total + (Array.isArray(refs) ? refs.length : 0), 0),
      modifiedAt: Number(session.modifiedAt) || 0
    });
  }
  namedSessions.sort((a, b) => b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id));
  return {
    namedSessions,
    ...(includeSnapshotCount ? { snapshotCount } : {})
  };
}

/** @param {unknown} value */
export function isSessionIdentityIndex(value) {
  if (!value || typeof value !== "object" ||
      value.version !== SESSION_IDENTITY_INDEX_VERSION ||
      !value.sessionsById || typeof value.sessionsById !== "object" ||
      Array.isArray(value.sessionsById)) return false;
  return Object.values(value.sessionsById).every((session) =>
    session && typeof session === "object" && typeof session.id === "string" &&
    typeof session.name === "string" && Array.isArray(session.windowUrls) &&
    session.windowUrls.every((urls) =>
      Array.isArray(urls) && urls.every((url) => typeof url === "string"))
  );
}

/**
 * Pure projection from the canonical Session map. Snapshots and tombstones are
 * excluded, and no tab/window payload crosses into the index.
 * @param {Record<string, import("./types.js").Session>} sessionMap
 */
export function buildSessionIdentityIndex(sessionMap = {}) {
  const sessionsById = {};
  for (const session of Object.values(sessionMap ?? {})) {
    if (!session || session.auto || session.deletedAt || !session.id) continue;
    const windowUrls = (Array.isArray(session.windows) ? session.windows : []).map((refs) => {
      const urls = [];
      const seen = new Set();
      for (const ref of Array.isArray(refs) ? refs : []) {
        const key = normalizeUrl(String(ref?.url ?? ""));
        if (!key || seen.has(key)) continue;
        seen.add(key);
        urls.push(key);
      }
      return urls;
    });
    sessionsById[session.id] = {
      id: session.id,
      name: String(session.name ?? "Session"),
      windowUrls
    };
  }
  return { version: SESSION_IDENTITY_INDEX_VERSION, sessionsById };
}

/**
 * URL membership for one restored Session window. A stale binding falls back
 * to the whole Session, matching the established drift behavior. A malformed
 * identity returns null so Open skips the optional drift hint instead of risking
 * the primary ledger.
 * @param {any} session @param {number} windowIndex
 * @returns {string[]|null}
 */
export function sessionUrlsForWindow(session, windowIndex) {
  if (!Array.isArray(session?.windowUrls)) return null;
  const selected = session.windowUrls[windowIndex];
  if (Array.isArray(selected)) return selected;
  return session.windowUrls.flatMap((urls) => Array.isArray(urls) ? urls : []);
}

/**
 * Compact URL → named-Session projection for list-row membership links.
 * It consumes only the identity index, never automatic Snapshot payloads.
 * @param {Array<{id:string,name:string,windowUrls:string[][]}>} identities
 * @returns {Map<string,{id:string,name:string}[]>}
 */
export function buildSessionMembershipsByUrl(identities = []) {
  const byUrl = new Map();
  for (const session of identities ?? []) {
    const id = String(session?.id ?? "").trim();
    const name = String(session?.name ?? "").trim();
    if (!id || !name) continue;
    for (const url of (session.windowUrls ?? []).flat()) {
      const key = normalizeUrl(String(url ?? ""));
      if (!key) continue;
      const memberships = byUrl.get(key) ?? [];
      if (!memberships.some((entry) => entry.id === id)) memberships.push({ id, name });
      byUrl.set(key, memberships);
    }
  }
  for (const memberships of byUrl.values()) {
    memberships.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  return byUrl;
}

/** Backward-compatible name-only view for non-interactive consumers. */
export function buildSessionNamesByUrl(identities = []) {
  return new Map([...buildSessionMembershipsByUrl(identities)]
    .map(([url, memberships]) => [url, memberships.map((entry) => entry.name)]));
}
