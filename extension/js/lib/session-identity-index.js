/**
 * Small read model used by Open tabs. Automatic snapshots deliberately share
 * the full `sessions` store for data compatibility, but Open only needs the id,
 * name, and normalized URL membership of live named Sessions to label restored
 * windows and detect drift. Keeping that compact projection separately prevents
 * years of automatic snapshots from joining the first-paint path.
 */
import { normalizeUrl } from "./url-key.js";

export const SESSION_IDENTITY_INDEX_KEY = "sessionIdentityIndex";
const SESSION_IDENTITY_INDEX_VERSION = 2;

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
 * to the whole Session, matching the historical drift behavior. A malformed or
 * pre-v2 identity returns null so Open skips the optional drift hint instead of
 * risking the primary ledger.
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
 * Read only the compact Open identity projection. A missing pre-index profile
 * returns an empty list rather than falling back to the potentially huge full
 * Session map; the background backfill publishes names and drift membership
 * moments later.
 */
export async function readSessionIdentities() {
  const result = await chrome.storage.local.get(SESSION_IDENTITY_INDEX_KEY);
  const index = result[SESSION_IDENTITY_INDEX_KEY];
  if (!isSessionIdentityIndex(index)) return [];
  return Object.values(index.sessionsById).map((session) => ({ ...session }));
}
