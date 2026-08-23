/**
 * F22 — global, local-first shortcuts for Home.
 *
 * Identity is the canonical HTTP(S) URL, not a particular open/saved copy.
 * The deterministic UUID makes independent stars of the same URL converge in
 * the per-item Vault store. Every mutation commits the record and its Undo
 * journal entry together under the shared store lock.
 */
import { normalizeUrl } from "./dedup.js";
import { STORE_KEYS, SCHEMA_VERSION } from "./types.js";
import { getDeviceId, listItems, mutateStores } from "./store.js";
import {
  JOURNAL_KEY, appendedJournal, makeJournalEntry
} from "./journal.js";

const encoder = new TextEncoder();

/** @param {string} value */
export function canonicalStarUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return normalizeUrl(url.href);
  } catch {
    return null;
  }
}

/** Deterministic, UUID-shaped identity accepted by the Vault file contract. */
export async function starIdForUrl(value) {
  const url = canonicalStarUrl(value);
  if (!url) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(url)));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The one shortcut order: the user's own `position`, then age, then id so the
 * result is total even when a vault merge hands two devices the same position.
 */
export function byStarredOrder(a, b) {
  return (a.position ?? 0) - (b.position ?? 0) ||
    (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
    a.id.localeCompare(b.id);
}

/** @returns {Promise<import("./types.js").StarredTab[]>} */
export async function listStarred() {
  return (await listItems(STORE_KEYS.starred)).sort(byStarredOrder);
}

/**
 * F45: put one shortcut at a new place in the rail, so the user owns the order.
 *
 * Deliberately NOT journaled: the inverse is simply dragging it back, nothing
 * is created or destroyed, and every journal entry raises the undo toast — one
 * toast per reorder would be noise, not safety.
 *
 * Positions are rewritten as a dense run, but only for the records whose index
 * actually changed, so a reorder touches the moved span rather than the whole
 * map and stays cheap to merge through the vault.
 * @param {string} id
 * @param {(from: number, count: number) => number} resolveIndex destination
 * @returns {Promise<boolean>} whether a commit happened
 */
function commitStarredOrder(id, resolveIndex) {
  const now = Date.now();
  return mutateStores([STORE_KEYS.starred], (maps) => {
    const starred = maps[STORE_KEYS.starred] ?? {};
    const order = Object.values(starred).filter((item) => !item.deletedAt).sort(byStarredOrder);
    const from = order.findIndex((item) => item.id === id);
    if (from < 0) return null; // removed on another device mid-gesture
    const to = resolveIndex(from, order.length);
    if (!Number.isInteger(to) || to < 0 || to >= order.length || to === from) return null;
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    const next = { ...starred };
    let changed = false;
    order.forEach((item, index) => {
      if ((Number(item.position) || 0) === index) return;
      next[item.id] = { ...item, position: index, modifiedAt: now };
      changed = true;
    });
    if (!changed) return null;
    return { [STORE_KEYS.starred]: next };
  });
}

/**
 * Move one shortcut one place up (`delta < 0`) or down. The keyboard path; a
 * move past either end is refused rather than clamped, so the run's ends stay
 * meaningful.
 * @param {string} id @param {number} delta @returns {Promise<boolean>}
 */
export async function moveStarred(id, delta) {
  const step = Number(delta) < 0 ? -1 : 1;
  return commitStarredOrder(id, (from) => from + step);
}

/**
 * Drop one shortcut at `toIndex`. The pointer path: a drop past either end is
 * CLAMPED, because releasing below the last row plainly means "put it last".
 * @param {string} id @param {number} toIndex @returns {Promise<boolean>}
 */
export async function reorderStarred(id, toIndex) {
  return commitStarredOrder(id, (from, count) =>
    Math.max(0, Math.min(count - 1, Math.trunc(Number(toIndex)))));
}

/** @param {string} url */
export async function isStarredUrl(url) {
  const id = await starIdForUrl(url);
  if (!id) return false;
  return (await listItems(STORE_KEYS.starred)).some((item) => item.id === id);
}

/**
 * @param {{url:string,title?:string,favIconUrl?:string}} ref
 * @returns {Promise<boolean>} true when a record was committed
 */
export async function starTab(ref) {
  const url = canonicalStarUrl(ref?.url);
  const id = await starIdForUrl(url);
  if (!id) return false;
  const deviceId = await getDeviceId();
  const now = Date.now();
  return mutateStores([STORE_KEYS.starred, JOURNAL_KEY], (maps) => {
    const starred = maps[STORE_KEYS.starred] ?? {};
    const existing = starred[id];
    if (existing && !existing.deletedAt) return null;
    const live = Object.values(starred).filter((item) => !item.deletedAt);
    const item = {
      id, deviceId,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
      schemaVersion: SCHEMA_VERSION,
      url,
      title: String(ref.title || url),
      ...(ref.favIconUrl ? { favIconUrl: ref.favIconUrl } : {}),
      position: live.reduce((max, item) => Math.max(max, Number(item.position) || 0), -1) + 1
    };
    const entry = makeJournalEntry(`Starred “${item.title}”`, {
      dels: [{ store: STORE_KEYS.starred, id }]
    });
    return {
      [STORE_KEYS.starred]: { ...starred, [id]: item },
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
}

/** @param {string} id @returns {Promise<boolean>} */
export async function unstarTab(id) {
  const now = Date.now();
  return mutateStores([STORE_KEYS.starred, JOURNAL_KEY], (maps) => {
    const starred = maps[STORE_KEYS.starred] ?? {};
    const item = starred[id];
    if (!item || item.deletedAt) return null;
    const entry = makeJournalEntry(`Unstarred “${item.title}”`, {
      puts: [{ store: STORE_KEYS.starred, item }]
    });
    return {
      [STORE_KEYS.starred]: {
        ...starred,
        [id]: { ...item, deletedAt: now, modifiedAt: now }
      },
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
}

/**
 * F34-2 — rename a shortcut. The record already carries `title`, so this is an
 * edit of an existing field rather than a schema change, and it syncs through
 * the same per-item starred store. The previous record rides the journal entry,
 * so Undo restores the old name exactly.
 * @param {string} id
 * @param {string} title
 * @returns {Promise<boolean>} false when the name is unusable or unchanged
 */
export async function renameStarred(id, title) {
  const next = String(title ?? "").trim();
  if (!next) return false;
  const now = Date.now();
  return mutateStores([STORE_KEYS.starred, JOURNAL_KEY], (maps) => {
    const starred = maps[STORE_KEYS.starred] ?? {};
    const item = starred[id];
    if (!item || item.deletedAt || item.title === next) return null;
    const entry = makeJournalEntry(`Renamed “${item.title}” to “${next}”`, {
      puts: [{ store: STORE_KEYS.starred, item }]
    });
    return {
      [STORE_KEYS.starred]: {
        ...starred,
        [id]: { ...item, title: next, modifiedAt: now }
      },
      [JOURNAL_KEY]: appendedJournal(maps[JOURNAL_KEY], entry)
    };
  });
}

/** @param {string} url @returns {Promise<boolean>} */
export async function unstarUrl(url) {
  const id = await starIdForUrl(url);
  return id ? unstarTab(id) : false;
}

/** @param {{url:string,title?:string,favIconUrl?:string}} ref */
export async function toggleStarred(ref) {
  return isStarredUrl(ref?.url) ? unstarUrl(ref.url) : starTab(ref);
}
