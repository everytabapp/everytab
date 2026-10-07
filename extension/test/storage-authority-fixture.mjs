import { STORE_KEYS, ARCHIVE_OVERLAY_KEY } from "../js/lib/types.js";
import {
  NAMED_SESSION_RECORDS_KEY
} from "../js/lib/session-identity-index.js";
import {
  setStorageAuthorityForTests
} from "../js/lib/storage/authority-runtime.js";

const nativeStructuredClone = globalThis.structuredClone.bind(globalThis);
const clone = (value) => value === undefined ? undefined : nativeStructuredClone(value);

function mergeMaps(base = {}, overlay = {}) {
  const merged = { ...base };
  for (const [id, item] of Object.entries(overlay ?? {})) {
    const current = merged[id];
    if (!current || (item?.modifiedAt ?? 0) >= (current?.modifiedAt ?? 0)) {
      merged[id] = item;
    }
  }
  return merged;
}

/**
 * Keep older map-shaped domain fixtures useful without restoring a production
 * fallback. This adapter is installed explicitly and exists only under test/.
 */
export function installBrowserMapStorageAuthority() {
  const authority = {
    async readMaps(keys) {
      const requested = [...new Set(keys ?? [])];
      const physical = [...requested];
      if (requested.includes(STORE_KEYS.archive) && !physical.includes(ARCHIVE_OVERLAY_KEY)) {
        physical.push(ARCHIVE_OVERLAY_KEY);
      }
      if (requested.includes(STORE_KEYS.sessions) &&
          !physical.includes(NAMED_SESSION_RECORDS_KEY)) {
        physical.push(NAMED_SESSION_RECORDS_KEY);
      }
      const stored = await chrome.storage.local.get(physical);
      const output = {};
      for (const key of requested) {
        if (Object.hasOwn(stored, key)) output[key] = clone(stored[key]);
      }
      if (requested.includes(ARCHIVE_OVERLAY_KEY) &&
          !Object.hasOwn(output, ARCHIVE_OVERLAY_KEY)) {
        output[ARCHIVE_OVERLAY_KEY] = {};
      }
      return output;
    },
    async commitMaps(sets) {
      await chrome.storage.local.set(clone(sets));
      return { revision: null };
    },
    async readItem(family, id) {
      const maps = await this.readMaps([family]);
      return clone(maps[family]?.[id] ?? null);
    },
    async readSessionNavigation() {
      const maps = await this.readMaps([STORE_KEYS.sessions, NAMED_SESSION_RECORDS_KEY]);
      const sessions = Object.values(mergeMaps(
        maps[STORE_KEYS.sessions], maps[NAMED_SESSION_RECORDS_KEY]
      ))
        .filter((session) => session && !session.deletedAt);
      return {
        namedSessions: sessions
          .filter((session) => !session.auto)
          .sort((left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0)),
        snapshotCount: sessions.filter((session) => session.auto).length
      };
    }
  };
  setStorageAuthorityForTests(authority);
  return authority;
}
